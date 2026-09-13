export const PROJECTILE_SOURCE_FILES = [
  'skins.vl2/textures/skins/disc00.PNG',
  'skins.vl2/textures/skins/Mortar_Projectile.png',
  'textures.vl2/textures/special/blasterBolt.PNG',
  // The bolt's cross quad, `EnergyBolt`'s texture[1] (blaster.cs:262).
  'textures.vl2/textures/special/blasterBoltCross.PNG',
  'textures.vl2/textures/special/shrikeBolt.png',
  'textures.vl2/textures/special/shrikeBoltCross.png',
  'textures.vl2/textures/special/tracer00.PNG',
  'textures.vl2/textures/special/tracercross.png',
  // The one shape here, and the one shape in the whole build the DTS reader cannot open:
  // `disc_explosion.dts` is version 18, older than the 19..23 memory-buffer layout `dts.ts`
  // implements (`TSShape::readOldShape` is a separate pre-v19 path), so this entry still
  // names the mirror's pre-converted `.glb` — which is 404, like every other one. It keeps
  // its cached `.glb` for now; a clean clone cannot fetch it (see ISSUES.md).
  'shapes.vl2/shapes/disc_explosion.glb',
] as const;
