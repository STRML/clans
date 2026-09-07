import { armorFor } from './armor.js';
import { playerHitbox, raySphereDistance, type PlayerHitbox } from './damage.js';
import { BASE_OBJECT_HIT_RADIUS, TURRET_HIT_RADIUS } from './projectiles.js';
import type { PlayerInput, Vec3, World } from './types.js';
import { VEHICLE_DATA, type VehicleKind } from './vehicles.js';

const BEAM_RANGE = 10; // packs/repairpack.cs:48 -- DefaultRepairBeam.beamRange.

interface RepairCandidate {
  kind: 'player' | 'baseObject' | 'turret' | 'vehicle';
  id: number;
  distance: number;
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
  return { kind, id, distance };
}

function nearerCandidate(
  a: RepairCandidate | null,
  b: RepairCandidate | null,
): RepairCandidate | null {
  if (!a) return b;
  if (!b) return a;
  return a.distance <= b.distance ? a : b;
}

function findDamagedPlayerCandidate(
  world: World,
  healerId: number,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < world.players.count; id += 1) {
    if (id === healerId || !world.players.active[id] || !world.players.alive[id]) continue;
    if ((world.players.damage[id] ?? 0) <= 0) continue;
    const hitbox = playerHitbox(world, id, armorFor(world, id));
    nearest = nearerCandidate(
      nearest,
      candidateFromHitbox('player', id, hitbox, origin, direction),
    );
  }
  return nearest;
}

function findDamagedBaseObjectCandidate(
  world: World,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const bases = world.baseObjects;
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.destroyed[id] || (bases.damage[id] ?? 0) <= 0) continue;
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
    nearest = nearerCandidate(
      nearest,
      candidateFromHitbox('baseObject', id, hitbox, origin, direction),
    );
  }
  return nearest;
}

function findDamagedTurretCandidate(
  world: World,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const turrets = world.turrets;
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < turrets.count; id += 1) {
    if (turrets.destroyed[id] || (turrets.damage[id] ?? 0) <= 0) continue;
    const base = id * 3;
    const hitbox: PlayerHitbox = {
      center: {
        x: turrets.position[base] ?? 0,
        y: turrets.position[base + 1] ?? 0,
        z: turrets.position[base + 2] ?? 0,
      },
      radius: TURRET_HIT_RADIUS,
      headY: Infinity,
    };
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
 *  `damage` only, never energy, for any of the three structure kinds. */
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
  const baseObject = findDamagedBaseObjectCandidate(world, origin, direction);
  const turret = findDamagedTurretCandidate(world, origin, direction);
  const vehicle = findDamagedVehicleCandidate(world, origin, direction);
  return nearerCandidate(nearerCandidate(nearerCandidate(player, baseObject), turret), vehicle);
}

/** Spec: "Repair Pack fires a repair beam that adds repairRate per tick to any damaged asset,
 *  vehicle, or player." repairRate is the same 0.0033/tick for every armor (the spec's Armor
 *  numbers table), applied as a flat per-call reduction -- stepRepairPacks always runs once
 *  per fixed 32 ms tick via stepWorld, the same convention applyJet's jetEnergyDrain already
 *  uses. */
function healCandidate(world: World, healerId: number, candidate: RepairCandidate): void {
  const rate = armorFor(world, healerId).repairRate;
  if (candidate.kind === 'player') {
    world.players.damage[candidate.id] = Math.max(
      0,
      (world.players.damage[candidate.id] ?? 0) - rate,
    );
  } else if (candidate.kind === 'baseObject') {
    world.baseObjects.damage[candidate.id] = Math.max(
      0,
      (world.baseObjects.damage[candidate.id] ?? 0) - rate,
    );
  } else if (candidate.kind === 'turret') {
    world.turrets.damage[candidate.id] = Math.max(
      0,
      (world.turrets.damage[candidate.id] ?? 0) - rate,
    );
  } else {
    world.vehicles.damage[candidate.id] = Math.max(
      0,
      (world.vehicles.damage[candidate.id] ?? 0) - rate,
    );
  }
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
