import { quat, vec3 } from 'gl-matrix';
import { attachShapeTextures, prepareVehicleAsset } from './textures.js';
import textureSources from './texture-sources.json' with { type: 'json' };
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSET_SIZE_BUDGET_BYTES,
  extractAttachment,
  extractTriangles,
  writeTriangleBinary,
} from './interiors.js';
import { parseMission } from './mis.js';
import { extractScene } from './scene.js';
import { decodeTer } from './ter.js';
import { convertVehicleShape, type VehicleShapeResult } from './vehicleShapes.js';

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

// Base objects and turrets carry no shape filename in the mission itself — T2 resolves that
// from the datablock script at load time (e.g. `GeneratorLarge -> station_generator_large.dts`,
// staticShape.cs:451). These fixed per-kind/per-barrel tables reproduce that resolution here,
// once, at build time, so the client/server never need the datablock scripts themselves.
const SHAPE_FOR_BASE_OBJECT_KIND: Record<number, string> = {
  0: 'station_generator_large', // Generator — staticShape.cs:451
  1: 'sensor_pulse_large', // Sensor — staticShape.cs:346
  2: 'station_inv_human', // StationInventory — station.cs:140
  3: 'vehicle_pad', // StationVehiclePad — station.cs:239
};
const SHAPE_FOR_TURRET_BARREL: Record<number, string> = {
  0: 'turret_fusion_large', // PlasmaBarrelLarge (the turret_base_large base is shared, rendered separately) — plasmaBarrelLarge.cs:246
  1: 'turret_aa_large', // AABarrelLarge — aaBarrelLarge.cs
  2: 'turret_sentry', // SentryTurretBarrel — sentryTurret.cs:141
};
const ALL_SHAPE_NAMES = [
  'sbunk2',
  'smisc3',
  'srock6',
  'srock7',
  'srock8',
  'sspir2',
  'sspir3',
  'sspir4',
  'stowr4',
  'stowr6',
  'svpad',
  'sensor_pulse_large',
  'station_generator_large',
  'station_inv_human',
  'turret_aa_large',
  'turret_base_large',
  'turret_fusion_large',
  'turret_muzzlepoint',
  'turret_sentry',
  'vehicle_pad',
  'vehicle_pad_station',
];

// T2 station.cs creates StationVehicle dynamically at the pad's Mount0 attachment.
// Convert the DTS basis half-turn, then the mission placement; do not guess an offset.
const attachment = await extractAttachment(
  resolve(cache, 'shapes.vl2/shapes/vehicle_pad.glb'),
  'Mount0',
);
const baseObjects = mission.baseObjects.map((placement) => {
  if (placement.kind !== 3) return placement;
  const [x, y, z] = attachment;
  const rotation = placement.rotation ?? { axis: [0, 1, 0], degrees: 0 };
  const axis = vec3.normalize(vec3.create(), rotation.axis);
  const orientation = quat.setAxisAngle(quat.create(), axis, (rotation.degrees * Math.PI) / 180);
  const local = vec3.multiply(vec3.create(), [-x, y, -z], placement.scale ?? [1, 1, 1]);
  vec3.transformQuat(local, local, orientation);
  vec3.add(local, local, placement.position);
  return { ...placement, usePosition: Array.from(local) };
});

const shapesDir = resolve(output, 'shapes');
const collisionDir = resolve(output, 'collision');
await mkdir(shapesDir, { recursive: true });
await mkdir(collisionDir, { recursive: true });
let totalBytes = 0;
for (const name of ALL_SHAPE_NAMES) {
  const sourceDir = mission.interiors.some((i) => i.shape === name)
    ? 'interiors.vl2/interiors'
    : 'shapes.vl2/shapes';
  const glbBytes = await readFile(resolve(cache, sourceDir, `${name}.glb`));
  await writeFile(resolve(shapesDir, `${name}.glb`), attachShapeTextures(glbBytes));
  totalBytes += glbBytes.byteLength;
  const triangles = await extractTriangles(resolve(cache, sourceDir, `${name}.glb`));
  const collisionBytes = writeTriangleBinary(triangles);
  await writeFile(resolve(collisionDir, `${name}.collision.bin`), collisionBytes);
  totalBytes += collisionBytes.byteLength;
}
for (const name of [
  'weapon_disc',
  'weapon_chaingun',
  'weapon_mortar',
  'weapon_sniper',
  'weapon_energy',
]) {
  const bytes = await readFile(resolve(cache, 'shapes.vl2/shapes', `${name}.glb`));
  await writeFile(resolve(shapesDir, `${name}.glb`), attachShapeTextures(bytes));
  totalBytes += bytes.byteLength;
}

if (totalBytes > ASSET_SIZE_BUDGET_BYTES) {
  throw new Error(
    `Interior/shape assets total ${String(totalBytes)} bytes, over the ${String(ASSET_SIZE_BUDGET_BYTES)} byte budget`,
  );
}

// Vehicles are spawned at runtime by the sim, not placed in the mission file, so they get
// no interior collision triangles here — the sim collides them against terrain/interiors
// with a simple sphere radius (VEHICLE_DATA[kind].checkRadius) instead of a mesh. Prefer the
// glb `fetch.ts` already cached locally; only fall through to convertVehicleShape's
// live-fetch STL/procedural chain if that cache entry is missing.
const T2_MAPPER_SHAPES_BASE =
  'https://raw.githubusercontent.com/exogen/t2-mapper/HEAD/docs/base/@vl2/shapes.vl2/shapes/';
const STL_FALLBACK_BASE = 'https://files.nastyhobbit.org/t2-models/stl-files/';
interface VehicleShapeSpec {
  kind: 'shrike' | 'wildcat';
  cacheName: string;
  stlName: string;
  outputName: string;
}
const VEHICLE_SHAPES: VehicleShapeSpec[] = [
  {
    kind: 'shrike',
    cacheName: 'vehicle_air_scout',
    stlName: 'Shrike-Fighter',
    outputName: 'vehicle_shrike.glb',
  },
  {
    kind: 'wildcat',
    cacheName: 'vehicle_grav_scout',
    stlName: 'Wildcat-Grav-Cycle',
    outputName: 'vehicle_wildcat.glb',
  },
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const vehicles: Record<string, { source: VehicleShapeResult['source']; shape: string }> = {};
for (const spec of VEHICLE_SHAPES) {
  const cachedPath = resolve(cache, 'shapes.vl2/shapes', `${spec.cacheName}.glb`);
  const resolved: VehicleShapeResult = (await exists(cachedPath))
    ? { source: 'glb', bytes: await readFile(cachedPath) }
    : await convertVehicleShape(
        `${T2_MAPPER_SHAPES_BASE}${spec.cacheName}.glb`,
        `${STL_FALLBACK_BASE}${spec.stlName}.stl`,
      );
  const prepared = prepareVehicleAsset(resolved);
  if (prepared.bytes) {
    await writeFile(resolve(shapesDir, spec.outputName), prepared.bytes);
  }
  vehicles[spec.kind] = { source: prepared.source, shape: spec.outputName };
}

await writeFile(
  resolve(output, 'scene.json'),
  `${JSON.stringify(
    {
      ...mission,
      baseObjects,
      shapesForBaseObjectKind: SHAPE_FOR_BASE_OBJECT_KIND,
      shapesForTurretBarrel: SHAPE_FOR_TURRET_BARREL,
      vehicles,
    },
    null,
    2,
  )}\n`,
);

// Original diffuse textures are external to the exported GLBs; animated IFLs use frame 1.
for (const [key, source] of Object.entries(textureSources)) {
  const directory = resolve(output, 'textures', key.split('/')[0]!);
  await mkdir(directory, { recursive: true });
  await copyFile(resolve(cache, source), resolve(output, 'textures', `${key}.png`));
}
