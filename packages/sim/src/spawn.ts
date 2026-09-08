import { raycastInteriors, type InteriorInstance } from './interiors.js';
import { sampleTerrain, type Heightfield } from './terrain.js';
import type { Vec3 } from './types.js';

function walkable(sample: ReturnType<typeof sampleTerrain>): boolean {
  return !sample.empty && sample.normal.y >= 0.85;
}

/** Mission SpawnSpheres describe areas, not player transforms. Prefer open ground so
 * a new player starts outside the base, with visible surroundings and room to walk.
 * Sampling density, slope/clearance margins and the golden-angle offset are our
 * deterministic demo policy, not claimed original Torque gameplay constants. */
export function findSpawnPosition(
  terrain: Heightfield,
  interiors: readonly InteriorInstance[],
  center: Vec3,
  radius: number,
  index: number,
): Vec3 {
  const clearance = Math.min(10, Math.max(1, radius / 4));
  const candidate = (x: number, z: number): Vec3 | null => {
    const ground = sampleTerrain(terrain, x, z);
    if (!walkable(ground)) return null;
    const y = ground.height + 0.1;
    if (Math.hypot(x - center.x, y - center.y, z - center.z) > radius + 0.1) return null;
    // Reject roofs, covered passages, buried terrain, and walls around the capsule.
    if (raycastInteriors(interiors, { x, y, z }, { x: 0, y: 1, z: 0 }, radius * 2 + 3)) return null;
    for (let direction = 0; direction < 8; direction++) {
      const angle = (direction * Math.PI) / 4;
      const dx = Math.sin(angle),
        dz = Math.cos(angle);
      if (raycastInteriors(interiors, { x, y: y + 1, z }, { x: dx, y: 0, z: dz }, clearance))
        return null;
      for (const distance of [1, clearance / 2, clearance]) {
        const next = sampleTerrain(terrain, x + dx * distance, z + dz * distance);
        if (!walkable(next) || Math.abs(next.height - ground.height) > distance * 0.6) return null;
      }
    }
    return { x, y, z };
  };
  // Try the center of a small area before searching around it.
  if (radius <= 10) {
    const middle = candidate(center.x, center.z);
    if (middle) return middle;
  }
  for (let ring = 1; ring <= 8; ring++) {
    const distance = (radius * ring) / 10;
    for (let sample = 0; sample < 32; sample++) {
      const angle = index * 2.399963229728653 + (sample * Math.PI) / 16;
      const point = candidate(
        center.x + Math.sin(angle) * distance,
        center.z + Math.cos(angle) * distance,
      );
      if (point) return point;
    }
  }
  throw new Error('Spawn sphere has no clear, walkable outdoor position');
}
