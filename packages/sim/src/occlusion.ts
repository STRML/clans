import { activeForceFieldBlockers } from './baseObjects.js';
import { raycastInteriors, type InteriorInstance } from './interiors.js';
import type { Vec3, World } from './types.js';

/**
 * Interior/force-field segment occlusion, shared by everything that must know whether two
 * points can see each other through the base's built geometry:
 *
 *  - Issue #49: turrets.ts's target acquisition/retention consulted `hasLineOfSight`,
 *    which samples terrain only, so a powered turret kept tracking and firing at a target
 *    standing behind an interior wall its own projectiles could not penetrate.
 *  - Issue #21: projectiles.ts's Laser Rifle hitscan needed the same layer folded into its
 *    visible-span computation (alongside base-object/turret volumes, which stay in
 *    projectiles.ts where the hit-sphere model lives).
 *
 * `hasLineOfSight` itself keeps its original terrain-only semantics on purpose --
 * packages/bots perception/waypoints and sim/repair.ts depend on exactly those -- so the
 * interior/force-field half lives here and callers AND the two answers. Both functions
 * below resolve geometry through the exact same `raycastInteriors` machinery every
 * projectile already collides with (a force field's cached geometry is itself an
 * `InteriorInstance`, baseObjects.ts): one raycaster, not two. Terrain is deliberately out
 * of scope; callers that need it already march it (marchTerrain / hasLineOfSight).
 */

/** Every interior/force-field collider a member of `team` must treat as solid along a ray
 *  or segment: every static interior, plus only OPPOSING force fields -- powered,
 *  non-destroyed fields owned by another team (`activeForceFieldBlockers`; a field is
 *  team-passable, so it never blinds or blocks its own side). Exported rather than private
 *  because `projectiles.ts`'s world-hit resolution needs the full collider list -- its hits
 *  carry distance/point/normal for beam ends and bounce normals, more than this module's
 *  boolean segment answer -- while `turrets.ts` only ever wants the boolean. */
export function interiorFieldColliders(world: World, team: number): InteriorInstance[] {
  const fields = activeForceFieldBlockers(world, team);
  return fields.length === 0 ? world.interiors : [...world.interiors, ...fields];
}

/** True when the straight segment `from` -> `to` crosses a static interior or an active
 *  opposing force field (see `interiorFieldColliders` for the team rule) -- i.e. when the
 *  two endpoints cannot see each other through built geometry. A zero-length segment
 *  cannot cross anything, and a world with no interiors or fields short-circuits before
 *  any ray math (the common case for every open-field map). */
export function segmentBlockedByInteriors(
  world: World,
  from: Vec3,
  to: Vec3,
  team: number,
): boolean {
  const colliders = interiorFieldColliders(world, team);
  if (colliders.length === 0) return false;
  const dx = to.x - from.x,
    dy = to.y - from.y,
    dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return false;
  const direction: Vec3 = { x: dx / length, y: dy / length, z: dz / length };
  return raycastInteriors(colliders, from, direction, length) !== null;
}
