import { addPlayer, createWorld, LIGHT_ARMOR, type Heightfield } from '@clans/sim';
import { describe, expect, it } from 'vitest';
import { EventKind } from '@clans/protocol';
import { activeProjectileCount, describeEvent, describePlayer, type DebugRow } from './stats.js';

/** Non-null by construction: every id here comes straight out of describePlayer's own row list,
 * so a lookup helper avoids repeating an optional-chain per assertion below. */
function findRow(rows: DebugRow[], id: string): DebugRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`describePlayer produced no '${id}' row`);
  return row;
}

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('describePlayer', () => {
  it('reports speed as the horizontal magnitude and flags as 0 or 1', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    world.players.velocity.set([3, 9, 4], id * 3);
    world.players.onGround[id] = 1;
    world.players.damage[id] = LIGHT_ARMOR.maxDamage / 2;
    const stats = {
      fps: 60,
      frameMs: 2.5,
      simMs: 0.4,
      ping: 42,
      bytesPerSecond: 900,
      packetLossEstimate: 0.05,
      predictionErrorM: 0.1,
      entityCount: 4,
    };
    const rows = describePlayer(world, id, stats, { projectileCount: 2, lastEvent: 'none' });
    expect(findRow(rows, 'debug-speed').value).toBe(5);
    expect(findRow(rows, 'debug-speed').text).toBe('5.0 m/s');
    expect(findRow(rows, 'debug-pos').text).toBe('1.0, 2.0, 3.0');
    expect(findRow(rows, 'debug-ground').value).toBe(1);
    expect(findRow(rows, 'debug-ski').value).toBe(0);
    expect(findRow(rows, 'debug-energy').value).toBe(60);
    expect(findRow(rows, 'debug-health').value).toBeCloseTo(LIGHT_ARMOR.maxDamage / 2);
    expect(findRow(rows, 'debug-fps').text).toBe('60');
    expect(findRow(rows, 'debug-ping').text).toBe('42 ms');
    expect(findRow(rows, 'debug-entities').value).toBe(4);
    expect(findRow(rows, 'debug-projectiles').value).toBe(2);
    expect(findRow(rows, 'debug-last-event').text).toBe('none');
  });
});

describe('activeProjectileCount', () => {
  it('counts only active projectile slots', () => {
    const world = createWorld(flat, 1);
    world.projectiles.count = 2;
    world.projectiles.active[0] = 1;
    expect(activeProjectileCount(world)).toBe(1);
  });
});

describe('describeEvent', () => {
  it('formats an event by its kind name and two ids', () => {
    expect(describeEvent({ type: 6, kind: EventKind.PlayerKilled, a: 3, b: 9 })).toBe(
      'PlayerKilled a=3 b=9',
    );
  });
});
