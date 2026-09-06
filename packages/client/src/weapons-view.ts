import * as THREE from 'three';
import { ProjectileType, WeaponId, type World } from '@clans/sim';
import { EventKind, type EventMessage, type ProjectileSnapshotData } from '@clans/protocol';

const EXPLOSION_LIFETIME_S = 0.25; // Ours: a quick flash, not simulated debris.
const LASER_BEAM_LIFETIME_S = 0.08; // Ours: one or two rendered frames at 60 fps.
const EXPLOSION_RADIUS = 1.5; // Ours: a visible flash, unrelated to the weapon's damage radius.

const WEAPON_COLOR: Record<number, number> = {
  [WeaponId.Spinfusor]: 0xffa000,
  [WeaponId.Chaingun]: 0xffee55,
  [WeaponId.Mortar]: 0x888888,
  [WeaponId.LaserRifle]: 0xff2222,
  [WeaponId.Blaster]: 0x55ccff,
};
const GRENADE_COLOR = 0x55aa55;

export function createProjectileMesh(projectile: ProjectileSnapshotData): THREE.Mesh {
  const isGrenade = projectile.type === ProjectileType.Grenade;
  const radius = isGrenade ? 0.25 : 0.15;
  const geometry = new THREE.SphereGeometry(radius, 8, 6);
  const color = isGrenade ? GRENADE_COLOR : (WEAPON_COLOR[projectile.weaponId] ?? 0xffffff);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
  // Codex review round 2 (PR #9), finding 8: the sim recycles freed projectile ids (same
  // pattern as player id reuse), so a mesh keyed only by id can't tell "same projectile,
  // moved" from "a different projectile got this id". Stamping the type/weaponId it was
  // built for onto the mesh itself lets syncProjectileMeshes below detect the swap.
  mesh.userData.type = projectile.type;
  mesh.userData.weaponId = projectile.weaponId;
  return mesh;
}

// Same convention as remote.ts's disposeMesh and flag-view.ts's disposeFlagGroup: every
// mesh/line here owns geometry and a material created just for it (createProjectileMesh,
// createFlash, createLaserBeam), so removing it from the scene alone leaves both
// allocated -- a match with any sustained weapons fire leaks WebGL resources the garbage
// collector never reclaims.
function disposeMesh(target: THREE.Mesh | THREE.Line): void {
  target.geometry.dispose();
  const material = Array.isArray(target.material) ? target.material : [target.material];
  for (const entry of material) entry.dispose();
}

function pruneProjectileMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  liveIds: Set<number>,
): void {
  for (const id of [...meshes.keys()]) {
    if (liveIds.has(id)) continue;
    const mesh = meshes.get(id);
    if (mesh) {
      scene.remove(mesh);
      disposeMesh(mesh);
    }
    meshes.delete(id);
  }
}

export function syncProjectileMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  projectiles: ProjectileSnapshotData[],
): void {
  const liveIds = new Set(projectiles.map((p) => p.id));
  pruneProjectileMeshes(scene, meshes, liveIds);
  for (const projectile of projectiles) {
    let mesh = meshes.get(projectile.id);
    // Codex review round 2 (PR #9), finding 8: an id surviving frame-to-frame is not proof
    // it is the same projectile -- the sim can free an id and hand it to a brand-new
    // projectile (a different type/weaponId) within one snapshot interval. Reusing the old
    // mesh in that case rendered the new projectile with the old one's geometry/color at
    // the new position, and (from this map's point of view) never registered the old
    // projectile's death.
    if (
      mesh &&
      (mesh.userData.type !== projectile.type || mesh.userData.weaponId !== projectile.weaponId)
    ) {
      scene.remove(mesh);
      disposeMesh(mesh);
      meshes.delete(projectile.id);
      mesh = undefined;
    }
    if (!mesh) {
      mesh = createProjectileMesh(projectile);
      scene.add(mesh);
      meshes.set(projectile.id, mesh);
    }
    mesh.position.set(projectile.x, projectile.y, projectile.z);
  }
}

// Pulls the `?? fallback` branches for a projectile's scalar fields out of
// readProjectileFromWorld itself, which otherwise trips the complexity lint's cap -- adding
// `armed` (round 15, PR #9, finding 2) was the field that tipped it over.
function projectileNum(arr: Float64Array | Uint8Array | Int16Array, i: number): number {
  return arr[i] ?? 0;
}

function readProjectileFromWorld(world: World, id: number): ProjectileSnapshotData {
  const p = world.projectiles;
  const base = id * 3;
  return {
    id,
    type: projectileNum(p.type, id),
    weaponId: projectileNum(p.weaponId, id),
    x: projectileNum(p.position, base),
    y: projectileNum(p.position, base + 1),
    z: projectileNum(p.position, base + 2),
    vx: projectileNum(p.velocity, base),
    vy: projectileNum(p.velocity, base + 1),
    vz: projectileNum(p.velocity, base + 2),
    ownerId: p.ownerId[id] ?? -1,
    armed: projectileNum(p.armed, id),
  };
}

/** Single-player mode has no server snapshot; read the sim's own projectile store directly. */
export function projectilesFromWorld(world: World): ProjectileSnapshotData[] {
  const out: ProjectileSnapshotData[] = [];
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    out.push(readProjectileFromWorld(world, id));
  }
  return out;
}

export interface Effect {
  mesh: THREE.Object3D;
  ttl: number;
}

function createFlash(position: { x: number; y: number; z: number }, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(EXPLOSION_RADIUS, 8, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  mesh.position.set(position.x, position.y, position.z);
  return mesh;
}

/** Projectiles present last frame and gone this frame get a one-shot flash at their last known
 * position — there is no explicit "projectile expired" wire message, so the caller diffs. */
export function spawnExplosionsForExpired(
  scene: THREE.Scene,
  effects: Effect[],
  previous: Map<number, ProjectileSnapshotData>,
  current: ProjectileSnapshotData[],
): void {
  const currentById = new Map(current.map((p) => [p.id, p]));
  for (const [id, last] of previous) {
    // Codex review round 2 (PR #9), finding 8: an id present in `current` is not proof the
    // same projectile is still alive -- the sim can free an id and hand it to a brand-new
    // projectile (different type/weaponId) within one snapshot interval. Matching on id
    // alone silently ate the old projectile's death flash because, from this diff's point
    // of view, "that id still exists". Only treat it as still alive when the type/weaponId
    // also match; otherwise the old one died and gets its flash same as any other expiry.
    const stillAlive = currentById.get(id);
    if (stillAlive && stillAlive.type === last.type && stillAlive.weaponId === last.weaponId) {
      continue;
    }
    const mesh = createFlash(last, WEAPON_COLOR[last.weaponId] ?? 0xffffff);
    scene.add(mesh);
    effects.push({ mesh, ttl: EXPLOSION_LIFETIME_S });
  }
}

export function createLaserBeam(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x, to.y, to.z),
  ]);
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: WEAPON_COLOR[WeaponId.LaserRifle] ?? 0xff2222 }),
  );
}

/** Draws a one-frame beam for each new LaserFired event since the caller's last call. The
 * Laser Rifle is hitscan (Task 3: "no stored projectile"), so it never appears in the
 * projectile snapshot — this Event message is the only way another client learns it fired. */
export function spawnLaserBeams(
  scene: THREE.Scene,
  effects: Effect[],
  newEvents: EventMessage[],
  positionOf: (playerId: number) => { x: number; y: number; z: number } | null,
): void {
  for (const event of newEvents) {
    if (event.kind !== EventKind.LaserFired) continue;
    const from = positionOf(event.a);
    const to = event.b >= 0 ? positionOf(event.b) : null;
    if (!from || !to) continue;
    const beam = createLaserBeam(from, to);
    scene.add(beam);
    effects.push({ mesh: beam, ttl: LASER_BEAM_LIFETIME_S });
  }
}

export function updateEffects(scene: THREE.Scene, effects: Effect[], dtSeconds: number): void {
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const effect = effects[i];
    if (!effect) continue;
    effect.ttl -= dtSeconds;
    if (effect.ttl <= 0) {
      scene.remove(effect.mesh);
      // Effect.mesh is every explosion flash (createFlash: a Mesh) and laser beam
      // (createLaserBeam: a Line) this module creates -- both own disposable geometry
      // and material, unlike an arbitrary Object3D.
      if (effect.mesh instanceof THREE.Mesh || effect.mesh instanceof THREE.Line) {
        disposeMesh(effect.mesh);
      }
      effects.splice(i, 1);
    }
  }
}
