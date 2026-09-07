import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addPlayer,
  buildInteriorCollider,
  createBaseObjects,
  createFlags,
  createTurrets,
  createWorld,
  sampleTerrain,
  type Heightfield,
  type InteriorInstance,
  type InteriorTriangles,
  type World,
} from '@clans/sim';

export interface SceneSpawn {
  name: string | null;
  team: number;
  position: [number, number, number];
  radius: number;
}
export interface SceneFlagStand {
  team: number;
  position: [number, number, number];
}
interface TerrainManifest {
  gridSize: number;
  squareSize: number;
  origin: { x: number; y: number; z: number };
  heightScale: number;
  heights: string;
  emptySquares: number[];
}
interface SceneBaseObject {
  kind: number;
  team: number;
  position: [number, number, number];
  // ForceField placements only -- every other kind leaves both undefined.
  rotation?: { axis: [number, number, number]; degrees: number };
  scale?: [number, number, number];
}
interface SceneTurret {
  barrel: number;
  team: number;
  position: [number, number, number];
}
interface SceneInterior {
  shape: string;
  position: [number, number, number];
  rotation: { axis: [number, number, number]; degrees: number };
}
interface SceneData {
  spawns: SceneSpawn[];
  flagStands: SceneFlagStand[];
  baseObjects: SceneBaseObject[];
  turrets: SceneTurret[];
  interiors: SceneInterior[];
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const assetsRoot = resolve(packageRoot, '../../assets/out/katabatic');
// Sized for 31 idle bots plus a few real clients; later milestones raise this to 32 v 32.
export const WORLD_CAPACITY = 64;

async function readHeights(manifest: TerrainManifest): Promise<Uint16Array> {
  const bytes = await readFile(resolve(assetsRoot, manifest.heights));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heights = new Uint16Array(bytes.byteLength / 2);
  for (let i = 0; i < heights.length; i += 1) heights[i] = view.getUint16(i * 2, true);
  return heights;
}

async function readCollisionTriangles(shape: string): Promise<InteriorTriangles> {
  const bytes = await readFile(resolve(assetsRoot, 'collision', `${shape}.collision.bin`));
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return { positions: view };
}

async function loadInteriors(interiors: SceneInterior[]): Promise<InteriorInstance[]> {
  const instances: InteriorInstance[] = [];
  for (const placement of interiors) {
    const triangles = await readCollisionTriangles(placement.shape);
    instances.push(
      buildInteriorCollider(triangles, {
        position: { x: placement.position[0], y: placement.position[1], z: placement.position[2] },
        rotation: {
          axis: {
            x: placement.rotation.axis[0],
            y: placement.rotation.axis[1],
            z: placement.rotation.axis[2],
          },
          degrees: placement.rotation.degrees,
        },
      }),
    );
  }
  return instances;
}

export async function loadKatabaticWorld(
  seed = 1,
): Promise<{ world: World; spawns: SceneSpawn[] }> {
  const manifest = JSON.parse(
    await readFile(resolve(assetsRoot, 'terrain.json'), 'utf8'),
  ) as TerrainManifest;
  const scene = JSON.parse(await readFile(resolve(assetsRoot, 'scene.json'), 'utf8')) as SceneData;
  const heights = await readHeights(manifest);
  const terrain: Heightfield = {
    gridSize: manifest.gridSize,
    squareSize: manifest.squareSize,
    originX: manifest.origin.x,
    originY: manifest.origin.y,
    originZ: manifest.origin.z,
    heightScale: manifest.heightScale,
    heights,
    emptySquares: new Set(manifest.emptySquares),
  };
  const world = createWorld(terrain, seed, WORLD_CAPACITY);
  createFlags(
    world,
    scene.flagStands.map(({ team, position: [x, y, z] }) => ({ team, position: { x, y, z } })),
  );
  createBaseObjects(
    world,
    scene.baseObjects.map(({ kind, team, position: [x, y, z], rotation, scale }) => ({
      kind,
      team,
      position: { x, y, z },
      ...(rotation && {
        rotation: {
          axis: { x: rotation.axis[0], y: rotation.axis[1], z: rotation.axis[2] },
          degrees: rotation.degrees,
        },
      }),
      ...(scale && { scale: { x: scale[0], y: scale[1], z: scale[2] } }),
    })),
  );
  createTurrets(
    world,
    scene.turrets.map(({ barrel, team, position: [x, y, z] }) => ({
      barrel,
      team,
      position: { x, y, z },
    })),
  );
  world.interiors = await loadInteriors(scene.interiors);
  return { world, spawns: scene.spawns };
}

export function teamCount(world: World, team: number): number {
  let count = 0;
  for (let id = 0; id < world.players.count; id += 1) {
    if (world.players.active[id] && world.players.team[id] === team) count += 1;
  }
  return count;
}

export function smallerTeam(world: World): number {
  return teamCount(world, 1) <= teamCount(world, 2) ? 1 : 2;
}

/**
 * Raises a spawn that sits below the terrain to just above it, matching the correction
 * the single-player client applies to the same mission data (app.ts's spawnPoint): the
 * committed scene has at least one team spawn below its sampled terrain height, and
 * without this the network path placed a player underground until the next simulated
 * tick's ground-contact resolution pushed them back up.
 */
export function spawnPointFor(
  terrain: Heightfield,
  spawns: SceneSpawn[],
  team: number,
  index: number,
): [number, number, number] {
  const teamSpawns = spawns.filter((spawn) => spawn.team === team);
  const chosen = teamSpawns[index % teamSpawns.length];
  if (!chosen) throw new Error(`No spawn point for team ${String(team)}`);
  const [x, y, z] = chosen.position;
  const ground = sampleTerrain(terrain, x, z).height;
  return [x, Math.max(y, ground + 0.1), z];
}

export function addBots(world: World, spawns: SceneSpawn[], count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const team = smallerTeam(world);
    const [x, y, z] = spawnPointFor(world.terrain, spawns, team, teamCount(world, team));
    ids.push(addPlayer(world, { x, y, z }, team));
  }
  return ids;
}
