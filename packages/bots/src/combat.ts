import {
  ammoIndex,
  armorFor,
  MUZZLE_HEIGHT,
  nextRandom,
  playerHitbox,
  WeaponId,
  WeaponState,
  WEAPON_DATA,
  type Vec3,
  type World,
} from '@clans/sim';
import type { BotRuntimeState } from './types.js';
import {
  CARRIER_THREAT_RADIUS_M,
  findCarrierThreat,
  findEscortedCarrier,
  findNearestVisibleEnemy,
  isCarryingEnemyFlag,
  visibleEnemyDistanceM,
} from './perception.js';

export const CLOSE_RANGE = 25; // Ours.
// Keep the Chaingun selected for a small margin while it is spinning. Without this,
// a target weaving across CLOSE_RANGE switches the bot back to the Spinfusor on the
// very next tick, which releases the trigger and makes the Chaingun pay its 0.5 s
// spin-up again on every approach.
export const CHAINGUN_RELEASE_RANGE = CLOSE_RANGE + 5; // Ours.
export const MORTAR_MIN_RANGE = 40; // Ours.
export const AIM_TOLERANCE_DEG = 4; // Ours.
export const AIM_JITTER_DEG = 2; // Ours, applied as +/-.

/** Issue #32 carrier fire discipline: the range inside which a bot CARRYING the enemy
 *  flag still shoots. The carrier's life is the score, and in this engine an aim solution
 *  is also a steering command (brain.ts's stepBot sends the combat yaw as the tick's own
 *  yaw, and movement.ts runs the body along input.yaw), so "stop and trade shots at
 *  range" is literally the carrier turning OFF the route it is trying to walk. Exactly
 *  CHAINGUN_RELEASE_RANGE (CLOSE_RANGE + 5): that is the distance at which the bot's own
 *  weapon choice has already switched to the close-range Chaingun (see CLOSE_RANGE's
 *  comment), i.e. a knife fight rather than a ranged exchange -- a carrier met there
 *  answers. Beyond it the ranged fight belongs to the escort screen (brain.ts: the
 *  ESCORT_AHEAD_M picket paces up to 100 m ahead of a healthy carrier, collapsing to
 *  ESCORT_CLOSE_M 30 m for a hurt one) -- the body that is supposed to take that duel.
 *  A carrier is therefore never defenseless: it answers anything inside knife range and
 *  keeps its route through everything else. */
export const CARRIER_FIRE_RANGE_M = CHAINGUN_RELEASE_RANGE; // Ours, meters.

/** Horizontal distance between two XZ points. Every engagement distance in this file is
 *  judged on the horizontal plane -- the convention chooseWeapon has always used for
 *  CLOSE_RANGE, and the one aimAtPoint already documents for a static point -- so the
 *  weapon switch, the aim solve and the carrier's fire envelope all read the same
 *  projection instead of three slightly different ones. */
function horizontalDistanceM(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** The bot's own feet position, read straight from the world store -- the combat layer
 *  never trusts a cached one across ticks. The same private reader brain.ts keeps; not
 *  exported from there because brain.ts imports this file, and not imported from the sim
 *  because the sim reads positions through flat Float64Array columns and exports no
 *  per-player reader. */
function playerPoint(world: World, botId: number): Vec3 {
  const base = botId * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: world.players.position[base + 1] ?? 0,
    z: world.players.position[base + 2] ?? 0,
  };
}

/** Issue #32 carrier fire discipline, the rule itself: true when this bot must keep its
 *  weapon down at `distance` -- it is carrying the enemy flag and the fight is farther
 *  out than CARRIER_FIRE_RANGE_M. A pure world query with no runtime state, so the fire
 *  gate in aimAndFire/aimAtPoint below and the decision layer's own engagement gate
 *  (carrierHoldsFireOn / carrierHoldsFireOnPoint) ask one identical question. */
export function carrierHoldsFire(world: World, botId: number, distance: number): boolean {
  return distance > CARRIER_FIRE_RANGE_M && isCarryingEnemyFlag(world, botId);
}

/** Issue #32: carrierHoldsFire for a player target, measured exactly as aimAndFire
 *  measures its own engagement distance (horizontal, feet to target hitbox centre) so the
 *  gate applied before engaging and the gate applied to the trigger can never disagree.
 *  Exposed for the decision layer, which has a target id and must decide whether to take
 *  the engagement at all -- if it engages, `aiming` turns true and stepBot steers on the
 *  aim yaw, which is the route interruption this rule exists to prevent. */
export function carrierHoldsFireOn(world: World, botId: number, targetId: number): boolean {
  const hitbox = playerHitbox(world, targetId, armorFor(world, targetId));
  const distance = horizontalDistanceM(playerPoint(world, botId), hitbox.center);
  return carrierHoldsFire(world, botId, distance);
}

/** Issue #32: the structure form of the same rule, on aimAtPoint's own horizontal
 *  measure to a world point, for the decision layer's turret branch. A carrier pivoting
 *  onto a plasma turret 110 m away is walking back into the base it just left -- the same
 *  "stopped to trade" failure the envelope exists to prevent, aimed at a structure. */
export function carrierHoldsFireOnPoint(world: World, botId: number, point: Vec3): boolean {
  const feet = playerPoint(world, botId);
  const eye: Vec3 = { x: feet.x, y: feet.y + MUZZLE_HEIGHT, z: feet.z };
  return carrierHoldsFire(world, botId, horizontalDistanceM(eye, point));
}

function ammoFor(world: World, botId: number, weaponId: WeaponId): number {
  return world.players.ammo[ammoIndex(botId, weaponId)] ?? 0;
}

function keepSpinningChaingun(world: World, botId: number, distance: number): boolean {
  const active =
    world.players.weaponSlot[botId] === WeaponId.Chaingun &&
    (world.players.weaponState[botId] === WeaponState.SpinUp || world.players.spunUp[botId] === 1);
  return (
    active && distance <= CHAINGUN_RELEASE_RANGE && ammoFor(world, botId, WeaponId.Chaingun) !== 0
  );
}

/** Spinfusor/Blaster beyond CLOSE_RANGE, Chaingun inside it, Mortar only for a Heavy
 *  bot engaging beyond MORTAR_MIN_RANGE (its own blast radius makes it unsafe closer;
 *  in practice this only ever fires for Heavy, since every other armor's mortarAmmo is
 *  0), Blaster as the final fallback (ammo is always -1/infinite for it -- weapons.ts's
 *  own resetLoadout convention). Never switches to a weapon with zero ammo. */
export function chooseWeapon(world: World, botId: number, distance: number): WeaponId {
  if (keepSpinningChaingun(world, botId, distance)) return WeaponId.Chaingun;
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
  // Issue #32 escort threat priority: the switch happens HERE, in the aim path itself, so
  // a bodyguard covering its carrier fights the carrier's duel even if the caller that
  // picked this target has not learned about escortPriorityTarget yet. A caller that has
  // (decideCombat, via selectCombatTarget) passes the same id back in and nothing changes.
  const engageId = escortPriorityTarget(world, botId, targetId);
  rollJitterIfNewTarget(runtime, engageId);
  const shooterFeet = playerPoint(world, botId);
  // Codex review round 3, finding (P1): aiming and firing from the player's feet position
  // instead of the real fire origin (weapons.ts's shooterOrigin: position.y + MUZZLE_HEIGHT,
  // the same point weapons.ts:282's own fireDirection uses) put every bot's shot roughly
  // 1.6 m below the target's actual hit sphere (damage.ts's playerHitbox is centered at
  // position.y + height/2), so a "hit" by this file's own tolerance check consistently
  // missed the authoritative ray. A read-only probe against a stationary target 10 m away
  // confirmed zero damage over 40 ticks before this fix.
  const shooterEye: Vec3 = { x: shooterFeet.x, y: shooterFeet.y + MUZZLE_HEIGHT, z: shooterFeet.z };
  const hitbox = playerHitbox(world, engageId, armorFor(world, engageId));
  const distance = horizontalDistanceM(shooterFeet, hitbox.center);
  const weaponId = chooseWeapon(world, botId, distance);
  const weapon = WEAPON_DATA[weaponId];
  const targetBase = engageId * 3;
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
    // Issue #32 carrier fire discipline: the trigger gate, added to the aim gate. The aim
    // solution itself is returned untouched, and on purpose: `aiming` (decideCombat) is
    // what decides whether stepBot steers on this yaw or on move.headingYaw, so the
    // route-preserving half of this rule belongs to the caller, which must not take the
    // engagement at all (carrierHoldsFireOn answers exactly that question). A synthesized
    // route yaw here was tried and rejected: stepBot stores the returned yaw as
    // runtime.aimYaw, so returning the stored one freezes the carrier's facing while
    // steering.ts keeps computing moveX/moveZ against the live heading -- the body then
    // walks a fixed bearing off its own route.
    fire: yawErrorDeg <= AIM_TOLERANCE_DEG && !carrierHoldsFire(world, botId, distance),
    weaponId,
  };
}

export interface AimSolution {
  yaw: number;
  pitch: number;
  fire: boolean;
  weaponId: WeaponId;
}

/** Issue #32 carrier survival: aim-and-fire at a STATIC world point -- an enemy base
 *  turret -- instead of a led player target. Same fire gate as aimAndFire (only pull the
 *  trigger once the previous tick's yaw is already on the point), same weapon choice by
 *  range, but no lead solve and no aim jitter: the turret never moves, and the Spinfusor's
 *  7.5 m splash radius around the impact point already absorbs the residual aim error, so
 *  the jitter a dodging human target needs would only spread shots off the structure. */
export function aimAtPoint(
  world: World,
  runtime: BotRuntimeState,
  botId: number,
  point: Vec3,
): AimSolution {
  const feet = playerPoint(world, botId);
  const shooterEye: Vec3 = { x: feet.x, y: feet.y + MUZZLE_HEIGHT, z: feet.z };
  const distance = horizontalDistanceM(shooterEye, point);
  const weaponId = chooseWeapon(world, botId, distance);
  const dx = point.x - shooterEye.x,
    dy = point.y - shooterEye.y,
    dz = point.z - shooterEye.z;
  const idealYaw = Math.atan2(dx, dz);
  const idealPitch = Math.atan2(dy, Math.hypot(dx, dz));
  const aimYaw = runtime.aimYaw;
  const yawErrorDeg = Math.abs(
    toDeg(Math.atan2(Math.sin(idealYaw - aimYaw), Math.cos(idealYaw - aimYaw))),
  );
  return {
    yaw: idealYaw,
    pitch: idealPitch,
    // Issue #32 carrier fire discipline: same trigger gate as aimAndFire's, on the
    // horizontal measure above. A structure is still a thing a carrier would pivot onto,
    // and pivoting is steering.
    fire: yawErrorDeg <= AIM_TOLERANCE_DEG && !carrierHoldsFire(world, botId, distance),
    weaponId,
  };
}

/** Issue #32 escort threat priority: how close the escort must be to its carrier before
 *  the carrier's fight becomes its own. The escort formation's furthest station is
 *  ESCORT_AHEAD_M (100 m) down the carrier's remaining route (brain.ts) and the goal
 *  layer tolerates 6 m of drift before repathing (steering.ts's GOAL_DRIFT_REPATH_M), so
 *  120 m covers every position that goal actually assigns; a body farther out than that
 *  is not a bodyguard, it is a separate fight on the same map, and the enemy nearest its
 *  own gun is the only one it can reach in time. Same value as CARRIER_THREAT_RADIUS_M so
 *  the two envelopes coincide: the escort fights the carrier's fight over exactly the
 *  region where those threats live. */
export const ESCORT_COVER_RADIUS_M = CARRIER_THREAT_RADIUS_M; // Ours, meters.

/** Issue #32 escort threat priority, the rule itself, applied to whichever target the
 *  caller already chose: an escort covered by its carrier swaps the caller's target for
 *  the enemy that threatens the CARRIER (findCarrierThreat: the closest enemy the carrier
 *  can see inside CARRIER_THREAT_RADIUS_M). Kept private and used by both entry points --
 *  aimAndFire's own aim path (so the switch is live without any caller change, which is
 *  what makes this slice shippable on its own) and selectCombatTarget below (so the
 *  decision layer that picks the target for `decideState` and the defender leash can ask
 *  the identical question).
 *
 *  Two gates keep the switch honest, both of them checks on whether the escort can
 *  actually be the body that takes the duel:
 *   - the carrier's threat must be visible to the ESCORT too (visibleEnemyDistanceM from
 *     the escort's own eye): taking a target it cannot see would rotate its facing, and
 *     with it its movement, toward an enemy it cannot damage;
 *   - the carrier must be inside ESCORT_COVER_RADIUS_M, because "the carrier's threat" can
 *     otherwise be hundreds of metres behind the escort's own next fight.
 *  Everything else -- no carrier, carrier out of cover, no visible threat, threat unseen
 *  by the escort -- returns the caller's own choice unchanged. */
function escortPriorityTarget(world: World, botId: number, fallbackTargetId: number): number {
  const team = world.players.team[botId] ?? 0;
  const carrierId = findEscortedCarrier(world, team, botId);
  if (carrierId === null) return fallbackTargetId;
  const gap = horizontalDistanceM(playerPoint(world, botId), playerPoint(world, carrierId));
  if (gap > ESCORT_COVER_RADIUS_M) return fallbackTargetId;
  const threatId = findCarrierThreat(world, carrierId, CARRIER_THREAT_RADIUS_M);
  if (threatId === null || visibleEnemyDistanceM(world, botId, threatId) === null) {
    return fallbackTargetId;
  }
  return threatId;
}

/** Issue #32 escort threat priority: which enemy this bot should aim at this tick, for the
 *  decision layer. Same rule escortPriorityTarget applies inside aimAndFire, with the
 *  bot's own nearest visible enemy as the fallback -- so a caller that selects a target
 *  BEFORE aiming (decideCombat picks one for decideState and the defender leash) and the
 *  aim path itself agree on who the escort is fighting. Null when the bot sees nobody:
 *  an enemy the escort cannot see can never be its target, so there is nothing to swap.
 *  The measured failure this addresses: carriers lose duels at 6-51% health with
 *  friendlies nowhere near, and a bodyguard fighting its own nearest enemy is not
 *  standing in the fight that kills its principal. */
export function selectCombatTarget(world: World, botId: number): number | null {
  const nearest = findNearestVisibleEnemy(world, botId);
  if (nearest === null) return null;
  return escortPriorityTarget(world, botId, nearest);
}
