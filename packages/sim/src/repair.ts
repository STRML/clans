import { BASE_OBJECT_DATA, BaseObjectKind, activeForceFieldBlockers } from './baseObjects.js';
import { armorFor } from './armor.js';
import { playerHitbox, raySphereDistance, type PlayerHitbox } from './damage.js';
import { raycastInteriors } from './interiors.js';
import { BASE_OBJECT_HIT_RADIUS } from './projectiles.js';
import { baseFor, hasLineOfSight, turretHitbox, type TurretBarrelId } from './turrets.js';
import type { PlayerInput, Vec3, World } from './types.js';
import { VEHICLE_DATA, type VehicleKind } from './vehicles.js';

const BEAM_RANGE = 10; // packs/repairpack.cs:48 -- DefaultRepairBeam.beamRange.

interface RepairCandidate {
  kind: 'player' | 'baseObject' | 'turret' | 'vehicle';
  id: number;
  distance: number;
  /** Target center the beam terminates on -- the same point the line-of-sight check uses,
   *  so repairBeamTarget can hand the client exact beam endpoints for free. */
  point: Vec3;
}

function eyeOrigin(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: (world.players.position[base + 1] ?? 0) + 1.6, // Same MUZZLE_HEIGHT convention as weapons.ts.
    z: world.players.position[base + 2] ?? 0,
  };
}

function aimDirection(yaw: number, pitch: number): Vec3 {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
}

function candidateFromHitbox(
  kind: RepairCandidate['kind'],
  id: number,
  hitbox: PlayerHitbox,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const distance = raySphereDistance(origin, direction, hitbox);
  if (distance === null || distance > BEAM_RANGE) return null;
  return { kind, id, distance, point: hitbox.center };
}

function nearerCandidate(
  a: RepairCandidate | null,
  b: RepairCandidate | null,
): RepairCandidate | null {
  if (!a) return b;
  if (!b) return a;
  return a.distance <= b.distance ? a : b;
}

/** The repair beam uses the same terrain and interior collision rules as a fired projectile.
 *  Allied force fields do not block their owner's beam; enemy force fields do. */
function hasRepairLineOfSight(world: World, healerTeam: number, from: Vec3, to: Vec3): boolean {
  if (!hasLineOfSight(world, from, to)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return true;
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  return !raycastInteriors(
    [...world.interiors, ...activeForceFieldBlockers(world, healerTeam)],
    from,
    direction,
    length,
  );
}

function findDamagedPlayerCandidate(
  world: World,
  healerId: number,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const healerTeam = world.players.team[healerId] ?? 0;
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < world.players.count; id += 1) {
    if (id === healerId || !world.players.active[id] || !world.players.alive[id]) continue;
    if ((world.players.damage[id] ?? 0) <= 0) continue;
    const hitbox = playerHitbox(world, id, armorFor(world, id));
    // Issue #51 residual: player candidates were the last kind that still healed straight
    // through terrain. findDamagedBaseObjectCandidate and findDamagedTurretCandidate already
    // gate on this exact helper, whose own contract is "the repair beam uses the same terrain
    // and interior collision rules as a fired projectile" -- so this extends that established
    // rule to the final candidate kind rather than inventing a second convention, and keeps
    // the beam's own source (`packs/repairpack.cs:48`'s DefaultRepairBeam) consistent with
    // its range citation above. The target point is the ray/sphere hitbox center, so the
    // beam's endpoint and the aiming test agree exactly as they do in those two searches.
    if (!hasRepairLineOfSight(world, healerTeam, origin, hitbox.center)) continue;
    nearest = nearerCandidate(
      nearest,
      candidateFromHitbox('player', id, hitbox, origin, direction),
    );
  }
  return nearest;
}

function findDamagedBaseObjectCandidate(
  world: World,
  healerId: number,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const bases = world.baseObjects;
  const healerTeam = world.players.team[healerId] ?? 0;
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < bases.count; id += 1) {
    // Same rule the turret search already enforces: an enemy asset is never a repair target,
    // while a friendly WRECK stays targetable so the beam can rebuild it (issue #50 --
    // destroying both generators used to leave a team permanently without power). A
    // destroyed object always has damage > 0, so the damaged check below keeps only that
    // distinction; invincible kinds (vehicle pad, force field) can never accumulate damage
    // and are excluded here for free.
    if (bases.team[id] !== healerTeam || (bases.damage[id] ?? 0) <= 0) continue;
    const base = id * 3;
    const hitbox: PlayerHitbox = {
      center: {
        x: bases.position[base] ?? 0,
        y: bases.position[base + 1] ?? 0,
        z: bases.position[base + 2] ?? 0,
      },
      radius: BASE_OBJECT_HIT_RADIUS,
      headY: Infinity,
    };
    // The beam follows a real line of sight, the same rule turret candidates already obey:
    // terrain cannot be rebuilt through. Use the same target point as the ray/sphere hit
    // test so visual aiming and repair selection agree.
    if (!hasRepairLineOfSight(world, healerTeam, origin, hitbox.center)) continue;
    nearest = nearerCandidate(
      nearest,
      candidateFromHitbox('baseObject', id, hitbox, origin, direction),
    );
  }
  return nearest;
}

function findDamagedTurretCandidate(
  world: World,
  healerId: number,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const turrets = world.turrets;
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < turrets.count; id += 1) {
    // A repair beam must not be able to restore an enemy emplacement, but a destroyed
    // friendly turret remains a repairable target. Unlike vehicles, T2's base turrets can
    // be brought back by repair work.
    if (turrets.team[id] !== world.players.team[healerId] || (turrets.damage[id] ?? 0) <= 0) {
      continue;
    }
    const hitbox = turretHitbox(world, id);
    // The beam follows a real line of sight: terrain cannot be repaired through. Use the
    // same target point as the ray/sphere hit test so visual aiming and repair selection agree.
    if (!hasRepairLineOfSight(world, world.players.team[healerId] ?? 0, origin, hitbox.center)) {
      continue;
    }
    nearest = nearerCandidate(
      nearest,
      candidateFromHitbox('turret', id, hitbox, origin, direction),
    );
  }
  return nearest;
}

/** M5, self-check finding (Codex review round 1, finding 7): the spec explicitly lists
 *  "vehicle" among repairable targets, and a vehicle's own hit-sphere radius/center are
 *  already established elsewhere (projectiles.ts's vehicle-aware nearestStructureHitFrom) --
 *  same checkRadius-per-kind convention reused here rather than a new one invented. Only a
 *  DESTROYED vehicle is excluded, matching baseObject/turret's own "destroyed structures
 *  aren't healable, only their still-standing damaged siblings are" rule; energy (shield) is
 *  deliberately left untouched, matching those same two candidate kinds -- it already
 *  recharges passively every tick inside stepShrike/stepWildcat, so a repair beam heals
 *  `damage` only, never energy, for any of the three structure kinds. Note this is now the
 *  ONLY candidate kind that still excludes wrecks: base objects (#50) and turrets rebuild,
 *  vehicles deliberately do not (a wreck's only way back into service is its team's vehicle
 *  pad, so the pad keeps its spawn cost and cooldown). */
function findDamagedVehicleCandidate(
  world: World,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const vehicles = world.vehicles;
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < vehicles.count; id += 1) {
    if (!vehicles.active[id] || vehicles.destroyed[id] || (vehicles.damage[id] ?? 0) <= 0) {
      continue;
    }
    const base = id * 3;
    const hitbox: PlayerHitbox = {
      center: {
        x: vehicles.position[base] ?? 0,
        y: vehicles.position[base + 1] ?? 0,
        z: vehicles.position[base + 2] ?? 0,
      },
      radius: VEHICLE_DATA[vehicles.kind[id] as VehicleKind].checkRadius,
      headY: Infinity,
    };
    nearest = nearerCandidate(
      nearest,
      candidateFromHitbox('vehicle', id, hitbox, origin, direction),
    );
  }
  return nearest;
}

function findRepairTarget(
  world: World,
  healerId: number,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const player = findDamagedPlayerCandidate(world, healerId, origin, direction);
  const baseObject = findDamagedBaseObjectCandidate(world, healerId, origin, direction);
  const turret = findDamagedTurretCandidate(world, healerId, origin, direction);
  const vehicle = findDamagedVehicleCandidate(world, origin, direction);
  return nearerCandidate(nearerCandidate(nearerCandidate(player, baseObject), turret), vehicle);
}

/** Spec: "Repair Pack fires a repair beam that adds repairRate per tick to any damaged asset,
 *  vehicle, or player." repairRate is the same 0.0033/tick for every armor (the spec's Armor
 *  numbers table), applied as a flat per-call reduction -- stepRepairPacks always runs once
 *  per fixed 32 ms tick via stepWorld, the same convention applyJet's jetEnergyDrain already
 *  uses. Each store kind gets its own heal helper below so the dispatch stays flat. */
function healCandidate(world: World, healerId: number, candidate: RepairCandidate): void {
  const rate = armorFor(world, healerId).repairRate;
  if (candidate.kind === 'player') healPlayer(world, candidate.id, rate);
  else if (candidate.kind === 'baseObject') healBaseObject(world, candidate.id, rate);
  else if (candidate.kind === 'turret') healTurret(world, candidate.id, rate);
  else healVehicle(world, candidate.id, rate);
}

function healPlayer(world: World, id: number, rate: number): void {
  world.players.damage[id] = Math.max(0, (world.players.damage[id] ?? 0) - rate);
}

function healBaseObject(world: World, id: number, rate: number): void {
  const store = world.baseObjects;
  const maxHealth = BASE_OBJECT_DATA[store.kind[id] as BaseObjectKind].maxHealth;
  // A wreck's repair clock starts from its real max health, not the destroying shot's
  // overkill: applyBaseObjectDamage has no destruction-time cap to reuse, so the clamp
  // lands here, giving base wrecks the same "repairable in the same finite time
  // regardless of overkill" property applyTurretDamage's own cap gives turret wrecks.
  if (store.destroyed[id] && (store.damage[id] ?? 0) > maxHealth) {
    store.damage[id] = maxHealth;
  }
  store.damage[id] = Math.max(0, (store.damage[id] ?? 0) - rate);
  // Issue #50 rebuild threshold: stock T2 static shapes carry no turret-style
  // disabledLevel, and a threshold of "any repair below maxHealth" would revive a capped
  // wreck in a single tick -- contradicting the rebuild pacing the same spec's repairRate
  // implies (a 1.5-health generator needs ~455 ticks ~= 14.6 s of sustained beam work).
  // So a base asset returns to service only once the beam has carried the damage all the
  // way back to zero. stepWorld's stepPower call re-derives the team's powered bits from
  // teamHasPower on the next tick, and the client's snapshot-driven views restore the
  // model's visibility from the same cleared flag -- no extra bookkeeping needed here.
  if (store.destroyed[id] && (store.damage[id] ?? 0) <= 0) {
    store.destroyed[id] = 0;
  }
}

function healTurret(world: World, id: number, rate: number): void {
  world.turrets.damage[id] = Math.max(0, (world.turrets.damage[id] ?? 0) - rate);
  // Base turrets return to service only after repair crosses the original T2 disabledLevel;
  // a barely-repaired wreck remains offline. Vehicles deliberately retain their non-revivable
  // rule.
  const barrel = world.turrets.barrel[id] as TurretBarrelId;
  if ((world.turrets.damage[id] ?? 0) < baseFor(barrel).disabledDamage) {
    world.turrets.destroyed[id] = 0;
  }
}

function healVehicle(world: World, id: number, rate: number): void {
  world.vehicles.damage[id] = Math.max(0, (world.vehicles.damage[id] ?? 0) - rate);
}

/** BEAM_RANGE exposed for the client's feedback row -- one source of truth for the beam's
 *  10 m reach (packs/repairpack.cs:48). */
export const REPAIR_BEAM_RANGE = BEAM_RANGE;

function remainingHealthFraction(world: World, candidate: RepairCandidate): number {
  let damage = 0;
  let max = 0;
  if (candidate.kind === 'player') {
    damage = world.players.damage[candidate.id] ?? 0;
    max = armorFor(world, candidate.id).maxDamage;
  } else if (candidate.kind === 'baseObject') {
    damage = world.baseObjects.damage[candidate.id] ?? 0;
    max = BASE_OBJECT_DATA[world.baseObjects.kind[candidate.id] as BaseObjectKind].maxHealth;
  } else if (candidate.kind === 'turret') {
    damage = world.turrets.damage[candidate.id] ?? 0;
    max = baseFor(world.turrets.barrel[candidate.id] as TurretBarrelId).maxHealth;
  } else {
    damage = world.vehicles.damage[candidate.id] ?? 0;
    max = VEHICLE_DATA[world.vehicles.kind[candidate.id] as VehicleKind].maxDamage;
  }
  return max > 0 ? Math.min(1, Math.max(0, 1 - damage / max)) : 0;
}

export interface RepairTargetInfo {
  kind: RepairCandidate['kind'];
  id: number;
  /** Eye-to-target-center distance in metres; never beyond REPAIR_BEAM_RANGE. */
  distance: number;
  /** The healer's eye point the beam itself is drawn from (eyeOrigin's conventions). */
  origin: Vec3;
  /** Target center the beam terminates on. */
  point: Vec3;
  /** 0-1 share of the target's damage budget still standing, for client feedback rows. */
  healthFraction: number;
  /** BaseObjectKind id when `kind` is 'baseObject'; the client resolves its own label. */
  baseObjectKind?: number;
}

/** Client-side twin of stepRepairPacks's own targeting: the repair beam a player sees must
 *  be exactly the target the sim would heal (same range, team, wreck and line-of-sight
 *  rules), so this is the same findRepairTarget query and NOT a re-implementation. Read-only
 *  -- no world field is written, so the client can call it every rendered frame. */
export function repairBeamTarget(
  world: World,
  healerId: number,
  yaw: number,
  pitch: number,
): RepairTargetInfo | null {
  const origin = eyeOrigin(world, healerId);
  const candidate = findRepairTarget(world, healerId, origin, aimDirection(yaw, pitch));
  if (!candidate) return null;
  return {
    kind: candidate.kind,
    id: candidate.id,
    distance: candidate.distance,
    origin,
    point: candidate.point,
    healthFraction: remainingHealthFraction(world, candidate),
    ...(candidate.kind === 'baseObject' && {
      baseObjectKind: world.baseObjects.kind[candidate.id],
    }),
  };
}

export function stepRepairPacks(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id] || !world.players.hasRepairPack[id])
      continue;
    const input = inputs.get(id);
    if (!input?.packActive) continue;
    const origin = eyeOrigin(world, id);
    const direction = aimDirection(input.yaw, input.pitch);
    const target = findRepairTarget(world, id, origin, direction);
    if (target) healCandidate(world, id, target);
  }
  void dt; // dt is part of every step*'s signature for consistency; the heal rate is per-tick, not dt-scaled.
}
