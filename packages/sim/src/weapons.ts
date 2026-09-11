import { armorFor, type ArmorData, type ArmorId } from './armor.js';
import { respawnPlayer as respawnHealth } from './damage.js';
import type { PlayerInput, Vec3, World } from './types.js';

export enum WeaponId {
  Spinfusor = 0,
  Chaingun = 1,
  Mortar = 2,
  LaserRifle = 3,
  Blaster = 4,
}
// A plain array, not Object.values(WeaponId): numeric enums also carry reverse-mapping
// string keys, which would type this loop as (WeaponId | string)[] for no reason.
const ALL_WEAPONS: readonly WeaponId[] = [
  WeaponId.Spinfusor,
  WeaponId.Chaingun,
  WeaponId.Mortar,
  WeaponId.LaserRifle,
  WeaponId.Blaster,
];
export const WEAPON_COUNT = 5;

export enum WeaponState {
  Activate = 0,
  Ready = 1,
  Firing = 2,
  Reload = 3,
  NoAmmo = 4,
  DryFire = 5,
  /** Chaingun's source-backed pre-fire spin-up; serialized like every other state. */
  SpinUp = 6,
}

export enum ProjectileType {
  Linear = 0,
  Tracer = 1,
  Grenade = 2,
  /** T2 EnergyProjectileData(EnergyBolt): a bouncing Blaster bolt. */
  Energy = 3,
  /** Shrike's tracer is visually distinct from the player-held Blaster bolt. */
  VehicleLaser = 4,
}

export interface WeaponData {
  id: WeaponId;
  projectile: ProjectileType | null; // null = hitscan (Laser Rifle)
  speed: number;
  velInherit: number;
  directDamage: number;
  radiusDamage: number;
  radius: number;
  kickback: number;
  fireTime: number;
  reloadTime: number;
  lifetime: number;
  activateTime: number;
  spinUpTime?: number;
  drag?: number;
  elasticity?: number;
  armTime?: number;
  maxRange?: number;
  headMultiplier?: number;
  energyPerShot?: number;
  minEnergy?: number;
}

const DRY_FIRE_SECONDS = 0.2; // Ours: a brief empty-click before the persistent NoAmmo state.
export const MUZZLE_HEIGHT = 1.6; // Ours: roughly chest height on Light's 2.3 m capsule.
const TIMER_EPSILON = 1e-9;

// Mirrors movement.ts's own IDLE: a player active in the world but missing from this
// tick's input map (a dropped packet, say) should be treated as holding no keys at all,
// not skipped outright -- see stepWeapons's own comment for why skipping instead froze
// every weapon timer solid.
const IDLE_INPUT: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  jet: false,
  fire: false,
  altFire: false,
  slot: 0,
  packActive: false,
  use: false,
};

// Source-derived weapon values, except where the playtest explicitly changes a cadence.
export const WEAPON_DATA: Record<WeaponId, WeaponData> = {
  [WeaponId.Spinfusor]: {
    id: WeaponId.Spinfusor,
    projectile: ProjectileType.Linear,
    speed: 90,
    velInherit: 0.5,
    directDamage: 0,
    radiusDamage: 0.5,
    radius: 7.5,
    kickback: 1750,
    fireTime: 1.25,
    reloadTime: 0.5,
    lifetime: 5,
    activateTime: 0,
  },
  [WeaponId.Chaingun]: {
    id: WeaponId.Chaingun,
    projectile: ProjectileType.Tracer,
    speed: 425,
    velInherit: 1.0,
    directDamage: 0.0825,
    radiusDamage: 0,
    radius: 0,
    kickback: 0,
    // T2's Fire state is 0.15 s. Playtest tuning requests 0.10 s while held.
    fireTime: 0.1,
    reloadTime: 0,
    lifetime: 3,
    activateTime: 0,
    spinUpTime: 0.5,
  },
  [WeaponId.Mortar]: {
    id: WeaponId.Mortar,
    projectile: ProjectileType.Grenade,
    speed: 63.7,
    velInherit: 0.5,
    directDamage: 0,
    radiusDamage: 1.0,
    radius: 20,
    kickback: 2500,
    fireTime: 0.8,
    reloadTime: 2.0,
    lifetime: 5,
    activateTime: 0,
    drag: 0.1,
    elasticity: 0.15,
    armTime: 2.0,
  },
  [WeaponId.LaserRifle]: {
    id: WeaponId.LaserRifle,
    projectile: null,
    speed: 0,
    velInherit: 0,
    directDamage: 0.4,
    radiusDamage: 0,
    radius: 0,
    kickback: 0,
    fireTime: 0.5,
    reloadTime: 0.5,
    lifetime: 0,
    activateTime: 0,
    maxRange: 1000,
    headMultiplier: 1.3,
    energyPerShot: 6,
    minEnergy: 6,
  },
  // EnergyProjectileData(EnergyBolt), weapons/blaster.cs:217-271.
  [WeaponId.Blaster]: {
    id: WeaponId.Blaster,
    projectile: ProjectileType.Energy,
    speed: 90,
    velInherit: 0.5,
    directDamage: 0.15,
    radiusDamage: 0,
    radius: 0,
    kickback: 0,
    fireTime: 0.3,
    // T2's Reload state has no timeout, therefore the Fire state's 0.3 s timeout is
    // the complete held-trigger cadence.
    reloadTime: 0,
    lifetime: 3,
    activateTime: 0,
    drag: 0.05,
    elasticity: 0.998,
    armTime: 0.5,
  },
};

// Hand grenade: the spec's grenade.cs row gives only "0.4 radius" damage. Every other field
// (radius, kickback, throw speed, arm delay, lifetime, cooldown) is ours; drag/elasticity
// reuse Mortar's GrenadeProjectile physics numbers since the spec ties both to the same base.
export const GRENADE_DATA = {
  radiusDamage: 0.4,
  radius: 10,
  kickback: 1000,
  speed: 25,
  armTime: 0.5,
  lifetime: 3,
  drag: 0.1,
  elasticity: 0.15,
  throwCooldown: 1.0,
};

export interface FireEvent {
  playerId: number;
  weaponId: WeaponId;
  isAltFire: boolean;
  origin: Vec3;
  direction: Vec3;
  shooterVelocity: Vec3;
  energyScale: number; // 1 for every weapon except the Laser Rifle
  /**
   * The authoritative hit-test's own result, filled in by projectiles.ts -- the SAME
   * code path already used to apply real damage -- at the point of resolution, NOT here at
   * fire time. Both fields start at their unresolved defaults (-1 / null) and only a weapon
   * that resolves synchronously within the SAME tick it fires (the Laser Rifle's hitscan,
   * and the Chaingun's Tracer, stepped immediately in spawnFromEvent) ever gets them
   * updated before world.lastFireEvents is read back out. A weapon that instead spawns a
   * traveling projectile resolved on a LATER tick (Spinfusor, Mortar, a thrown grenade)
   * leaves them at these defaults for the tick recorded in lastFireEvents -- by design, not
   * a bug; those don't need the same-tick broadcast-immediacy this exists for.
   *
   * hitPlayerId is -1 when that resolution found no player (a clean miss, or a terrain
   * hit) -- hitPoint stays null in that same case and is only ever set alongside a real
   * hitPlayerId, to the exact point of contact. This exists so server/net.ts's own separate
   * hit-test for the laser-beam broadcast (findLaserHit, which doesn't account for terrain
   * occlusion and can disagree with the damage the sim actually applied) can be replaced by
   * reading this already-authoritative result instead. Codex review round 3, finding 4.
   */
  hitPlayerId: number;
  hitPoint: Vec3 | null;
  /** Laser Rifle visual endpoint. Unlike hitPoint, this is also set on a world-only miss. */
  beamEnd?: Vec3;
  /**
   * The id of the projectile this event spawned in the projectile store (projectiles.ts's
   * spawnStored), or -1 for a shot that never got one -- a genuinely hitscan weapon (the
   * Laser Rifle, which has no projectile at all), or a store-full shot whose ammo was
   * refunded instead. Set at the same point spawnStored allocates the slot, so it's
   * available by the time this event reaches world.lastFireEvents.
   *
   * Exists so server/net.ts's applyLagCompensatedHits can free the exact tracer this event
   * spawned once a rewound recheck determines it would have hit: without a way to name that
   * projectile, a Chaingun shot corrected by lag comp keeps its still-flying Tracer object
   * alive and traveling, and that tracer can go on to score a second, independent hit on a
   * later tick's stepProjectiles pass -- one non-penetrating shot damaging two players
   * (Codex review round 5, finding 1).
   */
  projectileId: number;
  /**
   * True once this event's authoritative same-tick hit-test has actually run and produced
   * hitPlayerId/hitPoint -- resolveHitscan for the Laser Rifle, or the immediate
   * stepLinearOrTracer call for the Chaingun's Tracer (projectiles.ts). Defaults to false at
   * construction and stays false for anything that never resolves same-tick (Spinfusor,
   * Mortar, a thrown grenade) as well as for a Chaingun/Laser shot whose 256-slot projectile
   * store was full: spawnStored returns null, the ammo is scheduled for refund via
   * world.pendingAmmoRefunds, and the hit-test never runs at all.
   *
   * Exists because hitPlayerId alone can't tell a caller "this never resolved" apart from
   * "this resolved and found no one": both leave hitPlayerId at its -1 default. Without this
   * field, server/net.ts's applyLagCompensatedHits (round 3) treated a shot that never
   * actually fired into the world the same as a genuine live miss, and reran a
   * lag-compensated hit-test for it anyway -- letting a "shot" that structurally never
   * existed land real damage on top of its own ammo refund (Codex review round 4, finding
   * 3). A caller should only recheck an event where `resolved === true && hitPlayerId ===
   * -1`: a real miss worth rechecking, not a shot that was never resolved in the first
   * place.
   */
  resolved: boolean;
}

/**
 * Recorded by projectiles.ts's spawnStored when the 256-slot projectile store is full and a
 * shot can't be allocated, so the ammo it already spent optimistically (tryFireWeapon /
 * tryThrowGrenade decrement ammo before the store is consulted) doesn't just vanish. Carries
 * weaponId and isAltFire, not just the playerId, because crediting back a shot means crediting
 * the *specific* thing that was spent -- a weapon's ammo slot via ammoIndex, or the separate
 * grenade count for an alt-fire throw -- and there's no way to recover that from a bare id.
 */
export interface AmmoRefund {
  playerId: number;
  weaponId: WeaponId;
  isAltFire: boolean;
}

export function ammoIndex(id: number, weaponId: WeaponId): number {
  return id * WEAPON_COUNT + weaponId;
}

export function weaponIdForSlot(slot: number): WeaponId | null {
  return slot >= 1 && slot <= 5 ? ((slot - 1) as WeaponId) : null;
}

function fireDirection(yaw: number, pitch: number): Vec3 {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
}

function shooterVelocity(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.velocity[base] ?? 0,
    y: world.players.velocity[base + 1] ?? 0,
    z: world.players.velocity[base + 2] ?? 0,
  };
}

function shooterOrigin(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: (world.players.position[base + 1] ?? 0) + MUZZLE_HEIGHT,
    z: world.players.position[base + 2] ?? 0,
  };
}

function applySlot(world: World, id: number, input: PlayerInput): void {
  const requested = weaponIdForSlot(input.slot);
  if (requested === null || requested === world.players.weaponSlot[id]) return;
  world.players.weaponSlot[id] = requested;
  world.players.weaponState[id] = WeaponState.Ready;
  world.players.weaponTimer[id] = 0;
  world.players.spunUp[id] = 0;
}

/**
 * Applies one expired timer's transition and returns the timer value the *next* state
 * starts at (its full duration minus however far this tick overshot the expiry, so a
 * remainder never gets silently dropped). Reload can itself expire in the same tick it
 * starts (the Chaingun's reloadTime is 0), so the caller re-invokes this until a tick's
 * worth of overshoot stops producing a further transition, rather than relying on a
 * timer of exactly 0 to be revisited on some future tick that would never come (the
 * timer<=0 guard in advanceTimer would otherwise skip it forever).
 */
function transitionExpired(world: World, id: number, overshoot: number): number {
  const players = world.players;
  const state = players.weaponState[id];
  if (state === WeaponState.Firing) {
    const data = WEAPON_DATA[players.weaponSlot[id] as WeaponId];
    players.weaponState[id] = WeaponState.Reload;
    return data.reloadTime - overshoot;
  }
  if (state === WeaponState.Reload) {
    players.weaponState[id] = WeaponState.Ready;
    return 0;
  }
  if (state === WeaponState.DryFire) {
    players.weaponState[id] = WeaponState.NoAmmo;
    return 0;
  }
  return 0;
}

function advanceTimer(world: World, id: number, dt: number): void {
  const players = world.players;
  const timer = players.weaponTimer[id] ?? 0;
  if (timer <= 0) return;
  let remaining = timer - dt;
  while (remaining <= 0) {
    const before = players.weaponState[id];
    remaining = transitionExpired(world, id, -remaining);
    if (players.weaponState[id] === before) break; // nothing further to cascade into
  }
  players.weaponTimer[id] = Math.max(0, remaining);
}

function energyScaleFor(world: World, id: number, data: WeaponData): number | null {
  if (data.energyPerShot === undefined) return 1;
  const energy = world.players.energy[id] ?? 0;
  if (energy < (data.minEnergy ?? 0)) return null;
  const scale = Math.min(1, energy / armorFor(world, id).maxEnergy);
  world.players.energy[id] = energy - data.energyPerShot;
  return scale;
}

function tryFireWeapon(world: World, id: number, input: PlayerInput): void {
  const players = world.players;
  const weaponId = players.weaponSlot[id] as WeaponId;
  const data = WEAPON_DATA[weaponId];
  const index = ammoIndex(id, weaponId);
  const ammo = players.ammo[index] ?? 0;
  const energyScale = energyScaleFor(world, id, data);
  if (ammo === 0 || energyScale === null) {
    players.weaponState[id] = WeaponState.DryFire;
    players.weaponTimer[id] = DRY_FIRE_SECONDS;
    return;
  }
  if (ammo > 0) players.ammo[index] = ammo - 1;
  players.weaponState[id] = WeaponState.Firing;
  players.weaponTimer[id] = data.fireTime;
  world.pendingFireEvents.push({
    playerId: id,
    weaponId,
    isAltFire: false,
    origin: shooterOrigin(world, id),
    direction: fireDirection(input.yaw, input.pitch),
    shooterVelocity: shooterVelocity(world, id),
    energyScale,
    hitPlayerId: -1,
    hitPoint: null,
    projectileId: -1,
    resolved: false,
  });
}

/** Advances Blaster's single timed Fire state. Keeping its negative remainder means a
 * 0.3 s cadence stays 0.3 s on average at the 32 ms simulation tick, instead of becoming
 * ceil(0.3 / 0.032) ticks for every shot. */
function advanceHeldBlaster(world: World, id: number, input: PlayerInput, dt: number): void {
  const players = world.players;
  const data = WEAPON_DATA[WeaponId.Blaster];
  let remaining = (players.weaponTimer[id] ?? 0) - dt;
  while (remaining <= TIMER_EPSILON && input.fire) {
    players.weaponState[id] = WeaponState.Ready;
    tryFireWeapon(world, id, input);
    if (players.weaponState[id] !== WeaponState.Firing) return;
    remaining += data.fireTime;
  }
  if (remaining <= TIMER_EPSILON) {
    players.weaponState[id] = WeaponState.Ready;
    players.weaponTimer[id] = 0;
    return;
  }
  players.weaponTimer[id] = remaining;
}

/** The original Chaingun waits through its 0.5 s Spinup state before its first Fire
 * state. Thereafter this uses the requested 0.10 s playtest interval. As with Blaster,
 * carry the overshoot forward so tick rounding does not permanently slow the weapon. */
function advanceChaingun(world: World, id: number, input: PlayerInput, dt: number): void {
  const players = world.players;
  const data = WEAPON_DATA[WeaponId.Chaingun];
  let remaining = (players.weaponTimer[id] ?? 0) - dt;
  if (players.weaponState[id] === WeaponState.SpinUp) {
    if (remaining > TIMER_EPSILON) {
      players.weaponTimer[id] = remaining;
      return;
    }
    players.spunUp[id] = 1;
    players.weaponState[id] = WeaponState.Firing;
  }
  while (remaining <= TIMER_EPSILON && input.fire) {
    tryFireWeapon(world, id, input);
    if (players.weaponState[id] !== WeaponState.Firing) return;
    remaining += data.fireTime;
  }
  players.weaponTimer[id] = Math.max(0, remaining);
}

function stepChaingun(world: World, id: number, input: PlayerInput, dt: number): void {
  const players = world.players;
  if (!input.fire) {
    players.spunUp[id] = 0;
    if (
      players.weaponState[id] === WeaponState.Firing ||
      players.weaponState[id] === WeaponState.SpinUp
    ) {
      players.weaponState[id] = WeaponState.Ready;
      players.weaponTimer[id] = 0;
    }
    advanceTimer(world, id, dt);
    return;
  }
  if (
    players.weaponState[id] === WeaponState.Ready ||
    players.weaponState[id] === WeaponState.NoAmmo
  ) {
    players.spunUp[id] = 0;
    players.weaponState[id] = WeaponState.SpinUp;
    players.weaponTimer[id] = WEAPON_DATA[WeaponId.Chaingun].spinUpTime ?? 0;
  }
  if (
    players.weaponState[id] === WeaponState.Firing ||
    players.weaponState[id] === WeaponState.SpinUp
  ) {
    advanceChaingun(world, id, input, dt);
  } else advanceTimer(world, id, dt);
}

function tryThrowGrenade(world: World, id: number, input: PlayerInput): void {
  const players = world.players;
  if (!input.altFire || (players.grenadeCooldown[id] ?? 0) > 0 || (players.grenades[id] ?? 0) <= 0)
    return;
  players.grenades[id] = (players.grenades[id] ?? 0) - 1;
  players.grenadeCooldown[id] = GRENADE_DATA.throwCooldown;
  world.pendingFireEvents.push({
    playerId: id,
    weaponId: WeaponId.Spinfusor,
    isAltFire: true,
    origin: shooterOrigin(world, id),
    direction: fireDirection(input.yaw, input.pitch),
    shooterVelocity: shooterVelocity(world, id),
    energyScale: 1,
    hitPlayerId: -1,
    hitPoint: null,
    projectileId: -1,
    resolved: false,
  });
}

function stepHandWeapon(world: World, id: number, input: PlayerInput, dt: number): void {
  const weaponId = world.players.weaponSlot[id] as WeaponId;
  if (weaponId === WeaponId.Chaingun) {
    stepChaingun(world, id, input, dt);
    return;
  }
  const state = world.players.weaponState[id];
  if (input.fire && (state === WeaponState.Ready || state === WeaponState.NoAmmo)) {
    tryFireWeapon(world, id, input);
  }
  if (weaponId === WeaponId.Blaster && world.players.weaponState[id] === WeaponState.Firing) {
    advanceHeldBlaster(world, id, input, dt);
  } else {
    advanceTimer(world, id, dt);
  }
}

/**
 * The fire-eligibility check reads the state from before this tick's advanceTimer runs,
 * and advanceTimer always runs afterward (even on the tick a fresh Firing/DryFire timer
 * was just set, giving it its first tick of decrement immediately). Without this
 * ordering, a timer expiring into Ready or NoAmmo this same tick would be visible to the
 * fire check within the very call that produced it, so a held fire button would re-fire
 * (or dry-fire) the instant the state resolved rather than on the following tick, and a
 * state like NoAmmo -- meant to be externally observable while ammo stays empty -- would
 * never survive past the tick it was reached.
 */
function stepOnePlayer(world: World, id: number, input: PlayerInput, dt: number): void {
  const players = world.players;
  // A mounted player's own weapon system is inert -- the vehicle's own weapon (the Shrike
  // blaster) reads the driver's fire input directly inside stepVehicles instead (M5 plan,
  // Global Constraints, Task 6). This is the same "exactly one system owns this id's state
  // this tick" rule movement.ts's own mounted guard follows.
  if (players.mountedVehicleId[id] !== -1) return;
  if ((players.grenadeCooldown[id] ?? 0) > 0) {
    players.grenadeCooldown[id] = Math.max(0, (players.grenadeCooldown[id] ?? 0) - dt);
  }
  applySlot(world, id, input);
  stepHandWeapon(world, id, input, dt);
  tryThrowGrenade(world, id, input);
}

/**
 * Credits back the ammo or grenade a shot spent last tick when projectiles.ts discovered,
 * one tick later, that the projectile store had no room for it (world.pendingAmmoRefunds is
 * recorded there, then read and cleared here at the start of stepWeapons's own next call --
 * the same one-tick-later boundary pendingDeaths already crosses between being produced and
 * consumed). -1 ammo means infinite (Laser Rifle, Blaster) and is left untouched.
 */
function applyPendingAmmoRefunds(world: World): void {
  for (const refund of world.pendingAmmoRefunds) {
    if (refund.isAltFire) {
      world.players.grenades[refund.playerId] = (world.players.grenades[refund.playerId] ?? 0) + 1;
      continue;
    }
    const index = ammoIndex(refund.playerId, refund.weaponId);
    const ammo = world.players.ammo[index] ?? 0;
    if (ammo >= 0) world.players.ammo[index] = ammo + 1;
  }
  world.pendingAmmoRefunds = [];
}

/**
 * Falls back to an idle input for an active player missing from `inputs`, the same way
 * stepPlayers (movement.ts) already does for movement -- a tick with no input entry for a
 * connected player (a dropped packet, not a disconnect) still has to advance that player's
 * reload/spin-up/grenade-cooldown timers, not freeze them. Skipping the player outright (this
 * used to) left a weapon stuck in Firing/Reload forever the instant one tick's input went
 * missing, since nothing ever called advanceTimer for it again. Codex review round 3,
 * finding 2.
 */
export function stepWeapons(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  applyPendingAmmoRefunds(world);
  world.pendingFireEvents = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const input = inputs.get(id) ?? IDLE_INPUT;
    stepOnePlayer(world, id, input, dt);
  }
}

/**
 * The loadout a (re)spawn grants, from the armor's own ammo table. #55: if the player has
 * a station-selected weapon set (`carriedWeapons`, written by baseObjects.ts's
 * applyLoadoutSelection), that choice PERSISTS -- the source's inventory station remembers
 * a loadout until the player changes it, so a respawn must not resurrect weapons the
 * player did not select. The mask is sanitized and capped at selection time
 * (baseObjects.ts's clampWeaponMask: only armor-allowed bits, at most maxWeapons of them),
 * so this is a plain subset check, not a re-validation. 0 is NOT a station loadout: it is
 * the pre-#55 legacy spawn table below (every weapon, with the Laser Rifle's infinite ammo),
 * which a player who has never visited a station keeps -- baseObjects.ts's defaultWeaponMask
 * is what an EMPTY station request grants instead.
 */
export function resetLoadout(world: World, id: number, armor: ArmorData): void {
  const players = world.players;
  players.weaponSlot[id] = WeaponId.Blaster; // Ours: Blaster is the starting/fallback weapon.
  players.weaponState[id] = WeaponState.Ready;
  players.weaponTimer[id] = 0;
  players.spunUp[id] = 0;
  players.grenadeCooldown[id] = 0;
  players.ammo[ammoIndex(id, WeaponId.Spinfusor)] = armor.discAmmo;
  players.ammo[ammoIndex(id, WeaponId.Chaingun)] = armor.chaingunAmmo;
  players.ammo[ammoIndex(id, WeaponId.Mortar)] = armor.mortarAmmo;
  players.ammo[ammoIndex(id, WeaponId.LaserRifle)] = -1; // -1 = infinite, gated by energy only.
  players.ammo[ammoIndex(id, WeaponId.Blaster)] = -1;
  players.grenades[id] = armor.grenadeCount;
  const carried = players.carriedWeapons[id] ?? 0;
  if (carried === 0) return;
  for (const weapon of ALL_WEAPONS) {
    if ((carried & (1 << weapon)) === 0) players.ammo[ammoIndex(id, weapon)] = 0;
  }
  // Firing from an empty-handed slot is a DryFire click; point the spawn at a weapon the
  if ((carried & (1 << WeaponId.Blaster)) === 0) {
    for (const weapon of ALL_WEAPONS) {
      if ((carried & (1 << weapon)) !== 0) {
        players.weaponSlot[id] = weapon;
        break;
      }
    }
  }
}

export function respawnPlayer(world: World, id: number, spawn: Vec3, armor?: ArmorId): void {
  if (armor !== undefined) world.players.armor[id] = armor;
  respawnHealth(world, id, spawn);
  resetLoadout(world, id, armorFor(world, id));
}
