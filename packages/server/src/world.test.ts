import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createBaseObjects,
  createFlags,
  createTurrets,
  createWorld,
  stepWorld,
  raycastInteriors,
  type Heightfield,
  type PlayerInput,
} from '@clans/sim';
import {
  addBots,
  loadKatabaticWorld,
  smallerTeam,
  spawnPointFor,
  teamCount,
  WORLD_CAPACITY,
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

  it('rejects a spawn sphere entirely buried below solid terrain', () => {
    // Codex round 8 (PR #4): the server returned a mission spawn's raw y unmodified,
    // while the single-player path (app.ts's spawnPoint) raises it to just above the
    // sampled terrain height. The committed Katabatic scene has a spawn below terrain,
    // so a network client spawned there started underground for a tick.
    const sunken: Heightfield = { ...terrain, heights: new Uint16Array([50, 50, 50, 50]) };
    const spawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, -5, 1], radius: 5 }];
    expect(() => spawnPointFor(sunken, spawns, 1, 0)).toThrow(/no clear/);
  });

  it('rejects a spawn area with no walkable ground', () => {
    const cutOut = {
      ...terrain,
      heights: new Uint16Array([50, 50, 50, 50]),
      emptySquares: new Set([0]),
    };
    const spawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, -5, 1], radius: 5 }];
    expect(() => spawnPointFor(cutOut, spawns, 1, 0)).toThrow(/no clear/);
  });

  it('rejects a sphere suspended above all ground', () => {
    const spawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 40, 1], radius: 5 }];
    expect(() => spawnPointFor(terrain, spawns, 1, 0)).toThrow(/no clear/);
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
    const [x, y, z] = spawns.find((spawn) => spawn.team === 1)!.position;
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

// Issue #58: this loop used to call loadKatabaticWorld() once per spawn sample --
// 64 full fixture loads per run, each re-reading heights.bin plus all 29 interior
// collision files and rebuilding every interior collider (roughly 2,100 file reads
// and 1,856 collider builds per test, ~1.6 s isolated). Under a loaded full-suite
// run that crossed vitest's 5 s per-test budget even though spawning itself was
// fine. Only the fixture's immutable pieces are expensive, so load them once:
// interiors.ts builds each collider's uniform grid exactly once at load and every
// consumer (raycastInteriors, resolveSphereAgainstInteriors, the movement sweeps)
// takes readonly instances, and sampleTerrain only reads the heightfield. The
// per-sample world is still pristine -- fresh flags, base objects, turrets and
// player store each iteration via the same create* calls loadKatabaticWorld makes
// -- so turret aim and projectile state cannot leak between spawn samples the way
// stepping all 64 samples in one shared world would allow.
it('every real spawn lets a player walk forward out of the starting area', async () => {
  const { world: fixture, spawns } = await loadKatabaticWorld();
  // The same committed scene loadKatabaticWorld reads, re-read here only because
  // it does not return the scene; one small JSON read beats re-decoding every
  // binary asset per sample.
  const scene = JSON.parse(
    await readFile(
      resolve(
        fileURLToPath(new URL('../', import.meta.url)),
        '../../assets/out/katabatic',
        'scene.json',
      ),
      'utf8',
    ),
  ) as {
    flagStands: Array<{ team: number; position: [number, number, number] }>;
    baseObjects: Array<{
      kind: number;
      team: number;
      position: [number, number, number];
      usePosition?: [number, number, number];
      rotation?: { axis: [number, number, number]; degrees: number };
      scale?: [number, number, number];
    }>;
    turrets: Array<{ barrel: number; team: number; position: [number, number, number] }>;
  };
  for (const team of [1, 2])
    for (const index of Array.from({ length: 32 }, (_, i) => i)) {
      const world = createWorld(fixture.terrain, 1, WORLD_CAPACITY);
      createFlags(
        world,
        scene.flagStands.map(({ team, position: [x, y, z] }) => ({ team, position: { x, y, z } })),
      );
      createBaseObjects(
        world,
        scene.baseObjects.map(
          ({ kind, team, position: [x, y, z], usePosition, rotation, scale }) => ({
            kind,
            team,
            position: { x, y, z },
            ...(usePosition && {
              usePosition: { x: usePosition[0], y: usePosition[1], z: usePosition[2] },
            }),
            ...(rotation && {
              rotation: {
                axis: {
                  x: rotation.axis[0],
                  y: rotation.axis[1],
                  z: rotation.axis[2],
                },
                degrees: rotation.degrees,
              },
            }),
            ...(scale && { scale: { x: scale[0], y: scale[1], z: scale[2] } }),
          }),
        ),
      );
      createTurrets(
        world,
        scene.turrets.map(({ barrel, team, position: [x, y, z] }) => ({
          barrel,
          team,
          position: { x, y, z },
        })),
      );
      world.interiors = fixture.interiors;
      const [x, y, z] = spawnPointFor(world.terrain, spawns, team, index, world.interiors);
      const id = addPlayer(world, { x, y, z }, team);
      const input = {
        moveX: 0,
        moveZ: 1,
        yaw: 0,
        pitch: 0,
        jump: false,
        jet: false,
        ski: false,
        fire: false,
        altFire: false,
        slot: 0,
        packActive: false,
        use: false,
        grenade: false,
      } as PlayerInput;
      for (let tick = 0; tick < 100; tick++) stepWorld(world, new Map([[id, input]]));
      expect(
        world.players.position[id * 3 + 2]! - z,
        `team ${team}, spawn ${index}`,
      ).toBeGreaterThan(8);
    }
});
