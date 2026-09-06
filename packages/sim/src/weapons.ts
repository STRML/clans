import { LIGHT_ARMOR, type ArmorData } from './armor.js';
import { respawnPlayer as respawnHealth } from './damage.js';
import type { PlayerInput, Vec3, World } from './types.js';

export enum WeaponId {
  Spinfusor = 0,
  Chaingun = 1,
  Mortar = 2,
  LaserRifle = 3,
  Blaster = 4,
}
export const WEAPON_COUNT = 5;

export enum WeaponState {
  Activate = 0,
  Ready = 1,
  Firing = 2,
  Reload = 3,
  NoAmmo = 4,
  DryFire = 5,
}

export enum ProjectileType {
  Linear = 0,
  Tracer = 1,
  Grenade = 2,
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

// Spec's Weapon numbers table, used exactly. Chaingun's spinDownTime (1.0 s) is kept for the
// client's future barrel-spin visual but does not gate fire logic this milestone — see the
// spin-up test for the gating we do implement.
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
    fireTime: 0.15,
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
  // Blaster: the spec gives no numbers for the player-carried Blaster, only the vehicle
  // Shrike blaster (0.125 direct, 425 m/s). Every field below is ours.
  [WeaponId.Blaster]: {
    id: WeaponId.Blaster,
    projectile: ProjectileType.Linear,
    speed: 300,
    velInherit: 0.5,
    directDamage: 0.1,
    radiusDamage: 0,
    radius: 0,
    kickback: 0,
    fireTime: 0.2,
    reloadTime: 0.3,
    lifetime: 2,
    activateTime: 0,
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

function fireCost(world: World, id: number, data: WeaponData): number {
  if (data.id !== WeaponId.Chaingun) return data.fireTime;
  if (world.players.spunUp[id]) return data.fireTime;
  world.players.spunUp[id] = 1;
  return (data.spinUpTime ?? 0) + data.fireTime;
}

function energyScaleFor(world: World, id: number, data: WeaponData): number | null {
  if (data.energyPerShot === undefined) return 1;
  const energy = world.players.energy[id] ?? 0;
  if (energy < (data.minEnergy ?? 0)) return null;
  const scale = Math.min(1, energy / LIGHT_ARMOR.maxEnergy);
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
  players.weaponTimer[id] = fireCost(world, id, data);
  world.pendingFireEvents.push({
    playerId: id,
    weaponId,
    isAltFire: false,
    origin: shooterOrigin(world, id),
    direction: fireDirection(input.yaw, input.pitch),
    shooterVelocity: shooterVelocity(world, id),
    energyScale,
  });
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
  });
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
  if (!input.fire) players.spunUp[id] = 0;
  if ((players.grenadeCooldown[id] ?? 0) > 0) {
    players.grenadeCooldown[id] = Math.max(0, (players.grenadeCooldown[id] ?? 0) - dt);
  }
  applySlot(world, id, input);
  const state = players.weaponState[id];
  if (input.fire && (state === WeaponState.Ready || state === WeaponState.NoAmmo)) {
    tryFireWeapon(world, id, input);
  }
  advanceTimer(world, id, dt);
  tryThrowGrenade(world, id, input);
}

export function stepWeapons(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  world.pendingFireEvents = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const input = inputs.get(id);
    if (input) stepOnePlayer(world, id, input, dt);
  }
}

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
}

export function respawnPlayer(world: World, id: number, spawn: Vec3): void {
  respawnHealth(world, id, spawn);
  resetLoadout(world, id, LIGHT_ARMOR);
}
