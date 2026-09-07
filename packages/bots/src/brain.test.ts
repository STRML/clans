import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  BaseObjectKind,
  createBaseObjects,
  createFlags,
  createWorld,
  stepPower,
  stepWorld,
  type Heightfield,
} from '@clans/sim';
import { decideCombat, decideGoal, decideState, stepBot, stepBots } from './brain.js';
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
    const goal = decideGoal(world, runtime);
    expect(goal.position).toEqual({ x: 100, y: 0, z: 0 });
    expect(goal.key).toBe('enemyFlag:1');
  });

  it('an Attacker carrying the enemy flag heads to its own flag stand', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.flags.carrierId[1] = bot;
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime);
    expect(goal.position).toEqual({ x: -100, y: 0, z: 0 });
    expect(goal.key).toBe('home:0');
  });

  it('a Defender with no teammate carrying the enemy flag holds at its own flag stand', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime);
    expect(goal.position).toEqual({ x: -100, y: 0, z: 0 });
    expect(goal.key).toBe('home:0');
  });

  it('a Defender with a living teammate carrying the enemy flag escorts them', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const carrier = addPlayer(world, { x: 20, y: 0, z: 30 }, 1);
    world.flags.carrierId[1] = carrier;
    const runtime = createBotRuntimeState(bot, BotRole.Defender, 1);
    const goal = decideGoal(world, runtime);
    expect(goal.position).toEqual({ x: 20, y: 0, z: 30 });
    expect(goal.key).toBe(`escort:${String(carrier)}`);
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
    const goal = decideGoal(world, runtime);
    expect(goal.position).toEqual({ x: 5, y: 0, z: 0 });
    expect(goal.key).toBe('heal:1');
  });

  it('a healthy bot with no station nearby is unaffected -- decideHealGoal is a no-op', () => {
    const world = createWorld(flat, 1);
    setupFlags(world);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const goal = decideGoal(world, runtime);
    expect(goal.key).toBe('enemyFlag:1');
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
    expect(decideGoal(world, runtime).key).toBe(`escort:${String(carrier)}`);
    world.players.alive[carrier] = 0;
    const goal = decideGoal(world, runtime);
    expect(goal.key).toBe('home:0');
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
    stepBot(world, graph, runtime);
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
    stepBot(world, graph, runtime);
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
    const input = stepBot(world, graph, runtime);
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
    const input = stepBot(world, graph, runtime);
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
    const input = stepBot(world, graph, runtime);
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
    const input = stepBot(world, graph, runtime);
    expect(input.use).toBe(false);
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
      const inputs = stepBots(world, graph, new Map([[bot, runtime]]));
      stepWorld(world, inputs);
    }
    expect(world.players.damage[enemy]).toBeGreaterThan(0);
  });
});
