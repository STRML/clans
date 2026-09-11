import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  ammoIndex,
  createFlags,
  createWorld,
  WeaponId,
  WeaponState,
  type Heightfield,
  type World,
} from '@clans/sim';
import {
  aimAndFire,
  aimAtPoint,
  CARRIER_FIRE_RANGE_M,
  carrierHoldsFire,
  carrierHoldsFireOn,
  carrierHoldsFireOnPoint,
  CHAINGUN_RELEASE_RANGE,
  chooseWeapon,
  CLOSE_RANGE,
  ESCORT_COVER_RADIUS_M,
  leadPosition,
  selectCombatTarget,
} from './combat.js';
import {
  CARRIER_THREAT_RADIUS_M,
  findCarrierThreat,
  findNearestVisibleEnemy,
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

describe('chooseWeapon', () => {
  it('picks the Spinfusor beyond CLOSE_RANGE when disc ammo is available', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(chooseWeapon(world, bot, CLOSE_RANGE + 10)).toBe(WeaponId.Spinfusor);
  });

  it('picks the Chaingun inside CLOSE_RANGE when chaingun ammo is available', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(chooseWeapon(world, bot, CLOSE_RANGE - 5)).toBe(WeaponId.Chaingun);
  });

  it('keeps a spinning Chaingun selected just outside CLOSE_RANGE so its held trigger can finish spinning up', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.weaponSlot[bot] = WeaponId.Chaingun;
    world.players.weaponState[bot] = WeaponState.SpinUp;
    expect(chooseWeapon(world, bot, CLOSE_RANGE + 1)).toBe(WeaponId.Chaingun);
    expect(chooseWeapon(world, bot, CHAINGUN_RELEASE_RANGE + 1)).toBe(WeaponId.Spinfusor);
  });

  it('falls back to the Blaster when both Spinfusor and Chaingun are out of ammo', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.ammo[ammoIndex(bot, WeaponId.Spinfusor)] = 0;
    world.players.ammo[ammoIndex(bot, WeaponId.Chaingun)] = 0;
    expect(chooseWeapon(world, bot, CLOSE_RANGE - 5)).toBe(WeaponId.Blaster);
    expect(chooseWeapon(world, bot, CLOSE_RANGE + 5)).toBe(WeaponId.Blaster);
  });
});

describe('leadPosition', () => {
  it('returns the target position unchanged for a stationary target', () => {
    const lead = leadPosition(
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      90,
    );
    expect(lead).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('leads a moving target proportional to distance/projectileSpeed', () => {
    const lead = leadPosition(
      { x: 0, y: 0, z: 0 },
      { x: 90, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      90,
    );
    // distance 90, speed 90 -> travelTime 1s -> target moves 10m further along +x.
    expect(lead.x).toBeCloseTo(100, 5);
  });

  it('returns the target position unchanged for a hitscan weapon (projectileSpeed 0)', () => {
    const lead = leadPosition({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 0);
    expect(lead).toEqual({ x: 10, y: 0, z: 0 });
  });
});

describe('aimAndFire', () => {
  it('fires only once the computed aim is within AIM_TOLERANCE_DEG of the lead direction', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    runtime.aimYaw = Math.PI; // facing directly away from the target -- should not fire.
    const away = aimAndFire(world, runtime, bot, target);
    expect(away.fire).toBe(false);
    runtime.aimYaw = away.yaw; // now aimed exactly at the (jittered) lead direction.
    const onTarget = aimAndFire(world, runtime, bot, target);
    expect(onTarget.fire).toBe(true);
  });

  it('re-rolls jitter only when the engaged target changes, holding steady across repeated calls', () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const targetA = addPlayer(world, { x: 0, y: 0, z: 10 }, 2);
    const targetB = addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    aimAndFire(world, runtime, bot, targetA);
    const jitterA1 = runtime.aimJitterDeg;
    aimAndFire(world, runtime, bot, targetA);
    const jitterA2 = runtime.aimJitterDeg;
    expect(jitterA2).toBe(jitterA1);
    aimAndFire(world, runtime, bot, targetB);
    expect(runtime.engagedTargetId).toBe(targetB);
  });

  it("returns the chosen weaponId, matching chooseWeapon's own decision for the same distance (Codex review round 2, P2)", () => {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const closeTarget = addPlayer(world, { x: 0, y: 0, z: CLOSE_RANGE - 5 }, 2);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    const result = aimAndFire(world, runtime, bot, closeTarget);
    expect(result.weaponId).toBe(chooseWeapon(world, bot, CLOSE_RANGE - 5));
  });
});

/** Two flag stands on the x axis, the same fixture shape perception.test.ts uses: flag id
 *  1 belongs to team 2, so a team-1 bot stored in carrierId[1] is the one carrying the
 *  enemy flag home -- the only state combat.ts's carrier fire discipline reads. */
function addFlags(world: World): void {
  createFlags(world, [
    { team: 1, position: { x: -10, y: 0, z: 0 } },
    { team: 2, position: { x: 10, y: 0, z: 0 } },
  ]);
}

/** A world holding one team-1 bot at the origin and one team-2 target `targetZ` metres
 *  down +z; `carrying` stores the bot in the enemy flag's carrierId. Two of these -- one
 *  carrying, one not -- put an identical bot at an identical distance from an identical
 *  target, so a difference in the fire gate can only come from the flag. Each world holds
 *  a single enemy, so the escort re-target (which needs a teammate carrier) cannot
 *  confound the measurement. */
function engagementWorld(
  targetZ: number,
  carrying: boolean,
): { world: World; bot: number; target: number } {
  const world = createWorld(flat, 1);
  const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
  const target = addPlayer(world, { x: 0, y: 0, z: targetZ }, 2);
  addFlags(world);
  if (carrying) world.flags.carrierId[1] = bot;
  return { world, bot, target };
}

describe('carrierHoldsFire (issue #32 carrier fire discipline)', () => {
  it('holds the carrier beyond CARRIER_FIRE_RANGE_M while an equally distant non-carrier fires', () => {
    const far = CARRIER_FIRE_RANGE_M + 30;
    const carrier = engagementWorld(far, true);
    const plain = engagementWorld(far, false);
    const carrierRuntime = createBotRuntimeState(carrier.bot, BotRole.Attacker, 1);
    const plainRuntime = createBotRuntimeState(plain.bot, BotRole.Attacker, 1);
    // Both bots are already aimed dead on their target before the call under test.
    carrierRuntime.aimYaw = aimAndFire(
      carrier.world,
      carrierRuntime,
      carrier.bot,
      carrier.target,
    ).yaw;
    plainRuntime.aimYaw = aimAndFire(plain.world, plainRuntime, plain.bot, plain.target).yaw;
    expect(aimAndFire(carrier.world, carrierRuntime, carrier.bot, carrier.target).fire).toBe(false);
    expect(aimAndFire(plain.world, plainRuntime, plain.bot, plain.target).fire).toBe(true);
  });

  it('fires inside the envelope: the carrier is not defenseless at knife range', () => {
    const close = engagementWorld(CARRIER_FIRE_RANGE_M - 10, true);
    const runtime = createBotRuntimeState(close.bot, BotRole.Attacker, 1);
    runtime.aimYaw = aimAndFire(close.world, runtime, close.bot, close.target).yaw;
    expect(aimAndFire(close.world, runtime, close.bot, close.target).fire).toBe(true);
  });

  it('is inclusive at its own edge: exactly CARRIER_FIRE_RANGE_M is the last ranged shot', () => {
    const carrier = engagementWorld(60, true);
    const plain = engagementWorld(60, false);
    expect(carrierHoldsFire(carrier.world, carrier.bot, CARRIER_FIRE_RANGE_M)).toBe(false);
    expect(carrierHoldsFire(carrier.world, carrier.bot, CARRIER_FIRE_RANGE_M + 1)).toBe(true);
    expect(carrierHoldsFire(plain.world, plain.bot, CARRIER_FIRE_RANGE_M + 1)).toBe(false);
  });

  it('holds a carrier off a structure point at range while the same point is engageable for a non-carrier', () => {
    const carrier = engagementWorld(60, true);
    const plain = engagementWorld(60, false);
    const farPoint = { x: 0, y: 5, z: CARRIER_FIRE_RANGE_M + 30 };
    expect(carrierHoldsFireOnPoint(carrier.world, carrier.bot, farPoint)).toBe(true);
    expect(carrierHoldsFireOnPoint(plain.world, plain.bot, farPoint)).toBe(false);
    expect(carrierHoldsFireOnPoint(carrier.world, carrier.bot, { x: 0, y: 5, z: 10 })).toBe(false);
  });

  it("keeps a carrier's trigger down at range through aimAtPoint itself, and the same point is fireable for a non-carrier", () => {
    const farPoint = { x: 0, y: 5, z: CARRIER_FIRE_RANGE_M + 30 };
    const carrier = engagementWorld(60, true);
    const plain = engagementWorld(60, false);
    const runtime = createBotRuntimeState(carrier.bot, BotRole.Attacker, 1);
    runtime.aimYaw = aimAtPoint(carrier.world, runtime, carrier.bot, farPoint).yaw; // dead on the point
    expect(aimAtPoint(carrier.world, runtime, carrier.bot, farPoint).fire).toBe(false);
    const plainRuntime = createBotRuntimeState(plain.bot, BotRole.Attacker, 1);
    plainRuntime.aimYaw = aimAtPoint(plain.world, plainRuntime, plain.bot, farPoint).yaw;
    expect(aimAtPoint(plain.world, plainRuntime, plain.bot, farPoint).fire).toBe(true);
  });

  it('is the same rule in both forms: carrierHoldsFireOn measures a player target the way aimAndFire does', () => {
    const carrier = engagementWorld(60, true);
    const plain = engagementWorld(60, false);
    expect(carrierHoldsFireOn(carrier.world, carrier.bot, carrier.target)).toBe(true);
    expect(carrierHoldsFireOn(plain.world, plain.bot, plain.target)).toBe(false);
  });
});

describe('selectCombatTarget (issue #32 escort threat priority)', () => {
  it('picks the enemy nearest the carrier over the enemy nearest the escort', () => {
    const world = createWorld(flat, 1);
    addFlags(world);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const escort = addPlayer(world, { x: 0, y: 0, z: -20 }, 1);
    const nearEscort = addPlayer(world, { x: 0, y: 0, z: -25 }, 2); // 5 m from the escort, 25 m from the carrier
    const nearCarrier = addPlayer(world, { x: 0, y: 0, z: 10 }, 2); // 30 m from the escort, 10 m from the carrier
    world.flags.carrierId[1] = carrier;
    // The escort's own nearest is one answer; the carrier's nearest is the other.
    expect(findNearestVisibleEnemy(world, escort)).toBe(nearEscort);
    expect(selectCombatTarget(world, escort)).toBe(nearCarrier);
    // And the switch is live in the aim path itself: handed its own nearest, aimAndFire
    // engages the carrier's threat instead (engagedTargetId is what the aim solve used).
    const runtime = createBotRuntimeState(escort, BotRole.Attacker, 1);
    aimAndFire(world, runtime, escort, nearEscort);
    expect(runtime.engagedTargetId).toBe(nearCarrier);
  });

  it('falls back to the nearest enemy to itself when no teammate carries the flag', () => {
    const world = createWorld(flat, 1);
    addFlags(world);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const escort = addPlayer(world, { x: 0, y: 0, z: -20 }, 1);
    const nearEscort = addPlayer(world, { x: 0, y: 0, z: -25 }, 2);
    addPlayer(world, { x: 0, y: 0, z: 10 }, 2);
    expect(selectCombatTarget(world, escort)).toBe(nearEscort);
    const runtime = createBotRuntimeState(escort, BotRole.Attacker, 1);
    aimAndFire(world, runtime, escort, nearEscort);
    expect(runtime.engagedTargetId).toBe(nearEscort);
  });

  it('falls back to its own nearest when the carrier is outside ESCORT_COVER_RADIUS_M', () => {
    const world = createWorld(flat, 1);
    addFlags(world);
    const escort = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const carrier = addPlayer(world, { x: 0, y: 0, z: -(ESCORT_COVER_RADIUS_M + 1) }, 1);
    const nearEscort = addPlayer(world, { x: 0, y: 0, z: -25 }, 2);
    const nearCarrier = addPlayer(world, { x: 0, y: 0, z: -(ESCORT_COVER_RADIUS_M + 6) }, 2);
    world.flags.carrierId[1] = carrier;
    // The carrier's threat exists and is inside CARRIER_THREAT_RADIUS_M of the carrier --
    // only the escort's distance from the carrier rejects it.
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBe(nearCarrier);
    expect(selectCombatTarget(world, escort)).toBe(nearEscort);
    // Exactly at the cover radius the carrier's fight is the escort's again.
    world.players.position[carrier * 3 + 2] = -ESCORT_COVER_RADIUS_M;
    expect(selectCombatTarget(world, escort)).toBe(nearCarrier);
  });

  it('falls back to its own nearest when the carrier sees a threat the escort itself cannot', () => {
    const world = createWorld(flat, 1);
    addFlags(world);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const escort = addPlayer(world, { x: 0, y: 0, z: -100 }, 1); // inside cover of the carrier
    const nearEscort = addPlayer(world, { x: 0, y: 0, z: -120 }, 2); // 20 m from the escort
    const carrierOnlyThreat = addPlayer(world, { x: 0, y: 0, z: 60 }, 2); // 60 m from carrier, 160 m from escort
    world.flags.carrierId[1] = carrier;
    expect(findCarrierThreat(world, carrier, CARRIER_THREAT_RADIUS_M)).toBe(carrierOnlyThreat);
    expect(selectCombatTarget(world, escort)).toBe(nearEscort);
  });
});
