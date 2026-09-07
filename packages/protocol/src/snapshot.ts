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
  MAX_SNAPSHOT_BASE_OBJECTS,
  MAX_SNAPSHOT_FLAGS,
  MAX_SNAPSHOT_PLAYERS,
  MAX_SNAPSHOT_PROJECTILES,
  MAX_SNAPSHOT_TURRETS,
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
  /**
   * ProjectileStore.armed (0/1) -- whether this projectile can still detonate on contact
   * (projectiles.ts). hash.ts's mixProjectiles has hashed this since round 13, but it was
   * never wired onto the snapshot itself, a real gap in what a client can observe about a
   * live projectile. expiresAtTick is deliberately NOT wired alongside it: it is a raw
   * internal tick counter with no meaning across a client/server boundary that numbers
   * ticks differently, and the client doesn't need it -- weapons-view.ts already handles
   * projectile lifecycle by reacting to a projectile's absence in the next snapshot, not by
   * predicting its exact expiry tick. Codex review round 15 (PR #9), finding 2.
   */
  armed: number;
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
export interface BaseObjectSnapshotData {
  id: number;
  damage: number;
  destroyed: 0 | 1;
  powered: 0 | 1;
}
export interface TurretSnapshotData {
  id: number;
  damage: number;
  destroyed: 0 | 1;
  powered: 0 | 1;
  targetId: number; // -1 = none
  state: number; // TurretState from @clans/sim
}
export interface WorldExtras {
  projectiles: ProjectileSnapshotData[];
  flags: FlagSnapshotData[];
  baseObjects: BaseObjectSnapshotData[];
  turrets: TurretSnapshotData[];
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
    baseObjects: [],
    turrets: [],
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
  baseObjects: BaseObjectSnapshotData[];
  turrets: TurretSnapshotData[];
  teamScores: [number, number];
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number;
  gameOverReason: number;
}

const HEADER_BYTES = 1 + 4 + 4 + 4 + 4 + 1; // type, snapshotId, baselineId, tick, lastInputSequence, flags
// id, team, 7 f32, energy f32, status byte, health f32, weaponSlot u8, respawnSeq u8,
// discAmmo u8, chaingunAmmo u8, mortarAmmo u8, grenades u8.
// respawnSeq is a single byte (mod-256 truncation of the sim's Uint16 counter, see
// sim/types.ts's respawnSeq doc comment) -- a client only ever compares it against what the
// immediately-previous snapshot IT received reported, so the only way that comparison could
// miss a change is 256 respawns of the same id landing between two snapshots the client
// actually got. Not a realistic loss/coalescing scenario at this milestone's scale.
// The four ammo fields are single bytes each: the spec's largest ammo pool (mortar, up to
// 200) and grenade count both fit comfortably under 256. Codex review round 10 (PR #9),
// finding 1: without these on the wire, reconciliation had no authoritative ammo value to
// correct client-side prediction against, so a lost or evicted input's ammo drift persisted
// until the player's next death/respawn instead of self-healing on the next snapshot.
// weaponState (u8, WeaponState enum, 0-5) + weaponTimer (f32) + spunUp (u8, 0/1): the
// fire-eligibility state machine itself (weapons.ts's stepWeapons), missing from the wire
// even after round 10 wired ammo. Codex review round 11 (PR #9): a lost fire input could
// get its ammo corrected on the next snapshot while staying stuck in a stale Firing state,
// silently suppressing the player's next real shot for up to a full fire-cycle duration.
// grenadeCooldown (f32): the grenade throw's own parallel cooldown timer (weapons.ts's
// tryThrowGrenade), a sibling to weaponState/weaponTimer/spunUp that round 11 missed.
// Codex review round 12 (PR #9), finding 1: round 10's ammo fix self-heals the grenade
// COUNT after a lost altFire input, but left this cooldown stuck at its stale
// locally-predicted value, silently suppressing the player's next real throw.
// score (i16, signed -- suicide/team-kill scoring can go negative) + godMode (u8, 0/1):
// round 13's hashWorld/mixPlayer already mixed both into the determinism hash, but neither
// was ever wired onto the snapshot itself, so a decoded/reconstructed player always came
// back with score 0 / godMode 0 regardless of the source's real values, and hashWorld on
// the two worlds diverged even though the wire faithfully transmitted everything it
// actually carried. Codex review round 14 (PR #9), finding 1.
// wasJumpHeld: no new bytes -- it packs into the existing status byte's bit 2 (statusByte's
// own comment has the detail). Codex review round 15 (PR #9), finding 1.
// armor (u8, ArmorId) + hasRepairPack (u8, 0/1): sim/snapshot.ts's PlayerSnapshotData has
// carried these since serializePlayer/deserializePlayer were written, and the sim-side round
// trip (snapshot.test.ts in packages/sim) already exercised them -- but writePlayerFull/
// readPlayerFull never actually put them on the WIRE, so every decoded player came back
// hardcoded to Light/no-pack regardless of what a station visit (applyLoadoutRequest) had
// set. A networked client's HUD, prediction (armorFor drives energy/speed caps and fall-
// damage scaling), and reconcile() all silently disagreed with the server's real loadout.
// Codex round 1, finding 2.
const PLAYER_FULL_BYTES = 2 + 1 + 4 * 7 + 4 + 1 + 4 + 1 + 1 + 4 + 1 + 4 + 1 + 4 + 2 + 1 + 1 + 1;
// id, type, weaponId, 6 f32 (pos+vel), ownerId, armed (round 15, PR #9, finding 2).
const PROJECTILE_BYTES = 2 + 1 + 1 + 4 * 6 + 2 + 1;
const FLAG_BYTES = 1 + 1 + 1 + 4 * 3 + 2 + 4; // id, team, state, 3 f32 (pos), carrierId i16, returnInS f32
const BASE_OBJECT_BYTES = 2 + 4 + 1 + 1; // id, damage f32, destroyed, powered
const TURRET_BYTES = 2 + 4 + 1 + 1 + 2 + 1; // id, damage f32, destroyed, powered, targetId i16, state
const DELTA_FLAG = 1;
const DIRTY_TRANSFORM = 1;
const DIRTY_ENERGY = 2;
const DIRTY_STATUS = 4;
const DIRTY_TEAM = 8;
const DIRTY_HEALTH = 16;
const DIRTY_WEAPON = 32;
const DIRTY_RESPAWN = 64;
// The last bit available in the dirty-mask byte. Round 10 put the four ammo/grenade fields
// here, since there is no room left for each to claim its own bit -- consistent with
// DIRTY_TRANSFORM already batching seven fields under one bit. Round 11 (PR #9, finding 2)
// folds weaponState/weaponTimer/spunUp into the SAME bit rather than growing the mask to a
// Uint16: ammo and the weapon state machine are already the same reconciliation concern
// (both exist purely to correct client-side prediction drift from a lost or evicted fire
// input), they change together on nearly every shot, and a weapon actively firing/reloading
// touches weaponTimer virtually every tick regardless -- splitting them into a second bit
// would rarely save a byte and would cost a full mask-width bump to get. Renamed from
// DIRTY_AMMO to reflect the broader "prediction-correcting state changed" meaning. Round 12
// (PR #9, finding 1) folds grenadeCooldown in here too, for the identical reason: it is the
// grenade throw's own reconciled-prediction timer, changes in lockstep with the grenades
// count already under this bit, and gains nothing from a bit of its own. Round 14 (PR #9,
// finding 1) folds score and godMode in here too: both are reconciliation-adjacent
// authoritative corrections (godMode backs netclient.ts's networked god-mode fix, finding
// 2 of the same round) that change rarely and gain nothing from a bit of their own.
const DIRTY_PREDICTION = 128;
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

// Bit 2 (wasJumpHeld) added round 15 (PR #9), finding 1: a single boolean, so it packs into
// this existing status byte the same way onGround/ski already do, rather than claiming a
// whole new wire byte for one bit -- see PlayerSnapshotData.wasJumpHeld's doc comment
// (sim/snapshot.ts) for the misprediction this closes.
function statusByte(data: PlayerSnapshotData): number {
  return (data.onGround ? 1 : 0) | (data.ski ? 2 : 0) | (data.wasJumpHeld ? 4 : 0);
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
  writeU8(cursor, data.discAmmo);
  writeU8(cursor, data.chaingunAmmo);
  writeU8(cursor, data.mortarAmmo);
  writeU8(cursor, data.grenades);
  writeU8(cursor, data.weaponState);
  writeF32(cursor, data.weaponTimer);
  writeU8(cursor, data.spunUp);
  writeF32(cursor, data.grenadeCooldown);
  writeI16(cursor, data.score);
  writeU8(cursor, data.godMode);
  writeU8(cursor, data.armor);
  writeU8(cursor, data.hasRepairPack);
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
  const discAmmo = readU8(cursor);
  const chaingunAmmo = readU8(cursor);
  const mortarAmmo = readU8(cursor);
  const grenades = readU8(cursor);
  const weaponState = readU8(cursor);
  const weaponTimer = readF32(cursor);
  const spunUp = readU8(cursor) ? 1 : 0;
  const grenadeCooldown = readF32(cursor);
  const score = readI16(cursor);
  const godMode = readU8(cursor) ? 1 : 0;
  const armor = readU8(cursor);
  const hasRepairPack = readU8(cursor) ? 1 : 0;
  assertFinite([x, y, z, vx, vy, vz, yaw, energy, health, weaponTimer, grenadeCooldown]);
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
    wasJumpHeld: flags & 4 ? 1 : 0,
    health,
    weaponSlot,
    respawnSeq,
    discAmmo,
    chaingunAmmo,
    mortarAmmo,
    grenades,
    weaponState,
    weaponTimer,
    spunUp,
    grenadeCooldown,
    score,
    godMode,
    armor,
    hasRepairPack,
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
  writeU8(cursor, p.armed);
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
  const armed = readU8(cursor) ? 1 : 0;
  assertFinite([x, y, z, vx, vy, vz]);
  return { id, type, weaponId, x, y, z, vx, vy, vz, ownerId, armed };
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

function writeBaseObject(cursor: Cursor, o: BaseObjectSnapshotData): void {
  writeU16(cursor, o.id);
  writeF32(cursor, o.damage);
  writeU8(cursor, o.destroyed);
  writeU8(cursor, o.powered);
}
function readBaseObject(cursor: Cursor): BaseObjectSnapshotData {
  const id = readU16(cursor);
  const damage = readF32(cursor);
  assertFinite([damage]);
  const destroyed = (readU8(cursor) ? 1 : 0) as 0 | 1;
  const powered = (readU8(cursor) ? 1 : 0) as 0 | 1;
  return { id, damage, destroyed, powered };
}
function writeTurret(cursor: Cursor, t: TurretSnapshotData): void {
  writeU16(cursor, t.id);
  writeF32(cursor, t.damage);
  writeU8(cursor, t.destroyed);
  writeU8(cursor, t.powered);
  writeI16(cursor, t.targetId);
  writeU8(cursor, t.state);
}
function readTurret(cursor: Cursor): TurretSnapshotData {
  const id = readU16(cursor);
  const damage = readF32(cursor);
  assertFinite([damage]);
  const destroyed = (readU8(cursor) ? 1 : 0) as 0 | 1;
  const powered = (readU8(cursor) ? 1 : 0) as 0 | 1;
  const targetId = readI16(cursor);
  const state = readU8(cursor);
  return { id, damage, destroyed, powered, targetId, state };
}

function writeExtras(cursor: Cursor, extras: WorldExtras): void {
  writeU16(cursor, extras.projectiles.length);
  for (const p of extras.projectiles) writeProjectile(cursor, p);
  writeU8(cursor, extras.flags.length);
  for (const f of extras.flags) writeFlag(cursor, f);
  writeU8(cursor, extras.baseObjects.length);
  for (const o of extras.baseObjects) writeBaseObject(cursor, o);
  writeU8(cursor, extras.turrets.length);
  for (const t of extras.turrets) writeTurret(cursor, t);
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
  const baseObjectCount = readU8(cursor);
  assertPlausibleExtrasCount(baseObjectCount, MAX_SNAPSHOT_BASE_OBJECTS, 'baseObject');
  const baseObjects: BaseObjectSnapshotData[] = [];
  for (let i = 0; i < baseObjectCount; i += 1) baseObjects.push(readBaseObject(cursor));
  const turretCount = readU8(cursor);
  assertPlausibleExtrasCount(turretCount, MAX_SNAPSHOT_TURRETS, 'turret');
  const turrets: TurretSnapshotData[] = [];
  for (let i = 0; i < turretCount; i += 1) turrets.push(readTurret(cursor));
  const teamScores: [number, number] = [readU16(cursor), readU16(cursor)];
  const gameOver = readU8(cursor) !== 0;
  const winnerTeam = readU8(cursor);
  const timeRemainingS = readF32(cursor);
  const gameOverReason = readU8(cursor);
  assertFinite([timeRemainingS]);
  return {
    projectiles,
    flags,
    baseObjects,
    turrets,
    teamScores,
    gameOver,
    winnerTeam,
    timeRemainingS,
    gameOverReason,
  };
}
function extrasByteLength(extras: WorldExtras): number {
  return (
    2 +
    extras.projectiles.length * PROJECTILE_BYTES +
    1 +
    extras.flags.length * FLAG_BYTES +
    1 +
    extras.baseObjects.length * BASE_OBJECT_BYTES +
    1 +
    extras.turrets.length * TURRET_BYTES +
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
  return a.onGround !== b.onGround || a.ski !== b.ski || a.wasJumpHeld !== b.wasJumpHeld;
}
// Codex round 1, finding 2: armor/hasRepairPack folded into the same bit team already used
// (renamed from teamChanged) rather than claiming one of their own -- every mask bit is
// already spoken for (see DIRTY_PREDICTION's own comment on the same constraint), and a
// loadout change is, like a team change, a coarse, infrequent event: it fires once per
// station visit, not every tick the way transform/energy do. Exact equality for both, like
// respawnSeqChanged/ammoChanged above: armor is a small integer id and hasRepairPack a 0/1
// flag, neither a float that needs EPSILON tolerance.
function identityChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return a.team !== b.team || a.armor !== b.armor || a.hasRepairPack !== b.hasRepairPack;
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
// Exact equality, like respawnSeqChanged above: these are integer ammo counts, not floats,
// so any difference at all is a real change worth sending.
function ammoChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return (
    a.discAmmo !== b.discAmmo ||
    a.chaingunAmmo !== b.chaingunAmmo ||
    a.mortarAmmo !== b.mortarAmmo ||
    a.grenades !== b.grenades
  );
}
// weaponState/spunUp are small integers (exact equality, like ammo above); weaponTimer and
// grenadeCooldown are floats counting down every tick their respective timer is running, so
// both use the same EPSILON tolerance transformChanged does rather than exact equality.
// grenadeCooldown added round 12 (PR #9), finding 1: the grenade throw's own cooldown timer,
// a sibling to weaponTimer that round 11 missed.
function weaponMachineChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return (
    a.weaponState !== b.weaponState ||
    Math.abs(a.weaponTimer - b.weaponTimer) > EPSILON ||
    a.spunUp !== b.spunUp ||
    Math.abs(a.grenadeCooldown - b.grenadeCooldown) > EPSILON
  );
}
// Exact equality, like respawnSeqChanged/ammoChanged above: score is an integer counter and
// godMode a 0/1 flag, neither a float that needs EPSILON tolerance.
function scoreOrGodModeChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return a.score !== b.score || a.godMode !== b.godMode;
}
// Everything DIRTY_PREDICTION covers, folded into one check -- see that constant's comment
// for why ammo, the weapon state machine, and score/godMode all share it. Pulled out of
// dirtyMask itself to keep that function's branch count under the complexity lint's cap.
function predictionChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return ammoChanged(a, b) || weaponMachineChanged(a, b) || scoreOrGodModeChanged(a, b);
}
function dirtyMask(current: PlayerSnapshotData, previous: PlayerSnapshotData): number {
  let mask = 0;
  if (transformChanged(current, previous)) mask |= DIRTY_TRANSFORM;
  if (energyChanged(current, previous)) mask |= DIRTY_ENERGY;
  if (statusChanged(current, previous)) mask |= DIRTY_STATUS;
  if (identityChanged(current, previous)) mask |= DIRTY_TEAM;
  if (healthChanged(current, previous)) mask |= DIRTY_HEALTH;
  if (weaponChanged(current, previous)) mask |= DIRTY_WEAPON;
  if (respawnSeqChanged(current, previous)) mask |= DIRTY_RESPAWN;
  if (predictionChanged(current, previous)) mask |= DIRTY_PREDICTION;
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
  if (mask & DIRTY_TEAM) bytes += 3; // team(1) + armor(1) + hasRepairPack(1) -- see identityChanged.
  if (mask & DIRTY_HEALTH) bytes += 4;
  if (mask & DIRTY_WEAPON) bytes += 1;
  if (mask & DIRTY_RESPAWN) bytes += 1;
  // ammo(4) + weaponState(1) + weaponTimer(4) + spunUp(1) + grenadeCooldown(4) + score(2)
  // + godMode(1)
  if (mask & DIRTY_PREDICTION) bytes += 4 + 1 + 4 + 1 + 4 + 2 + 1;
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
function writeChangedAmmo(cursor: Cursor, data: PlayerSnapshotData): void {
  writeU8(cursor, data.discAmmo);
  writeU8(cursor, data.chaingunAmmo);
  writeU8(cursor, data.mortarAmmo);
  writeU8(cursor, data.grenades);
}
function writeChangedWeaponMachine(cursor: Cursor, data: PlayerSnapshotData): void {
  writeU8(cursor, data.weaponState);
  writeF32(cursor, data.weaponTimer);
  writeU8(cursor, data.spunUp);
  writeF32(cursor, data.grenadeCooldown);
}
function writeChangedScoreGodMode(cursor: Cursor, data: PlayerSnapshotData): void {
  writeI16(cursor, data.score);
  writeU8(cursor, data.godMode);
}
function writeChangedPlayer(cursor: Cursor, data: PlayerSnapshotData, mask: number): void {
  writeU16(cursor, data.id);
  writeU8(cursor, mask);
  if (mask & DIRTY_TRANSFORM) writeChangedTransform(cursor, data);
  if (mask & DIRTY_ENERGY) writeF32(cursor, data.energy);
  if (mask & DIRTY_STATUS) writeU8(cursor, statusByte(data));
  if (mask & DIRTY_TEAM) {
    writeU8(cursor, data.team);
    writeU8(cursor, data.armor);
    writeU8(cursor, data.hasRepairPack);
  }
  if (mask & DIRTY_HEALTH) writeF32(cursor, data.health);
  if (mask & DIRTY_WEAPON) writeU8(cursor, data.weaponSlot);
  if (mask & DIRTY_RESPAWN) writeU8(cursor, data.respawnSeq);
  if (mask & DIRTY_PREDICTION) {
    writeChangedAmmo(cursor, data);
    writeChangedWeaponMachine(cursor, data);
    writeChangedScoreGodMode(cursor, data);
  }
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
  next.wasJumpHeld = flags & 4 ? 1 : 0;
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
function readChangedAmmo(cursor: Cursor, next: PlayerSnapshotData): void {
  next.discAmmo = readU8(cursor);
  next.chaingunAmmo = readU8(cursor);
  next.mortarAmmo = readU8(cursor);
  next.grenades = readU8(cursor);
}
function readChangedWeaponMachine(cursor: Cursor, next: PlayerSnapshotData): void {
  const weaponState = readU8(cursor);
  const weaponTimer = readF32(cursor);
  next.weaponState = weaponState;
  next.weaponTimer = weaponTimer;
  next.spunUp = readU8(cursor) ? 1 : 0;
  const grenadeCooldown = readF32(cursor);
  assertFinite([weaponTimer, grenadeCooldown]);
  next.grenadeCooldown = grenadeCooldown;
}
function readChangedScoreGodMode(cursor: Cursor, next: PlayerSnapshotData): void {
  next.score = readI16(cursor);
  next.godMode = readU8(cursor) ? 1 : 0;
}
// Split out like readChangedAmmo/readChangedWeaponMachine above, not inlined into
// applyChangedPlayer's own DIRTY_TEAM branch -- the hasRepairPack ternary alone pushed that
// function's cyclomatic complexity from 10 (already at budget) to 11.
function readChangedIdentity(cursor: Cursor, next: PlayerSnapshotData): void {
  next.team = readU8(cursor);
  next.armor = readU8(cursor);
  next.hasRepairPack = readU8(cursor) ? 1 : 0;
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
  if (mask & DIRTY_TEAM) readChangedIdentity(cursor, next);
  if (mask & DIRTY_HEALTH) readChangedHealth(cursor, next);
  if (mask & DIRTY_WEAPON) next.weaponSlot = readU8(cursor);
  if (mask & DIRTY_RESPAWN) next.respawnSeq = readU8(cursor);
  if (mask & DIRTY_PREDICTION) {
    readChangedAmmo(cursor, next);
    readChangedWeaponMachine(cursor, next);
    readChangedScoreGodMode(cursor, next);
  }
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
