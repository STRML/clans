import type { RandomState } from './random.js';
import type { Heightfield } from './terrain.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface PlayerInput {
  moveX: number;
  moveZ: number;
  yaw: number;
  jump: boolean;
  jet: boolean;
}
export interface PlayerStore {
  count: number;
  position: Float64Array;
  /** Where each player entered the world; the fall-out reset returns them here. */
  spawn: Float64Array;
  velocity: Float64Array;
  yaw: Float64Array;
  energy: Float64Array;
  onGround: Uint8Array;
  ski: Uint8Array;
  wasGrounded: Uint8Array;
  wasJumpHeld: Uint8Array;
  landingSpeed: Float64Array;
}
export interface World {
  tick: number;
  random: RandomState;
  terrain: Heightfield;
  players: PlayerStore;
}
