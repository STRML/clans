import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { decideVehicleGoal, findMountableVehicle, shouldUseVehicle } from './vehicles.js';
import { BotRole, createBotRuntimeState } from './types.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: -500,
  originY: 0,
  originZ: 500,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function addVehicle(
  world: ReturnType<typeof createWorld>,
  fields: Partial<{
    team: number;
    x: number;
    y: number;
    z: number;
    driverId: number;
    active: number;
    destroyed: number;
  }>,
): number {
  const store = world.vehicles;
  const id = store.count;
  store.count += 1;
  store.active[id] = fields.active ?? 1;
  store.destroyed[id] = fields.destroyed ?? 0;
  store.team[id] = fields.team ?? 1;
  store.driverId[id] = fields.driverId ?? -1;
  store.position.set([fields.x ?? 0, fields.y ?? 0, fields.z ?? 0], id * 3);
  return id;
}

describe('findMountableVehicle', () => {
  it('finds the nearest active, unoccupied, same-team vehicle within MOUNT_RANGE', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const near = addVehicle(world, { team: 1, x: 2, z: 0 });
    addVehicle(world, { team: 1, x: 3.9, z: 0 });
    expect(findMountableVehicle(world, bot)).toBe(near);
  });

  it('returns null when the only candidate is destroyed', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addVehicle(world, { team: 1, x: 2, z: 0, destroyed: 1 });
    expect(findMountableVehicle(world, bot)).toBeNull();
  });

  it('returns null when the only candidate is already occupied', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addVehicle(world, { team: 1, x: 2, z: 0, driverId: 5 });
    expect(findMountableVehicle(world, bot)).toBeNull();
  });

  it('returns null when the only candidate is owned by the enemy team', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addVehicle(world, { team: 2, x: 2, z: 0 });
    expect(findMountableVehicle(world, bot)).toBeNull();
  });

  it('returns null when the only candidate is beyond MOUNT_RANGE', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addVehicle(world, { team: 1, x: 10, z: 0 });
    expect(findMountableVehicle(world, bot)).toBeNull();
  });

  it('excludes a vehicle within horizontal range but beyond MOUNT_RANGE vertically (Codex review round 1)', () => {
    // Real mounting (sim/vehicles.ts's findUnoccupiedVehicleInRange) checks full 3D
    // distance, not horizontal-only -- a vehicle directly above/below the bot (a cliff
    // edge, a ledge) must not read as mountable here just because its X/Z is close.
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addVehicle(world, { team: 1, x: 0, y: 10, z: 0 });
    expect(findMountableVehicle(world, bot)).toBeNull();
  });
});

describe('decideVehicleGoal', () => {
  it('returns null when findMountableVehicle finds nothing', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    expect(decideVehicleGoal(world, runtime)).toBeNull();
  });

  it('returns a goal at the vehicle position with key vehicle:<id> otherwise', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const vehicleId = addVehicle(world, { team: 1, x: 2, z: 3 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideVehicleGoal(world, runtime);
    expect(goal).toEqual({ position: { x: 2, y: 0, z: 3 }, key: `vehicle:${String(vehicleId)}` });
  });
});

describe('shouldUseVehicle', () => {
  it('is false when the current goal is not a vehicle goal', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addVehicle(world, { team: 1, x: 0, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.goalKey = 'enemyFlag:1';
    expect(shouldUseVehicle(world, runtime, bot)).toBe(false);
  });

  it('is false when the goal is a vehicle goal but still out of MOUNT_RANGE', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const vehicleId = addVehicle(world, { team: 1, x: 10, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.goalKey = `vehicle:${String(vehicleId)}`;
    expect(shouldUseVehicle(world, runtime, bot)).toBe(false);
  });

  it('is false when the goal vehicle is within horizontal range but beyond MOUNT_RANGE vertically', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const vehicleId = addVehicle(world, { team: 1, x: 0, y: 10, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.goalKey = `vehicle:${String(vehicleId)}`;
    expect(shouldUseVehicle(world, runtime, bot)).toBe(false);
  });

  it('is true once within range and the vehicle is still unoccupied', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const vehicleId = addVehicle(world, { team: 1, x: 2, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.goalKey = `vehicle:${String(vehicleId)}`;
    expect(shouldUseVehicle(world, runtime, bot)).toBe(true);
  });

  it('is false if the targeted vehicle was mounted by someone else in the meantime', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const vehicleId = addVehicle(world, { team: 1, x: 2, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.goalKey = `vehicle:${String(vehicleId)}`;
    world.vehicles.driverId[vehicleId] = 9;
    expect(shouldUseVehicle(world, runtime, bot)).toBe(false);
  });

  it('is false if the targeted vehicle was destroyed in the meantime', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const vehicleId = addVehicle(world, { team: 1, x: 2, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.goalKey = `vehicle:${String(vehicleId)}`;
    world.vehicles.destroyed[vehicleId] = 1;
    expect(shouldUseVehicle(world, runtime, bot)).toBe(false);
  });
});
