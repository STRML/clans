import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, stepWorld, raycastInteriors, type Heightfield } from '@clans/sim';
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
    // Katabatic packs 106 empty squares into 17 runs for the base cut-outs.
    expect(world.terrain.emptySquares?.size).toBe(106);
    expect(world.terrain.emptySquares?.has(26538)).toBe(true);
  });

  it('loads the committed Katabatic terrain and scene', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    expect(world.terrain.gridSize).toBe(256);
    expect(spawns.filter((s) => s.team === 1)).toHaveLength(2);
    expect(spawns.filter((s) => s.team === 2)).toHaveLength(2);
    expect(world.flags.state.length).toBe(2);
  });

  it('places every base object, turret, and interior from scene.json', async () => {
    const { world } = await loadKatabaticWorld();
    expect(world.baseObjects.count).toBeGreaterThan(0);
    expect(world.turrets.count).toBeGreaterThan(0);
    expect(world.interiors.length).toBeGreaterThan(0);
    // Katabatic's real counts: 4 generators, 2 sensors, 18 stations, 2 pads, 2 force fields =
    // 28 base objects; 4 TurretBaseLarge + 2 SentryTurret = 6 turrets; 29 interior placements
    // (11 unique shapes).
    expect(world.baseObjects.count).toBe(28);
    expect(world.turrets.count).toBe(6);
    expect(world.interiors.length).toBe(29);
    expect(world.forceFields).toHaveLength(2);
  });

  it('picks the team with fewer active players, team 1 on a tie', () => {
    const world = createWorld(terrain, 1);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(smallerTeam(world)).toBe(2);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    expect(smallerTeam(world)).toBe(1);
  });

  it('cycles spawn points within a team by index, raised 0.1 m above this flat terrain', () => {
    const spawns: SceneSpawn[] = [
      { name: null, team: 1, position: [1, 0, 1], radius: 5 },
      { name: null, team: 1, position: [2, 0, 2], radius: 5 },
    ];
    expect(spawnPointFor(terrain, spawns, 1, 0)).toEqual([1, 0.1, 1]);
    expect(spawnPointFor(terrain, spawns, 1, 1)).toEqual([2, 0.1, 2]);
    expect(spawnPointFor(terrain, spawns, 1, 2)).toEqual([1, 0.1, 1]);
  });

  it('raises a spawn point sitting below the terrain, matching the single-player client', () => {
    // Codex round 8 (PR #4): the server returned a mission spawn's raw y unmodified,
    // while the single-player path (app.ts's spawnPoint) raises it to just above the
    // sampled terrain height. The committed Katabatic scene has a spawn below terrain,
    // so a network client spawned there started underground for a tick.
    const sunken: Heightfield = { ...terrain, heights: new Uint16Array([50, 50, 50, 50]) };
    const spawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, -5, 1], radius: 5 }];
    expect(spawnPointFor(sunken, spawns, 1, 0)).toEqual([1, 50.1, 1]);
  });

  it('keeps interior spawns below terrain where the mission cuts a hole', () => {
    const cutOut = {
      ...terrain,
      heights: new Uint16Array([50, 50, 50, 50]),
      emptySquares: new Set([0]),
    };
    const spawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, -5, 1], radius: 5 }];
    expect(spawnPointFor(cutOut, spawns, 1, 0)).toEqual([1, -5, 1]);
  });

  it('leaves a spawn point already above the terrain untouched', () => {
    const spawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 40, 1], radius: 5 }];
    expect(spawnPointFor(terrain, spawns, 1, 0)).toEqual([1, 40, 1]);
  });

  it('aligns authoritative interior collision with every mission turret anchor', async () => {
    const { world } = await loadKatabaticWorld();
    for (let id = 0; id < world.turrets.count; id++) {
      const x = world.turrets.position[id * 3]!;
      const y = world.turrets.position[id * 3 + 1]!;
      const z = world.turrets.position[id * 3 + 2]!;
      const hit = raycastInteriors(world.interiors, { x, y: y + 0.1, z }, { x: 0, y: -1, z: 0 }, 1);
      expect(hit).not.toBeNull();
      expect(Math.abs(hit!.point.y - y)).toBeLessThan(0.04);
    }
  });

  it('keeps an idle player grounded inside the real bunker instead of drifting into terrain', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    const [x, y, z] = spawnPointFor(world.terrain, spawns, 1, 0);
    const id = addPlayer(world, { x, y, z }, 1);
    for (let tick = 0; tick < 100; tick++) stepWorld(world, new Map());
    expect(world.players.onGround[id]).toBe(1);
    expect(world.players.position[id * 3 + 1]).toBeLessThan(y + 1);
    expect(
      Math.hypot(world.players.velocity[id * 3]!, world.players.velocity[id * 3 + 2]!),
    ).toBeLessThan(0.1);
  });

  it('adds N idle bots balanced across both teams at real spawn points', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    const ids = addBots(world, spawns, 4);
    expect(ids).toHaveLength(4);
    expect(teamCount(world, 1)).toBe(2);
    expect(teamCount(world, 2)).toBe(2);
  });
});
