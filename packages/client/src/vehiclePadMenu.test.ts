import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  BaseObjectKind,
  createBaseObjects,
  createWorld,
  stepPower,
  type Heightfield,
} from '@clans/sim';
import { vehiclePadMenuVisible, vehicleStationTriggerAt } from './vehiclePadMenu.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function poweredPadWorld(): { world: ReturnType<typeof createWorld>; padId: number } {
  const world = createWorld(flat, 1);
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 1, y: 0, z: 0 } },
  ]);
  stepPower(world);
  return { world, padId: 1 };
}

describe('vehiclePadMenuVisible', () => {
  it('is false when menuOpen is false, even inside a powered pad use radius', () => {
    const { world } = poweredPadWorld();
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(vehiclePadMenuVisible(world, player, false)).toBe(false);
  });

  it('is true when menuOpen is true and the player is inside a powered pad use radius', () => {
    const { world } = poweredPadWorld();
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(vehiclePadMenuVisible(world, player, true)).toBe(true);
  });

  it('is false when menuOpen is true but no pad is in range (closes itself)', () => {
    const { world } = poweredPadWorld();
    const player = addPlayer(world, { x: 500, y: 0, z: 0 }, 1);
    expect(vehiclePadMenuVisible(world, player, true)).toBe(false);
  });
});

// createVehiclePadMenu itself touches `document` (button creation/click wiring), which this
// package's test environment does not provide -- see stationMenu.test.ts, which draws the
// same line and only unit-tests stationMenuVisible for the same reason. The real click-through
// (choosing Shrike/Wildcat sends VehicleSpawn) is covered by Task 14's Playwright e2e spec,
// which runs in a real browser.

it('uses the separate vehicle control station, not the vehicle spawning platform', () => {
  const { world } = poweredPadWorld();
  world.baseObjects.usePosition.set([14, 1, 0], 3);
  const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
  expect(vehiclePadMenuVisible(world, player, true)).toBe(false);
  expect(vehicleStationTriggerAt(world, player)).toBeNull();
  world.players.position.set([14, 0, 0], player * 3);
  expect(vehiclePadMenuVisible(world, player, true)).toBe(true);
  expect(vehicleStationTriggerAt(world, player)).toBe(1);
  world.baseObjects.powered[1] = 0;
  expect(vehicleStationTriggerAt(world, player)).toBeNull();
});
