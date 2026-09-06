import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import {
  activeForceFieldBlockers,
  applyBaseObjectDamage,
  BASE_OBJECT_DATA,
  BaseObjectKind,
  createBaseObjects,
  STATION_USE_RADIUS,
  stationAt,
  stepPower,
  teamHasPower,
} from './baseObjects.js';
import { raycastInteriors } from './interiors.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function twoGeneratorsOneStation(world: ReturnType<typeof createWorld>): {
  gen1: number;
  gen2: number;
  station: number;
} {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
  ]);
  stepPower(world);
  return { gen1: 0, gen2: 1, station: 2 };
}

describe('BASE_OBJECT_DATA', () => {
  it('matches the spec Base asset numbers table and staticShape.cs exactly', () => {
    expect(BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth).toBe(1.5);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Generator].energyPerDamagePoint).toBe(30);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].maxHealth).toBe(1.5);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].energyPerDamagePoint).toBe(33);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].detectRadius).toBe(300);
    expect(BASE_OBJECT_DATA[BaseObjectKind.StationInventory].maxHealth).toBe(1.0);
    expect(BASE_OBJECT_DATA[BaseObjectKind.StationVehiclePad].invincible).toBe(true);
  });
});

describe('stepPower', () => {
  it('a team with at least one living generator powers its other objects', () => {
    const world = createWorld(flat, 1);
    const { station } = twoGeneratorsOneStation(world);
    expect(world.baseObjects.powered[station]).toBe(1);
    expect(teamHasPower(world, 1)).toBe(true);
  });
  it('destroying one of two generators keeps the team powered', () => {
    const world = createWorld(flat, 1);
    const { gen1, station } = twoGeneratorsOneStation(world);
    applyBaseObjectDamage(world, gen1, BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10);
    stepPower(world);
    expect(world.baseObjects.powered[station]).toBe(1);
  });
  it('failure matrix row 4: destroying both generators unpowers every other object of that team', () => {
    const world = createWorld(flat, 1);
    const { gen1, gen2, station } = twoGeneratorsOneStation(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, gen1, overkill);
    applyBaseObjectDamage(world, gen2, overkill);
    stepPower(world);
    expect(world.baseObjects.powered[station]).toBe(0);
  });
  it('a generator itself is always "powered" (it does not depend on another generator)', () => {
    const world = createWorld(flat, 1);
    const { gen1 } = twoGeneratorsOneStation(world);
    expect(world.baseObjects.powered[gen1]).toBe(1);
  });
});

describe('applyBaseObjectDamage: shielded damage spends energy before health', () => {
  it('spends energy at energyPerDamagePoint before touching health', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1.0);
    expect(world.baseObjects.damage[0]).toBe(0);
    expect(world.baseObjects.energy[0]).toBeCloseTo(50 - 1.0 * 30);
  });
  it('overflow past the shield reaches health', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 2.0);
    expect(world.baseObjects.energy[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBeCloseTo(2.0 - 50 / 30);
  });
  it('destroys at maxHealth and further damage is a no-op', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    const damageAfter = world.baseObjects.damage[0];
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.damage[0]).toBe(damageAfter);
  });
  it('a StationVehiclePad is invincible: damage is always a no-op (station.cs isInvincible)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBe(0);
  });
});

describe('stationAt', () => {
  it('finds a powered station within STATION_USE_RADIUS of the player', () => {
    const world = createWorld(flat, 1);
    const { station } = twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10 + STATION_USE_RADIUS - 0.1, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBe(station);
  });
  it('returns null outside the use radius', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10 + STATION_USE_RADIUS + 5, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
  it('returns null for an unpowered station (failure matrix row 4)', () => {
    const world = createWorld(flat, 1);
    const { gen1, gen2 } = twoGeneratorsOneStation(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, gen1, overkill);
    applyBaseObjectDamage(world, gen2, overkill);
    stepPower(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
  it('never returns an enemy team station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationInventory, team: 2, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
});

describe('ForceField', () => {
  const forceFieldPlacement = (team: number) => ({
    kind: BaseObjectKind.ForceField,
    team,
    position: { x: 0, y: 0, z: 0 },
    rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
    scale: { x: 6, y: 4, z: 1 },
  });

  it('BASE_OBJECT_DATA[ForceField] is invincible — forceField.cs has no energy/maxDamage field of its own', () => {
    expect(BASE_OBJECT_DATA[BaseObjectKind.ForceField].invincible).toBe(true);
    expect(BASE_OBJECT_DATA[BaseObjectKind.ForceField].maxHealth).toBe(0);
  });

  it('failure matrix row 18: an unpowered force field blocks no one', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [forceFieldPlacement(1)]);
    // No generator: stepPower leaves it unpowered.
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(0);
    expect(activeForceFieldBlockers(world, 1)).toHaveLength(0);
  });

  it('a powered force field blocks the opposing team and passes its own (failure matrix row 17)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1); // team 2 (enemy) is blocked
    expect(activeForceFieldBlockers(world, 1)).toHaveLength(0); // team 1 (owner) passes freely
  });

  it("destroying both of the owning team's generators drops the force field from every team's blocker list", () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 25, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, 0, overkill);
    applyBaseObjectDamage(world, 1, overkill);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(0);
  });

  it('a destroyed generator that leaves one alive keeps the force field powered', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 25, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, 0, overkill);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1);
  });

  it("the blocker geometry sits at the field's own position, sized from the placement scale", () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    const [blocker] = activeForceFieldBlockers(world, 2);
    // A ray straight through the field's own position, aimed at its plane, must hit it.
    const hit =
      blocker && raycastInteriors([blocker], { x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
  });
});
