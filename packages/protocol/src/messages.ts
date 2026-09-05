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
