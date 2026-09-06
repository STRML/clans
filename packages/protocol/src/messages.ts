import type { PlayerInput } from '@clans/sim';

export enum MessageType {
  Join = 1,
  Welcome = 2,
  Input = 3,
  Snapshot = 4,
  Ack = 5,
  Event = 6,
  God = 7,
}

export const PROTOCOL_VERSION = 2; // M1/M2 carried no version field at all; this milestone starts at 2.

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
}
export interface EventMessage {
  type: MessageType.Event;
  kind: EventKind;
  a: number;
  b: number;
}
export interface GodMessage {
  type: MessageType.God;
  enabled: boolean;
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
