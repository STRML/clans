import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPlayer, createWorld, type Heightfield, type World } from '@clans/sim';

export interface SceneSpawn {
  name: string | null;
  team: number;
  position: [number, number, number];
  radius: number;
}
interface TerrainManifest {
  gridSize: number;
  squareSize: number;
  origin: { x: number; y: number; z: number };
  heightScale: number;
  heights: string;
}
interface SceneData {
  spawns: SceneSpawn[];
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const assetsRoot = resolve(packageRoot, '../../assets/out/katabatic');
// Sized for 31 idle bots plus a few real clients; later milestones raise this to 32 v 32.
const WORLD_CAPACITY = 64;

async function readHeights(manifest: TerrainManifest): Promise<Uint16Array> {
  const bytes = await readFile(resolve(assetsRoot, manifest.heights));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heights = new Uint16Array(bytes.byteLength / 2);
  for (let i = 0; i < heights.length; i += 1) heights[i] = view.getUint16(i * 2, true);
  return heights;
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
  };
  return { world: createWorld(terrain, seed, WORLD_CAPACITY), spawns: scene.spawns };
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

export function spawnPointFor(
  spawns: SceneSpawn[],
  team: number,
  index: number,
): [number, number, number] {
  const teamSpawns = spawns.filter((spawn) => spawn.team === team);
  const chosen = teamSpawns[index % teamSpawns.length];
  if (!chosen) throw new Error(`No spawn point for team ${String(team)}`);
  return chosen.position;
}

export function addBots(world: World, spawns: SceneSpawn[], count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const team = smallerTeam(world);
    const [x, y, z] = spawnPointFor(spawns, team, teamCount(world, team));
    ids.push(addPlayer(world, { x, y, z }, team));
  }
  return ids;
}
