import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { BaseObjectKind, createBaseObjects, stepPower } from '@clans/sim';
import { createTurrets, stepTurretPower, TurretBarrelId } from '@clans/sim';
import { friendlySensorCircles, playersFromWorld, sensedEnemyIds } from './commander-map.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

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
    const ids = sensedEnemyIds(playersFromWorld(world), 1, [{ x: 0, z: 0, radius: 300 }]);
    expect(ids).toContain(enemy);
  });
  it('never reports a teammate, even inside the circle', () => {
    const world = createWorld(flat, 1);
    const friend = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    const ids = sensedEnemyIds(playersFromWorld(world), 1, [{ x: 0, z: 0, radius: 300 }]);
    expect(ids).not.toContain(friend);
  });
  it('does not report an enemy outside every circle', () => {
    const world = createWorld(flat, 1);
    addPlayer(world, { x: 1000, y: 0, z: 0 }, 2);
    expect(sensedEnemyIds(playersFromWorld(world), 1, [{ x: 0, z: 0, radius: 300 }])).toHaveLength(
      0,
    );
  });
});
