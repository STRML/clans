import { createDiscExplosion } from './disc-explosion.js';
import * as THREE from 'three';
import {
  FIXED_TICK_MS,
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  type ProjectileImpact,
  type World,
} from '@clans/sim';
import {
  EventKind,
  SNAPSHOT_EVERY_N_TICKS,
  type EventMessage,
  type ProjectileSnapshotData,
} from '@clans/protocol';
import { assetUrl } from './assets.js';
import { ProjectileTrail } from './projectile-trail.js';
import { MAX_EXTRAPOLATE_MS } from './remote.js';

const EXPLOSION_LIFETIME_S = 0.25; // Ours: a quick flash, not simulated debris.
/** Issue #57: how long a disc's launch flash lives. Ours -- a muzzle flash is a launch
 *  marker, not simulated debris, and `disc.cs` has no flash datablock of its own to copy.
 *  80 ms is two NTSC frames and ~5 frames at 60 fps: long enough to read the disc leaving
 *  the muzzle, short enough that it never reads as a projectile of its own. */
const MUZZLE_FLASH_LIFETIME_S = 0.08;
/** The launch flash spans a little wider than the disc plate it marks (0.816 m across,
 *  `disc.glb`), so the bloom reads as light coming off the disc rather than as a second
 *  disc. */
const MUZZLE_FLASH_SIZE = 1.2;
const LASER_BEAM_LIFETIME_S = 1; // sniperRifle.cs: fadeTime.
const EXPLOSION_RADIUS = 1.5; // Ours: a visible flash, unrelated to the weapon's damage radius.
/** The snapshot cadence itself, derived exactly the way remote.ts's own private constant is:
 *  the server sends one every SNAPSHOT_EVERY_N_TICKS ticks (server/src/net.ts), 64 ms at the
 *  sim's 32 ms tick. Derived here rather than imported: remote.ts keeps its copy private to its
 *  own file, and a two-line product of the two published constants is cheaper than widening
 *  that surface for the projectile path. */
const SNAPSHOT_INTERVAL_MS = FIXED_TICK_MS * SNAPSHOT_EVERY_N_TICKS;
/** How far behind the newest projectile sample a disc is drawn: one whole snapshot interval,
 *  which is the smallest delay that keeps the render clock inside the newest CLOSED segment
 *  (a sample on either side of it) rather than in front of the newest sample, where every
 *  frame would be a prediction. That distinction is the whole point for a projectile: inside a
 *  closed segment the draw is an interpolation between two positions the sim really reported,
 *  so a velocity change the client has not seen yet (a bounce) cannot pop the mesh the way a
 *  dead-reckoned prediction would, and the stale-copy repeats RemoteBuffer has to tolerate
 *  cannot happen here at all (projectiles beyond the relevance radius are never sent,
 *  server/src/snapshot-policy.ts, so every projectile sample describes motion). It is
 *  deliberately NOT remote.ts's INTERP_DELAY_MS: that 100 ms exists so a *player's* pose is
 *  bracketed at a 64 ms cadence, and the extra 36 ms would only park the disc further behind
 *  the explosion its own impact record draws -- 9 m of flight at the disc's 90 m/s. */
const PROJECTILE_INTERP_DELAY_MS = SNAPSHOT_INTERVAL_MS;
/** How many samples one projectile's flight history keeps. Two is the whole need: the render
 *  clock can sit between them (interpolate), after the newest (dead-reckon forward into a
 *  stalled stream), or -- for the first frames of a shot, before the second sample has landed
 *  -- before the oldest (dead-reckon back along the flight line). A projectile's velocity is
 *  constant between bounces, so unlike RemoteBuffer's 8-sample history there is no fresher
 *  anchor to hunt for. */
const PROJECTILE_HISTORY_LENGTH = 2;
/** User report 2026-09-16 (jetting disc birth): how long a local shot's rendered birth slides
 *  from the muzzle the CLIENT saw onto the server's authoritative path. The snapshot that
 *  first carries the shot arrives 1-2 snapshots after the fire and describes a disc launched
 *  from the SERVER's own muzzle -- its player store, a tick or two after the client's
 *  predicted one, metres behind a shooter who kept jetting -- so the birth pull-back alone
 *  lands the disc on that lagged line and the shot visibly leaves from behind the shooter.
 *  T2's own cosmetic answer (TribesNext-era): draw the birth from the client's predicted
 *  muzzle and blend onto the authoritative path over a quarter second -- long enough that
 *  the slide never reads as a pop, short enough that authority wins while the disc is still
 *  close enough for the difference to matter. */
const LAUNCH_BLEND_MS = 250;
/** How long a recorded launch may wait for the snapshot that first carries its projectile:
 *  input flight + server tick + snapshot cadence + jitter, comfortably inside 400 ms. Past
 *  it the shot is presumed lost (dropped packet, pre-join fire) and left uncorrected, so a
 *  stale launch can never anchor some later projectile's birth. */
const PENDING_LAUNCH_TIMEOUT_MS = 400;

const WEAPON_COLOR: Record<number, number> = {
  [WeaponId.Spinfusor]: 0x66bbff,
  [WeaponId.Chaingun]: 0xffee55,
  [WeaponId.Mortar]: 0x888888,
  [WeaponId.LaserRifle]: 0xff2222,
  [WeaponId.Blaster]: 0x55ccff,
};
const GRENADE_COLOR = 0x55aa55;
/** T2 reads a fast projectile partly BY its trail (projectile-trail.ts), so ours carries the
 *  weapon's own glow family: the disc's descends from its datablock light `0.175 0.175 0.5`
 *  (disc.cs:350-378), lifted into the blue the plate already glows in; mortar and grenade
 *  share the shell green GRENADE_COLOR already gives them. */
const DISC_TRAIL_COLOR = 0x7fa8ff;
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
const BLASTER_CROSS = sourceTexture('projectiles/blasterBoltCross.PNG');
// The Blaster bolt, from its own datablock rather than approximated (blaster.cs's EnergyBolt):
// `scale = "0.25 20.0 1.0"` is the stretched quad that gives the bolt its streak, and
// `crossSize = 0.55` the cross quad that gives it volume from any angle, textured
// `special/blasterBolt` and `special/blasterBoltCross` (:261-262). Issue #53's residual was
// exactly this pair: the committed presentation was a sphere plus a positional-history line,
// because the source's own rendering was thought to live only upstream.
const BLASTER_TRAIL_WIDTH = 0.25;
const BLASTER_TRAIL_LENGTH = 20;
const BLASTER_CROSS_SIZE = 0.55;
const SHRIKE_BOLT_LENGTH = 45;
const CHAINGUN_TRACER_LENGTH = 15;
// vehicle_shrike.cs mounts the Shrike's blaster images at offset x ±1.93, z +0.044
// (the "PairImage" at +1.93 fires the right barrel, its sibling at -1.93 the left), and
// %obj.nextWeaponFire alternates the two image slots per shot -- twin-muzzle emission.
const SHRIKE_MUZZLE_OFFSET_X = 1.93;
const SHRIKE_MUZZLE_OFFSET_Y = 0.044;
let nextShrikeMuzzleSide = 1;

function directionFor(projectile: ProjectileSnapshotData): THREE.Vector3 {
  const velocity = new THREE.Vector3(projectile.vx, projectile.vy, projectile.vz);
  return velocity.lengthSq() > 1e-6 ? velocity.normalize() : new THREE.Vector3(0, 0, -1);
}
function projectileGeometry(
  p: ProjectileSnapshotData,
  tail?: { x: number; y: number },
): THREE.BufferGeometry {
  // Source proportions from the original projectile shape (t2-mapper's disc.glb, the
  // disc.cs `projectileShapeName = "disc.dts"` conversion): the Disc plate mesh spans
  // x/z ±0.408 with y ±0.031 -- a 0.816 m plate 0.062 m thick. The old 0.18 m plate was
  // under half the authored size and read as a speck at range.
  if (p.weaponId === WeaponId.Spinfusor) return new THREE.CylinderGeometry(0.408, 0.408, 0.062, 24);
  if (isTracerType(p.type)) return tracerGeometry(p, tail);
  if (p.weaponId === WeaponId.Mortar || p.type === ProjectileType.Grenade) {
    return new THREE.SphereGeometry(p.type === ProjectileType.Grenade ? 0.25 : 0.19, 10, 7);
  }
  if (p.type === ProjectileType.Energy) return blasterTrailGeometry();
  return new THREE.SphereGeometry(0.07, 8, 6);
}

/** The Blaster bolt's streak quad: `EnergyBolt`'s own `scale` of 0.25 wide by 20 long
 *  (blaster.cs:255), laid along the bolt's travel axis the same way the tracer ribbons are,
 *  so the texture stretches behind the head rather than sitting on it. */
function blasterTrailGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(BLASTER_TRAIL_WIDTH, BLASTER_TRAIL_LENGTH);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, BLASTER_TRAIL_LENGTH / 2);
  return geometry;
}

function projectileColor(weaponId: number, type: number): number {
  if (weaponId === WeaponId.Spinfusor) return 0x4da5ff;
  if (type === ProjectileType.VehicleLaser) return 0xffffff;
  if (type === ProjectileType.Tracer) return 0xd3d778;
  if (weaponId === WeaponId.Mortar || type === ProjectileType.Grenade) return GRENADE_COLOR;
  return WEAPON_COLOR[weaponId] ?? 0xffffff;
}

function projectileTexture(p: ProjectileSnapshotData): THREE.Texture | null {
  if (p.type === ProjectileType.VehicleLaser) return SHRIKE_TEXTURE;
  if (p.type === ProjectileType.Tracer) return TRACER_TEXTURE;
  if (p.weaponId === WeaponId.Spinfusor) return DISC_TEXTURE;
  if (p.weaponId === WeaponId.Mortar) return MORTAR_TEXTURE;
  if (p.type === ProjectileType.Energy) return BLASTER_TEXTURE;
  return null;
}

function isTracerType(type: number): boolean {
  return type === ProjectileType.VehicleLaser || type === ProjectileType.Tracer;
}

function tracerLength(p: ProjectileSnapshotData): number {
  return p.type === ProjectileType.VehicleLaser ? SHRIKE_BOLT_LENGTH : CHAINGUN_TRACER_LENGTH;
}

/** Ribbon geometry spanning local z 0..length behind the bolt head. `tail` shears the
 * far end sideways: the shot origin presentation, so a Shrike bolt's visible tail sits at
 * the alternating wing barrel instead of the vehicle centreline the sim spawns at. The
 * server's collision endpoint stays authoritative -- only this far end moves. */
function tracerGeometry(
  p: ProjectileSnapshotData,
  tail?: { x: number; y: number },
): THREE.PlaneGeometry {
  const width = p.type === ProjectileType.VehicleLaser ? 0.55 : 0.1;
  const length = tracerLength(p);
  const geometry = new THREE.PlaneGeometry(width, length);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, length / 2);
  if (tail) {
    const position = geometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      if (position.getZ(vertex) > length / 2) {
        position.setX(vertex, position.getX(vertex) + tail.x);
        position.setY(vertex, position.getY(vertex) + tail.y);
      }
    }
  }
  return geometry;
}

/** Alternates +1/-1 per Shrike bolt built, so consecutive shots present two distinct
 * origins the way the source's paired image slots do. A recycled projectile id that
 * rebuilds its mesh flips the side early -- a cosmetic, not a sim, fault. */
function nextShrikeMuzzleTail(): { x: number; y: number } {
  const side = nextShrikeMuzzleSide;
  nextShrikeMuzzleSide = -nextShrikeMuzzleSide;
  return { x: SHRIKE_MUZZLE_OFFSET_X * side, y: SHRIKE_MUZZLE_OFFSET_Y };
}

/** The muzzle tail for one bolt. The simulation now chooses the side and sends it on the
 *  projectile (issue #53: `VehicleStore.nextWeaponFire` alternates exactly as
 *  `%obj.nextWeaponFire` does, and the shot carries it), so that value is authoritative and
 *  is what a bolt uses. The local alternation below is only the fallback for a projectile
 *  that arrives without one. */
function muzzleTailFor(p: ProjectileSnapshotData): { x: number; y: number } {
  if (p.muzzleSide === undefined) return nextShrikeMuzzleTail();
  return { x: SHRIKE_MUZZLE_OFFSET_X * p.muzzleSide, y: SHRIKE_MUZZLE_OFFSET_Y };
}

/** Crossed textured ribbons preserve the original glow from different viewing angles.
 * A Shrike bolt's two ribbons share the alternating muzzle tail; the cross ribbon is the
 * same geometry rotated a quarter turn about the beam axis, so its shear arrives
 * pre-rotated (rotation.z maps local +x onto -y) and both tails meet at one point. */
function addTracerCross(
  mesh: THREE.Mesh,
  p: ProjectileSnapshotData,
  tail?: { x: number; y: number },
): void {
  if (!isTracerType(p.type) && p.type !== ProjectileType.Energy) return;
  if (p.type !== ProjectileType.Energy) {
    const ribbon = new THREE.Mesh(
      tracerGeometry(p, tail && { x: tail.y, y: -tail.x }),
      mesh.material,
    );
    ribbon.rotation.z = Math.PI / 2;
    ribbon.name = 'tracer-ribbon';
    mesh.add(ribbon);
  }
  const size =
    p.type === ProjectileType.Energy
      ? BLASTER_CROSS_SIZE
      : p.type === ProjectileType.VehicleLaser
        ? 0.99
        : 0.2;
  const head = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map:
        p.type === ProjectileType.Energy
          ? BLASTER_CROSS
          : p.type === ProjectileType.VehicleLaser
            ? SHRIKE_CROSS
            : TRACER_CROSS,
      color: projectileColor(p.weaponId, p.type),
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
  return (
    isTracerType(p.type) || p.type === ProjectileType.Energy || p.weaponId === WeaponId.Spinfusor
  );
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
    new THREE.PlaneGeometry(1, 1),
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

/** Issue #57: the disc's launch flash, at the muzzle the disc leaves from.
 *
 *  Why a launch marker rather than more disc: the disc is a flat plate 0.816 m across and
 *  0.062 m thick (`disc.glb`, `disc.cs`'s own shape) flying level, so a shooter looking down
 *  its own flight line sees it close to edge-on -- at 20 m out, 0.4 m below the eye
 *  (EYE_HEIGHT 2.0 in app.ts against the sim's MUZZLE_HEIGHT 1.6 in weapons.ts), the plate
 *  presents a sliver about 2 cm tall. Nothing about that changes at range, so the launch is
 *  the one moment the disc can be made readable without redrawing its flight presentation.
 *
 *  Two crossed quads rather than one, because the mesh they ride spins about its own plate
 *  normal (`syncOneProjectile`'s `rotateY`: 30 rad/s, ~4.8 rev/s as the source's own disc
 *  does). A single quad would swing its face off the flight axis within one frame of launch;
 *  two quads a quarter turn apart on that same axis keep one of them presented to the shooter
 *  at every point of the spin, with the worst case a 45-degree turn (a 29% dip in the
 *  additive contribution, not a disappearance) -- the same crossed-quad answer
 *  `addTracerCross` gives for the tracers' own glows. The flash rides the disc rather than
 *  staying at the muzzle because it is parented to the projectile mesh the caller owns; over
 *  80 ms the disc travels 2-3 m, so it reads as the head of the launch streak, and giving it
 *  its own scene object would put a second lifetime on a second list for no visual gain.
 *
 *  User report 2026-09-16 (jetting disc birth): the flash is parented at the mesh's own
 *  origin and born the frame the id is first seen, so it sits wherever placeProjectile draws
 *  that first frame -- under a launch correction (ProjectileBuffer.setLaunchCorrection) that
 *  is the client's predicted muzzle. Flash and disc leave the same gun by construction; the
 *  flash never needs a position of its own. */
function addDiscMuzzleFlash(mesh: THREE.Mesh, p: ProjectileSnapshotData): void {
  if (p.weaponId !== WeaponId.Spinfusor) return;
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(MUZZLE_FLASH_SIZE, MUZZLE_FLASH_SIZE),
    new THREE.MeshBasicMaterial({
      map: DISC_TEXTURE,
      color: 0x88bbff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    }),
  );
  flash.name = 'disc-muzzle-flash';
  // The plate's own frame (projectileOrientation) puts -Z along the flight direction, so this
  // quad's face points straight back at whoever fired.
  const cross = new THREE.Mesh(flash.geometry, flash.material);
  cross.rotation.y = Math.PI / 2;
  cross.name = 'disc-muzzle-flash-cross';
  flash.add(cross);
  mesh.add(flash);
  mesh.userData.muzzleFlash = flash;
}

/** Ages the launch flash a projectile carries: fade over MUZZLE_FLASH_LIFETIME_S, then
 *  release the two quads' own geometry and material (disposeMesh, not removal alone -- same
 *  rule every owned mesh in this file follows). */
function ageMuzzleFlash(mesh: THREE.Mesh, dt: number): void {
  const flash = mesh.userData.muzzleFlash as THREE.Mesh | undefined;
  if (!flash) return;
  const age = ((mesh.userData.muzzleFlashAge as number | undefined) ?? 0) + dt;
  mesh.userData.muzzleFlashAge = age;
  flash.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      (node.material as THREE.MeshBasicMaterial).opacity = Math.max(
        0,
        1 - age / MUZZLE_FLASH_LIFETIME_S,
      );
    }
  });
  if (age >= MUZZLE_FLASH_LIFETIME_S) {
    mesh.remove(flash);
    disposeMesh(flash);
    mesh.userData.muzzleFlash = undefined;
  }
}

export function createProjectileMesh(projectile: ProjectileSnapshotData): THREE.Mesh {
  // Tribes 2's disc is a spinning flat plate; mortar and grenade are their own chunky
  // green shells, not recoloured copies of the same generic sphere. Only the Shrike's
  // bolt carries the twin-muzzle tail: its alternating wing origins come from the source
  // image-pair offsets, while the handheld Chaingun has the one barrel.
  const color = projectileColor(projectile.weaponId, projectile.type);
  const tail =
    projectile.type === ProjectileType.VehicleLaser ? muzzleTailFor(projectile) : undefined;
  const mesh = new THREE.Mesh(
    projectileGeometry(projectile, tail),
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
  addTracerCross(mesh, projectile, tail);
  addDiscGlow(mesh, projectile);
  addDiscMuzzleFlash(mesh, projectile);
  // Codex review round 2 (PR #9), finding 8: the sim recycles freed projectile ids (same
  // pattern as player id reuse), so a mesh keyed only by id can't tell "same projectile,
  // moved" from "a different projectile got this id". Stamping the type/weaponId it was
  // built for onto the mesh itself lets syncProjectileMeshes below detect the swap.
  mesh.userData.type = projectile.type;
  mesh.userData.weaponId = projectile.weaponId;
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

/** One projectile's flight, in the client's own frame: where the disc is drawn this frame,
 *  dead-reckoned or interpolated between the snapshots that describe it. */
export interface ProjectilePose {
  x: number;
  y: number;
  z: number;
}

interface ProjectileSample {
  atMs: number;
  data: ProjectileSnapshotData;
}

/** The pose and velocity the sim reported are the same six numbers, so a difference in any of
 *  them is real information and an identical set is the caller re-observing one snapshot. The
 *  comparison is exact on purpose: the wire carries full state per projectile record (no
 *  stale-copy resend -- a distant one is simply not sent), and this file's caller polls the
 *  newest decoded list every FRAME, so a repeat is literally the same floats. An epsilon like
 *  remote.ts's REPEAT_EPSILON_M would instead swallow a genuinely creeping projectile's step
 *  (a mortar shell on its last few metres moves 3 mm a snapshot). */
function sameFlight(a: ProjectileSnapshotData, b: ProjectileSnapshotData): boolean {
  return (
    a.x === b.x && a.y === b.y && a.z === b.z && a.vx === b.vx && a.vy === b.vy && a.vz === b.vz
  );
}

/** The local player's own latest fire, as this client predicted it: the muzzle origin the
 *  shot left from and the caller's clock at fire. Held until the server snapshot that first
 *  carries the shot (matchLaunchToBuffer), then handed to the matching ProjectileBuffer as
 *  its launch correction. */
export interface PendingLaunch {
  origin: { x: number; y: number; z: number };
  atMs: number;
}

/**
 * One projectile id's flight between snapshots, the projectile twin of remote.ts's
 * RemoteBuffer and the same shape: samples arrive stamped with the caller's clock, and
 * `positionAt` answers at a render time one delay behind now.
 *
 * The path is RemoteBuffer's own policy -- interpolate when the render time is bracketed by
 * two samples, dead-reckon from the nearest sample when it is not -- because a projectile
 * carries its own ballistic velocity on the wire, which is what dead reckoning needs and
 * interpolation does not: `x(t) = x_i + v_i * (t - t_i)` over the segment the render clock is
 * inside is exactly the sim's own integration of that segment (projectiles.ts moves a
 * projectile by velocity * dt, so two samples of a straight flight lie on one line). The
 * delay then only has to place the clock inside a closed segment, and no residual relaxation
 * is needed the way it is for a player: while the clock is inside the held pair, both ends of
 * the segment it is sweeping are positions the sim itself reported, so a sample landing mid
 * sweep cannot move the drawn point at all -- only advance it along a line the sim drew. The
 * frames that are not inside the pair are the first ones of a shot (there is nothing but a
 * birth sample yet) and the ones a stalled or backlogged socket leaves at the pair's edges;
 * both are carried on a held sample's own reported velocity, which for a disc -- no drag, no
 * gravity, no elasticity (WEAPON_DATA) -- is the same line the missing segment lay on. A
 * bouncing bolt would be the one to see that difference, for a frame's worth of it.
 *
 * Two things it deliberately does NOT do, both covered elsewhere: recycled ids (the sim holds
 * a freed id unallocated for at least one snapshot, so the id is always seen missing and its
 * history pruned, and a same-id different-weapon swap is caught by the mesh rebuild's own
 * type/weaponId test, whose caller resets this), and the solo path (no snapshots, no cadence
 * to hide: syncProjectileMeshes leaves the mesh on the sim's live position there).
 */
export class ProjectileBuffer {
  private samples: ProjectileSample[] = [];
  private launch: PendingLaunch | undefined;

  /** User report 2026-09-16 (jetting disc birth): anchors this id's rendered birth to the
   *  muzzle the local client predicted instead of the lagged server one the birth pull-back
   *  alone lands on (see LAUNCH_BLEND_MS). One correction per buffer; a second call
   *  overwrites, so a refire after the blend window re-anchors the id to its new shot. */
  setLaunchCorrection(origin: { x: number; y: number; z: number }, launchAtMs: number): void {
    this.launch = { origin, atMs: launchAtMs };
  }

  /** Files one poll of a projectile's snapshot state. A repeat of the newest sample is
   *  dropped rather than stored: the caller polls per frame while snapshots land every second
   *  tick (SNAPSHOT_EVERY_N_TICKS), so storing repeats would stamp the same state a segment
   *  later every frame and walk the render clock ever further behind the sim. */
  push(atMs: number, projectile: ProjectileSnapshotData): void {
    const newest = this.samples.at(-1);
    if (newest && sameFlight(newest.data, projectile)) return;
    // The wire carries one snapshot every SNAPSHOT_INTERVAL_MS, so two samples stamped closer
    // together than that are the caller's arrival clock, not the server's: a socket that
    // stalled and released its backlog puts two samples that are 64 ms apart on the wire 17 ms
    // apart on the clock (app.ts's per-frame poll can see two snapshots' worth of movement in
    // consecutive frames). Interpolated at face value the disc crosses that segment at 3.8x
    // its real speed; keeping the protocol's own spacing leaves the segment the same length in
    // render time as it was on the server. The same clamp, and the same reasoning, as
    // RemoteBuffer's own.
    const stampedAtMs = newest ? Math.max(atMs, newest.atMs + SNAPSHOT_INTERVAL_MS) : atMs;
    this.samples.push({ atMs: stampedAtMs, data: projectile });
    if (this.samples.length > PROJECTILE_HISTORY_LENGTH) this.samples.shift();
  }

  /** Drops the history: the id was recycled into a different projectile, so these samples
   *  describe a flight that is over. The launch correction goes with them -- it anchors one
   *  specific shot, and the recycled id is a new flight the old shot's muzzle is nowhere
   *  near. */
  reset(): void {
    this.samples.length = 0;
    this.launch = undefined;
  }

  /** Where to draw the projectile at `nowMs`, or null before any sample has arrived (the
   *  caller then falls back to the sample it holds, as it does without a buffer at all). */
  positionAt(nowMs: number): ProjectilePose | null {
    const renderTime = nowMs - PROJECTILE_INTERP_DELAY_MS;
    const newest = this.samples.at(-1);
    const oldest = this.samples[0];
    if (!newest || !oldest) return null;
    return this.withLaunchCorrection(
      this.snapshotPoseAt(newest, oldest, renderTime),
      oldest,
      renderTime,
    );
  }

  /** The path the snapshots describe -- the interpolate/dead-reckon policy documented on the
   *  class, split out so positionAt can wrap it in the launch correction. */
  private snapshotPoseAt(
    newest: ProjectileSample,
    oldest: ProjectileSample,
    renderTime: number,
  ): ProjectilePose {
    if (renderTime >= newest.atMs) return extrapolate(newest, renderTime);
    // Before the oldest sample is the birth case: the client learns of a shot up to one
    // snapshot after it was fired and the render clock sits a further delay behind that, so
    // for the first frames the clock is behind the only sample there is. Carrying it BACK
    // along that sample's own velocity puts the disc where the flight line says it was -- near
    // the muzzle -- instead of freezing it at the position a snapshot already carried it 5.8 m
    // past, which is what made a freshly seen disc hang in the air and then jump.
    if (renderTime <= oldest.atMs) return extrapolate(oldest, renderTime);
    const t = (renderTime - oldest.atMs) / (newest.atMs - oldest.atMs);
    return {
      x: oldest.data.x + (newest.data.x - oldest.data.x) * t,
      y: oldest.data.y + (newest.data.y - oldest.data.y) * t,
      z: oldest.data.z + (newest.data.z - oldest.data.z) * t,
    };
  }

  /** User report 2026-09-16 (jetting disc birth): slides the rendered birth from the muzzle
   *  the client's prediction chose onto the snapshot path while a launch correction is live.
   *  With position rendered as
   *
   *      mix(predictedLine, serverPath, age / LAUNCH_BLEND_MS),  age = renderTime - launchAtMs
   *
   *  where predictedLine(t) = origin + v * (t - launchAtMs)/1000 and v is the birth sample's
   *  own reported velocity, the predicted line and the server path never diverge in
   *  direction -- the same v is on the wire, so aim mismatch is impossible and the mix is a
   *  straight slide along the constant offset between two parallel lines: at the fire itself
   *  the disc sits on the predicted muzzle, by LAUNCH_BLEND_MS it sits on the path the
   *  server says it has been on all along. age <= 0 (the render clock still behind the fire
   *  -- the shot's first snapshot can land within the interpolation delay of it on a fast
   *  link) draws the predicted line pure: the disc visibly leaves the gun. */
  private withLaunchCorrection(
    server: ProjectilePose,
    birth: ProjectileSample,
    renderTime: number,
  ): ProjectilePose {
    const launch = this.launch;
    if (!launch) return server;
    const age = renderTime - launch.atMs;
    if (age >= LAUNCH_BLEND_MS) {
      // Authority won; dropping the correction here keeps every later frame on the plain
      // server path without re-deriving an expired anchor each one.
      this.launch = undefined;
      return server;
    }
    const seconds = age / 1000;
    const predicted: ProjectilePose = {
      x: launch.origin.x + birth.data.vx * seconds,
      y: launch.origin.y + birth.data.vy * seconds,
      z: launch.origin.z + birth.data.vz * seconds,
    };
    if (age <= 0) return predicted;
    const t = age / LAUNCH_BLEND_MS;
    return {
      x: predicted.x + (server.x - predicted.x) * t,
      y: predicted.y + (server.y - predicted.y) * t,
      z: predicted.z + (server.z - predicted.z) * t,
    };
  }
}

/** User report 2026-09-16 (jetting disc birth): hands a recorded launch (app.ts records the
 *  local player's own fire events per tick, beside recordLocalShots) to its projectile on
 *  the first snapshot that carries it. "First" is by flight history: an id not yet in
 *  `buffers` is a shot this client has never drawn, and the sim's id-reuse delay guarantees
 *  a recycled id sat out of the list at least one snapshot, so its buffer -- and any old
 *  correction with it -- was already pruned. Matching the wire's ownerId keeps other
 *  players' discs and turret shots (-1) out; consuming on match and expiring at
 *  PENDING_LAUNCH_TIMEOUT_MS keeps a lost shot from anchoring some later projectile's birth.
 *  Returns the pending that still has no projectile (undefined when absent, consumed, or
 *  expired) so the caller keeps its state in one expression; the only mutation is the
 *  correction itself, written through the buffer map the caller already owns -- the same map
 *  syncProjectileMeshes consumes the moment after, so the very first rendered frame is the
 *  corrected one. */
export function matchLaunchToBuffer(
  pending: PendingLaunch | undefined,
  projectiles: readonly ProjectileSnapshotData[],
  localOwnerId: number,
  buffers: Map<number, ProjectileBuffer>,
  nowMs: number,
): PendingLaunch | undefined {
  if (!pending) return undefined;
  if (nowMs - pending.atMs >= PENDING_LAUNCH_TIMEOUT_MS) return undefined;
  for (const projectile of projectiles) {
    if (projectile.ownerId !== localOwnerId) continue;
    const existing = buffers.get(projectile.id);
    if (existing) continue;
    const buffer = new ProjectileBuffer();
    buffers.set(projectile.id, buffer);
    buffer.setLaunchCorrection(pending.origin, pending.atMs);
    return undefined;
  }
  return pending;
}

/** Dead reckoning from one sample along its own reported velocity, in either direction: the
 *  flight line is the same curve backwards as forwards. Bounded by remote.ts's
 *  MAX_EXTRAPOLATE_MS on both sides -- the same constant answers "how far may a client invent
 *  motion from a sample" for a stalled socket's forward glide and for the birth pull-back, and
 *  past it the projectile freezes rather than sliding further than the sim's evidence carries
 *  it. */
function extrapolate(sample: ProjectileSample, renderTime: number): ProjectilePose {
  const held = renderTime - sample.atMs;
  const seconds = Math.max(-MAX_EXTRAPOLATE_MS, Math.min(held, MAX_EXTRAPOLATE_MS)) / 1000;
  return {
    x: sample.data.x + sample.data.vx * seconds,
    y: sample.data.y + sample.data.vy * seconds,
    z: sample.data.z + sample.data.vz * seconds,
  };
}

/** Where the caller keeps one frame's projectile interpolation state. Optional at the call
 *  site, and only for a SNAPSHOT-CADENCED feed: the solo app reads the sim's own live projectile
 *  store (a fresh position every frame, so there is no cadence to hide) and must keep drawing
 *  the mesh on the raw position it just read. Feeding those live positions here would have the
 *  stamp clamp stretch 17 ms of render clock into a 64 ms segment, drawing a disc at a quarter
 *  of its speed -- app.ts passes this from its networked branch only. */
export interface ProjectileInterpolation {
  /** One flight history per live projectile id; pruned against each frame's own list, the way
   *  app.ts prunes its remote-player buffers. */
  buffers: Map<number, ProjectileBuffer>;
  /** The caller's clock -- the same `performance.now()` RemoteBuffer.positionAt is queried
   *  with, so a disc and the remote player it flies past come out of one render time. */
  nowMs: number;
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
      disposeProjectileTrail(mesh);
      scene.remove(mesh);
      disposeMesh(mesh);
    }
    meshes.delete(id);
  }
}

/** The history of an id the snapshot list no longer reports. An id only comes back as a new
 *  projectile after at least one snapshot it was missing from (PROJECTILE_ID_REUSE_DELAY_TICKS,
 *  projectiles.ts), so this is what makes a recycled id a birth rather than a slide from where
 *  its predecessor died -- the same job remote.ts's teleport test does for a player id. A
 *  render loop that stalls across the whole reuse window would still see the id reappear
 *  without an observed gap; that residual is a brief slide on one disc, not worth a
 *  distance heuristic that would misfire on the 425 m/s Chaingun tracers. */
function pruneProjectileBuffers(
  buffers: Map<number, ProjectileBuffer> | undefined,
  liveIds: Set<number>,
): void {
  if (!buffers) return;
  for (const id of [...buffers.keys()]) {
    if (!liveIds.has(id)) buffers.delete(id);
  }
}

/** Whether an id's mesh was built for a different projectile than the one now carrying that
 *  id: the sim recycles freed ids, so "same id" is not "same projectile" (round 2, PR #9,
 *  finding 8). Stamped onto the mesh in createProjectileMesh. */
function isRecycledProjectile(mesh: THREE.Mesh | undefined, p: ProjectileSnapshotData): boolean {
  return (
    mesh !== undefined && (mesh.userData.type !== p.type || mesh.userData.weaponId !== p.weaponId)
  );
}

/** One live id's flight history, created on first sight and reset when the id turns out to
 *  have been recycled under its mesh -- a new projectile's first frame must not be interpolated
 *  from the previous one's last sample. */
function projectileBufferFor(
  buffers: Map<number, ProjectileBuffer> | undefined,
  p: ProjectileSnapshotData,
  recycled: boolean,
): ProjectileBuffer | undefined {
  if (!buffers) return undefined;
  const buffer = buffers.get(p.id) ?? new ProjectileBuffer();
  if (recycled) buffer.reset();
  buffers.set(p.id, buffer);
  return buffer;
}

/** Whether a projectile presents the position-history trail. T2's Spinfusor and Mortar
 *  projectiles trail (the datablock's particleEmitter; the thrown grenade's read is the same
 *  green smoke), so ours does too; the Chaingun and Shrike tracers and the Blaster bolt
 *  already ARE trails (tracerGeometry / blasterTrailGeometry), and the Laser Rifle never
 *  spawns a projectile at all. */
function wantsProjectileTrail(p: ProjectileSnapshotData): boolean {
  return (
    p.weaponId === WeaponId.Spinfusor ||
    p.weaponId === WeaponId.Mortar ||
    p.type === ProjectileType.Grenade
  );
}

/** One live id's trail, hung off the mesh the way the muzzle flash is: created on first sight
 *  of a trail-worthy id, removed and disposed wherever the mesh is (prune, recycle). The
 *  ribbon is world-space, so it is a SIBLING of the mesh in the scene -- the mesh's own frame
 *  is reset to the flight pose every frame and spun (discs, 30 rad/s), which would whip a
 *  child ribbon around. The thrown grenade rides the Spinfusor's weaponId (weapons.ts's
 *  altFire), so the colour check separates on the projectile type, not the weapon. */
function projectileTrailFor(
  mesh: THREE.Mesh,
  p: ProjectileSnapshotData,
): ProjectileTrail | undefined {
  if (!wantsProjectileTrail(p)) return undefined;
  const existing = mesh.userData.trail as ProjectileTrail | undefined;
  if (existing) return existing;
  const disc = p.weaponId === WeaponId.Spinfusor && p.type !== ProjectileType.Grenade;
  const trail = new ProjectileTrail(disc ? DISC_TRAIL_COLOR : GRENADE_COLOR);
  mesh.userData.trail = trail;
  mesh.parent?.add(trail.mesh);
  return trail;
}

/** Releases one mesh's trail: out of the scene, GPU resources disposed -- the same rule
 *  disposeMesh enforces for the mesh itself. Called from every path that removes a mesh: the
 *  id recycle (projectileTrackFor) and the id's death (pruneProjectileMeshes). */
function disposeProjectileTrail(mesh: THREE.Mesh): void {
  const trail = mesh.userData.trail as ProjectileTrail | undefined;
  if (!trail) return;
  trail.mesh.parent?.remove(trail.mesh);
  trail.dispose();
  mesh.userData.trail = undefined;
}

/** One live id's mesh and flight history for this frame, rebuilt and reset when the id turns
 *  out to have been recycled: a new projectile's first frame must not be interpolated from the
 *  previous one's last sample. Split out of syncOneProjectile to hold that function under the
 *  complexity gate, the same reason projectileNum exists below. */
function projectileTrackFor(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  buffers: Map<number, ProjectileBuffer> | undefined,
  p: ProjectileSnapshotData,
): { mesh: THREE.Mesh; buffer: ProjectileBuffer | undefined } {
  let mesh = meshes.get(p.id);
  const recycled = isRecycledProjectile(mesh, p);
  if (mesh && recycled) {
    disposeProjectileTrail(mesh);
    scene.remove(mesh);
    disposeMesh(mesh);
    meshes.delete(p.id);
    mesh = undefined;
  }
  const buffer = projectileBufferFor(buffers, p, recycled);
  if (mesh) return { mesh, buffer };
  const created = createProjectileMesh(p);
  scene.add(created);
  meshes.set(p.id, created);
  return { mesh: created, buffer };
}

/** Where the mesh is placed this frame: the flight history's own render-time position when the
 *  caller keeps one, the sample's raw position otherwise (no history yet, or no interpolation
 *  at all -- the solo path). Returns the pose it placed, so the trail (projectileTrailFor)
 *  samples exactly what was drawn and ribbon and disc can never disagree. */
function placeProjectile(
  mesh: THREE.Mesh,
  buffer: ProjectileBuffer | undefined,
  p: ProjectileSnapshotData,
  nowMs: number,
): ProjectilePose {
  const pose = buffer?.positionAt(nowMs);
  const x = pose?.x ?? p.x;
  const y = pose?.y ?? p.y;
  const z = pose?.z ?? p.z;
  mesh.position.set(x, y, z);
  return { x, y, z };
}

function syncOneProjectile(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  buffers: Map<number, ProjectileBuffer> | undefined,
  p: ProjectileSnapshotData,
  dt: number,
  nowMs: number,
): void {
  const { mesh, buffer } = projectileTrackFor(scene, meshes, buffers, p);
  buffer?.push(nowMs, p);
  const pose = placeProjectile(mesh, buffer, p, nowMs);
  // The trail samples the pose the mesh was actually drawn at, so ribbon and disc agree --
  // including the launch-blend slide (ProjectileBuffer's correction), which the ribbon
  // records as the flight that was presented, not the server's hidden one.
  projectileTrailFor(mesh, p)?.update(pose);
  projectileOrientation(mesh, p);
  if (p.weaponId === WeaponId.Spinfusor) {
    // The disc spins about its local plate normal. rotateY is a relative rotation, so
    // this advances by the per-frame delta (30 rad/s ~ 4.8 rev/s, a brisk T2-like spin);
    // accumulating the total and re-applying it every frame spun the plate quadratically
    // and broke the plate-level flight frame within a couple of frames.
    mesh.rotateY(dt * 30);
  }
  ageMuzzleFlash(mesh, dt);
  if (isTracerType(p.type)) {
    const travelled =
      ((mesh.userData.travelled as number | undefined) ?? 0) + Math.hypot(p.vx, p.vy, p.vz) * dt;
    mesh.userData.travelled = travelled;
    mesh.scale.z = Math.min(1, travelled / tracerLength(p));
  }
}

/** Draws the snapshot's projectiles, each at `interpolation.positionAt` under the caller's own
 *  clock rather than at the newest sample's raw position. Without `interpolation` this is the
 *  old behaviour exactly -- mesh on the sample -- which is what the solo app and this file's
 *  own presentation tests still want. */
export function syncProjectileMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  projectiles: ProjectileSnapshotData[],
  dtSeconds = 1 / 60,
  interpolation?: ProjectileInterpolation,
): void {
  const liveIds = new Set(projectiles.map((p) => p.id));
  pruneProjectileMeshes(scene, meshes, liveIds);
  pruneProjectileBuffers(interpolation?.buffers, liveIds);
  const nowMs = interpolation?.nowMs ?? 0;
  for (const projectile of projectiles) {
    syncOneProjectile(scene, meshes, interpolation?.buffers, projectile, dtSeconds, nowMs);
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

/** The flash one authoritative impact record renders, keyed on the record's own projectile
 *  type (#52) rather than on a disappearing snapshot entry: tracers make compact cross
 *  flashes, everything else the weapon-colored fireball at the sim's exact contact point. */
function impactFlash(impact: ProjectileImpact): THREE.Mesh {
  if (!isTracerType(impact.type)) {
    return createFlash(impact, WEAPON_COLOR[impact.weaponId] ?? 0xffffff);
  }
  // Bullets make compact impact flashes, not the explosive weapons' metre-wide fireballs.
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 8, 6),
    new THREE.MeshBasicMaterial({
      map: impact.type === ProjectileType.VehicleLaser ? SHRIKE_CROSS : TRACER_CROSS,
      color: projectileColor(impact.weaponId, impact.type),
      transparent: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      depthWrite: false,
    }),
  );
  mesh.position.set(impact.x, impact.y, impact.z);
  mesh.scale.setScalar(impact.type === ProjectileType.VehicleLaser ? 0.5 : 0.12);
  return mesh;
}

/** The one-shot effect one impact record (#52) deserves, or null for the removals that must
 *  NOT look like an impact: a Linear/Tracer/Energy projectile expiring at end of lifetime
 *  used to fire the exact same disappearance flash a real strike did, at whatever position
 *  the last snapshot reported. Only an armed grenade's timeout really detonates
 *  (finalizeGrenadeLifetime), so only a Grenade-type Timeout gets explosion FX. */
function impactEffectFor(impact: ProjectileImpact): Effect | null {
  if (impact.reason === ProjectileImpactReason.Timeout) {
    if (impact.type !== ProjectileType.Grenade) return null;
    const mesh = createFlash(impact, projectileColor(impact.weaponId, impact.type));
    return { mesh, ttl: EXPLOSION_LIFETIME_S, expanding: true };
  }
  // A bounce is a reflection, not a detonation: the projectile keeps flying, so the record
  // renders a brief compact puff at the contact point instead of a full fireball.
  if (impact.reason === ProjectileImpactReason.Bounce) {
    return { mesh: impactFlash(impact), ttl: EXPLOSION_LIFETIME_S / 2 };
  }
  if (impact.weaponId === WeaponId.Spinfusor) {
    const original = createDiscExplosion(impact);
    if (original) return original;
    const mesh = createFlash(impact, 0x66bbff);
    mesh.scale.setScalar(3);
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.fog = false;
    return { mesh, ttl: 0.6, expanding: true };
  }
  return { mesh: impactFlash(impact), ttl: EXPLOSION_LIFETIME_S };
}

/** Spawns the FX for every authoritative impact record (#52). The caller passes each record
 *  exactly once -- networked clients extract them from their drained event stream, the solo
 *  app drains world.projectiles.lastImpacts per tick -- and nothing here or upstream infers
 *  an effect from a projectile leaving the snapshot list anymore, so a shot that is also seen
 *  disappearing can never produce a duplicate effect. */
export function spawnProjectileImpacts(
  scene: THREE.Scene,
  effects: Effect[],
  impacts: readonly ProjectileImpact[],
): void {
  for (const impact of impacts) {
    const effect = impactEffectFor(impact);
    if (!effect) continue;
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
