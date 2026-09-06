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
