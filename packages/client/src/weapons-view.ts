import { createDiscExplosion } from './disc-explosion.js';
import * as THREE from 'three';
import { ProjectileType, WeaponId, type World } from '@clans/sim';
import { EventKind, type EventMessage, type ProjectileSnapshotData } from '@clans/protocol';
import { assetUrl } from './assets.js';

const EXPLOSION_LIFETIME_S = 0.25; // Ours: a quick flash, not simulated debris.
const LASER_BEAM_LIFETIME_S = 1; // sniperRifle.cs: fadeTime.
const EXPLOSION_RADIUS = 1.5; // Ours: a visible flash, unrelated to the weapon's damage radius.

const WEAPON_COLOR: Record<number, number> = {
  [WeaponId.Spinfusor]: 0x66bbff,
  [WeaponId.Chaingun]: 0xffee55,
  [WeaponId.Mortar]: 0x888888,
  [WeaponId.LaserRifle]: 0xff2222,
  [WeaponId.Blaster]: 0x55ccff,
};
const GRENADE_COLOR = 0x55aa55;
function sourceTexture(path: string): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const texture = new THREE.TextureLoader().load(assetUrl(path));
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const DISC_TEXTURE = sourceTexture('projectiles/disc00.PNG');
const MORTAR_TEXTURE = sourceTexture('projectiles/Mortar_Projectile.png');
const BLASTER_TEXTURE = sourceTexture('projectiles/blasterBolt.PNG');
const SHRIKE_TEXTURE = sourceTexture('projectiles/shrikeBolt.png');
const SHRIKE_CROSS = sourceTexture('projectiles/shrikeBoltCross.png');
const TRACER_TEXTURE = sourceTexture('projectiles/tracer00.PNG');
const TRACER_CROSS = sourceTexture('projectiles/tracercross.png');
const BLASTER_TRAIL_SECONDS = 0.2;
const SHRIKE_BOLT_LENGTH = 45;
const CHAINGUN_TRACER_LENGTH = 15;

type TrailPoint = { position: THREE.Vector3; age: number };

function directionFor(projectile: ProjectileSnapshotData): THREE.Vector3 {
  const velocity = new THREE.Vector3(projectile.vx, projectile.vy, projectile.vz);
  return velocity.lengthSq() > 1e-6 ? velocity.normalize() : new THREE.Vector3(0, 0, -1);
}

function projectileGeometry(p: ProjectileSnapshotData): THREE.BufferGeometry {
  if (p.weaponId === WeaponId.Spinfusor) return new THREE.CylinderGeometry(0.18, 0.18, 0.045, 16);
  if (isTracer(p)) return tracerGeometry(p);
  if (p.weaponId === WeaponId.Mortar || p.type === ProjectileType.Grenade) {
    return new THREE.SphereGeometry(p.type === ProjectileType.Grenade ? 0.25 : 0.19, 10, 7);
  }
  return new THREE.SphereGeometry(p.type === ProjectileType.Energy ? 0.11 : 0.07, 8, 6);
}

function projectileColor(p: ProjectileSnapshotData): number {
  if (p.weaponId === WeaponId.Spinfusor) return 0x4da5ff;
  if (p.type === ProjectileType.VehicleLaser) return 0xffffff;
  if (p.type === ProjectileType.Tracer) return 0xd3d778;
  if (p.weaponId === WeaponId.Mortar || p.type === ProjectileType.Grenade) return GRENADE_COLOR;
  return WEAPON_COLOR[p.weaponId] ?? 0xffffff;
}

function projectileTexture(p: ProjectileSnapshotData): THREE.Texture | null {
  if (p.type === ProjectileType.VehicleLaser) return SHRIKE_TEXTURE;
  if (p.type === ProjectileType.Tracer) return TRACER_TEXTURE;
  if (p.weaponId === WeaponId.Spinfusor) return DISC_TEXTURE;
  if (p.weaponId === WeaponId.Mortar) return MORTAR_TEXTURE;
  if (p.type === ProjectileType.Energy) return BLASTER_TEXTURE;
  return null;
}

function addProjectileTrail(mesh: THREE.Mesh, p: ProjectileSnapshotData, color: number): void {
  if (p.type !== ProjectileType.Energy) return;
  const length = 0;
  const trail = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, length),
    ]),
    new THREE.LineBasicMaterial({
      color: p.type === ProjectileType.Energy ? 0xff5533 : color,
      transparent: true,
      opacity: 0.7,
    }),
  );
  trail.name = 'projectile-trail';
  mesh.add(trail);
}

function isTracer(p: ProjectileSnapshotData): boolean {
  return p.type === ProjectileType.VehicleLaser || p.type === ProjectileType.Tracer;
}

function tracerLength(p: ProjectileSnapshotData): number {
  return p.type === ProjectileType.VehicleLaser ? SHRIKE_BOLT_LENGTH : CHAINGUN_TRACER_LENGTH;
}

function tracerGeometry(p: ProjectileSnapshotData): THREE.PlaneGeometry {
  const width = p.type === ProjectileType.VehicleLaser ? 0.55 : 0.1;
  const length = tracerLength(p);
  const geometry = new THREE.PlaneGeometry(width, length);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, length / 2);
  return geometry;
}

/** Crossed textured ribbons preserve the original glow from different viewing angles. */
function addTracerCross(mesh: THREE.Mesh, p: ProjectileSnapshotData): void {
  if (!isTracer(p)) return;
  const ribbon = new THREE.Mesh(tracerGeometry(p), mesh.material);
  ribbon.rotation.z = Math.PI / 2;
  ribbon.name = 'tracer-ribbon';
  mesh.add(ribbon);
  const size = p.type === ProjectileType.VehicleLaser ? 0.99 : 0.2;
  const head = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: p.type === ProjectileType.VehicleLaser ? SHRIKE_CROSS : TRACER_CROSS,
      color: projectileColor(p),
      transparent: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  head.name = 'tracer-head';
  mesh.add(head);
}

function glowProjectile(p: ProjectileSnapshotData): boolean {
  return isTracer(p) || p.type === ProjectileType.Energy || p.weaponId === WeaponId.Spinfusor;
}

function projectileOrientation(mesh: THREE.Mesh, p: ProjectileSnapshotData): void {
  const forward = directionFor(p);
  if (p.weaponId !== WeaponId.Spinfusor) {
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), forward);
    return;
  }
  // A shortest-arc quaternion introduces heading-dependent roll when aiming up/down.
  // Build the disc's flight frame from world up, keeping the plate level across headings.
  const right = forward.clone().cross(new THREE.Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = right.clone().cross(forward).normalize();
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward.negate()));
}

function addDiscGlow(mesh: THREE.Mesh, p: ProjectileSnapshotData): void {
  if (p.weaponId !== WeaponId.Spinfusor) return;
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.65, 0.65),
    new THREE.MeshBasicMaterial({
      map: DISC_TEXTURE,
      color: 0x88bbff,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.name = 'disc-glow';
  mesh.add(glow);
}

export function createProjectileMesh(projectile: ProjectileSnapshotData): THREE.Mesh {
  // Tribes 2's disc is a spinning flat plate; mortar and grenade are their own chunky
  // green shells, not recoloured copies of the same generic sphere.
  const color = projectileColor(projectile);
  const mesh = new THREE.Mesh(
    projectileGeometry(projectile),
    new THREE.MeshBasicMaterial({
      color:
        projectile.type === ProjectileType.Energy || projectile.weaponId === WeaponId.Spinfusor
          ? 0xffffff
          : color,
      map: projectileTexture(projectile),
      transparent: true,
      opacity: projectile.weaponId === WeaponId.Spinfusor ? 1 : 0.9,
      blending: glowProjectile(projectile) ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !glowProjectile(projectile),
      fog: !glowProjectile(projectile),
      side: THREE.DoubleSide,
    }),
  );
  addProjectileTrail(mesh, projectile, color);
  addTracerCross(mesh, projectile);
  addDiscGlow(mesh, projectile);
  // Codex review round 2 (PR #9), finding 8: the sim recycles freed projectile ids (same
  // pattern as player id reuse), so a mesh keyed only by id can't tell "same projectile,
  // moved" from "a different projectile got this id". Stamping the type/weaponId it was
  // built for onto the mesh itself lets syncProjectileMeshes below detect the swap.
  mesh.userData.type = projectile.type;
  mesh.userData.weaponId = projectile.weaponId;
  mesh.userData.history = projectile.type === ProjectileType.Energy ? [] : undefined;
  projectileOrientation(mesh, projectile);
  return mesh;
}

// Same convention as remote.ts's disposeMesh and flag-view.ts's disposeFlagGroup: every
// mesh/line here owns geometry and a material created just for it (createProjectileMesh,
// createFlash, createLaserBeam), so removing it from the scene alone leaves both
// allocated -- a match with any sustained weapons fire leaks WebGL resources the garbage
// collector never reclaims.
function disposeMesh(target: THREE.Object3D): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  target.traverse((object) => {
    const renderable = object as THREE.Mesh | THREE.Line;
    if (
      'geometry' in renderable &&
      renderable.geometry &&
      !disposedGeometries.has(renderable.geometry)
    ) {
      renderable.geometry.dispose();
      disposedGeometries.add(renderable.geometry);
    }
    if ('material' in renderable && renderable.material) {
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material];
      for (const material of materials) {
        if (!disposedMaterials.has(material)) {
          material.dispose();
          disposedMaterials.add(material);
        }
      }
    }
  });
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

function updateBlasterHistory(
  mesh: THREE.Mesh,
  trail: THREE.Line,
  p: ProjectileSnapshotData,
  dt: number,
): void {
  const history = (mesh.userData.history as TrailPoint[] | undefined) ?? [];
  const current = new THREE.Vector3(p.x, p.y, p.z);
  for (const point of history) point.age += dt;
  while (history.length > 0 && history[0]!.age > BLASTER_TRAIL_SECONDS) history.shift();
  const last = history[history.length - 1];
  if (!last || last.position.distanceToSquared(current) > 1e-8)
    history.push({ position: current, age: 0 });
  mesh.userData.history = history;
  const inverse = new THREE.Matrix4().compose(mesh.position, mesh.quaternion, mesh.scale).invert();
  trail.geometry.setFromPoints(
    history.map((point) => point.position.clone().applyMatrix4(inverse)),
  );
}

function updateBlasterTrail(mesh: THREE.Mesh, p: ProjectileSnapshotData, dt: number): void {
  const trail = mesh.getObjectByName('projectile-trail');
  if (!(trail instanceof THREE.Line) || !(trail.material instanceof THREE.LineBasicMaterial))
    return;
  if (p.type === ProjectileType.Energy) updateBlasterHistory(mesh, trail, p, dt);
  trail.material.opacity = p.type === ProjectileType.Tracer ? 0.8 : 0.7;
}

function syncOneProjectile(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  p: ProjectileSnapshotData,
  dt: number,
): void {
  let mesh = meshes.get(p.id);
  if (mesh && (mesh.userData.type !== p.type || mesh.userData.weaponId !== p.weaponId)) {
    scene.remove(mesh);
    disposeMesh(mesh);
    meshes.delete(p.id);
    mesh = undefined;
  }
  if (!mesh) {
    mesh = createProjectileMesh(p);
    scene.add(mesh);
    meshes.set(p.id, mesh);
  }
  mesh.position.set(p.x, p.y, p.z);
  projectileOrientation(mesh, p);
  if (p.weaponId === WeaponId.Spinfusor) {
    mesh.userData.spin = ((mesh.userData.spin as number | undefined) ?? 0) + dt * 30;
    mesh.rotateY(mesh.userData.spin as number);
  }
  if (isTracer(p)) {
    const travelled =
      ((mesh.userData.travelled as number | undefined) ?? 0) + Math.hypot(p.vx, p.vy, p.vz) * dt;
    mesh.userData.travelled = travelled;
    mesh.scale.z = Math.min(1, travelled / tracerLength(p));
  }
  updateBlasterTrail(mesh, p, dt);
}

export function syncProjectileMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  projectiles: ProjectileSnapshotData[],
  dtSeconds = 1 / 60,
): void {
  const liveIds = new Set(projectiles.map((p) => p.id));
  pruneProjectileMeshes(scene, meshes, liveIds);
  for (const projectile of projectiles) syncOneProjectile(scene, meshes, projectile, dtSeconds);
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
  expanding?: boolean;
  update?: (dt: number, camera?: THREE.Camera) => void;
  dispose?: () => void;
}

function createFlash(position: { x: number; y: number; z: number }, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(EXPLOSION_RADIUS, 8, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  mesh.position.set(position.x, position.y, position.z);
  return mesh;
}

function createProjectileImpact(p: ProjectileSnapshotData): THREE.Mesh {
  if (!isTracer(p)) return createFlash(p, WEAPON_COLOR[p.weaponId] ?? 0xffffff);
  // Bullets make compact impact flashes, not the explosive weapons' metre-wide fireballs.
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 8, 6),
    new THREE.MeshBasicMaterial({
      map: p.type === ProjectileType.VehicleLaser ? SHRIKE_CROSS : TRACER_CROSS,
      color: projectileColor(p),
      transparent: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      depthWrite: false,
    }),
  );
  mesh.position.set(p.x, p.y, p.z);
  mesh.scale.setScalar(p.type === ProjectileType.VehicleLaser ? 0.5 : 0.12);
  return mesh;
}

function projectileImpactEffect(p: ProjectileSnapshotData): Effect {
  if (p.weaponId === WeaponId.Spinfusor) {
    const original = createDiscExplosion(p);
    if (original) return original;
    const mesh = createFlash(p, 0x66bbff);
    mesh.scale.setScalar(3);
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.fog = false;
    return { mesh, ttl: 0.6, expanding: true };
  }
  return { mesh: createProjectileImpact(p), ttl: EXPLOSION_LIFETIME_S };
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
    const effect = projectileImpactEffect(last);
    scene.add(effect.mesh);
    effects.push(effect);
  }
}

export function spawnVehicleExplosion(
  scene: THREE.Scene,
  effects: Effect[],
  position: { x: number; y: number; z: number },
): void {
  const mesh = createFlash(position, 0xff8822);
  mesh.name = 'vehicle-explosion';
  mesh.scale.setScalar(4);
  scene.add(mesh);
  effects.push({ mesh, ttl: 1, expanding: true });
}

export function createLaserBeam(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x, to.y, to.z),
  ]);
  const material = new THREE.LineBasicMaterial({ color: 0xff2222, transparent: true });
  const beam = new THREE.Line(geometry, material);
  const start = new THREE.Vector3(from.x, from.y, from.z);
  const end = new THREE.Vector3(to.x, to.y, to.z);
  const direction = end.clone().sub(start);
  // sniperRifle.cs startBeamWidth/endBeamWidth. A mesh preserves width on WebGL,
  // where LineBasicMaterial linewidth is fixed at one pixel.
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(0.125, 0.0725, direction.length(), 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, depthWrite: false }),
  );
  core.position.copy(start).add(end).multiplyScalar(0.5);
  core.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  beam.add(core);
  return beam;
}

/** Draws a one-frame beam for each new LaserFired event since the caller's last call. The
 * Laser Rifle is hitscan (Task 3: "no stored projectile"), so it never appears in the
 * projectile snapshot — this Event message is the only way another client learns it fired. */
function beamEndpoints(
  event: EventMessage,
  positionOf: (id: number) => { x: number; y: number; z: number } | null,
) {
  return {
    from: event.beam?.from ?? positionOf(event.a),
    to: event.beam?.to ?? (event.b >= 0 ? positionOf(event.b) : null),
  };
}

export function spawnLaserBeams(
  scene: THREE.Scene,
  effects: Effect[],
  newEvents: EventMessage[],
  positionOf: (playerId: number) => { x: number; y: number; z: number } | null,
  localPlayerId = -1,
): void {
  for (const event of newEvents) {
    if (event.kind !== EventKind.LaserFired) continue;
    const { from, to } = beamEndpoints(event, positionOf);
    if (!from || !to) continue;
    const muzzle = new THREE.Vector3(from.x, from.y, from.z);
    if (event.a === localPlayerId) {
      // Visual muzzle offset only; the server's collision endpoint remains authoritative.
      const forward = new THREE.Vector3(to.x, to.y, to.z).sub(muzzle).normalize();
      const right = forward
        .clone()
        .cross(new THREE.Vector3(0, 1, 0))
        .normalize();
      muzzle.addScaledVector(right, 0.32).addScaledVector(forward, 0.7);
      muzzle.y -= 0.22;
    }
    const beam = createLaserBeam(muzzle, to);
    scene.add(beam);
    effects.push({ mesh: beam, ttl: LASER_BEAM_LIFETIME_S });
  }
}

function disposeEffect(effect: Effect): void {
  if (effect.dispose) effect.dispose();
  else if (effect.mesh instanceof THREE.Mesh || effect.mesh instanceof THREE.Line)
    disposeMesh(effect.mesh);
}

export function updateEffects(
  scene: THREE.Scene,
  effects: Effect[],
  dtSeconds: number,
  camera?: THREE.Camera,
): void {
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const effect = effects[i];
    if (!effect) continue;
    effect.ttl -= dtSeconds;
    effect.update?.(dtSeconds, camera);
    if (effect.mesh instanceof THREE.Line) {
      effect.mesh.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.Line) {
          (node.material as THREE.Material).opacity = Math.max(
            0,
            effect.ttl / LASER_BEAM_LIFETIME_S,
          );
        }
      });
    }
    if (effect.expanding && effect.mesh instanceof THREE.Mesh) {
      effect.mesh.scale.addScalar(dtSeconds * 4);
      (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, effect.ttl) * 0.8;
    }
    if (effect.ttl <= 0) {
      scene.remove(effect.mesh);
      // Effect.mesh is every explosion flash (createFlash: a Mesh) and laser beam
      // (createLaserBeam: a Line) this module creates -- both own disposable geometry
      // and material, unlike an arbitrary Object3D.
      disposeEffect(effect);
      effects.splice(i, 1);
    }
  }
}
