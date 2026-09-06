import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { describe, expect, it } from 'vitest';
import { describePlayer } from './stats.js';

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
    const rows = Object.fromEntries(describePlayer(world, id, stats).map((row) => [row.id, row]));
    expect(rows['debug-speed']?.value).toBe(5);
    expect(rows['debug-speed']?.text).toBe('5.0 m/s');
    expect(rows['debug-pos']?.text).toBe('1.0, 2.0, 3.0');
    expect(rows['debug-ground']?.value).toBe(1);
    expect(rows['debug-ski']?.value).toBe(0);
    expect(rows['debug-energy']?.value).toBe(60);
    expect(rows['debug-fps']?.text).toBe('60');
    expect(rows['debug-ping']?.text).toBe('42 ms');
    expect(rows['debug-entities']?.value).toBe(4);
  });
});
