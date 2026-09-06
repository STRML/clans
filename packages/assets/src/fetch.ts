import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/exogen/t2-mapper/HEAD/docs/base/@vl2/';
const SOURCES = [
  'missions.vl2/missions/Katabatic.mis',
  'missions.vl2/terrains/Katabatic.ter',
  'textures.vl2/textures/terrain/IceWorld.Snow.png',
  'textures.vl2/textures/terrain/IceWorld.RockBlue.png',
  'textures.vl2/textures/terrain/IceWorld.SnowRock.png',
  'textures.vl2/textures/terrain/IceWorld.Ice.png',
  'interiors.vl2/interiors/sbunk2.glb',
  'interiors.vl2/interiors/smisc3.glb',
  'interiors.vl2/interiors/srock6.glb',
  'interiors.vl2/interiors/srock7.glb',
  'interiors.vl2/interiors/srock8.glb',
  'interiors.vl2/interiors/sspir2.glb',
  'interiors.vl2/interiors/sspir3.glb',
  'interiors.vl2/interiors/sspir4.glb',
  'interiors.vl2/interiors/stowr4.glb',
  'interiors.vl2/interiors/stowr6.glb',
  'interiors.vl2/interiors/svpad.glb',
  'shapes.vl2/shapes/sensor_pulse_large.glb',
  'shapes.vl2/shapes/station_generator_large.glb',
  'shapes.vl2/shapes/station_inv_human.glb',
  'shapes.vl2/shapes/turret_aa_large.glb',
  'shapes.vl2/shapes/turret_base_large.glb',
  'shapes.vl2/shapes/turret_fusion_large.glb',
  'shapes.vl2/shapes/turret_muzzlepoint.glb',
  'shapes.vl2/shapes/turret_sentry.glb',
  'shapes.vl2/shapes/vehicle_pad.glb',
] as const;
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cacheRoot = resolve(packageRoot, 'cache');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

for (const source of SOURCES) {
  const destination = resolve(cacheRoot, source);
  if (await exists(destination)) continue;
  const response = await fetch(new URL(source, BASE));
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}
