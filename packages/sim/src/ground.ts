import { raycastInteriors } from './interiors.js';
import { sampleTerrain } from './terrain.js';
import type { Vec3, World } from './types.js';

/** Find support below an object without treating removed terrain as a surface. */
export function groundHeightAt(world: World, position: Vec3): number | null {
  const terrain = sampleTerrain(world.terrain, position.x, position.z);
  if (!terrain.empty) return terrain.height;
  // Start just above the object so a point resting on a floor still finds it.
  const epsilon = 0.001;
  const hit = raycastInteriors(
    world.interiors,
    { ...position, y: position.y + epsilon },
    { x: 0, y: -1, z: 0 },
    Math.max(0, position.y - world.killY) + epsilon,
  );
  return hit?.point.y ?? null;
}
