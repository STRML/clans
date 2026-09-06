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
  pitch: number;
  jump: boolean;
  jet: boolean;
  fire: boolean;
  altFire: boolean;
  slot: number; // 0 = no change, 1..5 = select that weapon slot (see weaponIdForSlot)
}
export interface PlayerStore {
  count: number;
  freeIds: number[];
  active: Uint8Array;
  team: Uint8Array;
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
  damage: Float64Array;
  alive: Uint8Array;
  respawnAt: Float64Array;
  score: Int16Array;
  weaponSlot: Uint8Array;
  weaponState: Uint8Array;
  weaponTimer: Float64Array;
  spunUp: Uint8Array;
  grenadeCooldown: Float64Array;
  ammo: Int16Array;
  grenades: Uint8Array;
}
export interface ProjectileStore {
  count: number;
  freeIds: number[];
  active: Uint8Array;
  type: Uint8Array;
  weaponId: Uint8Array;
  ownerId: Int16Array;
  position: Float64Array;
  velocity: Float64Array;
  /** Ticks this projectile has been alive, counted by stepProjectiles itself rather than
   *  world.tick: stepProjectiles is called directly (not only via stepWorld) by its own
   *  tests, which never advance world.tick, so a self-contained per-projectile counter is
   *  the only thing that behaves the same under both call paths. */
  expiresAtTick: Float64Array;
  armed: Uint8Array;
}
export interface FlagStore {
  team: Uint8Array;
  state: Uint8Array;
  position: Float64Array;
  standPosition: Float64Array;
  carrierId: Int16Array;
  returnAt: Float64Array;
}
export interface World {
  tick: number;
  random: RandomState;
  terrain: Heightfield;
  /** Below this height a player has fallen out of the world and returns to spawn. */
  killY: number;
  players: PlayerStore;
  projectiles: ProjectileStore;
  pendingDeaths: Array<{ id: number; attackerId: number }>;
  pendingFireEvents: import('./weapons.js').FireEvent[];
  flags: FlagStore;
  teamScores: Uint16Array;
  gameOver: boolean;
  winnerTeam: number;
  timeLimitTicks: number;
  gameOverReason: import('./flags.js').GameOverReason;
}
