import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMission } from './mis.js';
import { extractScene } from './scene.js';
import { decodeTer } from './ter.js';

export interface TerrainManifest {
  gridSize: 256;
  squareSize: 8;
  origin: { x: number; y: number; z: number };
  minHeight: number;
  maxHeight: number;
  heightScale: 32;
  heights: 'heights.bin';
  materials: 'materials.bin';
  layers: Array<{ name: string; texture: string; alpha: string }>;
  emptySquares: number[];
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const cache = resolve(packageRoot, 'cache');
const output = resolve(repoRoot, 'assets/out/katabatic');
const missionBytes = await readFile(resolve(cache, 'missions.vl2/missions/Katabatic.mis'));
const mission = extractScene(parseMission(new TextDecoder('windows-1252').decode(missionBytes)));
const terrain = decodeTer(await readFile(resolve(cache, 'missions.vl2/terrains/Katabatic.ter')));
const expectedNames = [
  'terrain.IceWorld.Snow',
  'terrain.IceWorld.RockBlue',
  'terrain.IceWorld.SnowRock',
  'terrain.IceWorld.Ice',
];
if (terrain.materialNames.join('|') !== expectedNames.join('|')) {
  throw new Error(`Unexpected Katabatic materials: ${terrain.materialNames.join(', ')}`);
}

await mkdir(output, { recursive: true });
const heightBytes = new Uint8Array(terrain.heights.length * 2);
const heightView = new DataView(heightBytes.buffer);
terrain.heights.forEach((height, index) => heightView.setUint16(index * 2, height, true));
await writeFile(resolve(output, 'heights.bin'), heightBytes);
await writeFile(resolve(output, 'materials.bin'), terrain.materials);
const textureDir = 'terrain';
const layers = [];
for (let index = 0; index < terrain.materialNames.length; index += 1) {
  const name = terrain.materialNames[index] ?? '';
  const texture = `${name}.png`;
  const alpha = `alpha-${index}.bin`;
  // Material names carry the texture directory as a leading dot segment
  // (e.g. "terrain.IceWorld.Snow"), but the cached source files are bare
  // ("IceWorld.Snow.png"). Strip the known directory prefix to find the
  // source file; this generalizes to any material under the same directory.
  const sourceName = name.startsWith(`${textureDir}.`) ? name.slice(textureDir.length + 1) : name;
  await writeFile(resolve(output, alpha), terrain.alphaMaps[index] ?? new Uint8Array());
  await copyFile(
    resolve(cache, 'textures.vl2/textures/terrain', `${sourceName}.png`),
    resolve(output, texture),
  );
  layers.push({ name, texture, alpha });
}
let minHeight = Infinity;
let maxHeight = -Infinity;
for (const height of terrain.heights) {
  minHeight = Math.min(minHeight, height / 32);
  maxHeight = Math.max(maxHeight, height / 32);
}
const manifest: TerrainManifest = {
  gridSize: 256,
  squareSize: 8,
  origin: {
    x: mission.terrain.position[0],
    y: mission.terrain.position[1],
    z: mission.terrain.position[2],
  },
  minHeight,
  maxHeight,
  heightScale: 32,
  heights: 'heights.bin',
  materials: 'materials.bin',
  layers,
  emptySquares: mission.terrain.emptySquares,
};
await writeFile(resolve(output, 'terrain.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(output, 'scene.json'), `${JSON.stringify(mission, null, 2)}\n`);
