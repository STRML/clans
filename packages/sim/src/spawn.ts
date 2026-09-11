import { HEAVY_ARMOR } from './armor.js';
import { raycastInteriors, type InteriorInstance } from './interiors.js';
import { sampleTerrain, type Heightfield } from './terrain.js';
import type { Vec3 } from './types.js';

function walkable(sample: ReturnType<typeof sampleTerrain>): boolean {
  return !sample.empty && sample.normal.y >= 0.85;
}

/** A spawn may not share its capsule with an already-seated player. Katabatic's per-team
 * spheres are 65-100 m across, but only a few degrees of any one sampling ring is walkable
 * ground, so the pure golden-angle fan-out below funnelled every occupant of a sphere into
 * the same first successful slot: 24 bots per team on the real map measured 57 same-team
 * pairs closer than the capsule diameter (minimum 0.05 m, i.e. two players standing inside
 * each other), which the sim never untangles -- packages/sim has no player-vs-player
 * collision. HEAVY_ARMOR's bounding box [1.63, 1.63, 2.6] is the widest capsule any
 * respawn can wear (armor.ts; a station loadout change persists across respawns), so
 * clearing it clears every armor; every bot and every fresh join is LIGHT_ARMOR. */
const SPAWN_SEPARATION = Math.max(HEAVY_ARMOR.boundingBox[0], HEAVY_ARMOR.boundingBox[1]);
const SPAWN_HEIGHT = HEAVY_ARMOR.boundingBox[2];

/** True when a capsule standing at (x, y, z) overlaps the capsule of anyone already
 * seated: closer than one capsule width horizontally AND less than a capsule tall apart
 * vertically (two capsules' y-spans overlap exactly when |dy| < height). */
function overlapsSeatedPlayer(x: number, y: number, z: number, occupied: readonly Vec3[]): boolean {
  for (const seated of occupied) {
    const dx = x - seated.x;
    const dz = z - seated.z;
    if (dx * dx + dz * dz >= SPAWN_SEPARATION * SPAWN_SEPARATION) continue;
    const dy = y - seated.y;
    if (dy > -SPAWN_HEIGHT && dy < SPAWN_HEIGHT) return true;
  }
  return false;
}

/** Mission SpawnSpheres describe areas, not player transforms. Prefer open ground so
 * a new player starts outside the base, with visible surroundings and room to walk.
 * Sampling density, slope/clearance margins and the golden-angle offset are our
 * deterministic demo policy, not claimed original Torque gameplay constants.
 *
 * `occupied` is who is already standing there (server/world.ts feeds it every active
 * player's position). The golden-angle offset alone cannot keep occupants apart: the
 * candidate ring is a fixed 32-point circle, so once the walkable arc of a ring is
 * narrower than one step, every later occupant's first successful sample is the same
 * spot. The capsule-overlap rejection above is what makes the fan-out work past a
 * handful of occupants of one sphere -- and it is also what lets the ring ladder reach
 * wider rings (further from the sphere's crowded first ring) for the ones that follow. */
export function findSpawnPosition(
  terrain: Heightfield,
  interiors: readonly InteriorInstance[],
  center: Vec3,
  radius: number,
  index: number,
  occupied: readonly Vec3[] = [],
): Vec3 {
  const clearance = Math.min(10, Math.max(1, radius / 4));
  const candidate = (x: number, z: number): Vec3 | null => {
    const ground = sampleTerrain(terrain, x, z);
    if (!walkable(ground)) return null;
    const y = ground.height + 0.1;
    if (Math.hypot(x - center.x, y - center.y, z - center.z) > radius + 0.1) return null;
    if (overlapsSeatedPlayer(x, y, z, occupied)) return null;
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
  throw new Error(
    `Spawn sphere at (${center.x}, ${center.y}, ${center.z}) r=${String(radius)} has no ` +
      `clear, walkable outdoor position for seat ${String(index)} clear of ` +
      `${String(occupied.length)} seated player(s)`,
  );
}
