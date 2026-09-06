import { WeaponId, type PlayerSnapshotData } from '@clans/sim';
import {
  bytesOf,
  createReader,
  createWriter,
  readF32,
  readU16,
  readU32,
  readU8,
  writeF32,
  writeU16,
  writeU32,
  writeU8,
  type Cursor,
} from './codec.js';
import { MAX_SNAPSHOT_PLAYERS, MessageType } from './messages.js';

export interface SnapshotBaseline {
  snapshotId: number;
  players: PlayerSnapshotData[];
}
export interface DecodedSnapshot {
  snapshotId: number;
  baselineId: number;
  tick: number;
  lastInputSequence: number;
  players: PlayerSnapshotData[];
  removedIds: number[];
}

const HEADER_BYTES = 1 + 4 + 4 + 4 + 4 + 1; // type, snapshotId, baselineId, tick, lastInputSequence, flags
const PLAYER_FULL_BYTES = 2 + 1 + 4 * 7 + 4 + 1; // id, team, 7 f32 (transform), energy f32, status byte
const DELTA_FLAG = 1;
const DIRTY_TRANSFORM = 1;
const DIRTY_ENERGY = 2;
const DIRTY_STATUS = 4;
const DIRTY_TEAM = 8;
const EPSILON = 1e-4;

interface SnapshotHeader {
  snapshotId: number;
  baselineId: number;
  tick: number;
  lastInputSequence: number;
  flags: number;
}

function writeHeader(cursor: Cursor, header: SnapshotHeader): void {
  writeU8(cursor, MessageType.Snapshot);
  writeU32(cursor, header.snapshotId);
  writeU32(cursor, header.baselineId);
  writeU32(cursor, header.tick);
  writeU32(cursor, header.lastInputSequence);
  writeU8(cursor, header.flags);
}
function readHeader(cursor: Cursor): SnapshotHeader {
  const type = readU8(cursor);
  if (type !== MessageType.Snapshot)
    throw new RangeError(`Expected Snapshot, got type ${String(type)}`);
  return {
    snapshotId: readU32(cursor),
    baselineId: readU32(cursor),
    tick: readU32(cursor),
    lastInputSequence: readU32(cursor),
    flags: readU8(cursor),
  };
}

function statusByte(data: PlayerSnapshotData): number {
  return (data.onGround ? 1 : 0) | (data.ski ? 2 : 0);
}

function writePlayerFull(cursor: Cursor, data: PlayerSnapshotData): void {
  writeU16(cursor, data.id);
  writeU8(cursor, data.team);
  writeF32(cursor, data.x);
  writeF32(cursor, data.y);
  writeF32(cursor, data.z);
  writeF32(cursor, data.vx);
  writeF32(cursor, data.vy);
  writeF32(cursor, data.vz);
  writeF32(cursor, data.yaw);
  writeF32(cursor, data.energy);
  writeU8(cursor, statusByte(data));
}
// A NaN or Infinity in any of these would otherwise reach client-side prediction
// (or the server's own authoritative state, for a delta the server decodes) and poison
// it, exactly as an unvalidated input axis would (see handshake.ts's readSample).
function assertFinite(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Snapshot value must be finite');
  }
}

function readPlayerFull(cursor: Cursor): PlayerSnapshotData {
  const id = readU16(cursor);
  const team = readU8(cursor);
  const x = readF32(cursor);
  const y = readF32(cursor);
  const z = readF32(cursor);
  const vx = readF32(cursor);
  const vy = readF32(cursor);
  const vz = readF32(cursor);
  const yaw = readF32(cursor);
  const energy = readF32(cursor);
  const flags = readU8(cursor);
  assertFinite([x, y, z, vx, vy, vz, yaw, energy]);
  return {
    id,
    team,
    x,
    y,
    z,
    vx,
    vy,
    vz,
    yaw,
    energy,
    // Not on the wire yet: PlayerSnapshotData grew weaponSlot for the sim's weapon state
    // machines (M3 Task 2), but the snapshot codec only gains a real wire field for it in
    // the protocol task that follows. Every decoded player reports the same starting
    // weapon a fresh addPlayer gives them until then, matching health's existing pattern
    // of defaulting to "as if nothing has happened yet" for a field not yet on the wire.
    weaponSlot: WeaponId.Blaster,
    onGround: flags & 1 ? 1 : 0,
    ski: flags & 2 ? 1 : 0,
  };
}

function encodeFullSnapshot(
  snapshotId: number,
  tick: number,
  lastInputSequence: number,
  players: PlayerSnapshotData[],
): Uint8Array {
  const cursor = createWriter(HEADER_BYTES + 2 + players.length * PLAYER_FULL_BYTES);
  writeHeader(cursor, { snapshotId, baselineId: 0, tick, lastInputSequence, flags: 0 });
  writeU16(cursor, players.length);
  for (const player of players) writePlayerFull(cursor, player);
  return bytesOf(cursor);
}

function transformChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return (
    Math.abs(a.x - b.x) > EPSILON ||
    Math.abs(a.y - b.y) > EPSILON ||
    Math.abs(a.z - b.z) > EPSILON ||
    Math.abs(a.vx - b.vx) > EPSILON ||
    Math.abs(a.vy - b.vy) > EPSILON ||
    Math.abs(a.vz - b.vz) > EPSILON ||
    Math.abs(a.yaw - b.yaw) > EPSILON
  );
}
function energyChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return Math.abs(a.energy - b.energy) > EPSILON;
}
function statusChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return a.onGround !== b.onGround || a.ski !== b.ski;
}
function teamChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return a.team !== b.team;
}
function dirtyMask(current: PlayerSnapshotData, previous: PlayerSnapshotData): number {
  let mask = 0;
  if (transformChanged(current, previous)) mask |= DIRTY_TRANSFORM;
  if (energyChanged(current, previous)) mask |= DIRTY_ENERGY;
  if (statusChanged(current, previous)) mask |= DIRTY_STATUS;
  if (teamChanged(current, previous)) mask |= DIRTY_TEAM;
  return mask;
}

interface SnapshotDiff {
  added: PlayerSnapshotData[];
  changed: Array<{ data: PlayerSnapshotData; mask: number }>;
  removedIds: number[];
}
function diffPlayers(current: PlayerSnapshotData[], previous: PlayerSnapshotData[]): SnapshotDiff {
  const previousById = new Map(previous.map((player) => [player.id, player]));
  const currentIds = new Set(current.map((player) => player.id));
  const added: PlayerSnapshotData[] = [];
  const changed: Array<{ data: PlayerSnapshotData; mask: number }> = [];
  for (const player of current) {
    const before = previousById.get(player.id);
    if (!before) {
      added.push(player);
      continue;
    }
    const mask = dirtyMask(player, before);
    if (mask !== 0) changed.push({ data: player, mask });
  }
  const removedIds = previous
    .filter((player) => !currentIds.has(player.id))
    .map((player) => player.id);
  return { added, changed, removedIds };
}

function changedRecordBytes(mask: number): number {
  let bytes = 3; // id (2) + mask (1)
  if (mask & DIRTY_TRANSFORM) bytes += 28;
  if (mask & DIRTY_ENERGY) bytes += 4;
  if (mask & DIRTY_STATUS) bytes += 1;
  if (mask & DIRTY_TEAM) bytes += 1;
  return bytes;
}
function writeChangedTransform(cursor: Cursor, data: PlayerSnapshotData): void {
  writeF32(cursor, data.x);
  writeF32(cursor, data.y);
  writeF32(cursor, data.z);
  writeF32(cursor, data.vx);
  writeF32(cursor, data.vy);
  writeF32(cursor, data.vz);
  writeF32(cursor, data.yaw);
}
function writeChangedPlayer(cursor: Cursor, data: PlayerSnapshotData, mask: number): void {
  writeU16(cursor, data.id);
  writeU8(cursor, mask);
  if (mask & DIRTY_TRANSFORM) writeChangedTransform(cursor, data);
  if (mask & DIRTY_ENERGY) writeF32(cursor, data.energy);
  if (mask & DIRTY_STATUS) writeU8(cursor, statusByte(data));
  if (mask & DIRTY_TEAM) writeU8(cursor, data.team);
}

function encodeDeltaSnapshot(
  snapshotId: number,
  tick: number,
  lastInputSequence: number,
  baseline: SnapshotBaseline,
  players: PlayerSnapshotData[],
): Uint8Array {
  const diff = diffPlayers(players, baseline.players);
  const changedBytes = diff.changed.reduce((sum, entry) => sum + changedRecordBytes(entry.mask), 0);
  const bodyBytes =
    2 + diff.added.length * PLAYER_FULL_BYTES + 2 + changedBytes + 2 + diff.removedIds.length * 2;
  const cursor = createWriter(HEADER_BYTES + bodyBytes);
  writeHeader(cursor, {
    snapshotId,
    baselineId: baseline.snapshotId,
    tick,
    lastInputSequence,
    flags: DELTA_FLAG,
  });
  writeU16(cursor, diff.added.length);
  for (const player of diff.added) writePlayerFull(cursor, player);
  writeU16(cursor, diff.changed.length);
  for (const entry of diff.changed) writeChangedPlayer(cursor, entry.data, entry.mask);
  writeU16(cursor, diff.removedIds.length);
  for (const id of diff.removedIds) writeU16(cursor, id);
  return bytesOf(cursor);
}

export function encodeSnapshot(
  snapshotId: number,
  tick: number,
  lastInputSequence: number,
  players: PlayerSnapshotData[],
  baseline: SnapshotBaseline | null,
): Uint8Array {
  return baseline
    ? encodeDeltaSnapshot(snapshotId, tick, lastInputSequence, baseline, players)
    : encodeFullSnapshot(snapshotId, tick, lastInputSequence, players);
}

function assertPlausibleCount(count: number): void {
  if (count > MAX_SNAPSHOT_PLAYERS) {
    throw new RangeError(`Snapshot count ${String(count)} exceeds ${String(MAX_SNAPSHOT_PLAYERS)}`);
  }
}

function decodeFull(cursor: Cursor, header: SnapshotHeader): DecodedSnapshot {
  const count = readU16(cursor);
  assertPlausibleCount(count);
  const players: PlayerSnapshotData[] = [];
  for (let i = 0; i < count; i += 1) players.push(readPlayerFull(cursor));
  return {
    snapshotId: header.snapshotId,
    baselineId: 0,
    tick: header.tick,
    lastInputSequence: header.lastInputSequence,
    players,
    removedIds: [],
  };
}

function readChangedTransform(cursor: Cursor, next: PlayerSnapshotData): void {
  const x = readF32(cursor);
  const y = readF32(cursor);
  const z = readF32(cursor);
  const vx = readF32(cursor);
  const vy = readF32(cursor);
  const vz = readF32(cursor);
  const yaw = readF32(cursor);
  assertFinite([x, y, z, vx, vy, vz, yaw]);
  next.x = x;
  next.y = y;
  next.z = z;
  next.vx = vx;
  next.vy = vy;
  next.vz = vz;
  next.yaw = yaw;
}
function readChangedStatus(cursor: Cursor, next: PlayerSnapshotData): void {
  const flags = readU8(cursor);
  next.onGround = flags & 1 ? 1 : 0;
  next.ski = flags & 2 ? 1 : 0;
}
function readChangedEnergy(cursor: Cursor, next: PlayerSnapshotData): void {
  const energy = readF32(cursor);
  assertFinite([energy]);
  next.energy = energy;
}
function applyChangedPlayer(cursor: Cursor, byId: Map<number, PlayerSnapshotData>): void {
  const id = readU16(cursor);
  const mask = readU8(cursor);
  const before = byId.get(id);
  if (!before) throw new RangeError(`Changed player ${String(id)} missing from baseline`);
  const next: PlayerSnapshotData = { ...before };
  if (mask & DIRTY_TRANSFORM) readChangedTransform(cursor, next);
  if (mask & DIRTY_ENERGY) readChangedEnergy(cursor, next);
  if (mask & DIRTY_STATUS) readChangedStatus(cursor, next);
  if (mask & DIRTY_TEAM) next.team = readU8(cursor);
  byId.set(id, next);
}

function decodeDelta(
  cursor: Cursor,
  header: SnapshotHeader,
  baseline: SnapshotBaseline | null,
): DecodedSnapshot {
  if (!baseline || baseline.snapshotId !== header.baselineId) {
    throw new RangeError(`Delta snapshot needs baseline ${String(header.baselineId)}`);
  }
  const byId = new Map(baseline.players.map((player) => [player.id, player]));
  const addedCount = readU16(cursor);
  assertPlausibleCount(addedCount);
  for (let i = 0; i < addedCount; i += 1) {
    const player = readPlayerFull(cursor);
    byId.set(player.id, player);
  }
  // addedCount alone was capped, but a baseline near the cap plus another capped batch
  // of additions can still push the *reconstructed* roster over MAX_SNAPSHOT_PLAYERS,
  // and nothing ever shrinks it back down between deltas -- growing it a little on every
  // delta a client applies eventually reaches the same tens-of-thousands-of-meshes cap
  // the count check on a single message was meant to prevent.
  assertPlausibleCount(byId.size);
  const changedCount = readU16(cursor);
  assertPlausibleCount(changedCount);
  for (let i = 0; i < changedCount; i += 1) applyChangedPlayer(cursor, byId);
  const removedCount = readU16(cursor);
  assertPlausibleCount(removedCount);
  const removedIds: number[] = [];
  for (let i = 0; i < removedCount; i += 1) {
    const id = readU16(cursor);
    byId.delete(id);
    removedIds.push(id);
  }
  return {
    snapshotId: header.snapshotId,
    baselineId: header.baselineId,
    tick: header.tick,
    lastInputSequence: header.lastInputSequence,
    players: [...byId.values()],
    removedIds,
  };
}

export function decodeSnapshot(
  bytes: Uint8Array,
  baseline: SnapshotBaseline | null,
): DecodedSnapshot {
  const cursor = createReader(bytes);
  const header = readHeader(cursor);
  return header.flags & DELTA_FLAG
    ? decodeDelta(cursor, header, baseline)
    : decodeFull(cursor, header);
}

export interface SnapshotHeaderPeek {
  snapshotId: number;
  baselineId: number;
  isDelta: boolean;
}

/**
 * Reads only the snapshot header, without a baseline, so a caller holding several
 * historical snapshots (the server deltas against a client's last ACKED snapshot,
 * which can trail the newest one it sent) can pick the matching baseline before the
 * real decode. Cheap: it re-reads the same fixed-size header decodeSnapshot does.
 */
export function peekSnapshotHeader(bytes: Uint8Array): SnapshotHeaderPeek {
  const header = readHeader(createReader(bytes));
  return {
    snapshotId: header.snapshotId,
    baselineId: header.baselineId,
    isDelta: (header.flags & DELTA_FLAG) !== 0,
  };
}
