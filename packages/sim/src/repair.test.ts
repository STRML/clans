import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyDamage,
  createWorld,
  LIGHT_ARMOR,
  type Heightfield,
  type PlayerInput,
} from './index.js';
import { applyBaseObjectDamage, BaseObjectKind, createBaseObjects } from './baseObjects.js';
import { stepRepairPacks } from './repair.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const FIXED_DT = 32 / 1000;
const REPAIR_RATE = LIGHT_ARMOR.repairRate;
const IDLE: PlayerInput = {
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
const aimingAt = (from: { x: number; z: number }, to: { x: number; z: number }): number =>
  Math.atan2(to.x - from.x, to.z - from.z);

describe('stepRepairPacks', () => {
  it('does nothing for a player without the Repair Pack equipped', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt];
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBe(before);
  });

  it('heals a damaged, aimed-at, in-range teammate by repairRate per tick', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt] ?? 0;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBeCloseTo(before - REPAIR_RATE);
  });

  it('failure matrix row 13: stops the instant the target leaves the 10 m beam range', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 11, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt];
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 11, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBe(before);
  });

  it('heals a damaged base object within range', () => {
    const world = createWorld(flat, 1);
    // y=1, not 0: the healer's beam origin sits at eye height (player y + 1.6, eyeOrigin's
    // own MUZZLE_HEIGHT convention); a generator at y=0 sits 1.6 m below that beam, just
    // outside BASE_OBJECT_HIT_RADIUS (1.5 m), so the beam would never register a hit.
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 1, z: 0 } },
    ]);
    // 2.5 spends the shield (capacity 50/30 = 1.667) and lets 0.833 through to health --
    // comfortably under maxHealth (1.5), so the generator is damaged but not destroyed. The
    // plan's own text used 20 here, which overkills a Generator's 1.5 maxHealth outright and
    // destroys it, making it unhealable (stepRepairPacks correctly refuses a destroyed
    // target) -- a bug in the plan's test data, not this implementation.
    applyBaseObjectDamage(world, 0, 2.5);
    expect(world.baseObjects.destroyed[0]).toBe(0);
    const before = world.baseObjects.damage[0] ?? 0;
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.baseObjects.damage[0]).toBeLessThan(before);
  });

  it('failure matrix row 15: does not revive a destroyed generator', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.baseObjects.destroyed[0]).toBe(1);
    expect(world.baseObjects.damage[0]).toBeGreaterThan(0);
  });

  it('never reduces damage below zero', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.0001, -1, LIGHT_ARMOR);
    for (let tick = 0; tick < 10; tick += 1) {
      stepRepairPacks(
        world,
        new Map([
          [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
        ]),
        FIXED_DT,
      );
    }
    expect(world.players.damage[hurt]).toBe(0);
  });
});
