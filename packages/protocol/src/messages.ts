import type { PlayerInput, ProjectileImpact } from '@clans/sim';

export enum MessageType {
  Join = 1,
  Welcome = 2,
  Input = 3,
  Snapshot = 4,
  Ack = 5,
  Event = 6,
  God = 7,
  Loadout = 8,
  VehicleSpawn = 9,
  CommandOrder = 10,
  VoiceBind = 11,
}

/** Attack/Defend/Repair -- a commander's order to their own team's bots. */
export enum OrderKind {
  Attack = 0,
  Defend = 1,
  Repair = 2,
}

// M5 bumps 2 -> 3: a new MessageType (VehicleSpawn), a new PlayerInput flag bit (`use`), and
// a new WorldExtras field (vehicles) are all wire-format changes an M4 client cannot safely
// ignore -- WelcomeStatus.VersionMismatch exists specifically to reject a stale client rather
// than let it desync.
//
// M7 bumps 3 -> 4 (Codex review round 1 of the M7 PR): two new MessageTypes (CommandOrder,
// VoiceBind) and a new trailing WorldExtras field (orders, snapshot.ts) are wire-format
// changes too. Appending `orders` after every other field (not a PROTOCOL_VERSION bump) was
// this milestone's own original plan, reasoned only about a stale M6 CLIENT reading a fresh
// M7 SERVER's snapshot (it just stops decoding early, which is safe) -- it missed the
// opposite direction: a fresh M7 client connecting to a stale M6 server sends the same
// PROTOCOL_VERSION either way, so the handshake never catches it, and the client's own
// `readOrders` call then reads past the end of a snapshot that was never written with an
// orders block, throwing on every single snapshot. Bumping the version instead makes
// WelcomeStatus.VersionMismatch catch this exactly like it already catches every other
// wire-format change, in both directions.
// M7's flag-audio events add new EventKind values. Event payloads are still six bytes, but a
// stale client would not know how to interpret the new kinds, so reject mixed versions.
//
// #14/#24/#15 bump 8 -> 9: three wire-format changes an 8.x peer cannot decode correctly.
// BaseObjectSnapshotData/TurretSnapshotData gain a trailing energy f32 and TurretSnapshotData
// a trailing targetKind u8 (#14/#24) -- an old decoder stops reading a turret/base-object
// record five/four bytes early and misaligns every later array; and ProjectileSnapshotData's
// ownerId changed u16 -> i16 (#15) so the turret-shot "no owner" -1 sentinel survives the
// wire instead of decoding as a phantom player 65535. Same frame size (PROJECTILE_BYTES is
// unchanged), different meaning. WelcomeStatus.VersionMismatch catches all of this in both
// directions, exactly as the M7 bump below already reasoned.
//
// #52 bump 9 -> 10: a new EventKind (ProjectileImpact) whose Event frame grows an optional
// 19-byte impact payload (contact position, weaponId, projectile type, reason, sim sequence).
// A 9.x peer's decodeEvent only accepts 6- and 30-byte event frames, so it would throw on the
// new length on every impact; the handshake check must reject the mismatch in both directions
// exactly like every bump before it.
//
// #55 bump 10 -> 11: the Loadout message grows from 3 to 4 bytes. The Repair Pack boolean
// byte becomes a PackId (None/Repair/Energy, sim/baseObjects.ts) and a new trailing u8
// carries the carried-weapons bitmask -- a full T2 station loadout, not just armor + Repair
// Pack. A 10.x peer's decodeLoadout reads the pack byte as a Repair Pack boolean (Energy
// would silently decode as "Repair Pack") and never reads the weapons byte at all, so the
// handshake check must reject the mismatch in both directions exactly like every bump
// before it.
export const PROTOCOL_VERSION = 11;

export enum WelcomeStatus {
  Ok = 0,
  VersionMismatch = 1,
  /** Issue #31: join refused -- no team under the server's per-team seat cap can take
   *  another human, so the client must pick the alternate team or wait. That cap is the
   *  server's own `--team-size` (TARGET_TEAM_SIZE, the spec's 16 versus 16, by default;
   *  raised for a larger match), never a wire constant -- a refusal is a refusal at any
   *  cap. Byte-compatible addition: every client already treats any non-Ok status as a
   *  refusal, so no protocol version bump. */
  TeamFull = 2,
}

/** The wire shape of one tick's input is identical to the sim's own PlayerInput. */
export type NetInputSample = PlayerInput;

export interface JoinMessage {
  type: MessageType.Join;
  version: number;
}
export interface WelcomeMessage {
  type: MessageType.Welcome;
  playerId: number;
  team: number;
  tickMs: number;
  status: WelcomeStatus;
  /**
   * The mission spawn point the server placed this player at. M2 added this so the
   * client's local prediction world has a real fall-back spawn instead of the map origin
   * before its first snapshot arrives. `status` is new in M3; `spawnX`/`spawnY`/`spawnZ`
   * are unchanged from M2 and must not be dropped.
   */
  spawnX: number;
  spawnY: number;
  spawnZ: number;
}
export interface InputMessage {
  type: MessageType.Input;
  sequence: number;
  samples: [NetInputSample, NetInputSample, NetInputSample];
}
export interface AckMessage {
  type: MessageType.Ack;
  snapshotId: number;
}

export enum EventKind {
  PlayerKilled = 0, // a = attackerId (-1 = environment), b = victimId
  FlagTouched = 1, // a = playerId, b = flagId
  FlagCaptured = 2, // a = team, b = playerId
  LaserFired = 3, // a = shooterId, b = hitPlayerId (-1 = miss)
  VoiceBindPlayed = 4, // a = playerId, b = lineId
  FlagDropped = 5, // a = previous carrierId, b = flagId
  FlagReturned = 6, // a = playerId (-1 = timer), b = flagId
  /** #52: one authoritative projectile impact. `a` mirrors the record's ProjectileImpactReason
   *  (b is an unused -1 sentinel); the full record -- contact position, weaponId, projectile
   *  type, reason, and the sim's monotonic sequence number -- rides the optional `impact`
   *  payload below, so a consumer dedupes on the record's own seq rather than on this event's
   *  receipt order. */
  ProjectileImpact = 7,
}
export interface BeamSegment {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}
export interface EventMessage {
  type: MessageType.Event;
  kind: EventKind;
  a: number;
  /** Second event operand, still on the wire for every kind that has one (VoiceBindPlayed's
   *  line id, FlagDropped's flag id, FlagReturned's flag id, PlayerKilled's killer id) and for
   *  LaserFired's beam target, which is -1 for a miss. #52's ProjectileImpact events carry
   *  -1 here: the authoritative impact record rides the optional `impact` payload below. */
  b: number;
  /** Authoritative laser endpoints, including terrain hits and misses. */
  beam?: BeamSegment;
  /**
   * #52: the authoritative projectile impact this Event carries, present only for
   * EventKind.ProjectileImpact. Reuses @clans/sim's own ProjectileImpact shape (the same way
   * WorldExtras reuses the sim's snapshot types) so the sim-side emitter and the wire cannot
   * drift. Optional so every pre-existing EventMessage literal keeps compiling; encodeEvent
   * writes it and decodeEvent always populates it when the frame length says it is there.
   */
  impact?: ProjectileImpact;
}
export interface GodMessage {
  type: MessageType.God;
  enabled: boolean;
}
export interface LoadoutMessage {
  type: MessageType.Loadout;
  armor: number; // ArmorId from @clans/sim
  /** PackId from @clans/sim (baseObjects.ts): None = 0, Repair = 1, Energy = 2. Grew out of
   *  the pre-#55 `repairPack: boolean` byte, which was the only pack the wire could name. */
  pack: number;
  /** Bitmask of carried weapons: bit (1 << WeaponId) set = that weapon is part of the
   *  station loadout. Only the five WeaponId bits (0x1F) are defined; decodeLoadout masks
   *  the raw u8 so an out-of-range bit can never reach the sim. 0 = "armor defaults", the
   *  same full loadout a pre-#55 client got. */
  weapons: number;
}
export interface VehicleSpawnMessage {
  type: MessageType.VehicleSpawn;
  padId: number;
  kind: number; // VehicleKind from @clans/sim, kept as a raw number the same way other wire enums are
}
export interface CommandOrderMessage {
  type: MessageType.CommandOrder;
  kind: OrderKind;
  x: number;
  z: number;
}
export interface VoiceBindMessage {
  type: MessageType.VoiceBind;
  lineId: number;
}

/**
 * A team's currently active commander order, TTL-expired. Lives in `@clans/server`'s
 * `OrderBoard` (never in `World`/`hashWorld`, matching M6's `BotManager` runtime-memory
 * convention) but the *shape* is declared here, in protocol, so `@clans/bots` -- which
 * depends only on `@clans/sim` today, never on `@clans/server` (that dependency runs the
 * other way) -- can consume it without a circular package dependency. `@clans/server`'s
 * `orders.ts` imports this type rather than redeclaring it.
 */
export interface TeamOrder {
  team: number;
  kind: OrderKind;
  x: number;
  z: number;
  expiresAtTick: number;
}

export const SNAPSHOT_EVERY_N_TICKS = 2;
export const SNAPSHOT_FALLBACK_MS = 1000;
/**
 * How many recently sent (server side) or received (client side) snapshots each side
 * keeps around. The server only ever deltas against a client's last ACKED snapshot,
 * which can trail the newest one by several sends while an ACK is in flight or lost;
 * both sides need to agree on how far that trail can run so the client still holds
 * the matching baseline when a delta names it.
 */
export const SNAPSHOT_HISTORY_DEPTH = 8;
/**
 * A count field in the snapshot codec (player count, added/changed/removed counts) is a
 * raw wire u16 and would otherwise accept up to 65535 with no relation to how many
 * players can actually exist. World capacity is 64 today; this stays generous above any
 * milestone's planned roster (up to 32 v 32) so it never has to move for real growth,
 * while still rejecting a count that could only come from a corrupted or adversarial
 * packet, which would otherwise allocate tens of thousands of players and meshes.
 */
export const MAX_SNAPSHOT_PLAYERS = 256;
// Matches packages/sim's PROJECTILE_CAPACITY: the sim never produces more than this many active
// projectiles, so any wire value above it is corrupt or hostile, not just unusually busy.
export const MAX_SNAPSHOT_PROJECTILES = 256;
// Two flags in this milestone's CTF map. A little headroom in case a future map adds more.
export const MAX_SNAPSHOT_FLAGS = 8;
export const MAX_SNAPSHOT_BASE_OBJECTS = 64; // Matches @clans/sim's BASE_OBJECT_CAPACITY.
export const MAX_SNAPSHOT_TURRETS = 16; // Matches @clans/sim's TURRET_CAPACITY.
export const MAX_SNAPSHOT_VEHICLES = 255; // Matches @clans/sim's VehicleStore capacity (8) with
// headroom; capped at 255 (not 256) because the wire count is a single u8 -- since the #16
// fix every u8 extras count (vehicles here, flags/baseObjects/turrets at their own tighter
// MAX ceilings above) is guard-thrown at write time instead of silently wrapping, so 255
// stays the real ceiling, not just a round number. See snapshot.ts's writeExtras.
// One entry per currently-active bot in WorldExtras.bots (buildExtras filters runtimes by
// players.active, so the array can never outnumber active players), so the honest bound is
// the roster capacity, not any one milestone's match size: WORLD_CAPACITY is 64 seats (32 v
// 32), which covers the 24 v 24 target's 48 bots with 16 seats of headroom. The wire count
// is a single u8 (writeU8Counted in snapshot.ts writes it, readExtras reads it back with
// readU8), so raising this is a validation change only -- the bytes and PROTOCOL_VERSION are
// unchanged. It stays at the roster capacity rather than at the u8 maximum so the decode
// guard keeps real rejection power: a bound of 255 would accept any count the field can
// carry (a 200-bot count is impossible in a 64-seat world), and a bound of 256 would let the
// write side encode a 256-entry array as a wrapped 0 count and silently drop the block.
export const MAX_SNAPSHOT_BOTS = 64;
export const MAX_SNAPSHOT_ORDERS = 2; // Ours -- one active order per team, no queue.
export const VOICE_LINE_COUNT = 9; // Ours -- see M7 plan's "ours" numbers table.
