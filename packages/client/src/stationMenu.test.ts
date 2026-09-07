import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { createBaseObjects, BaseObjectKind, stepPower } from '@clans/sim';
import { stationMenuVisible } from './stationMenu.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('stationMenuVisible', () => {
  it('is false when menuOpen is false, even at a powered station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, false)).toBe(false);
  });
  it('is true when menuOpen is true and the player is at a powered station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, true)).toBe(true);
  });
  it('is false when menuOpen is true but no station is in range (closes itself)', () => {
    const world = createWorld(flat, 1);
    const player = addPlayer(world, { x: 500, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, true)).toBe(false);
  });
});
