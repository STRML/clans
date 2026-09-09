import type { PlayerInput } from '@clans/sim';

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
export const PROTOCOL_VERSION = 8;

export enum WelcomeStatus {
  Ok = 0,
  VersionMismatch = 1,
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
}
export interface BeamSegment {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}
export interface EventMessage {
  type: MessageType.Event;
  kind: EventKind;
  a: number;
  b: number;
  /** Authoritative laser endpoints, including terrain hits and misses. */
  beam?: BeamSegment;
}
export interface GodMessage {
  type: MessageType.God;
  enabled: boolean;
}
export interface LoadoutMessage {
  type: MessageType.Loadout;
  armor: number; // ArmorId from @clans/sim
  repairPack: boolean;
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
// headroom; capped at 255 (not 256) because the wire count is a single unchecked-write u8 --
// see snapshot.ts's writeExtras for why 255 is the real ceiling, not just a round number.
export const MAX_SNAPSHOT_BOTS = 32; // Ours -- TARGET_TEAM_SIZE * 2 (M6's own "ours" numbers table).
export const MAX_SNAPSHOT_ORDERS = 2; // Ours -- one active order per team, no queue.
export const VOICE_LINE_COUNT = 9; // Ours -- see M7 plan's "ours" numbers table.
