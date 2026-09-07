import { describe, expect, it } from 'vitest';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import { createWorld, type Heightfield, type PlayerInput } from './index.js';
import {
  activeVehicleCountForTeam,
  createVehicleStore,
  spawnVehicleAtPad,
  stepShrike,
  VEHICLE_DATA,
  VehicleKind,
  vehicleCapForTeam,
} from './vehicles.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function poweredPad(world: ReturnType<typeof createWorld>, team = 1): number {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationVehiclePad, team, position: { x: 5, y: 0, z: 0 } },
  ]);
  stepPower(world);
  return 1; // the pad's BaseObjectStore id, second createBaseObjects placement
}

describe('spawnVehicleAtPad', () => {
  it('spawns a Shrike at the pad position when powered', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const id = spawnVehicleAtPad(world, padId, VehicleKind.Shrike);
    expect(id).not.toBeNull();
    expect(world.vehicles.kind[id as number]).toBe(VehicleKind.Shrike);
    expect(world.vehicles.damage[id as number]).toBe(0);
  });

  it('refuses to spawn at an unpowered pad', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world); // no generator -> stays unpowered
    expect(spawnVehicleAtPad(world, 0, VehicleKind.Wildcat)).toBeNull();
  });

  it('spawning a second vehicle at the same pad destroys the first', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const first = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    const second = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    expect(world.vehicles.destroyed[first]).toBe(1);
    expect(second).not.toBe(first);
    expect(world.vehicles.destroyed[second]).toBe(0);
  });

  it('a destroyed vehicle id is not reallocated within the same tick it was freed', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const first = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    spawnVehicleAtPad(world, padId, VehicleKind.Wildcat);
    // Even though `first` is destroyed, its id must still read back as destroyed=1, not
    // silently vanish or get reused, until at least one stepVehicles call passes.
    expect(world.vehicles.active[first]).toBe(1);
    expect(world.vehicles.destroyed[first]).toBe(1);
  });
});

describe('vehicleCapForTeam / activeVehicleCountForTeam', () => {
  it('one pad means a cap of one', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    expect(vehicleCapForTeam(world, 1)).toBe(1);
    expect(activeVehicleCountForTeam(world, 1)).toBe(0);
    spawnVehicleAtPad(world, padId, VehicleKind.Shrike);
    expect(activeVehicleCountForTeam(world, 1)).toBe(1);
  });

  it('an unpowered pad does not count toward the cap', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    expect(vehicleCapForTeam(world, 1)).toBe(0);
  });
});

describe('VEHICLE_DATA', () => {
  it('matches the spec Vehicle numbers table exactly', () => {
    expect(VEHICLE_DATA[VehicleKind.Shrike].mass).toBe(150);
    expect(VEHICLE_DATA[VehicleKind.Shrike].maxDamage).toBe(1.4);
    expect(VEHICLE_DATA[VehicleKind.Shrike].maxEnergy).toBe(280);
    expect(VEHICLE_DATA[VehicleKind.Shrike].energyPerDamagePoint).toBe(160);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].mass).toBe(400);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].maxDamage).toBe(0.6);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].maxEnergy).toBe(150);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].energyPerDamagePoint).toBe(75);
  });
});

const idleInput: PlayerInput = {
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
};

function shrikeWorld(): { world: ReturnType<typeof createWorld>; id: number } {
  const world = createWorld(flat, 1);
  world.vehicles = createVehicleStore();
  world.vehicles.active[0] = 1;
  world.vehicles.count = 1;
  world.vehicles.kind[0] = VehicleKind.Shrike;
  world.vehicles.energy[0] = VEHICLE_DATA[VehicleKind.Shrike].maxEnergy;
  world.vehicles.position.set([0, 100, 0], 0); // well above the flat terrain (ground height 0)
  return { world, id: 0 };
}

describe('stepShrike', () => {
  it('an idle Shrike with no input falls under gravity like any unpowered body', () => {
    const { world, id } = shrikeWorld();
    stepShrike(world, id, idleInput, 1 / 32);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeLessThan(0);
  });

  it('forward thrust (moveZ) accelerates the Shrike along its heading', () => {
    const { world, id } = shrikeWorld();
    const forward: PlayerInput = { ...idleInput, moveZ: 1 };
    for (let tick = 0; tick < 60; tick += 1) stepShrike(world, id, forward, 1 / 32);
    const speed = Math.hypot(
      world.vehicles.velocity[id * 3] ?? 0,
      world.vehicles.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeGreaterThan(5);
  });

  it('mouse yaw (input.yaw) steers the Shrike via steeringForce, not a snap', () => {
    const { world, id } = shrikeWorld();
    const turning: PlayerInput = { ...idleInput, yaw: 0.5 };
    stepShrike(world, id, turning, 1 / 32);
    // One tick of steeringForce should nudge, not teleport, yaw.
    expect(Math.abs(world.vehicles.yaw[id] ?? 0)).toBeGreaterThan(0);
    expect(Math.abs(world.vehicles.yaw[id] ?? 0)).toBeLessThan(0.5);
  });

  it('afterburner (jet input) drains energy at jetEnergyDrain and refuses below minJetEnergy', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.energy[id] = 27; // below minJetEnergy (28)
    const boosting: PlayerInput = { ...idleInput, jet: true };
    stepShrike(world, id, boosting, 1 / 32);
    expect(world.vehicles.energy[id]).toBe(27); // refused, not drained -- also not recharged
    // this tick since jet was held (see applyShrikeAfterburner's else branch).
  });

  it('below maxAutoSpeed the auto-stabilizer damps angular velocity toward level', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.angVel.set([2, 0, 0], id * 3); // spinning fast in pitch
    world.vehicles.velocity.set([1, 0, 0], id * 3); // well under maxAutoSpeed (15)
    stepShrike(world, id, idleInput, 1 / 32);
    expect(Math.abs(world.vehicles.angVel[id * 3] ?? 0)).toBeLessThan(2);
  });
});
