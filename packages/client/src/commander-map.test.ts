import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { BaseObjectKind, createBaseObjects, stepPower } from '@clans/sim';
import { createTurrets, stepTurretPower, TurretBarrelId } from '@clans/sim';
import { OrderKind, type OrderSnapshotData } from '@clans/protocol';
import {
  canvasToWorld,
  drawOrderMarkers,
  friendlySensorCircles,
  playersFromWorld,
  sensedEnemyIds,
} from './commander-map.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

/** An 11x11 grid spanning world x,z in [-10, 10] (squareSize 2, origin at the -10,-10
 *  corner), flat at height 0 except a `bumpHeight`-metre ridge across both the middle row and
 *  the middle column -- same fixture shape as turrets.test.ts's own `hillBetween`, duplicated
 *  here rather than imported since it's a private test helper of that file. */
function hillBetween(bumpHeight: number): Heightfield {
  const size = 11;
  const heights = new Uint16Array(size * size);
  const mid = 5;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      heights[row * size + col] = row === mid || col === mid ? bumpHeight : 0;
    }
  }
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

describe('friendlySensorCircles', () => {
  it('includes a powered friendly Sensor at its detectRadius (300 m)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.Sensor, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const circles = friendlySensorCircles(world, 1);
    expect(circles).toHaveLength(1);
    expect(circles[0]?.radius).toBe(300);
  });
  it('excludes an unpowered sensor', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Sensor, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world); // no generator: stays unpowered
    expect(friendlySensorCircles(world, 1)).toHaveLength(0);
  });
  it('excludes an enemy team sensor', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.Sensor, team: 2, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    expect(friendlySensorCircles(world, 1)).toHaveLength(0);
  });
  it('includes a powered friendly turret at its engagement range', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    // stepPower only derives world.baseObjects.powered; a turret's own powered bit comes from
    // stepTurretPower (normally run inside stepTurrets/stepWorld each tick) -- see turrets.ts.
    stepTurretPower(world);
    const circles = friendlySensorCircles(world, 1);
    expect(circles.some((c) => c.radius === 60)).toBe(true);
  });
});

describe('sensedEnemyIds', () => {
  it('reports an enemy player inside a friendly sensor circle', () => {
    const world = createWorld(flat, 1);
    const enemy = addPlayer(world, { x: 100, y: 0, z: 0 }, 2);
    const ids = sensedEnemyIds(playersFromWorld(world), 1, [{ x: 0, z: 0, radius: 300 }], world);
    expect(ids).toContain(enemy);
  });
  it('never reports a teammate, even inside the circle', () => {
    const world = createWorld(flat, 1);
    const friend = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    const ids = sensedEnemyIds(playersFromWorld(world), 1, [{ x: 0, z: 0, radius: 300 }], world);
    expect(ids).not.toContain(friend);
  });
  it('does not report an enemy outside every circle', () => {
    const world = createWorld(flat, 1);
    addPlayer(world, { x: 1000, y: 0, z: 0 }, 2);
    expect(
      sensedEnemyIds(playersFromWorld(world), 1, [{ x: 0, z: 0, radius: 300 }], world),
    ).toHaveLength(0);
  });
});

describe('sensedEnemyIds line of sight (closes #19)', () => {
  it('an enemy inside sensor radius but behind a terrain ridge is not sensed', () => {
    const world = createWorld(hillBetween(10), 1);
    const enemy = addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    const ids = sensedEnemyIds(playersFromWorld(world), 1, [{ x: -8, z: 0, radius: 20 }], world);
    expect(ids).not.toContain(enemy);
  });

  it('an enemy inside sensor radius with a clear line of sight is still sensed', () => {
    const world = createWorld(hillBetween(0), 1);
    const enemy = addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    const ids = sensedEnemyIds(playersFromWorld(world), 1, [{ x: -8, z: 0, radius: 20 }], world);
    expect(ids).toContain(enemy);
  });
});

describe('canvasToWorld', () => {
  it('is the exact inverse of the existing toCanvas mapping', () => {
    const ctx = { canvas: { width: 512, height: 512 } } as CanvasRenderingContext2D;
    const missionArea = { minX: -896, minZ: -696, width: 1504, depth: 1392 };
    const world = canvasToWorld(ctx, missionArea, 256, 256);
    expect(world.x).toBeCloseTo(-896 + 1504 / 2);
    expect(world.z).toBeCloseTo(-696 + 1392 / 2);
  });
});

describe('drawOrderMarkers', () => {
  it("draws only the local team's own order, if present", () => {
    const orders: OrderSnapshotData[] = [
      { team: 1, kind: OrderKind.Attack, x: 0, z: 0, expiresInS: 10 },
      { team: 2, kind: OrderKind.Defend, x: 5, z: 5, expiresInS: 10 },
    ];
    let strokeCalls = 0;
    const ctx = {
      strokeStyle: '',
      lineWidth: 0,
      beginPath: () => undefined,
      arc: () => undefined,
      stroke: () => {
        strokeCalls += 1;
      },
    } as unknown as CanvasRenderingContext2D;
    const toCanvasStub = (x: number, z: number): [number, number] => [x, z];
    drawOrderMarkers(ctx, orders, 1, toCanvasStub);
    expect(strokeCalls).toBe(1);
  });

  it('draws nothing when the local team has no active order', () => {
    const orders: OrderSnapshotData[] = [
      { team: 2, kind: OrderKind.Defend, x: 5, z: 5, expiresInS: 10 },
    ];
    let strokeCalls = 0;
    const ctx = {
      strokeStyle: '',
      lineWidth: 0,
      beginPath: () => undefined,
      arc: () => undefined,
      stroke: () => {
        strokeCalls += 1;
      },
    } as unknown as CanvasRenderingContext2D;
    drawOrderMarkers(ctx, orders, 1, (x, z) => [x, z]);
    expect(strokeCalls).toBe(0);
  });
});
