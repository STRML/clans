import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  BaseObjectKind,
  createBaseObjects,
  createFlags,
  createWorld,
  stepPower,
  type Heightfield,
} from '@clans/sim';
import {
  findEscortedCarrier,
  findNearestFriendlyStation,
  findNearestVisibleEnemy,
  needsHealing,
  VISION_RANGE,
} from './perception.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: -500,
  originY: 0,
  originZ: 500,
  heightScale: 1,
  heights: new Uint16Array(4),
};

/** A single wall crossing world x=0 at every z, tall enough to block a line of sight at
 *  player eye height -- same construction as turrets.test.ts's own wallAcrossX fixture. */
function wallAcrossX(bumpHeight: number): Heightfield {
  const size = 11;
  const wallCol = 5;
  const heights = new Uint16Array(size * size);
  for (let row = 0; row < size; row += 1) heights[row * size + wallCol] = bumpHeight;
  return {
    gridSize: size,
    squareSize: 2,
    originX: -10,
    originY: 0,
    originZ: 0,
    heightScale: 1,
    heights,
  };
}

describe('findNearestVisibleEnemy', () => {
  it('returns null when no enemy is within VISION_RANGE', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: VISION_RANGE + 50, y: 0, z: 0 }, 2);
    expect(findNearestVisibleEnemy(world, bot)).toBeNull();
  });

  it('returns the nearest enemy id when two are in range', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    const near = addPlayer(world, { x: 20, y: 0, z: 0 }, 2);
    expect(findNearestVisibleEnemy(world, bot)).toBe(near);
  });

  it('skips an enemy terrain blocks line of sight to', () => {
    const world = createWorld(wallAcrossX(50), 1);
    const bot = addPlayer(world, { x: -5, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 5, y: 0, z: 0 }, 2);
    expect(findNearestVisibleEnemy(world, bot)).toBeNull();
  });

  it('excludes a mounted enemy even when otherwise in range and in line of sight (failure matrix row 18)', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    world.players.mountedVehicleId[enemy] = 0;
    expect(findNearestVisibleEnemy(world, bot)).toBeNull();
  });
});

describe('needsHealing', () => {
  it('is true below LOW_HEALTH_FRACTION', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.damage[bot] = 0.7; // Light armor maxDamage is 1.0 -- 70% damage, 30% health left.
    expect(needsHealing(world, bot)).toBe(true);
  });

  it('is true below LOW_ENERGY_FRACTION', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.energy[bot] = 1; // near-zero energy fraction
    expect(needsHealing(world, bot)).toBe(true);
  });

  it('is false at full health and energy', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(needsHealing(world, bot)).toBe(false);
  });
});

describe('findNearestFriendlyStation', () => {
  it('only returns a powered, non-destroyed, same-team station', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 2, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    expect(findNearestFriendlyStation(world, bot)).toBe(1);
  });

  it('returns null when the only own-team station is unpowered', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
    ]);
    stepPower(world); // no generator for team 1 -> unpowered
    expect(findNearestFriendlyStation(world, bot)).toBeNull();
  });

  it('prefers a true 3D-nearer station over one only horizontally closer (Codex review round 2, P2)', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      // Horizontally closer (5 m) but 20 m up -- true 3D distance ~20.6 m.
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 20, z: 0 } },
      // Horizontally farther (8 m) but at the bot's own height -- true 3D distance 8 m.
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    expect(findNearestFriendlyStation(world, bot)).toBe(2);
  });
});

describe('findEscortedCarrier', () => {
  it('finds a living teammate carrying the enemy flag', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: -10, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const carrier = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.flags.carrierId[1] = carrier;
    expect(findEscortedCarrier(world, 1, bot)).toBe(carrier);
  });

  it('returns null when no teammate is carrying the enemy flag', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: -10, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(findEscortedCarrier(world, 1, bot)).toBeNull();
  });

  it('returns null when the only carrier is selfId itself', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: -10, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.flags.carrierId[1] = bot;
    expect(findEscortedCarrier(world, 1, bot)).toBeNull();
  });
});
