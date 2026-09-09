import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  ammoIndex,
  createWorld,
  WeaponId,
  WeaponState,
  type Heightfield,
} from '@clans/sim';
import {
  aimAndFire,
  CHAINGUN_RELEASE_RANGE,
  chooseWeapon,
  CLOSE_RANGE,
  leadPosition,
} from './combat.js';
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
