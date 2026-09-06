import { describe, expect, it } from 'vitest';
import * as sim from './index.js';
import {
  addPlayer,
  createWorld,
  nextRandom,
  removePlayer,
  stepWorld,
  type Heightfield,
} from './index.js';

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

  it('rejects a heightfield whose heights array does not match gridSize squared', () => {
    // Codex round 15: sampleTerrain indexes with `?? 0`, so a truncated heights array
    // (a partial asset fetch) silently sampled as flat instead of failing to load.
    const truncated: Heightfield = { ...terrain, heights: new Uint16Array(3) };
    expect(() => createWorld(truncated, 1)).toThrow(RangeError);
  });

  it('assigns a default team of 0 and lets addPlayer set an explicit team', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    const b = addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    expect(world.players.team[a]).toBe(0);
    expect(world.players.team[b]).toBe(2);
  });

  it('frees a removed id and reuses it before growing the store', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 1, y: 0, z: 1 });
    const b = addPlayer(world, { x: 2, y: 0, z: 2 });
    removePlayer(world, a);
    const c = addPlayer(world, { x: 3, y: 0, z: 3 }, 1);
    expect(c).toBe(a);
    expect(world.players.active[a]).toBe(1);
    expect(world.players.position[a * 3]).toBe(3);
    expect(world.players.count).toBe(2);
    expect(b).not.toBe(c);
  });

  it('rejects removing an id that is not active', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    removePlayer(world, a);
    expect(() => removePlayer(world, a)).toThrow(RangeError);
  });

  it('skips inactive players when stepping the world', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 5, y: 0, z: 5 });
    removePlayer(world, a);
    expect(() => stepWorld(world, new Map())).not.toThrow();
    expect(world.players.position[a * 3]).toBe(5);
  });
});
