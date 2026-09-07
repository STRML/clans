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
  /** Repair Pack beam held down. Level-triggered, like `fire`. */
  packActive: boolean;
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
  /** 1 while the player is invulnerable (server admin toggle). Checked at the top of
   *  applyDamage, before any damage/death/score/flag-drop side effect can happen -- see
   *  that function's comment for why this has to live in the sim rather than be zeroed
   *  reactively after the fact by the server. */
  godMode: Uint8Array;
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
  /** Increments by 1 every time this player id respawns (damage.ts's respawnPlayer is the
   *  only writer). A wire-authoritative "a respawn just happened" signal: health/alive
   *  alone cannot tell a full-health-to-full-health respawn apart from "nothing happened"
   *  when the dead tick's snapshot never reaches the client (dropped, coalesced, or just
   *  not sent that cadence) and both the last-seen and the new snapshot report the same
   *  full health -- neither signal moves, so no heuristic over those two fields alone can
   *  close it (Codex review round 8, PR #9). Uint16 in the sim itself: a whole 25-minute
   *  match's worth of respawns for one id never gets remotely close to wrapping. The wire
   *  format (protocol/snapshot.ts) truncates it to a single byte -- see that file for why
   *  the narrower width is still safe. Reset to 0 by addPlayer on every join, including a
   *  reused id; never reset by anything else. */
  respawnSeq: Uint16Array;
  /** ArmorId (armor.ts). Set by addPlayer/respawnPlayer/a station loadout change; every
   *  system that used to hardcode LIGHT_ARMOR reads this through armor.ts's armorFor(world,
   *  id) instead -- see the M4 plan's Global Constraints. */
  armor: Uint8Array; // ArmorId
  /** 0/1. Set by a Loadout request (Task 6); the only pack modeled this milestone. */
  hasRepairPack: Uint8Array;
}
/** One id freed by `free()`, held out of `freeIds` until it has sat unallocated for at
 *  least PROJECTILE_ID_REUSE_DELAY_TICKS calls to `stepProjectiles` -- see that constant
 *  and ProjectileStore.pendingFreeIds for why. `ticksRemaining` counts down by one on every
 *  `stepProjectiles` call (the same self-contained, world.tick-independent convention
 *  `expiresAtTick` already uses, for the same reason: this file's own tests call
 *  `stepProjectiles` directly, without ever advancing `world.tick`). */
export interface PendingFreeId {
  id: number;
  ticksRemaining: number;
}
export interface ProjectileStore {
  count: number;
  freeIds: number[];
  /** Ids freed recently, held back from `freeIds` until they've sat unallocated for at least
   *  PROJECTILE_ID_REUSE_DELAY_TICKS `stepProjectiles` calls -- mirrors World.pendingAmmoRefunds's
   *  cross-tick-boundary pattern. Without this, a projectile freed earlier in a
   *  `stepProjectiles` call (a hit or expiry) could have its id popped straight back off
   *  `freeIds` and reallocated to a DIFFERENT weapon fired later in that SAME call, so no
   *  snapshot ever showed the id absent -- the client's disappearance-based cleanup
   *  (weapons-view.ts) relies on that gap to tell "still the same projectile" apart from "a
   *  new one reused the old id" (Codex review round 7, finding 5).
   *
   *  A flat one-tick defer (this array's original shape: `number[]`, unconditionally flushed
   *  into `freeIds` at the start of the very next call) is NOT enough on its own: the server
   *  only broadcasts a snapshot every SNAPSHOT_EVERY_N_TICKS (packages/protocol/src/messages.ts,
   *  = 2 as of Codex review round 8) simulation ticks, so a one-tick defer doesn't guarantee any
   *  snapshot actually lands in the gap -- an id freed and reallocated within the same
   *  multi-tick snapshot window could still go out never having been observed absent,
   *  reintroducing the exact expiry-flash-suppression bug round 7 closed (Codex review round 8,
   *  finding 1). Each entry now tracks its own countdown instead of being flushed unconditionally. */
  pendingFreeIds: PendingFreeId[];
  active: Uint8Array;
  type: Uint8Array;
  weaponId: Uint8Array;
  ownerId: Int16Array;
  /** The shooter's team at spawn time (or a turret's own team for a turret-fired shot, which
   *  has no ownerId to look one up through). Read once here rather than looked up through
   *  ownerId on every later hit test — see baseObjects.ts's activeForceFieldBlockers, which
   *  every hit-test call site in projectiles.ts consults with this field. */
  team: Uint8Array;
  /** -1 for a player-fired shot; the firing turret's own id for a turret-fired one. A turret
   *  shot spawns at its own turret's exact position, which sits inside that same turret's own
   *  TURRET_HIT_RADIUS hit-sphere — without this, the shot's very first hit-test would
   *  register an immediate self-hit at distance 0 (`raySphereDistance`'s "origin already
   *  inside the sphere" case) and detonate against the turret that just fired it, never
   *  reaching its actual target. Mirrors how a player-fired shot already excludes its own
   *  shooter via `ownerId`/`isValidTarget` — see `nearestStructureHitFrom`. */
  sourceTurretId: Int16Array;
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
  interiors: import('./interiors.js').InteriorInstance[];
  baseObjects: import('./baseObjects.js').BaseObjectStore;
  forceFields: import('./baseObjects.js').ForceFieldGeometry[];
  turrets: import('./turrets.js').TurretStore;
  pendingTurretFireEvents: import('./turrets.js').TurretFireEvent[];
  players: PlayerStore;
  projectiles: ProjectileStore;
  pendingDeaths: Array<{ id: number; attackerId: number }>;
  pendingFireEvents: import('./weapons.js').FireEvent[];
  /** This tick's fire events, set by stepProjectiles right where it drains
   *  pendingFireEvents, but -- unlike pendingFireEvents -- not cleared again within that
   *  same call. It survives stepFlags and stepWorld's return, so server/net.ts can build a
   *  LaserFired broadcast from it after stepWorld already returned; the next tick's
   *  stepProjectiles call overwrites it with that tick's events (or an empty array if none
   *  fired), the same way pendingDeaths gets cleared by the next tick's stepPlayers. */
  lastFireEvents: import('./weapons.js').FireEvent[];
  /** Shots/throws that spent ammo but found the projectile store full, recorded by
   *  projectiles.ts's spawnStored. Read and cleared by stepWeapons at the start of its own
   *  next call, which credits back the spent ammo or grenade -- see weapons.ts's
   *  AmmoRefund and applyPendingAmmoRefunds. */
  pendingAmmoRefunds: import('./weapons.js').AmmoRefund[];
  flags: FlagStore;
  teamScores: Uint16Array;
  gameOver: boolean;
  winnerTeam: number;
  timeLimitTicks: number;
  gameOverReason: import('./flags.js').GameOverReason;
}
