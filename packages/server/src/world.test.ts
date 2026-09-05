import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import {
  addBots,
  loadKatabaticWorld,
  smallerTeam,
  spawnPointFor,
  teamCount,
  type SceneSpawn,
} from './world.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('server world bootstrap', () => {
  it("carries the mission's empty terrain squares into the sim heightfield", async () => {
    const { world } = await loadKatabaticWorld();
    // Katabatic marks 17 squares empty (the base interiors' terrain cut-outs).
    expect(world.terrain.emptySquares?.size).toBe(17);
    expect(world.terrain.emptySquares?.has(26538)).toBe(true);
  });

  it('loads the committed Katabatic terrain and scene', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    expect(world.terrain.gridSize).toBe(256);
    expect(spawns.filter((s) => s.team === 1)).toHaveLength(2);
    expect(spawns.filter((s) => s.team === 2)).toHaveLength(2);
  });

  it('picks the team with fewer active players, team 1 on a tie', () => {
    const world = createWorld(terrain, 1);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(smallerTeam(world)).toBe(2);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    expect(smallerTeam(world)).toBe(1);
  });

  it('cycles spawn points within a team by index', () => {
    const spawns: SceneSpawn[] = [
      { name: null, team: 1, position: [1, 0, 1], radius: 5 },
      { name: null, team: 1, position: [2, 0, 2], radius: 5 },
    ];
    expect(spawnPointFor(spawns, 1, 0)).toEqual([1, 0, 1]);
    expect(spawnPointFor(spawns, 1, 1)).toEqual([2, 0, 2]);
    expect(spawnPointFor(spawns, 1, 2)).toEqual([1, 0, 1]);
  });

  it('adds N idle bots balanced across both teams at real spawn points', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    const ids = addBots(world, spawns, 4);
    expect(ids).toHaveLength(4);
    expect(teamCount(world, 1)).toBe(2);
    expect(teamCount(world, 2)).toBe(2);
  });
});
