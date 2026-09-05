import type { PlayerInput } from '@clans/sim';

export enum MessageType {
  Join = 1,
  Welcome = 2,
  Input = 3,
  Snapshot = 4,
  Ack = 5,
}

/** The wire shape of one tick's input is identical to the sim's own PlayerInput. */
export type NetInputSample = PlayerInput;

export interface JoinMessage {
  type: MessageType.Join;
}
export interface WelcomeMessage {
  type: MessageType.Welcome;
  playerId: number;
  team: number;
  tickMs: number;
  /**
   * The mission spawn point the server placed this player at. Without it the client's
   * local prediction world has no spawn to fall back to and defaults to (0,0,0); a
   * client that mispredicts falling below the kill plane before its first snapshot
   * arrives then resets to the map origin instead of the real spawn, diverging from
   * the server until the next reconciliation papers over it.
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
