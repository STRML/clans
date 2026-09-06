import type { PlayerSnapshotData } from '@clans/sim';
import {
  bytesOf,
  createReader,
  createWriter,
  readF32,
  readI16,
  readU16,
  readU32,
  readU8,
  writeF32,
  writeI16,
  writeU16,
  writeU32,
  writeU8,
  type Cursor,
} from './codec.js';
import {
  MAX_SNAPSHOT_FLAGS,
  MAX_SNAPSHOT_PLAYERS,
  MAX_SNAPSHOT_PROJECTILES,
  MessageType,
} from './messages.js';

export interface SnapshotBaseline {
  snapshotId: number;
  players: PlayerSnapshotData[];
}
export interface ProjectileSnapshotData {
  id: number;
  type: number; // ProjectileType from @clans/sim
  weaponId: number; // WeaponId from @clans/sim
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ownerId: number;
}
export interface FlagSnapshotData {
  id: number;
  team: number;
  state: number; // FlagState from @clans/sim
  x: number;
  y: number;
  z: number;
  carrierId: number; // -1 if not carried
  returnInS: number; // -1 if not counting down
}
export interface WorldExtras {
  projectiles: ProjectileSnapshotData[];
  flags: FlagSnapshotData[];
  teamScores: [number, number]; // [team1, team2]
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number; // seconds until the match clock expires; derived, not the raw tick threshold
  gameOverReason: number; // GameOverReason from @clans/sim: 0 = capture limit, 1 = time limit
}
export function emptyExtras(): WorldExtras {
  return {
    projectiles: [],
    flags: [],
    teamScores: [0, 0],
    gameOver: false,
    winnerTeam: 0,
    timeRemainingS: 0,
    gameOverReason: 0,
  };
}
export interface DecodedSnapshot {
  snapshotId: number;
  baselineId: number;
  tick: number;
  lastInputSequence: number;
  players: PlayerSnapshotData[];
  removedIds: number[];
  projectiles: ProjectileSnapshotData[];
  flags: FlagSnapshotData[];
  teamScores: [number, number];
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number;
  gameOverReason: number;
}

const HEADER_BYTES = 1 + 4 + 4 + 4 + 4 + 1; // type, snapshotId, baselineId, tick, lastInputSequence, flags
// id, team, 7 f32, energy f32, status byte, health f32, weaponSlot u8, respawnSeq u8.
// respawnSeq is a single byte (mod-256 truncation of the sim's Uint16 counter, see
// sim/types.ts's respawnSeq doc comment) -- a client only ever compares it against what the
// immediately-previous snapshot IT received reported, so the only way that comparison could
// miss a change is 256 respawns of the same id landing between two snapshots the client
// actually got. Not a realistic loss/coalescing scenario at this milestone's scale.
const PLAYER_FULL_BYTES = 2 + 1 + 4 * 7 + 4 + 1 + 4 + 1 + 1;
const PROJECTILE_BYTES = 2 + 1 + 1 + 4 * 6 + 2; // id, type, weaponId, 6 f32 (pos+vel), ownerId
const FLAG_BYTES = 1 + 1 + 1 + 4 * 3 + 2 + 4; // id, team, state, 3 f32 (pos), carrierId i16, returnInS f32
const DELTA_FLAG = 1;
const DIRTY_TRANSFORM = 1;
const DIRTY_ENERGY = 2;
const DIRTY_STATUS = 4;
const DIRTY_TEAM = 8;
const DIRTY_HEALTH = 16;
const DIRTY_WEAPON = 32;
const DIRTY_RESPAWN = 64;
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

// A NaN or Infinity in any of these would otherwise reach client-side prediction
// (or the server's own authoritative state, for a delta the server decodes) and poison
// it, exactly as an unvalidated input axis would (see handshake.ts's readSample).
function assertFinite(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Snapshot value must be finite');
  }
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
  writeF32(cursor, data.health);
  writeU8(cursor, data.weaponSlot);
  writeU8(cursor, data.respawnSeq);
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
  const health = readF32(cursor);
  const weaponSlot = readU8(cursor);
  const respawnSeq = readU8(cursor);
  assertFinite([x, y, z, vx, vy, vz, yaw, energy, health]);
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
    onGround: flags & 1 ? 1 : 0,
    ski: flags & 2 ? 1 : 0,
    health,
    weaponSlot,
    respawnSeq,
  };
}

function writeProjectile(cursor: Cursor, p: ProjectileSnapshotData): void {
  writeU16(cursor, p.id);
  writeU8(cursor, p.type);
  writeU8(cursor, p.weaponId);
  writeF32(cursor, p.x);
  writeF32(cursor, p.y);
  writeF32(cursor, p.z);
  writeF32(cursor, p.vx);
  writeF32(cursor, p.vy);
  writeF32(cursor, p.vz);
  writeU16(cursor, p.ownerId);
}
function readProjectile(cursor: Cursor): ProjectileSnapshotData {
  const id = readU16(cursor);
  const type = readU8(cursor);
  const weaponId = readU8(cursor);
  const x = readF32(cursor);
  const y = readF32(cursor);
  const z = readF32(cursor);
  const vx = readF32(cursor);
  const vy = readF32(cursor);
  const vz = readF32(cursor);
  const ownerId = readU16(cursor);
  assertFinite([x, y, z, vx, vy, vz]);
  return { id, type, weaponId, x, y, z, vx, vy, vz, ownerId };
}

function writeFlag(cursor: Cursor, f: FlagSnapshotData): void {
  writeU8(cursor, f.id);
  writeU8(cursor, f.team);
  writeU8(cursor, f.state);
  writeF32(cursor, f.x);
  writeF32(cursor, f.y);
  writeF32(cursor, f.z);
  writeI16(cursor, f.carrierId);
  writeF32(cursor, f.returnInS);
}
function readFlag(cursor: Cursor): FlagSnapshotData {
  const id = readU8(cursor);
  const team = readU8(cursor);
  const state = readU8(cursor);
  const x = readF32(cursor);
  const y = readF32(cursor);
  const z = readF32(cursor);
  const carrierId = readI16(cursor);
  const returnInS = readF32(cursor);
  assertFinite([x, y, z, returnInS]);
  return { id, team, state, x, y, z, carrierId, returnInS };
}

function writeExtras(cursor: Cursor, extras: WorldExtras): void {
  writeU16(cursor, extras.projectiles.length);
  for (const p of extras.projectiles) writeProjectile(cursor, p);
  writeU8(cursor, extras.flags.length);
  for (const f of extras.flags) writeFlag(cursor, f);
  writeU16(cursor, extras.teamScores[0]);
  writeU16(cursor, extras.teamScores[1]);
  writeU8(cursor, extras.gameOver ? 1 : 0);
  writeU8(cursor, extras.winnerTeam);
  writeF32(cursor, extras.timeRemainingS);
  writeU8(cursor, extras.gameOverReason);
}
function assertPlausibleExtrasCount(count: number, max: number, label: string): void {
  if (count > max) {
    throw new RangeError(`Snapshot ${label} count ${String(count)} exceeds ${String(max)}`);
  }
}

function readExtras(cursor: Cursor): WorldExtras {
  const projectileCount = readU16(cursor);
  assertPlausibleExtrasCount(projectileCount, MAX_SNAPSHOT_PROJECTILES, 'projectile');
  const projectiles: ProjectileSnapshotData[] = [];
  for (let i = 0; i < projectileCount; i += 1) projectiles.push(readProjectile(cursor));
  const flagCount = readU8(cursor);
  assertPlausibleExtrasCount(flagCount, MAX_SNAPSHOT_FLAGS, 'flag');
  const flags: FlagSnapshotData[] = [];
  for (let i = 0; i < flagCount; i += 1) flags.push(readFlag(cursor));
  const teamScores: [number, number] = [readU16(cursor), readU16(cursor)];
  const gameOver = readU8(cursor) !== 0;
  const winnerTeam = readU8(cursor);
  const timeRemainingS = readF32(cursor);
  const gameOverReason = readU8(cursor);
  assertFinite([timeRemainingS]);
  return { projectiles, flags, teamScores, gameOver, winnerTeam, timeRemainingS, gameOverReason };
}
function extrasByteLength(extras: WorldExtras): number {
  return (
    2 +
    extras.projectiles.length * PROJECTILE_BYTES +
    1 +
    extras.flags.length * FLAG_BYTES +
    2 +
    2 +
    1 +
    1 +
    4 +
    1
  );
}

function encodeFullSnapshot(
  snapshotId: number,
  tick: number,
  lastInputSequence: number,
  players: PlayerSnapshotData[],
  extras: WorldExtras,
): Uint8Array {
  const cursor = createWriter(
    HEADER_BYTES + 2 + players.length * PLAYER_FULL_BYTES + extrasByteLength(extras),
  );
  writeHeader(cursor, { snapshotId, baselineId: 0, tick, lastInputSequence, flags: 0 });
  writeU16(cursor, players.length);
  for (const player of players) writePlayerFull(cursor, player);
  writeExtras(cursor, extras);
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
function healthChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return Math.abs(a.health - b.health) > EPSILON;
}
function weaponChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return a.weaponSlot !== b.weaponSlot;
}
// Exact equality, not the EPSILON comparison the float fields above use: respawnSeq is an
// integer counter, so any difference at all -- including the mod-256 wraparound the wire
// truncation can produce -- is itself a real change worth sending.
function respawnSeqChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return a.respawnSeq !== b.respawnSeq;
}
function dirtyMask(current: PlayerSnapshotData, previous: PlayerSnapshotData): number {
  let mask = 0;
  if (transformChanged(current, previous)) mask |= DIRTY_TRANSFORM;
  if (energyChanged(current, previous)) mask |= DIRTY_ENERGY;
  if (statusChanged(current, previous)) mask |= DIRTY_STATUS;
  if (teamChanged(current, previous)) mask |= DIRTY_TEAM;
  if (healthChanged(current, previous)) mask |= DIRTY_HEALTH;
  if (weaponChanged(current, previous)) mask |= DIRTY_WEAPON;
  if (respawnSeqChanged(current, previous)) mask |= DIRTY_RESPAWN;
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
  if (mask & DIRTY_HEALTH) bytes += 4;
  if (mask & DIRTY_WEAPON) bytes += 1;
  if (mask & DIRTY_RESPAWN) bytes += 1;
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
  if (mask & DIRTY_HEALTH) writeF32(cursor, data.health);
  if (mask & DIRTY_WEAPON) writeU8(cursor, data.weaponSlot);
  if (mask & DIRTY_RESPAWN) writeU8(cursor, data.respawnSeq);
}

function encodeDeltaSnapshot(
  snapshotId: number,
  tick: number,
  lastInputSequence: number,
  baseline: SnapshotBaseline,
  players: PlayerSnapshotData[],
  extras: WorldExtras,
): Uint8Array {
  const diff = diffPlayers(players, baseline.players);
  const changedBytes = diff.changed.reduce((sum, entry) => sum + changedRecordBytes(entry.mask), 0);
  const bodyBytes =
    2 +
    diff.added.length * PLAYER_FULL_BYTES +
    2 +
    changedBytes +
    2 +
    diff.removedIds.length * 2 +
    extrasByteLength(extras);
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
  writeExtras(cursor, extras);
  return bytesOf(cursor);
}

export function encodeSnapshot(
  snapshotId: number,
  tick: number,
  lastInputSequence: number,
  players: PlayerSnapshotData[],
  baseline: SnapshotBaseline | null,
  extras: WorldExtras,
): Uint8Array {
  return baseline
    ? encodeDeltaSnapshot(snapshotId, tick, lastInputSequence, baseline, players, extras)
    : encodeFullSnapshot(snapshotId, tick, lastInputSequence, players, extras);
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
  const extras = readExtras(cursor);
  return {
    snapshotId: header.snapshotId,
    baselineId: 0,
    tick: header.tick,
    lastInputSequence: header.lastInputSequence,
    players,
    removedIds: [],
    ...extras,
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
function readChangedHealth(cursor: Cursor, next: PlayerSnapshotData): void {
  const health = readF32(cursor);
  assertFinite([health]);
  next.health = health;
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
  if (mask & DIRTY_HEALTH) readChangedHealth(cursor, next);
  if (mask & DIRTY_WEAPON) next.weaponSlot = readU8(cursor);
  if (mask & DIRTY_RESPAWN) next.respawnSeq = readU8(cursor);
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
  const extras = readExtras(cursor);
  return {
    snapshotId: header.snapshotId,
    baselineId: header.baselineId,
    tick: header.tick,
    lastInputSequence: header.lastInputSequence,
    players: [...byId.values()],
    removedIds,
    ...extras,
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
