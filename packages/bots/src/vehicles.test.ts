import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import {
  decideVehicleGoal,
  driveInputFor,
  findMountableVehicle,
  shouldUseVehicle,
  VEHICLE_CARRIER_DETOUR_M,
  VEHICLE_DETOUR_M,
  VEHICLE_DISMOUNT_M,
  VEHICLE_MIN_LEG_M,
  vehicleDetourGoal,
} from './vehicles.js';
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

// --- Issue #32 vehicles: the driving controller and the detour policy -------------------

describe('driveInputFor', () => {
  function rig(): {
    world: ReturnType<typeof createWorld>;
    runtime: ReturnType<typeof createBotRuntimeState>;
  } {
    const world = createWorld(flat, 1);
    const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    return { world, runtime: createBotRuntimeState(playerId) };
  }

  it('steers at the goal and holds throttle until it is close', () => {
    const { world, runtime } = rig();
    // Due +z: the sim's own heading at yaw 0, so the drive yaw is 0 and the throttle is full.
    const ahead = driveInputFor(world, runtime, { x: 0, y: 0, z: 200 });
    expect(ahead.yaw).toBeCloseTo(0, 6);
    expect(ahead.moveZ).toBe(1);
    expect(ahead.use).toBe(false);
    // Due +x is a quarter turn, which is the bearing the controller has to produce.
    const right = driveInputFor(world, runtime, { x: 200, y: 0, z: 0 });
    expect(right.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('dismounts inside the dismount range and stops throttling', () => {
    const { world, runtime } = rig();
    const close = driveInputFor(world, runtime, { x: 0, y: 0, z: VEHICLE_DISMOUNT_M / 2 });
    expect(close.moveZ).toBe(0);
    expect(close.use).toBe(true);
  });

  it('holds jets only when the goal is above the craft', () => {
    const { world, runtime } = rig();
    expect(driveInputFor(world, runtime, { x: 0, y: 0, z: 200 }).jet).toBe(false);
    // A flag stand sits about 21 m up on a base deck; without the climb the craft can only
    // ever get underneath it.
    expect(driveInputFor(world, runtime, { x: 0, y: 21, z: 200 }).jet).toBe(true);
  });

  it('escapes a craft that stops making progress, and not one that is closing', () => {
    const { world, runtime } = rig();
    // Closing 10 m a tick on a goal that stays far away: never a stall, however long it runs.
    // (The goal has to stay outside the dismount range -- arriving is a dismount, which is a
    // different rule and would make this loop assert the wrong thing.)
    for (let tick = 0; tick < 200; tick += 1) {
      const goal = { x: 0, y: 0, z: 5000 - tick * 10 };
      expect(driveInputFor(world, runtime, goal).use).toBe(false);
    }
    // Now a goal it cannot reach: same distance every tick.
    const stuck = { x: 0, y: 0, z: 500 };
    let escapedAt = -1;
    for (let tick = 0; tick < 200 && escapedAt === -1; tick += 1) {
      if (driveInputFor(world, runtime, stuck).use) escapedAt = tick;
    }
    expect(escapedAt).toBeGreaterThan(0);
    expect(escapedAt).toBeLessThan(200);
  });
});

describe('vehicleDetourGoal', () => {
  it('is null for a short leg, and for a bot already riding', () => {
    const world = createWorld(flat, 1);
    const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addVehicle(world, { team: 1, x: 0, y: 0, z: 20 });
    // A leg under the threshold is a walk, not a ride.
    expect(
      vehicleDetourGoal(world, playerId, { x: 0, y: 0, z: VEHICLE_MIN_LEG_M - 10 }),
    ).toBeNull();
    // A bot already in a craft must keep steering at its real target: a vehicle goal here
    // would read as "arrived" and dismount on the spot.
    world.players.mountedVehicleId[playerId] = 0;
    expect(vehicleDetourGoal(world, playerId, { x: 0, y: 0, z: 5000 })).toBeNull();
  });

  it('takes a same-team craft on a long leg and ignores one it cannot use', () => {
    const world = createWorld(flat, 1);
    const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const far = { x: 0, y: 0, z: VEHICLE_MIN_LEG_M + 200 };
    // Enemy craft, destroyed craft and an occupied one are all unusable, so the answer is a
    // walk rather than a detour to something the sim would refuse to mount.
    const enemy = addVehicle(world, { team: 2, x: 0, y: 0, z: 10 });
    expect(vehicleDetourGoal(world, playerId, far)).toBeNull();
    world.vehicles.destroyed[enemy] = 1;
    expect(vehicleDetourGoal(world, playerId, far)).toBeNull();
    const mine = addVehicle(world, { team: 1, x: 0, y: 0, z: 30 });
    expect(vehicleDetourGoal(world, playerId, far)?.key).toBe(`vehicle:${String(mine)}`);
    world.vehicles.driverId[mine] = 7;
    expect(vehicleDetourGoal(world, playerId, far)).toBeNull();
  });

  it('gives a carrier a longer reach for its craft than an attacker gets', () => {
    // The carrier has about 1,060 m to walk home, so it will fetch a craft from further away
    // than an attacker will: measured 0, 7, 30 and 86 m closest approaches at the attacker's
    // 200 m against the first capture at the carrier's 400 m.
    const world = createWorld(flat, 1);
    const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const distance = VEHICLE_DETOUR_M + 50;
    addVehicle(world, { team: 1, x: 0, y: 0, z: distance });
    const far = { x: 0, y: 0, z: VEHICLE_MIN_LEG_M + 500 };
    expect(vehicleDetourGoal(world, playerId, far)).toBeNull();
    expect(vehicleDetourGoal(world, playerId, far, VEHICLE_CARRIER_DETOUR_M)).not.toBeNull();
  });
});
