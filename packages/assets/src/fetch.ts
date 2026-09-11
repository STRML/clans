import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import textureSources from './texture-sources.json' with { type: 'json' };
import { AUDIO_SOURCES } from './audio-sources.js';
import { GUI_SOURCE_FILES } from './gui-sources.js';
import { PROJECTILE_SOURCE_FILES } from './projectile-sources.js';

const BASE = 'https://raw.githubusercontent.com/exogen/t2-mapper/HEAD/docs/base/@vl2/';
// Two shape tiers, with different fates upstream. `shapes.vl2` publishes each shape's DTS
// source (`.dts`) while the mirror's pre-converted `.glb` files are gone (404), so those
// entries fetch the `.dts` and `build.ts` converts it with the engine-format reader in
// `dts.ts`. `interiors.vl2` has no `.dts` at all — interiors are `.dif` — and its
// pre-converted `.glb` files are 404 too, so those entries still name a dead URL rather
// than a format nothing here can read; see the interiors finding in ISSUES.md, which needs
// a real `.dif` parser before a clean clone can fetch them.
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
  'shapes.vl2/shapes/sensor_pulse_large.dts',
  'shapes.vl2/shapes/station_generator_large.dts',
  'shapes.vl2/shapes/station_inv_human.dts',
  'shapes.vl2/shapes/turret_aa_large.dts',
  'shapes.vl2/shapes/turret_base_large.dts',
  'shapes.vl2/shapes/turret_fusion_large.dts',
  'shapes.vl2/shapes/turret_muzzlepoint.dts',
  'shapes.vl2/shapes/turret_sentry.dts',
  'shapes.vl2/shapes/vehicle_pad.dts',
  'shapes.vl2/shapes/vehicle_pad_station.dts',
  'shapes.vl2/shapes/weapon_disc.dts',
  'shapes.vl2/shapes/weapon_chaingun.dts',
  'shapes.vl2/shapes/weapon_mortar.dts',
  'shapes.vl2/shapes/weapon_sniper.dts',
  'shapes.vl2/shapes/weapon_energy.dts',

  // Vehicles. The two the sim spawns first (their output names are the client-facing
  // `vehicle_shrike`/`vehicle_wildcat`), then the four base shapes the client has no
  // manifest entry for yet — built here so the model set is complete.
  'shapes.vl2/shapes/vehicle_air_scout.dts',
  'shapes.vl2/shapes/vehicle_grav_scout.dts',
  'shapes.vl2/shapes/vehicle_air_bomber.dts',
  'shapes.vl2/shapes/vehicle_air_hapc.dts',
  'shapes.vl2/shapes/vehicle_grav_tank.dts',
  'shapes.vl2/shapes/vehicle_land_mpbase.dts',
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

for (const source of [
  ...SOURCES,
  ...PROJECTILE_SOURCE_FILES,
  ...Object.values(textureSources),
  ...Object.values(AUDIO_SOURCES),
  ...GUI_SOURCE_FILES.map((file) => `textures.vl2/textures/gui/${file}`),
]) {
  const destination = resolve(cacheRoot, source);
  if (await exists(destination)) continue;
  const response = await fetch(new URL(source, BASE));
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}
