import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  BaseObjectKind,
  createBaseObjects,
  createFlags,
  createWorld,
  FlagState,
  LIGHT_ARMOR,
  PICKUP_RADIUS,
  stepFlags,
  stepPower,
  stepWorld,
  type Heightfield,
  type World,
} from '@clans/sim';
import { OrderKind, type TeamOrder } from '@clans/protocol';
import {
  CARRIER_HOLD_STANDOFF_M,
  CARRIER_RECOVER_M,
  CARRIER_STAGE_FROM_ENEMY_M,
  CARRIER_STAGE_RADIUS_M,
  CARRIER_STAGE_WAIT_TICKS,
  decideCombat,
  decideGoal,
  decideState,
  ESCORT_AHEAD_M,
  ESCORT_CLOSE_M,
  ESCORT_ENGAGE_M,
  ESCORT_STANDOFF_M,
  stepBot,
  stepBots,
} from './brain.js';
import { buildWaypointGraph } from './waypoints.js';
import { BotRole, BotState, createBotRuntimeState } from './types.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: -500,
  originY: 0,
  originZ: 500,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function setupFlags(world: ReturnType<typeof createWorld>): void {
  createFlags(world, [
    { team: 1, position: { x: -100, y: 0, z: 0 } },
    { team: 2, position: { x: 100, y: 0, z: 0 } },
  ]);
}

describe('decideGoal', () => {
  it('an Attacker whose flag is home and who is not the enemy carrier heads to the enemy flag', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: 100, y: 0, z: 0 });
    expect(goal.key).toBe('enemyFlag:1');
  });

  it('an Attacker carrying the enemy flag heads to its own flag stand', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.flags.carrierId[1] = bot;
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: -100, y: 0, z: 0 });
    expect(goal.key).toBe('home:0');
  });

  it('a Defender with no teammate carrying the enemy flag holds at its own flag stand', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: -100, y: 0, z: 0 });
    expect(goal.key).toBe('home:0');
  });

  it('a Defender with a living teammate carrying the enemy flag escorts them, holding ESCORT_STANDOFF_M off the carrier', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const carrier = addPlayer(world, { x: 20, y: 0, z: 30 }, 1);
    world.flags.carrierId[1] = carrier;
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    // The hold point sits on the ray from the carrier toward the escort, exactly
    // ESCORT_STANDOFF_M out: pressing onto the carrier itself shoves it off its route
    // (players collide), so a bodyguard parks a body-width back on its own side.
    const from = { x: 20, y: 0, z: 30 };
    const toward = Math.hypot(0 - from.x, 0 - from.z);
    const expected = {
      x: from.x + ((0 - from.x) / toward) * ESCORT_STANDOFF_M,
      y: 0,
      z: from.z + ((0 - from.z) / toward) * ESCORT_STANDOFF_M,
    };
    expect(goal.position.x).toBeCloseTo(expected.x, 5);
    expect(goal.position.y).toBeCloseTo(expected.y, 5);
    expect(goal.position.z).toBeCloseTo(expected.z, 5);
    expect(goal.key).toBe(`escort:${String(carrier)}`);
  });

  it('a Defender whose own flag is carried by an enemy hunts that carrier (issue #32)', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const thief = addPlayer(world, { x: 55, y: 0, z: -12 }, 2);
    world.flags.carrierId[0] = thief;
    world.flags.state[0] = FlagState.Carried;
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: 55, y: 0, z: -12 });
    expect(goal.key).toBe(`intercept:${String(thief)}`);
  });

  it('intercepting a thief outranks escorting a teammate carrier (issue #32)', () => {
    // Without our own flag home, a capture is refused outright (flags.ts's ownFlagHome),
    // so the thief is the more valuable target even with a teammate carrier to escort.
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const thief = addPlayer(world, { x: 55, y: 0, z: -12 }, 2);
    const mate = addPlayer(world, { x: 20, y: 0, z: 30 }, 1);
    world.flags.carrierId[0] = thief;
    world.flags.state[0] = FlagState.Carried;
    world.flags.carrierId[1] = mate;
    world.flags.state[1] = FlagState.Carried;
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe(`intercept:${String(thief)}`);
  });

  it('a bot below LOW_HEALTH_FRACTION heads to its nearest friendly station ahead of any CTF goal (Codex review round 1, P1)', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.damage[bot] = 0.9; // Light armor maxDamage 1.0 -- well under LOW_HEALTH_FRACTION.
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: 5, y: 0, z: 0 });
    expect(goal.key).toBe('heal:1');
  });

  it('a healthy bot with no station nearby is unaffected -- decideHealGoal is a no-op', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('enemyFlag:1');
  });
});

describe('decideGoal with an order', () => {
  it('an Attack order overrides the normal CTF goal for an Attacker', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const order: TeamOrder = {
      team: 1,
      kind: OrderKind.Attack,
      x: 200,
      z: 300,
      expiresAtTick: 1000,
    };
    const goal = decideGoal(world, runtime, order);
    expect(goal).toEqual({ position: { x: 200, y: 0, z: 300 }, key: 'order:attack' });
  });

  it("an order for the OTHER team never affects this bot's goal", () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const order: TeamOrder = {
      team: 2,
      kind: OrderKind.Attack,
      x: 200,
      z: 300,
      expiresAtTick: 1000,
    };
    const goal = decideGoal(world, runtime, order);
    expect(goal.key).not.toBe('order:attack');
    expect(goal.key).toBe('enemyFlag:1');
  });

  it('row 21: an expired order (null from currentOrder) falls back to the normal CTF goal', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).not.toMatch(/^order:/);
  });

  it('row 24: a Repair order with no reachable powered station keeps the bot heading toward the nearest one, never gives up', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    world.baseObjects.destroyed[0] = 1; // generator destroyed -- the station has no power.
    stepPower(world);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const order: TeamOrder = { team: 1, kind: OrderKind.Repair, x: 50, z: 50, expiresAtTick: 1000 };
    const goal = decideGoal(world, runtime, order);
    expect(goal.key).toBe('order:repair-equip');
    expect(goal.position).toEqual({ x: 50, y: 0, z: 50 });
    // Repower the station and call again -- still tries, never latches a give-up flag.
    world.baseObjects.destroyed[0] = 0;
    stepPower(world);
    const goalAfterRepower = decideGoal(world, runtime, order);
    expect(goalAfterRepower.key).toBe('order:repair-equip');
    expect(goalAfterRepower.position).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('a Repair order, once the bot already has a Repair Pack, targets the order location directly', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[bot] = 1;
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const order: TeamOrder = { team: 1, kind: OrderKind.Repair, x: 50, z: 50, expiresAtTick: 1000 };
    expect(decideGoal(world, runtime, order)).toEqual({
      position: { x: 50, y: 0, z: 50 },
      key: 'order:repair',
    });
  });

  it('a Defend order overrides the normal CTF goal for a Defender', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const order: TeamOrder = {
      team: 1,
      kind: OrderKind.Defend,
      x: 150,
      z: -20,
      expiresAtTick: 1000,
    };
    const goal = decideGoal(world, runtime, order);
    expect(goal).toEqual({ position: { x: 150, y: 0, z: -20 }, key: 'order:defend' });
  });

  it('a critically damaged bot still routes to a station ahead of any active order', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.damage[bot] = 0.9;
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const order: TeamOrder = {
      team: 1,
      kind: OrderKind.Attack,
      x: 200,
      z: 300,
      expiresAtTick: 1000,
    };
    const goal = decideGoal(world, runtime, order);
    expect(goal.key).toBe('heal:1');
  });
});

describe('decideCombat (failure matrix row 9)', () => {
  it('drops an engaged target that dies between two calls and re-derives a fresh decision the same tick', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: 5, y: 0, z: 0 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const first = decideCombat(world, runtime);
    expect(first.targetId).toBe(enemy);
    world.players.alive[enemy] = 0;
    expect(() => decideCombat(world, runtime)).not.toThrow();
    const second = decideCombat(world, runtime);
    expect(second.targetId).toBeNull();
    expect(runtime.engagedTargetId).toBe(-1);
  });

  it('an escort target that is killed is dropped, falling back to decideGoal on the next call', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const carrier = addPlayer(world, { x: 20, y: 0, z: 30 }, 1);
    world.flags.carrierId[1] = carrier;
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    expect(decideGoal(world, runtime, null).key).toBe(`escort:${String(carrier)}`);
    world.players.alive[carrier] = 0;
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
  });
});

describe('defender leash (issue #32)', () => {
  it('a Defender whose post is gone engages beyond DEFEND_ENGAGE_RADIUS: own flag away', () => {
    // The previous code leashed every Defender to DEFEND_ENGAGE_RADIUS around the home
    // stand regardless of the game state -- an interceptor 500 m out chasing the enemy
    // carrier never fired a shot. With the own flag away there IS no post to hold.
    const world = createWorld(flat, 1);
    setupFlags(world);
    // Home stand (flag 0) at (-100, 0, 0): a target 500 m west of it is far outside the
    // 120 m leash but inside VISION_RANGE (150 m) of the defender standing with it.
    const bot = addPlayer(world, { x: -120, y: 0, z: 0 }, 1);
    const thief = addPlayer(world, { x: -135, y: 0, z: 0 }, 2);
    world.flags.carrierId[0] = thief;
    world.flags.state[0] = FlagState.Carried;
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    expect(decideCombat(world, runtime).targetId).toBe(thief);
  });

  it('a Defender escorting a carrier engages beyond DEFEND_ENGAGE_RADIUS', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: -120, y: 0, z: 0 }, 1);
    const carrier = addPlayer(world, { x: -118, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: -135, y: 0, z: 0 }, 2);
    world.flags.carrierId[1] = carrier;
    world.flags.state[1] = FlagState.Carried;
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    expect(decideCombat(world, runtime).targetId).toBe(enemy);
  });

  it('a Defender still holding a post keeps the DEFEND_ENGAGE_RADIUS leash', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    // Defender 100 m from the home stand (-100, 0, 0); enemy 140 m from the stand --
    // outside the 120 m leash but inside the defender's 150 m vision range.
    const bot = addPlayer(world, { x: -200, y: 0, z: 0 }, 1);
    addPlayer(world, { x: -240, y: 0, z: 0 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    expect(decideCombat(world, runtime).targetId).toBeNull();
  });
});

describe('decideState', () => {
  it('reports Idle with no engaged target', () => {
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    expect(decideState(runtime, null)).toBe(BotState.Idle);
  });

  it('reports Attack for an Attacker engaged with a target', () => {
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    expect(decideState(runtime, 5)).toBe(BotState.Attack);
  });

  it('reports Defend for a Defender engaged with a target', () => {
    const runtime = createBotRuntimeState(1, BotRole.Defender, 1);
    expect(decideState(runtime, 5)).toBe(BotState.Defend);
  });
});

describe('stepBot', () => {
  it('heals a bot standing near a powered own-team station in the same tick it needs healing', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    world.players.damage[bot] = 0.9;
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 10, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    stepBot(world, graph, runtime, null);
    expect(world.players.damage[bot]).toBe(0);
  });

  it('does not heal a bot that is horizontally in range but vertically outside STATION_USE_RADIUS (Codex review round 2, P2)', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 10, y: 10, z: 0 }, 1);
    world.players.damage[bot] = 0.9;
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 10, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    stepBot(world, graph, runtime, null);
    expect(world.players.damage[bot]).toBe(0.9);
  });

  it("sets 'slot' to the weapon combat.ts actually chose while engaged, not 0 (Codex review round 2, P2)", () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 0, y: 0, z: 5 }, 2); // close enemy -> chooseWeapon picks the Chaingun (WeaponId 1)
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    const input = stepBot(world, graph, runtime, null);
    expect(input.slot).toBe(2); // WeaponId.Chaingun (1) + 1
  });

  it("returns an object satisfying every field of PlayerInput, including 'use'", () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    const input = stepBot(world, graph, runtime, null);
    for (const field of [
      'moveX',
      'moveZ',
      'yaw',
      'pitch',
      'jump',
      'jet',
      'fire',
      'altFire',
      'slot',
      'packActive',
      'use',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(input, field)).toBe(true);
    }
    expect(typeof input.use).toBe('boolean');
  });

  it('sets use: true once a bot with no active CTF priority walks within MOUNT_RANGE of a mountable own-team vehicle', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    // A Defender with no dropped own flag and no carrier to escort falls through to the
    // vehicle-mount fallback goal (Task 7) instead of standing idle at the flag stand.
    const bot = addPlayer(world, { x: 2, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const vehicleStore = world.vehicles;
    const vehicleId = vehicleStore.count;
    vehicleStore.count += 1;
    vehicleStore.active[vehicleId] = 1;
    vehicleStore.destroyed[vehicleId] = 0;
    vehicleStore.driverId[vehicleId] = -1;
    vehicleStore.team[vehicleId] = 1;
    vehicleStore.position.set([2, 0, 0], vehicleId * 3);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    const input = stepBot(world, graph, runtime, null);
    expect(input.use).toBe(true);
  });

  it('sets use: false when an active CTF goal is present even with a vehicle nearby', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 2, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const vehicleStore = world.vehicles;
    const vehicleId = vehicleStore.count;
    vehicleStore.count += 1;
    vehicleStore.active[vehicleId] = 1;
    vehicleStore.destroyed[vehicleId] = 0;
    vehicleStore.driverId[vehicleId] = -1;
    vehicleStore.team[vehicleId] = 1;
    vehicleStore.position.set([2, 0, 0], vehicleId * 3);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    const input = stepBot(world, graph, runtime, null);
    expect(input.use).toBe(false);
  });

  it('ignores a repair order from the opposing team when deciding whether to activate its Repair Pack', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[bot] = 1;
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    const order: TeamOrder = { team: 2, kind: OrderKind.Repair, x: 50, z: 50, expiresAtTick: 1000 };

    expect(stepBot(world, graph, runtime, order).packActive).toBe(false);
  });
});

describe('combat actually lands hits end to end (Codex review round 3, P1)', () => {
  it('a bot firing at a stationary enemy 10 m away deals real damage within a few ticks', () => {
    // Direct reproduction of the review's own probe: aimAndFire previously aimed and fired
    // from the player's feet position instead of the real fire origin (MUZZLE_HEIGHT above
    // it), so the ray missed the target's hit sphere every time even while this file's own
    // tolerance check reported fire: true.
    const world = createWorld(flat, 1, 4);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: 0, y: 0, z: 10 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph([
      { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
      { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
    ]);
    for (let tick = 0; tick < 40; tick += 1) {
      const inputs = stepBots(world, graph, new Map([[bot, runtime]]), new Map());
      stepWorld(world, inputs);
    }
    expect(world.players.damage[enemy]).toBeGreaterThan(0);
  });
});

/** Distance from a goal to team 1's flag stand -- the capture gate is flags.ts's
 *  PICKUP_RADIUS against exactly this point, so every hold assertion measures it. */
function standGap(goal: { x: number; y: number; z: number }): number {
  return Math.hypot(goal.x + 500, goal.y, goal.z);
}

/** The launch-cohesion and home-leg scenarios need a map whose stands are a realistic
 *  distance apart (Katabatic is ~1 km): on the 200 m fixture above, "200 m out from the
 *  enemy stand" IS the home stand, so the staging line would not exist at all. Team 1 holds
 *  (-500, 0, 0) and team 2 (500, 0, 0), which makes flag 1 the enemy flag and the staging
 *  point (300, 0, 0). */
function longMapFlags(world: World): void {
  createFlags(world, [
    { team: 1, position: { x: -500, y: 0, z: 0 } },
    { team: 2, position: { x: 500, y: 0, z: 0 } },
  ]);
}

/** Team 1's own flag out of the base and carried by an enemy `thiefX` metres along the x
 *  axis; returns the thief's player id. */
function ownFlagStolenBy(world: World, thiefX: number): number {
  const thief = addPlayer(world, { x: thiefX, y: 0, z: 0 }, 2);
  world.flags.carrierId[0] = thief;
  world.flags.state[0] = FlagState.Carried;
  return thief;
}

/** The carrier itself: a team-1 bot holding the enemy flag. */
function takeEnemyFlag(world: World, at: { x: number; y: number; z: number }): number {
  const bot = addPlayer(world, at, 1);
  world.flags.carrierId[1] = bot;
  world.flags.state[1] = FlagState.Carried;
  return bot;
}

describe('carrier home leg (issue #32 home-leg economy)', () => {
  it('a carrier whose own flag is carried by a distant thief holds inside the capture radius, not at the stand point', () => {
    // The mechanism: flags.ts's tryCapture refuses while ownFlagHome is false, so the carry
    // converts only on the tick the own flag comes back -- and only if the carrier is still
    // within PICKUP_RADIUS (2 m, 3D) of the stand then. The thief is deliberately outside
    // CARRIER_RECOVER_M, and the carrier is past the staging line (500 m from home against
    // the stage point's 800), so this is the pure hold case.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    ownFlagStolenBy(world, 300);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
    // The hold point sits CARRIER_HOLD_STANDOFF_M off the stand (one body-width back, off
    // the exact stand point a teammate would be colliding on) and therefore inside the
    // 2 m capture radius with margin to spare.
    expect(standGap(goal.position)).toBeCloseTo(CARRIER_HOLD_STANDOFF_M, 5);
    expect(standGap(goal.position)).toBeLessThan(PICKUP_RADIUS);
  });

  it('a carrier whose own flag is dropped away holds inside the capture radius instead of backing off', () => {
    // Two mechanisms in one: the own flag is away in the OTHER way flags.ts models (Dropped
    // reads not-Home, so the capture is refused just the same), and a visible enemy stands
    // inside REGROUP_ENEMY_M with no teammate within REGROUP_FRIENDLY_M -- exactly the
    // regroup case, which is suppressed here. Before this change the carrier retreated to
    // the regroup point 80 m along its own ray, i.e. past the stand and out of the capture
    // radius, at the moment it could least afford it.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    addPlayer(world, { x: 20, y: 0, z: 0 }, 2);
    world.flags.carrierId[0] = -1;
    world.flags.state[0] = FlagState.Dropped;
    world.flags.position.set([300, 0, 0], 0);
    world.flags.returnAt[0] = 9999;
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
    expect(standGap(goal.position)).toBeCloseTo(CARRIER_HOLD_STANDOFF_M, 5);
    expect(standGap(goal.position)).toBeLessThan(PICKUP_RADIUS);
  });

  it('a carrier whose own flag is carried by a thief inside CARRIER_RECOVER_M goes to take that flag back instead of holding', () => {
    // The explicit preference call: the enemy flag aboard is worth nothing until the own
    // flag returns, so inside the recovery envelope the carrier spends the carry on the one
    // thing that makes it convertible -- the thief -- and the goal key is the defender
    // duty's own `intercept:<id>`.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    const thief = ownFlagStolenBy(world, CARRIER_RECOVER_M - 5);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: CARRIER_RECOVER_M - 5, y: 0, z: 0 });
    expect(goal.key).toBe(`intercept:${String(thief)}`);
  });

  it('a carrier whose own flag is Home still heads to the stand itself -- no hold offset, no recovery', () => {
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: -500, y: 0, z: 0 });
    expect(goal.key).toBe('home:0');
  });

  it('an enemy who is not carrying our flag does not pull the holding carrier off the stand', () => {
    // The recovery case keys on the THIEF (findEnemyFlagCarrier), never on a nearby enemy:
    // this one stands well inside CARRIER_RECOVER_M carrying nothing, and the carrier still
    // holds -- its carry has no business chasing a random body.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    addPlayer(world, { x: 20, y: 0, z: 0 }, 2);
    ownFlagStolenBy(world, 300);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
    expect(standGap(goal.position)).toBeLessThan(PICKUP_RADIUS);
  });

  it('a Defender that picked the enemy flag up holds the home leg too -- the carry outranks the role', () => {
    // Before this, only decideAttackerGoal had a carrier branch: a Defender carrier fell
    // through to escort/intercept/vehicle-mount and could walk its flag back out of the
    // base. The carry is the same job in either role.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    ownFlagStolenBy(world, 300);
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
    expect(standGap(goal.position)).toBeLessThan(PICKUP_RADIUS);
  });
});

describe('carrier heal economy (issue #32 home-leg economy)', () => {
  it('a healthy holding carrier takes no heal detour', () => {
    // 0.55 health is below CARRIER_HEAL_HEALTH_FRACTION (0.6), so before this change the
    // carrier's own top-up gate fired and this station (marginal 10 m -- trivially inside
    // CARRIER_HEAL_MAX_MARGINAL_M) pulled it off the stand. With the own flag away the hold
    // outranks the top-up: the capture window is what the carry is for.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    world.players.damage[bot] = LIGHT_ARMOR.maxDamage * 0.45; // 0.55 health.
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    ownFlagStolenBy(world, 300);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
    expect(standGap(goal.position)).toBeLessThan(PICKUP_RADIUS);
  });

  it('a holding carrier below LOW_HEALTH_FRACTION may still leave for a station', () => {
    // The valve at the other end: below 0.4 the carrier dies to the next exchange and a
    // dead carrier drops the flag, so survival outranks a hold it was going to lose anyway.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    world.players.damage[bot] = LIGHT_ARMOR.maxDamage * 0.65; // 0.35 health.
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    ownFlagStolenBy(world, 300);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    expect(decideGoal(world, runtime, null).key).toBe('heal:1');
  });

  it('a carrier with its own flag Home still takes its usual top-up detour below 0.6', () => {
    // The suppression is scoped to the own-flag-away window: with a live capture to protect
    // the existing 0.6 top-up line is unchanged.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    world.players.damage[bot] = LIGHT_ARMOR.maxDamage * 0.45; // 0.55 health.
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    expect(decideGoal(world, runtime, null).key).toBe('heal:1');
  });
});

describe('launch cohesion (issue #32)', () => {
  it('a carrier that just took the flag stages for company instead of starting the return leg alone', () => {
    // The HARNESS telemetry this exists for: 21 carrier runs, 16 deaths, 15 credited to an
    // enemy player at a median 647 m from the carrier's own stand, best closest approach to
    // its own stand 272 m. The carrier is the body that took the flag, so the return leg
    // starts with nobody near it -- here, nothing at all inside CARRIER_STAGE_RADIUS_M.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 400, y: 0, z: 0 }); // 100 m off the enemy stand, 900 m from home
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    // The stage point: CARRIER_STAGE_FROM_ENEMY_M out from the enemy stand, on the enemy
    // side of midfield, not loitering on the flag deck the turrets cover.
    expect(goal.position).toEqual({ x: 500 - CARRIER_STAGE_FROM_ENEMY_M, y: 0, z: 0 });
    expect(goal.position.x).toBeGreaterThan(0); // still the enemy half of a 1 km map.
    expect(goal.key).toBe('stage:0');
    expect(runtime.carrierStageSinceTick).toBe(world.tick); // the bounded wait started here.
  });

  it('the wait opens the moment CARRIER_STAGE_TEAMMATES are inside CARRIER_STAGE_RADIUS_M: the carrier walks', () => {
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 400, y: 0, z: 0 });
    addPlayer(world, { x: 380, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 400, y: 0, z: 60 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position).toEqual({ x: -500, y: 0, z: 0 });
    expect(goal.key).toBe('home:0');
    expect(runtime.carrierStageSinceTick).toBe(-1); // no wait was ever started.
  });

  it('one teammate is not company: the gate needs CARRIER_STAGE_TEAMMATES, not merely somebody', () => {
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 400, y: 0, z: 0 });
    addPlayer(world, { x: 380, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    expect(decideGoal(world, runtime, null).key).toBe('stage:0');
  });

  it('a teammate outside CARRIER_STAGE_RADIUS_M is not company either', () => {
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 400, y: 0, z: 0 });
    addPlayer(world, { x: 400 + CARRIER_STAGE_RADIUS_M + 5, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 400, y: 0, z: CARRIER_STAGE_RADIUS_M + 5 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    expect(decideGoal(world, runtime, null).key).toBe('stage:0');
  });

  it('the wait is bounded: after CARRIER_STAGE_WAIT_TICKS the carrier launches alone', () => {
    // The give-up. One tick short of the bound it is still staging; at the bound it walks,
    // so the wait can never become the new dead end (nor a permanent stall the harness's
    // stall-window gate would flag). Mid-match tick, so "expired" is not confusable with
    // the -1 "no wait in progress" sentinel.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    world.tick = CARRIER_STAGE_WAIT_TICKS * 2;
    const bot = takeEnemyFlag(world, { x: 400, y: 0, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.carrierStageSinceTick = world.tick - (CARRIER_STAGE_WAIT_TICKS - 1);
    expect(decideGoal(world, runtime, null).key).toBe('stage:0');
    runtime.carrierStageSinceTick = world.tick - CARRIER_STAGE_WAIT_TICKS;
    const launched = decideGoal(world, runtime, null);
    expect(launched.position).toEqual({ x: -500, y: 0, z: 0 });
    expect(launched.key).toBe('home:0');
    expect(runtime.carrierStageSinceTick).toBe(-1);
  });

  it('the staging clock is cleared when the carry ends, so a fresh take stages again instead of launching at once', () => {
    const world = createWorld(flat, 1);
    longMapFlags(world);
    world.tick = CARRIER_STAGE_WAIT_TICKS * 2;
    const bot = takeEnemyFlag(world, { x: 400, y: 0, z: 0 });
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.carrierStageSinceTick = world.tick - CARRIER_STAGE_WAIT_TICKS - 1; // an expired wait
    expect(decideGoal(world, runtime, null).key).toBe('home:0'); // expired: launches
    world.flags.carrierId[1] = -1; // the flag is dropped/returned -- the carry is over
    world.flags.state[1] = FlagState.Home;
    decideGoal(world, runtime, null);
    expect(runtime.carrierStageSinceTick).toBe(-1);
    world.flags.carrierId[1] = bot; // a fresh take (flag 1 is Home again)
    world.flags.state[1] = FlagState.Carried;
    expect(decideGoal(world, runtime, null).key).toBe('stage:0');
    expect(runtime.carrierStageSinceTick).toBe(world.tick);
  });

  it('a carrier already past the stage line walks home rather than turning back to the rendezvous', () => {
    // Walking backwards off its own route is the documented carrier failure; the stage point
    // is only ever offered while the carrier is still on the enemy side of it.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 }); // 500 m from home; the stage point is 800
    ownFlagStolenBy(world, 300);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
    expect(standGap(goal.position)).toBeLessThan(PICKUP_RADIUS);
    expect(runtime.carrierStageSinceTick).toBe(-1);
  });

  it('an escort far behind a STATIONARY carrier closes on it instead of picketing 100 m ahead of a parked point', () => {
    // The escort side of the gate: a staging carrier is stationary (its stage goal collapses
    // onto its own position), and ESCORT_AHEAD_M along the route home is a point it will
    // never walk to. Closing on the body is also what satisfies the company count.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const escort = addPlayer(world, { x: -300, y: 0, z: 0 }, 1);
    const carrier = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    const runtime = createBotRuntimeState(escort, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe(`escort:${String(carrier)}`);
    expect(goal.position.x).toBeCloseTo(-ESCORT_STANDOFF_M, 5);
    expect(goal.position.z).toBeCloseTo(0, 5);
  });

  it('a MOVING carrier still gets the picket ESCORT_AHEAD_M along its route home', () => {
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const escort = addPlayer(world, { x: -300, y: 0, z: 0 }, 1);
    const carrier = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    world.players.velocity.set([-10, 0, 0], carrier * 3); // running home, well over CARRIER_STILL_SPEED_MPS
    const runtime = createBotRuntimeState(escort, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe(`escort:${String(carrier)}`);
    expect(goal.position.x).toBeCloseTo(-ESCORT_AHEAD_M, 5);
  });

  it('an escort far behind a carrier with a LIVE THREAT abandons the picket for engagement range on the threat side', () => {
    // The measured death: one enemy, point blank, no teammate within 100 m while the
    // bodyguard paces ESCORT_AHEAD_M up the route. The escort is 300 m out here and the
    // carrier's killer is 60 m off it, so the picket point (-100, 0, 0) is nowhere near the
    // fight; the threat-side station is ESCORT_ENGAGE_M out from the carrier toward the
    // enemy, well inside both bodies' weapon envelopes.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const escort = addPlayer(world, { x: -300, y: 0, z: 0 }, 1);
    const carrier = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    addPlayer(world, { x: 0, y: 0, z: 60 }, 2); // visible from the carrier (VISION_RANGE 150, flat LOS)
    world.players.velocity.set([-10, 0, 0], carrier * 3); // and the carrier is running, not staging
    const runtime = createBotRuntimeState(escort, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe(`escort:${String(carrier)}`);
    expect(goal.position.x).toBeCloseTo(0, 5);
    expect(goal.position.z).toBeCloseTo(ESCORT_ENGAGE_M, 5);
  });

  it('a threat already inside ESCORT_ENGAGE_M clamps the station to the threat itself', () => {
    // 17 m is the telemetry's median killer distance: the escort's station is the enemy,
    // because there is no room between the two bodies for anything else.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const escort = addPlayer(world, { x: -300, y: 0, z: 0 }, 1);
    const carrier = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    const killer = addPlayer(world, { x: 0, y: 0, z: 17 }, 2);
    const runtime = createBotRuntimeState(escort, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe(`escort:${String(carrier)}`);
    expect(goal.position).toEqual({ x: 0, y: 0, z: 17 });
    expect(world.players.team[killer]).toBe(2);
  });

  it('an enemy the carrier cannot see does not pull the escort off the picket', () => {
    // findCarrierThreat is visible-from-the-CARRIER, inside CARRIER_THREAT_RADIUS_M: an
    // enemy far outside that envelope leaves the escort pacing exactly as before.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const escort = addPlayer(world, { x: -300, y: 0, z: 0 }, 1);
    const carrier = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    addPlayer(world, { x: 0, y: 0, z: 300 }, 2); // 300 m from the carrier: outside the envelope
    world.players.velocity.set([-10, 0, 0], carrier * 3);
    const runtime = createBotRuntimeState(escort, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position.x).toBeCloseTo(-ESCORT_AHEAD_M, 5);
  });

  it('a hurt carrier still pulls the no-threat picket in to ESCORT_CLOSE_M (CARRIER_CLOSE_HEALTH unchanged)', () => {
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const escort = addPlayer(world, { x: -300, y: 0, z: 0 }, 1);
    const carrier = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    world.players.damage[carrier] = LIGHT_ARMOR.maxDamage * 0.3; // 0.7 health, under CARRIER_CLOSE_HEALTH
    world.players.velocity.set([-10, 0, 0], carrier * 3);
    const runtime = createBotRuntimeState(escort, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.position.x).toBeCloseTo(-ESCORT_CLOSE_M, 5);
  });
});

describe('the hold is a real capture window (issue #32)', () => {
  it('the sim captures on the tick the own flag returns Home while the carrier holds', () => {
    // Mechanism proof, not a goal-shape check: stand the carrier exactly where the hold
    // goal says to stand, drive the real flags step, and watch the refusal turn into a
    // capture on the very tick the own flag comes back.
    const world = createWorld(flat, 1);
    longMapFlags(world);
    const bot = takeEnemyFlag(world, { x: 0, y: 0, z: 0 });
    ownFlagStolenBy(world, 300);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime, null);
    expect(goal.key).toBe('home:0');
    world.players.position.set([goal.position.x, goal.position.y, goal.position.z], bot * 3);
    world.flags.position.set([goal.position.x, goal.position.y, goal.position.z], 3);

    stepFlags(world, 0.032);
    expect(world.teamScores[1]).toBe(0); // own flag away: refused outright (row 3)
    expect(world.flags.carrierId[1]).toBe(bot);

    // The own flag comes back -- by a kill, a touch, or the 45 s timer, the carrier does
    // not care which.
    world.flags.carrierId[0] = -1;
    world.flags.state[0] = FlagState.Home;
    world.flags.position.set([-500, 0, 0], 0);
    stepFlags(world, 0.032);
    expect(world.teamScores[1]).toBe(100);
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.flags.carrierId[1]).toBe(-1);
  });
});

describe('defender duty split (issue #32)', () => {
  it('the parity split puts one defender on the thief and one on our carrier, on the within-team index rather than raw id', () => {
    // squadIndex counts same-team players with a lower id, so the enemy sitting between the
    // two defenders (a lower raw id, wrong team) must not shift the split -- plain id parity
    // was the failure this replaced.
    const world = createWorld(flat, 1);
    setupFlags(world);
    const thief = addPlayer(world, { x: 55, y: 0, z: -12 }, 2); // id 0, carries OUR flag
    const first = addPlayer(world, { x: 0, y: 0, z: 0 }, 1); // team 1, squadIndex 0
    addPlayer(world, { x: 300, y: 0, z: 0 }, 2); // id 2, enemy filler
    const second = addPlayer(world, { x: -20, y: 0, z: 20 }, 1); // team 1, squadIndex 1
    const mate = addPlayer(world, { x: 20, y: 0, z: 30 }, 1); // id 4, carries the ENEMY flag
    world.flags.carrierId[0] = thief;
    world.flags.state[0] = FlagState.Carried;
    world.flags.carrierId[1] = mate;
    world.flags.state[1] = FlagState.Carried;
    const firstGoal = decideGoal(world, createBotRuntimeState(first, BotRole.Defender, 1), null);
    expect(firstGoal.position).toEqual({ x: 55, y: 0, z: -12 });
    expect(firstGoal.key).toBe(`intercept:${String(thief)}`);
    const secondGoal = decideGoal(world, createBotRuntimeState(second, BotRole.Defender, 1), null);
    expect(secondGoal.key).toBe(`escort:${String(mate)}`);
  });

  it('with no teammate carrying, every defender intercepts the thief -- the odd half is not starved of the chase', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const thief = addPlayer(world, { x: 55, y: 0, z: -12 }, 2);
    const first = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const second = addPlayer(world, { x: -20, y: 0, z: 20 }, 1);
    world.flags.carrierId[0] = thief;
    world.flags.state[0] = FlagState.Carried;
    for (const id of [first, second]) {
      const goal = decideGoal(world, createBotRuntimeState(id, BotRole.Defender, 1), null);
      expect(goal.key).toBe(`intercept:${String(thief)}`);
    }
  });

  it('with no thief, every defender escorts our carrier -- the even half is not starved of the bodyguard duty', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const first = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const second = addPlayer(world, { x: -20, y: 0, z: 20 }, 1);
    const mate = addPlayer(world, { x: -60, y: 0, z: 40 }, 1);
    world.flags.carrierId[1] = mate;
    world.flags.state[1] = FlagState.Carried;
    for (const id of [first, second]) {
      const goal = decideGoal(world, createBotRuntimeState(id, BotRole.Defender, 1), null);
      expect(goal.key).toBe(`escort:${String(mate)}`);
    }
  });
});

/** Issue #32, the wiring half of the COMBAT slice: combat.ts's rules are only live once
 *  decideCombat consults them. These tests drive the real `stepBot`/`decideCombat`, not
 *  the predicates, because the predicate tests cannot catch a missing call site -- the
 *  failure this wave was one integration line away from shipping with no test at all.
 *
 *  The fire-discipline property is stronger than "does not shoot", because an aim solution
 *  is also a steering command: brain.ts composes `yaw = aiming ? combat.yaw :
 *  move.headingYaw`, so a carrier that engages a distant enemy walks toward it. The
 *  assertion that matters is the heading, so both tests below check the heading, and the
 *  control case differs only in whether the bot carries the flag. */
describe('carrier fire discipline and escort priority through decideCombat (issue #32)', () => {
  const LANDMARKS = [
    { position: { x: -100, y: 0, z: 0 }, label: 'homeFlag' },
    { position: { x: 100, y: 0, z: 0 }, label: 'enemyFlag' },
  ];

  it('a carrying bot heading home holds fire at range and keeps its route heading', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 0, y: 0, z: 60 }, 2); // 60 m: inside VISION_RANGE, past the 30 m envelope
    world.flags.carrierId[1] = bot; // team 2's flag, carried by our team-1 bot
    world.flags.state[1] = FlagState.Carried;
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph(LANDMARKS);
    const input = stepBot(world, graph, runtime, null);
    expect(input.fire).toBe(false);
    // Route home is toward -x; aiming at the enemy (straight +z) would put sin(yaw) at ~0.
    expect(Math.sin(input.yaw)).toBeLessThan(-0.5);
  });

  it('the same bot without the flag engages the identical enemy', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 0, y: 0, z: 60 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const graph = buildWaypointGraph(LANDMARKS);
    expect(stepBot(world, graph, runtime, null).fire).toBe(true);
  });

  it('an escort aims at the enemy threatening its carrier, not the nearer enemy to itself', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const escort = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 60 }, 1);
    world.flags.carrierId[1] = carrier;
    world.flags.state[1] = FlagState.Carried;
    const nearestToEscort = addPlayer(world, { x: 0, y: 0, z: 20 }, 2); // 20 m from escort, 40 m from carrier
    const nearestToCarrier = addPlayer(world, { x: 0, y: 0, z: 70 }, 2); // 10 m from carrier, 70 m from escort
    expect(decideCombat(world, createBotRuntimeState(escort, BotRole.Attacker, 1)).targetId).toBe(
      nearestToCarrier,
    );
    // Control: with nobody carrying, the nearer enemy to the escort is its own business.
    world.flags.carrierId[1] = -1;
    world.flags.state[1] = FlagState.Home;
    expect(decideCombat(world, createBotRuntimeState(escort, BotRole.Attacker, 1)).targetId).toBe(
      nearestToEscort,
    );
  });
});
