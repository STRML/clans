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
import { dtsToGlb, parseDts } from './dts.js';
import { AUDIO_SOURCES } from './audio-sources.js';
import { GUI_SOURCE_FILES } from './gui-sources.js';
import { PROJECTILE_SOURCE_FILES } from './projectile-sources.js';

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
const audioOutput = resolve(output, 'audio');
await mkdir(audioOutput, { recursive: true });
for (const [name, source] of Object.entries(AUDIO_SOURCES)) {
  await copyFile(resolve(cache, source), resolve(audioOutput, name));
}
const guiOutput = resolve(output, 'gui');
await mkdir(guiOutput, { recursive: true });
for (const file of GUI_SOURCE_FILES) {
  await copyFile(resolve(cache, 'textures.vl2/textures/gui', file), resolve(guiOutput, file));
}
const projectileOutput = resolve(output, 'projectiles');
await mkdir(projectileOutput, { recursive: true });
for (const source of PROJECTILE_SOURCE_FILES) {
  const filename = source.split('/').at(-1)!;
  // The one shape in this list is a `shapes.vl2` shape: where the mirror publishes it as
  // `.dts` it goes through the shape reader and lands as a `.glb` beside its siblings, and
  // `disc_explosion` — the single shape whose DTS is too old for that reader — still comes
  // from its pre-converted `.glb`. The rest are textures the projectiles' renderer
  // consumes directly.
  if (source.startsWith('shapes.vl2/')) {
    const name = filename.replace(/\.(dts|glb)$/, '');
    const bytes = await readCachedShape(source);
    if (!bytes) throw new Error(`Missing cached shape: ${source}`);
    await mkdir(resolve(output, 'shapes'), { recursive: true });
    await writeFile(resolve(output, 'shapes', `${name}.glb`), attachShapeTextures(bytes));
  } else {
    await copyFile(resolve(cache, source), resolve(projectileOutput, filename));
  }
}
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

/** The only shapes this build converts from their `.dts` source.
 *
 *  Every other shape already has a converted `.glb` committed under
 *  `assets/out/katabatic/shapes/`, and that file is the one to keep. Its animation comes from
 *  the original conversion: the shipped Blender files carry the shape's DTS sequences as glTF
 *  clips, and this pipeline cannot yet emit clips at parity (see `emitSequenceAnimations` in
 *  `dts.ts` for the parity table and the two open defects). Regenerating one of those shapes
 *  would silently strip its animations — the weapons' `discSpin`/`Fire`/`Reload`, the
 *  chaingun's `Spin`, the turrets' `DumTurn`/`DumElevate`/`Deploy`, the pad's
 *  `Dummy_Pad_Center_Rotate`, the Shrike's `DumActWingL` fold — which is a worse file than
 *  the one already committed, not a better one.
 *
 *  So the seventeen shapes that have a committed counterpart stay as committed:
 *    weapons           weapon_disc, weapon_chaingun, weapon_mortar, weapon_sniper, weapon_energy
 *    turrets           turret_aa_large, turret_base_large, turret_fusion_large,
 *                      turret_muzzlepoint, turret_sentry
 *    stations          station_generator_large, station_inv_human, sensor_pulse_large
 *    pads              vehicle_pad, vehicle_pad_station
 *    vehicles          vehicle_shrike (vehicle_air_scout.dts), vehicle_wildcat (vehicle_grav_scout.dts)
 *  This list is the complement of the four names below; the four have no prior asset at all,
 *  so converting them costs nothing and shipping them is the whole point of the DTS reader.
 *  Delete this allowlist — not the sequence work — when the clips reach parity. */
const DTS_CONVERTED_SHAPES: Record<string, true> = {
  vehicle_air_bomber: true,
  vehicle_air_hapc: true,
  vehicle_grav_tank: true,
  vehicle_land_mpbase: true,
};

const shapesDir = resolve(output, 'shapes');
const collisionDir = resolve(output, 'collision');
await mkdir(shapesDir, { recursive: true });
await mkdir(collisionDir, { recursive: true });
let totalBytes = 0;
for (const name of ALL_SHAPE_NAMES) {
  // Which directory — and so which extension — a name comes from mirrors `fetch.ts`'s
  // manifest: an interior is published as `.glb`, every `shapes.vl2` shape as `.dts`.
  const source = mission.interiors.some((i) => i.shape === name)
    ? `interiors.vl2/interiors/${name}.glb`
    : `shapes.vl2/shapes/${name}.dts`;
  // A `.dts` source is this pipeline's own conversion, so it is written only for a shape
  // with no committed GLB (see `DTS_CONVERTED_SHAPES`); the interiors' `.glb` sources are
  // already renderable and keep flowing through the same texture-attach step as before.
  if (source.endsWith('.dts') && DTS_CONVERTED_SHAPES[name] !== true) continue;
  const glbBytes = await readCachedShape(source);
  if (!glbBytes) throw new Error(`Missing cached shape: ${source}`);
  const shapePath = resolve(shapesDir, `${name}.glb`);
  await writeFile(shapePath, attachShapeTextures(glbBytes));
  totalBytes += glbBytes.byteLength;
  // Read the collision soup back from the file just written rather than from the cache
  // source: for a `.dts` shape the cache holds the engine-format source, not geometry a glTF
  // reader can open, and `attachShapeTextures` only patches the JSON chunk of what it emits.
  const triangles = await extractTriangles(shapePath);
  const collisionBytes = writeTriangleBinary(triangles);
  await writeFile(resolve(collisionDir, `${name}.collision.bin`), collisionBytes);
  totalBytes += collisionBytes.byteLength;
}
// The five first-person weapons used to be converted here, ahead of the structures, because
// they are not part of `ALL_SHAPE_NAMES`. They are not converted any more: all five have a
// committed GLB whose clips this pipeline cannot yet reproduce, so they are kept as committed
// like every other `.dts` shape with a prior asset (`DTS_CONVERTED_SHAPES` above).

if (totalBytes > ASSET_SIZE_BUDGET_BYTES) {
  throw new Error(
    `Interior/shape assets total ${String(totalBytes)} bytes, over the ${String(ASSET_SIZE_BUDGET_BYTES)} byte budget`,
  );
}

// T2 station.cs creates StationVehicle dynamically at the pad's Mount0 attachment.
// Convert the DTS basis half-turn, then the mission placement; do not guess an offset.
// Read from the `vehicle_pad.glb` the loop above just wrote: the cache now holds that
// shape's DTS source, which no glTF reader can open.
const padAttachment = await extractAttachment(resolve(shapesDir, 'vehicle_pad.glb'), 'Mount0');
const baseObjects = mission.baseObjects.map((placement) => {
  if (placement.kind !== 3) return placement;
  const [x, y, z] = padAttachment;
  const rotation = placement.rotation ?? { axis: [0, 1, 0], degrees: 0 };
  const axis = vec3.normalize(vec3.create(), rotation.axis);
  const orientation = quat.setAxisAngle(quat.create(), axis, (rotation.degrees * Math.PI) / 180);
  const local = vec3.multiply(vec3.create(), [-x, y, -z], placement.scale ?? [1, 1, 1]);
  vec3.transformQuat(local, local, orientation);
  vec3.add(local, local, placement.position);
  return { ...placement, usePosition: Array.from(local) };
});

// Vehicles are spawned at runtime by the sim, not placed in the mission file, so they get
// no interior collision triangles here — the sim collides them against terrain/interiors
// with a simple sphere radius (VEHICLE_DATA[kind].checkRadius) instead of a mesh. The cache
// holds each vehicle's DTS source, converted here like every other `shapes.vl2` shape; only
// if that entry is missing does this fall through to convertVehicleShape's live-fetch
// glb/procedural chain. There is deliberately no STL tier: a raw .stl cannot be published
// under a .glb name (issue #29), so an unrenderable-shape day falls through to the client's
// procedural placeholder.
const T2_MAPPER_SHAPES_BASE =
  'https://raw.githubusercontent.com/exogen/t2-mapper/HEAD/docs/base/@vl2/shapes.vl2/shapes/';
interface VehicleShapeSpec {
  /** Key this shape fills in `scene.json`'s `vehicles` map, which is what the client's own
   *  vehicle manifest looks up. Omitted for a shape the client has no kind for yet: it is
   *  still built and published, so adopting it later is a manifest entry and nothing else. */
  kind?: 'shrike' | 'wildcat';
  /** DTS name in the mirror (`<cacheName>.dts`), never the output name. */
  cacheName: string;
  outputName: string;
}
const VEHICLE_SHAPES: VehicleShapeSpec[] = [
  {
    kind: 'shrike',
    cacheName: 'vehicle_air_scout',
    outputName: 'vehicle_shrike.glb',
  },
  {
    kind: 'wildcat',
    cacheName: 'vehicle_grav_scout',
    outputName: 'vehicle_wildcat.glb',
  },
  // The rest of the base game's vehicle shapes. They keep their own names as output names
  // because no sim kind renames them yet; each lands at `shapes/<outputName>` like every
  // other shape, which is the path the client asks for.
  { cacheName: 'vehicle_air_bomber', outputName: 'vehicle_air_bomber.glb' },
  { cacheName: 'vehicle_air_hapc', outputName: 'vehicle_air_hapc.glb' },
  { cacheName: 'vehicle_grav_tank', outputName: 'vehicle_grav_tank.glb' },
  { cacheName: 'vehicle_land_mpbase', outputName: 'vehicle_land_mpbase.glb' },
];

/** One shape's bytes from the cache at the path `fetch.ts` fetched it to, ready for
 *  `attachShapeTextures`.
 *
 *  A `shapes.vl2` shape arrives as DTS source — the engine's own container, which no glTF
 *  loader can open — so a `.dts` entry is converted here with `dtsToGlb`. A `.glb` entry is
 *  already the renderable form: that is `interiors.vl2`, whose interiors are `.dif` and have
 *  no DTS at all, and the one shape whose DTS predates the reader. Returns null when the
 *  cache does not hold that path, so callers decide how loud to be. */
async function readCachedShape(source: string): Promise<Uint8Array | null> {
  const path = resolve(cache, source);
  if (!(await exists(path))) return null;
  const bytes = new Uint8Array(await readFile(path));
  if (!source.endsWith('.dts')) return bytes;
  return dtsToGlb(parseDts(bytes), { name: source.split('/').at(-1)!.replace(/\.dts$/, '') });
}

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
  // Same cache-then-network order as every other shape, with `convertVehicleShape` kept as
  // the last tier for the day a vehicle's `.dts` is unavailable too.
  // A vehicle with a committed GLB keeps that file — but the manifest still has to name it,
  // which is what `source: 'glb'` says: the client loads `shapes/<outputName>` either way.
  if (DTS_CONVERTED_SHAPES[spec.outputName.replace(/\.glb$/, '')] !== true) {
    if (spec.kind) vehicles[spec.kind] = { source: 'glb', shape: spec.outputName };
    continue;
  }
  const cachedBytes = await readCachedShape(`shapes.vl2/shapes/${spec.cacheName}.dts`);
  const resolved: VehicleShapeResult = cachedBytes
    ? { source: 'glb', bytes: cachedBytes }
    : await convertVehicleShape(`${T2_MAPPER_SHAPES_BASE}${spec.cacheName}.glb`);
  const prepared = prepareVehicleAsset(resolved);
  if (prepared.bytes) {
    await writeFile(resolve(shapesDir, spec.outputName), prepared.bytes);
  }
  if (spec.kind) vehicles[spec.kind] = { source: prepared.source, shape: spec.outputName };
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

// Original diffuse textures are external to the exported GLBs. The manifest also carries
// one entry per authored IFL frame (skins/<frame>), so bindIflPlayback can load a whole
// texture sequence instead of holding frame 0; the mirror's bitmaps are copied verbatim,
// keeping their 8-bit-per-channel encoding and dimensions (issue #53).
for (const [key, source] of Object.entries(textureSources)) {
  const directory = resolve(output, 'textures', key.split('/')[0]!);
  await mkdir(directory, { recursive: true });
  await copyFile(resolve(cache, source), resolve(output, 'textures', `${key}.png`));
}
