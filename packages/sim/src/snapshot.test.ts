import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createWorld,
  deserializePlayer,
  removePlayer,
  serializeActivePlayers,
  serializePlayer,
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

describe('player snapshots', () => {
  it('serializes only what the protocol needs', () => {
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 }, 1);
    world.players.velocity.set([4, 5, 6], id * 3);
    world.players.yaw[id] = 0.5;
    world.players.energy[id] = 40;
    world.players.onGround[id] = 1;
    expect(serializePlayer(world, id)).toEqual({
      id,
      team: 1,
      x: 1,
      y: 2,
      z: 3,
      vx: 4,
      vy: 5,
      vz: 6,
      yaw: 0.5,
      energy: 40,
      onGround: 1,
      ski: 0,
    });
  });

  it('serializes only active players', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    addPlayer(world, { x: 1, y: 0, z: 0 });
    removePlayer(world, a);
    expect(serializeActivePlayers(world).map((p) => p.id)).toEqual([1]);
  });

  it('deserializes back into an equivalent player, growing the store if needed', () => {
    const world = createWorld(terrain, 1);
    deserializePlayer(world, {
      id: 3,
      team: 2,
      x: 9,
      y: 0,
      z: 9,
      vx: 1,
      vy: 0,
      vz: 0,
      yaw: 1,
      energy: 30,
      onGround: 0,
      ski: 1,
    });
    expect(world.players.count).toBe(4);
    expect(world.players.active[3]).toBe(1);
    expect(serializePlayer(world, 3)).toEqual({
      id: 3,
      team: 2,
      x: 9,
      y: 0,
      z: 9,
      vx: 1,
      vy: 0,
      vz: 0,
      yaw: 1,
      energy: 30,
      onGround: 0,
      ski: 1,
    });
  });
});
