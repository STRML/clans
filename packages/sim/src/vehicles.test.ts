import { describe, expect, it } from 'vitest';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import { createWorld, type Heightfield } from './index.js';
import {
  activeVehicleCountForTeam,
  spawnVehicleAtPad,
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
