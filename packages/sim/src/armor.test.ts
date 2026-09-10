import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import { ARMORS, ArmorId, armorFor, HEAVY_ARMOR, LIGHT_ARMOR, MEDIUM_ARMOR } from './armor.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('MEDIUM_ARMOR and HEAVY_ARMOR', () => {
  it('match the spec Armor numbers table exactly', () => {
    expect(MEDIUM_ARMOR.mass).toBe(130);
    expect(MEDIUM_ARMOR.maxDamage).toBe(1.1);
    expect(MEDIUM_ARMOR.maxEnergy).toBe(80);
    expect(MEDIUM_ARMOR.maxForwardSpeed).toBe(12);
    expect(MEDIUM_ARMOR.maxWeapons).toBe(4);
    expect(MEDIUM_ARMOR.laserRifleAllowed).toBe(false);
    expect(MEDIUM_ARMOR.mortarAllowed).toBe(false);
    expect(MEDIUM_ARMOR.discAmmo).toBe(15);
    expect(MEDIUM_ARMOR.chaingunAmmo).toBe(150);
    expect(MEDIUM_ARMOR.grenadeCount).toBe(6);

    expect(HEAVY_ARMOR.mass).toBe(180);
    expect(HEAVY_ARMOR.maxDamage).toBe(1.32);
    expect(HEAVY_ARMOR.maxEnergy).toBe(110);
    expect(HEAVY_ARMOR.maxForwardSpeed).toBe(7);
    expect(HEAVY_ARMOR.maxWeapons).toBe(5);
    expect(HEAVY_ARMOR.laserRifleAllowed).toBe(false);
    expect(HEAVY_ARMOR.mortarAllowed).toBe(true);
    expect(HEAVY_ARMOR.mortarAmmo).toBe(200);
    expect(HEAVY_ARMOR.grenadeCount).toBe(8);
  });
  it('ARMORS indexes by ArmorId to the same three objects', () => {
    expect(ARMORS[ArmorId.Light]).toBe(LIGHT_ARMOR);
    expect(ARMORS[ArmorId.Medium]).toBe(MEDIUM_ARMOR);
    expect(ARMORS[ArmorId.Heavy]).toBe(HEAVY_ARMOR);
  });
});

describe('vanilla movement datablock parity (issue #3)', () => {
  it('matches the T2 player.cs movement block for all three armors', () => {
    // Source: GameData/base/scripts/player.cs, LightMaleHumanArmor /
    // MediumMaleHumanArmor / HeavyMaleHumanArmor (community mirror jdknight/t2ds). The
    // mass-multiplied forces are written as the scripts write them. drag is retained
    // vanilla data that the engine only applies underwater (see armor.ts); the surface
    // angles gate Player::findContact's run/jump tests.
    expect(LIGHT_ARMOR.runForce).toBe(55.2 * 90);
    expect(LIGHT_ARMOR.jetForce).toBe(26.21 * 90);
    expect(LIGHT_ARMOR.jumpForce).toBe(8.3 * 90);
    expect(LIGHT_ARMOR.horizMaxSpeed).toBe(68);
    expect(LIGHT_ARMOR.horizResistSpeed).toBe(33);
    expect(LIGHT_ARMOR.horizResistFactor).toBe(0.35);
    expect(LIGHT_ARMOR.upMaxSpeed).toBe(80);
    expect(LIGHT_ARMOR.upResistSpeed).toBe(25);
    expect(LIGHT_ARMOR.upResistFactor).toBe(0.3);
    expect(LIGHT_ARMOR.drag).toBe(0.275);
    expect(LIGHT_ARMOR.runSurfaceAngle).toBe(70);
    expect(LIGHT_ARMOR.jumpSurfaceAngle).toBe(80);

    expect(MEDIUM_ARMOR.runForce).toBe(46 * 130);
    expect(MEDIUM_ARMOR.jetForce).toBe(25.22 * 130);
    expect(MEDIUM_ARMOR.jumpForce).toBe(8.3 * 130);
    expect(MEDIUM_ARMOR.horizMaxSpeed).toBe(60);
    expect(MEDIUM_ARMOR.horizResistSpeed).toBe(28);
    expect(MEDIUM_ARMOR.horizResistFactor).toBe(0.32);
    expect(MEDIUM_ARMOR.upMaxSpeed).toBe(70);
    expect(MEDIUM_ARMOR.upResistSpeed).toBe(30);
    expect(MEDIUM_ARMOR.upResistFactor).toBe(0.23);
    expect(MEDIUM_ARMOR.drag).toBe(0.3);
    expect(MEDIUM_ARMOR.runSurfaceAngle).toBe(70);
    // The script sets 75 and then overrides to 80 on its next line, so 80 is vanilla.
    expect(MEDIUM_ARMOR.jumpSurfaceAngle).toBe(80);

    expect(HEAVY_ARMOR.runForce).toBe(40.25 * 180);
    expect(HEAVY_ARMOR.jetForce).toBe(22.47 * 180);
    expect(HEAVY_ARMOR.jumpForce).toBe(8.3 * 180);
    expect(HEAVY_ARMOR.horizMaxSpeed).toBe(52);
    expect(HEAVY_ARMOR.horizResistSpeed).toBe(23);
    expect(HEAVY_ARMOR.horizResistFactor).toBe(0.29);
    expect(HEAVY_ARMOR.upMaxSpeed).toBe(60);
    expect(HEAVY_ARMOR.upResistSpeed).toBe(35);
    expect(HEAVY_ARMOR.upResistFactor).toBe(0.18);
    expect(HEAVY_ARMOR.drag).toBe(0.33);
    expect(HEAVY_ARMOR.runSurfaceAngle).toBe(70);
    // The two values issue #3 corrected: the Heavy datablock is the only one with 75 here,
    // and its speedDamageScale is 0.006, not the Light/Medium 0.004.
    expect(HEAVY_ARMOR.jumpSurfaceAngle).toBe(75);
    expect(HEAVY_ARMOR.speedDamageScale).toBe(0.006);
    expect(MEDIUM_ARMOR.speedDamageScale).toBe(0.004);
  });
});

describe('armorFor', () => {
  it('reads back the armor addPlayer assigned', () => {
    const world = createWorld(flat, 1);
    const light = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(armorFor(world, light)).toBe(LIGHT_ARMOR);
  });
  it('a Heavy player runs at 7 m/s, not the Light default of 15', () => {
    const world = createWorld(flat, 1);
    const heavy = addPlayer(world, { x: 0, y: 0, z: 0 }, 1, ArmorId.Heavy);
    expect(armorFor(world, heavy).maxForwardSpeed).toBe(7);
  });
});
