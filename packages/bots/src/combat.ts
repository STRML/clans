import {
  ammoIndex,
  armorFor,
  MUZZLE_HEIGHT,
  nextRandom,
  playerHitbox,
  WeaponId,
  WEAPON_DATA,
  type Vec3,
  type World,
} from '@clans/sim';
import type { BotRuntimeState } from './types.js';

export const CLOSE_RANGE = 25; // Ours.
export const MORTAR_MIN_RANGE = 40; // Ours.
export const AIM_TOLERANCE_DEG = 4; // Ours.
export const AIM_JITTER_DEG = 2; // Ours, applied as +/-.

function ammoFor(world: World, botId: number, weaponId: WeaponId): number {
  return world.players.ammo[ammoIndex(botId, weaponId)] ?? 0;
}

/** Spinfusor/Blaster beyond CLOSE_RANGE, Chaingun inside it, Mortar only for a Heavy
 *  bot engaging beyond MORTAR_MIN_RANGE (its own blast radius makes it unsafe closer;
 *  in practice this only ever fires for Heavy, since every other armor's mortarAmmo is
 *  0), Blaster as the final fallback (ammo is always -1/infinite for it -- weapons.ts's
 *  own resetLoadout convention). Never switches to a weapon with zero ammo. */
export function chooseWeapon(world: World, botId: number, distance: number): WeaponId {
  if (distance > MORTAR_MIN_RANGE && ammoFor(world, botId, WeaponId.Mortar) > 0) {
    return WeaponId.Mortar;
  }
  if (distance > CLOSE_RANGE) {
    if (ammoFor(world, botId, WeaponId.Spinfusor) !== 0) return WeaponId.Spinfusor; // -1 or > 0
  } else if (ammoFor(world, botId, WeaponId.Chaingun) !== 0) {
    return WeaponId.Chaingun;
  }
  if (ammoFor(world, botId, WeaponId.Spinfusor) !== 0) return WeaponId.Spinfusor;
  if (ammoFor(world, botId, WeaponId.Chaingun) !== 0) return WeaponId.Chaingun;
  return WeaponId.Blaster;
}

/** One-step lead: where the target will be after the time this weapon's projectile takes
 *  to cross the CURRENT distance. Not a true ballistic intercept solve (that requires
 *  iterating since the target moves while the shot is in flight, which in turn changes
 *  the intercept time) -- ours, matching the spec's own "close enough for a demo" bar
 *  elsewhere in this codebase. A projectileSpeed of 0 (hitscan) returns the target's
 *  current position unchanged. */
export function leadPosition(
  shooterPosition: Vec3,
  targetPosition: Vec3,
  targetVelocity: Vec3,
  projectileSpeed: number,
): Vec3 {
  if (projectileSpeed <= 0) return targetPosition;
  const distance = Math.hypot(
    shooterPosition.x - targetPosition.x,
    shooterPosition.y - targetPosition.y,
    shooterPosition.z - targetPosition.z,
  );
  const travelTime = distance / projectileSpeed;
  return {
    x: targetPosition.x + targetVelocity.x * travelTime,
    y: targetPosition.y + targetVelocity.y * travelTime,
    z: targetPosition.z + targetVelocity.z * travelTime,
  };
}

function toDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

function rollJitterIfNewTarget(runtime: BotRuntimeState, targetId: number): void {
  if (runtime.engagedTargetId === targetId) return;
  runtime.engagedTargetId = targetId;
  runtime.aimJitterDeg = (nextRandom(runtime.random) * 2 - 1) * AIM_JITTER_DEG;
}

export function aimAndFire(
  world: World,
  runtime: BotRuntimeState,
  botId: number,
  targetId: number,
): { yaw: number; pitch: number; fire: boolean; weaponId: WeaponId } {
  rollJitterIfNewTarget(runtime, targetId);
  const shooterBase = botId * 3;
  const shooterFeet: Vec3 = {
    x: world.players.position[shooterBase] ?? 0,
    y: world.players.position[shooterBase + 1] ?? 0,
    z: world.players.position[shooterBase + 2] ?? 0,
  };
  // Codex review round 3, finding (P1): aiming and firing from the player's feet position
  // instead of the real fire origin (weapons.ts's shooterOrigin: position.y + MUZZLE_HEIGHT,
  // the same point weapons.ts:282's own fireDirection uses) put every bot's shot roughly
  // 1.6 m below the target's actual hit sphere (damage.ts's playerHitbox is centered at
  // position.y + height/2), so a "hit" by this file's own tolerance check consistently
  // missed the authoritative ray. A read-only probe against a stationary target 10 m away
  // confirmed zero damage over 40 ticks before this fix.
  const shooterEye: Vec3 = { x: shooterFeet.x, y: shooterFeet.y + MUZZLE_HEIGHT, z: shooterFeet.z };
  const hitbox = playerHitbox(world, targetId, armorFor(world, targetId));
  const distance = Math.hypot(shooterFeet.x - hitbox.center.x, 0, shooterFeet.z - hitbox.center.z);
  const weaponId = chooseWeapon(world, botId, distance);
  const weapon = WEAPON_DATA[weaponId];
  const targetBase = targetId * 3;
  const targetVelocity: Vec3 = {
    x: world.players.velocity[targetBase] ?? 0,
    y: world.players.velocity[targetBase + 1] ?? 0,
    z: world.players.velocity[targetBase + 2] ?? 0,
  };
  const lead = leadPosition(shooterEye, hitbox.center, targetVelocity, weapon.speed);
  const dx = lead.x - shooterEye.x,
    dy = lead.y - shooterEye.y,
    dz = lead.z - shooterEye.z;
  const idealYaw = Math.atan2(dx, dz) + (runtime.aimJitterDeg * Math.PI) / 180;
  const idealPitch = Math.atan2(dy, Math.hypot(dx, dz));
  const aimYaw = runtime.aimYaw;
  const yawErrorDeg = Math.abs(
    toDeg(Math.atan2(Math.sin(idealYaw - aimYaw), Math.cos(idealYaw - aimYaw))),
  );
  return {
    yaw: idealYaw,
    pitch: idealPitch,
    fire: yawErrorDeg <= AIM_TOLERANCE_DEG,
    weaponId,
  };
}
