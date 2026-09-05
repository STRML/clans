import { describe, expect, it } from 'vitest';
import * as sim from './index.js';
import { createWorld, nextRandom, stepWorld, type Heightfield } from './index.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('fixed world', () => {
  it('generates the same random stream from the same seed', () => {
    const a = { value: 123 },
      b = { value: 123 };
    expect([nextRandom(a), nextRandom(a), nextRandom(a)]).toEqual([
      nextRandom(b),
      nextRandom(b),
      nextRandom(b),
    ]);
  });
  it('rejects frame delta instead of the fixed tick', () => {
    const world = createWorld(terrain, 1);
    expect(() => stepWorld(world, new Map(), 1 / 60)).toThrowError(
      new RangeError('Simulation step requires fixed tick 32 ms'),
    );
  });

  it('does not export the per-tick player step, so the fixed-tick guard cannot be bypassed', () => {
    expect('stepPlayers' in sim).toBe(false);
  });

  it('puts the kill plane 30 m below the lowest terrain point, not the origin', () => {
    const raised: Heightfield = {
      ...terrain,
      heights: Uint16Array.from([1600, 1700, 1800, 1900]),
      heightScale: 32,
    };
    expect(createWorld(raised, 1).killY).toBe(50 - 30);
  });
});
