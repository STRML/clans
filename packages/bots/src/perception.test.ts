import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  BaseObjectKind,
  createBaseObjects,
  createFlags,
  createWorld,
  stepPower,
  WeaponId,
  type Heightfield,
  type World,
} from '@clans/sim';
import {
  CARRIER_THREAT_RADIUS_M,
  damageMemoryTarget,
  ENGAGE_MEMORY_TICKS,
  findCarrierThreat,
  findEnemyFlagCarrier,
  findEscortedCarrier,
  findNearestFriendlyStation,
  findNearestVisibleEnemy,
  isCarryingEnemyFlag,
  needsHealing,
  refreshBotMemory,
  rememberSightedTarget,
  SEARCH_ARRIVE_M,
  searchMemoryPoint,
  VISION_RANGE,
} from './perception.js';
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

  it('returns a farther VISIBLE enemy when the nearest candidate is terrain-blocked', () => {
    // The scan marches candidates in ascending (distance, id) order and stops at the
    // first visible one (P2 ledger acceleration, docs/ISSUES.md): a nearer candidate that
    // fails its line-of-sight march must be skipped, not returned -- and the blocked
    // enemy here also has the LOWER id, so neither "first id wins" nor "nearest candidate
    // wins" can produce the right answer by accident.
    const world = createWorld(wallAcrossX(50), 1);
    const bot = addPlayer(world, { x: -5, y: 0, z: 0 }, 1);
    const blocked = addPlayer(world, { x: 5, y: 0, z: 0 }, 2); // 10 m, behind the wall
    const visible = addPlayer(world, { x: -40, y: 0, z: 0 }, 2); // 35 m, bot's own side
    expect(findNearestVisibleEnemy(world, bot)).toBe(visible);
    expect(blocked).toBeLessThan(visible); // the id order really is the hostile one
  });

  it('breaks an exact distance tie by the lower id', () => {
    // Mirror-image enemies are the same eye-to-hitbox distance to the bit (Math.hypot is
    // sign-symmetric), which is exactly the case the old strict-< fold settled by walking
    // ids ascending -- the (distance, id) preference order must agree with it.
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const lowerId = addPlayer(world, { x: 30, y: 0, z: 0 }, 2);
    addPlayer(world, { x: -30, y: 0, z: 0 }, 2);
    expect(findNearestVisibleEnemy(world, bot)).toBe(lowerId);
  });

  it('returns null when every candidate is terrain-blocked, not a partial answer', () => {
    const world = createWorld(wallAcrossX(50), 1);
    const bot = addPlayer(world, { x: -5, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 5, y: 0, z: 0 }, 2);
    addPlayer(world, { x: 7, y: 0, z: 3 }, 2);
    expect(findNearestVisibleEnemy(world, bot)).toBeNull();
  });

  it('returns null when there are no other players at all', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
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

describe('findEnemyFlagCarrier (issue #32)', () => {
  it('finds the enemy carrying OUR flag', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: -10, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const thief = addPlayer(world, { x: 5, y: 0, z: 0 }, 2);
    world.flags.carrierId[0] = thief;
    expect(findEnemyFlagCarrier(world, 1)).toBe(thief);
  });

  it('returns null when our flag sits home, dropped, or is carried by nobody alive', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: -10, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(findEnemyFlagCarrier(world, 1)).toBeNull(); // flag home, carrierId -1
    const dead = addPlayer(world, { x: 5, y: 0, z: 0 }, 2);
    world.players.alive[dead] = 0;
    world.flags.carrierId[0] = dead; // stale id from before the death cleared it
    expect(findEnemyFlagCarrier(world, 1)).toBeNull();
  });

  it('never reports a teammate as the thief of our own flag', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: -10, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const mate = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.flags.carrierId[0] = mate;
    expect(findEnemyFlagCarrier(world, 1)).toBeNull();
  });
});

describe('findCarrierThreat (issue #32 escort threat priority)', () => {
  it('returns the enemy nearest the CARRIER, measured from the carrier rather than the caller', () => {
    const world = createWorld(flat, 1);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 0, y: 0, z: 5 }, 1); // a teammate standing closest of all
    addPlayer(world, { x: 0, y: 0, z: 40 }, 2); // an enemy farther out than the nearest
    const nearest = addPlayer(world, { x: 0, y: 0, z: 10 }, 2);
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBe(nearest);
  });

  it('walks the radius edge: an enemy just inside is returned, one just outside is not', () => {
    const world = createWorld(flat, 1);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    // +/- 1 m of the edge rather than its exact metre: the measure is eye (feet + 1.6 m
    // muzzle height) to hitbox CENTRE (feet + half the armor height), so a target
    // "exactly" at the radius on the horizontal plane is a fraction of a metre past it.
    const enemy = addPlayer(world, { x: 0, y: 0, z: CARRIER_THREAT_RADIUS_M - 1 }, 2);
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBe(enemy);
    world.players.position[enemy * 3 + 2] = CARRIER_THREAT_RADIUS_M + 1;
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBeNull();
  });

  it('judges visibility from the CARRIER, not from whoever asks', () => {
    const world = createWorld(wallAcrossX(50), 1);
    const carrier = addPlayer(world, { x: -5, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 5, y: 0, z: 0 }, 2); // across the wall from the carrier
    const visible = addPlayer(world, { x: -5, y: 0, z: 20 }, 2);
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBe(visible);
  });

  it('skips a mounted enemy the carrier cannot shoot (failure matrix row 18)', () => {
    const world = createWorld(flat, 1);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const rider = addPlayer(world, { x: 0, y: 0, z: 10 }, 2);
    world.players.mountedVehicleId[rider] = 0;
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBeNull();
    world.players.mountedVehicleId[rider] = -1;
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBe(rider);
  });

  it('returns null for a dead, inactive, or out-of-world carrier', () => {
    const world = createWorld(flat, 1);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 0, y: 0, z: 10 }, 2);
    world.players.alive[carrier] = 0;
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBeNull();
    world.players.alive[carrier] = 1;
    world.players.active[carrier] = 0;
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBeNull();
    expect(findCarrierThreat(world, world.players.count + 5, CARRIER_THREAT_RADIUS_M)).toBeNull();
  });
});

describe('isCarryingEnemyFlag (issue #32 carrier fire discipline)', () => {
  it('is true only for the bot carrying the ENEMY flag', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: -10, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(isCarryingEnemyFlag(world, bot)).toBe(false);
    world.flags.carrierId[0] = bot; // our own flag is not the one carried home
    expect(isCarryingEnemyFlag(world, bot)).toBe(false);
    world.flags.carrierId[1] = bot; // the enemy flag is
    expect(isCarryingEnemyFlag(world, bot)).toBe(true);
    const mate = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    expect(isCarryingEnemyFlag(world, mate)).toBe(false);
  });
});

/** A resolved hitscan hit from `shooter` onto `victim`: the shape weapons.ts's FireEvent
 *  carries for the two weapons whose hit-test runs in the tick they fire (the Laser Rifle
 *  and the Chaingun's Tracer) -- the only exact damage attribution this sim can offer. */
function pushResolvedHit(world: World, shooter: number, victim: number): void {
  world.lastFireEvents.push({
    playerId: shooter,
    weaponId: WeaponId.LaserRifle,
    isAltFire: false,
    origin: { x: 0, y: 1.6, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    shooterVelocity: { x: 0, y: 0, z: 0 },
    energyScale: 1,
    hitPlayerId: victim,
    hitPoint: { x: 0, y: 1, z: 1 },
    projectileId: -1,
    resolved: true,
  });
}

describe('refreshBotMemory (T2 damage memory, dg.cs:812-815)', () => {
  it('names the nearest visible enemy as the source of a damage tick', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 30 }, 2);
    addPlayer(world, { x: 0, y: 0, z: 60 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime); // first sample: nothing to compare against yet
    expect(runtime.damageFromId).toBe(-1);
    world.tick = 10;
    world.players.damage[bot] = 20;
    refreshBotMemory(world, runtime);
    expect(runtime.damageFromId).toBe(shooter);
    expect(runtime.damageAtTick).toBe(10);
    // A tick with no further damage leaves the memory alone.
    world.tick = 11;
    refreshBotMemory(world, runtime);
    expect(runtime.damageAtTick).toBe(10);
  });

  it('prefers the exact same-tick hitscan attribution over the nearest-visible guess', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 0, y: 0, z: 10 }, 2); // nearer, but did not fire
    const farShooter = addPlayer(world, { x: 0, y: 0, z: 100 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime);
    pushResolvedHit(world, farShooter, bot);
    world.players.damage[bot] = 15;
    refreshBotMemory(world, runtime);
    expect(runtime.damageFromId).toBe(farShooter);
  });

  it('keeps no memory at all for teammate damage (aiCTF.cs:66-76)', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const teammate = addPlayer(world, { x: 0, y: 0, z: 10 }, 1);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime);
    pushResolvedHit(world, teammate, bot);
    world.tick = 5;
    world.players.damage[bot] = 15;
    refreshBotMemory(world, runtime);
    expect(runtime.damageFromId).toBe(-1);
    expect(runtime.damageAtTick).toBe(-1);
  });

  it('records an unknown source when nobody is visible and no shot resolved', () => {
    const world = createWorld(wallAcrossX(50), 1);
    const bot = addPlayer(world, { x: -5, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 5, y: 0, z: 0 }, 2); // behind the wall: not visible
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime);
    world.tick = 42;
    world.players.damage[bot] = 30;
    refreshBotMemory(world, runtime);
    expect(runtime.damageFromId).toBe(-1);
    expect(runtime.damageAtTick).toBe(42);
  });

  it('drops the grudge when the damage bar resets (respawn or a refit)', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 20 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime);
    world.players.damage[bot] = 25;
    refreshBotMemory(world, runtime);
    rememberSightedTarget(world, runtime, shooter);
    expect(runtime.damageAtTick).toBe(0);
    expect(runtime.sightTargetId).toBe(shooter);
    // Respawn or a station refill zeroes the bar: the grudge is stale. The sight memory is
    // deliberately kept (the respawn delay and the memory window are both 156 ticks, and
    // clearing it on this edge cost 36 kills -- see refreshDamageMemory).
    world.players.damage[bot] = 0;
    refreshBotMemory(world, runtime);
    expect(runtime.damageFromId).toBe(-1);
    expect(runtime.damageAtTick).toBe(-1);
    expect(runtime.sightTargetId).toBe(shooter);
  });

  it('clears both memories outright for a dead bot', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(world, { x: 0, y: 0, z: 20 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime);
    world.players.damage[bot] = 10;
    refreshBotMemory(world, runtime);
    rememberSightedTarget(world, runtime, 1);
    world.players.alive[bot] = 0;
    refreshBotMemory(world, runtime);
    expect(runtime.damageFromId).toBe(-1);
    expect(runtime.sightTargetId).toBe(-1);
  });
});

describe('damageMemoryTarget (T2 retaliation)', () => {
  it('returns the remembered attacker while it is visible and inside the window', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 75 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime);
    world.players.damage[bot] = 12;
    refreshBotMemory(world, runtime);
    expect(damageMemoryTarget(world, runtime)).toBe(shooter);
    // Out of the window, the grudge is gone.
    world.tick = ENGAGE_MEMORY_TICKS + 1;
    expect(damageMemoryTarget(world, runtime)).toBeNull();
  });

  it('returns null once the remembered attacker is out of the bot line of sight', () => {
    const world = createWorld(wallAcrossX(50), 1);
    const bot = addPlayer(world, { x: -5, y: 0, z: 0 }, 1);
    const shooter = addPlayer(world, { x: 5, y: 0, z: 0 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    refreshBotMemory(world, runtime);
    pushResolvedHit(world, shooter, bot);
    world.players.damage[bot] = 9;
    refreshBotMemory(world, runtime);
    expect(runtime.damageFromId).toBe(shooter);
    expect(damageMemoryTarget(world, runtime)).toBeNull();
  });
});

describe('searchMemoryPoint (T2 engage-task search state)', () => {
  it('returns the last known position once the target breaks line of sight', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runner = addPlayer(world, { x: 0, y: 0, z: 40 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    rememberSightedTarget(world, runtime, runner);
    // Reality moves the runner out past VISION_RANGE; the memory keeps the spot it was
    // SEEN at.
    world.players.position[runner * 3 + 2] = 200;
    const point = searchMemoryPoint(world, runtime, { x: 0, y: 0, z: 0 });
    expect(point).toEqual({ x: 0, y: 0, z: 40 });
  });

  it('returns null while the target is still in sight, and for a target that is gone', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: 0, y: 0, z: 40 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    rememberSightedTarget(world, runtime, enemy);
    expect(searchMemoryPoint(world, runtime, { x: 0, y: 0, z: 0 })).toBeNull();
    // Inside the window but with the target dead, the search is still refused.
    world.players.alive[enemy] = 0;
    expect(searchMemoryPoint(world, runtime, { x: 0, y: 0, z: 0 })).toBeNull();
    // And once the window has passed, a live target is refused too.
    world.players.alive[enemy] = 1;
    world.tick = ENGAGE_MEMORY_TICKS + 1;
    expect(searchMemoryPoint(world, runtime, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('consumes the memory when the bot reaches the remembered spot', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const runner = addPlayer(world, { x: 0, y: 0, z: 40 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    rememberSightedTarget(world, runtime, runner);
    world.players.position[runner * 3 + 2] = 200;
    expect(searchMemoryPoint(world, runtime, { x: 0, y: 0, z: 40 - SEARCH_ARRIVE_M })).toBeNull();
    expect(runtime.sightTargetId).toBe(-1);
  });
});
