import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VehicleKind, type World } from '@clans/sim';
import type { VehicleSnapshotData } from '@clans/protocol';
import { shapeUrl, type KatabaticAssets } from './assets.js';

export interface VehicleView {
  meshes: Map<number, THREE.Object3D>;
  sync(vehicles: VehicleSnapshotData[]): void;
}

// --- Remote-vehicle interpolation (Codex review round 1, this PR, finding 9) --------------
// Before this, app.ts fed net.vehicles -- the single latest decoded snapshot, replaced
// wholesale every time one arrived -- straight into sync() above, so every OTHER vehicle
// on screen (never the one the local player is driving, which app.ts's placeVehicleCamera
// already reads live off world.vehicles) visibly snapped to a new position/orientation once
// per snapshot interval instead of smoothing through it the way remote players already do
// (remote.ts's RemoteBuffer). Same render-time-behind-now, interpolate-or-extrapolate shape
// as RemoteBuffer, kept as a separate small class rather than generalizing RemoteBuffer
// itself: vehicles carry pitch/roll and non-positional fields (kind/team/energy/damage/
// destroyed/driverId/...) RemoteBuffer's player-only shape has no use for, and forcing both
// through one generic risked exactly the kind of premature abstraction Simplicity
// Enforcement warns against for a second, structurally different caller.
export const VEHICLE_INTERP_DELAY_MS = 100; // matches remote.ts's own INTERP_DELAY_MS
const VEHICLE_MAX_EXTRAPOLATE_MS = 50; // matches remote.ts's own MAX_EXTRAPOLATE_MS
const VEHICLE_HISTORY_LENGTH = 8;

interface VehicleSample {
  atMs: number;
  data: VehicleSnapshotData;
}
interface VehiclePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

function findVehicleBracket(
  samples: VehicleSample[],
  renderTime: number,
): { before: VehicleSample | undefined; after: VehicleSample | undefined } {
  let before = samples[0] ?? samples[samples.length - 1];
  let after = samples[samples.length - 1];
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    if (a && b && a.atMs <= renderTime && renderTime <= b.atMs) {
      before = a;
      after = b;
      break;
    }
  }
  return { before, after };
}

const ZERO_POSE: VehiclePose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };

// Split out of a single `sample?.field ?? 0` expression per field (lint: complexity budget --
// six chained `??`s in one function counted as six branches on their own).
function vehiclePoseFromSample(sample: VehicleSample | undefined): VehiclePose {
  if (!sample) return ZERO_POSE;
  const { x, y, z, yaw, pitch, roll } = sample.data;
  return { x, y, z, yaw, pitch, roll };
}

function lerpVehiclePose(
  before: VehicleSample,
  after: VehicleSample,
  renderTime: number,
): VehiclePose {
  const t = Math.max(0, Math.min(1, (renderTime - before.atMs) / (after.atMs - before.atMs)));
  return {
    x: before.data.x + (after.data.x - before.data.x) * t,
    y: before.data.y + (after.data.y - before.data.y) * t,
    z: before.data.z + (after.data.z - before.data.z) * t,
    yaw: before.data.yaw + (after.data.yaw - before.data.yaw) * t,
    pitch: before.data.pitch + (after.data.pitch - before.data.pitch) * t,
    roll: before.data.roll + (after.data.roll - before.data.roll) * t,
  };
}

/** One vehicle id's own interpolation history. Only position/orientation are smoothed --
 *  everything else on a sample (kind/team/energy/damage/destroyed/driverId/...) is discrete
 *  logical state a client should show as of the LATEST sample, never blended, so callers read
 *  those straight off the newest pushed sample rather than through positionAt(). */
export class VehicleBuffer {
  private samples: VehicleSample[] = [];

  push(atMs: number, data: VehicleSnapshotData): void {
    this.samples.push({ atMs, data });
    if (this.samples.length > VEHICLE_HISTORY_LENGTH) this.samples.shift();
  }

  latest(): VehicleSnapshotData | null {
    return this.samples.at(-1)?.data ?? null;
  }

  positionAt(nowMs: number): VehiclePose | null {
    const latest = this.samples.at(-1);
    if (!latest) return null;
    const renderTime = nowMs - VEHICLE_INTERP_DELAY_MS;
    return renderTime >= latest.atMs
      ? this.extrapolate(latest, renderTime)
      : this.interpolate(renderTime);
  }

  private interpolate(renderTime: number): VehiclePose {
    const { before, after } = findVehicleBracket(this.samples, renderTime);
    if (!before || !after || before.atMs === after.atMs) {
      return vehiclePoseFromSample(before ?? after);
    }
    return lerpVehiclePose(before, after, renderTime);
  }

  private extrapolate(latest: VehicleSample, renderTime: number): VehiclePose {
    const seconds = Math.min(renderTime - latest.atMs, VEHICLE_MAX_EXTRAPOLATE_MS) / 1000;
    return {
      x: latest.data.x + latest.data.vx * seconds,
      y: latest.data.y + latest.data.vy * seconds,
      z: latest.data.z + latest.data.vz * seconds,
      yaw: latest.data.yaw,
      pitch: latest.data.pitch,
      roll: latest.data.roll,
    };
  }
}

/**
 * Merges every vehicle id's interpolation buffer into the flat array vehicle-view.ts's
 * `sync` expects: position/orientation come from `positionAt` (smoothed), everything else
 * from that id's own latest raw sample (see VehicleBuffer's own doc comment). `mountedId`
 * (the local player's own driven vehicle, or -1) is deliberately excluded and must be
 * supplied by the caller instead reading world.vehicles directly -- the same live,
 * zero-latency source app.ts's placeVehicleCamera already uses, so the mesh the camera is
 * chasing never lags one interpolation delay behind where the camera itself already is.
 */
export function vehicleRenderDataFrom(
  buffers: Map<number, VehicleBuffer>,
  nowMs: number,
  mountedId: number,
): VehicleSnapshotData[] {
  const out: VehicleSnapshotData[] = [];
  for (const [id, buffer] of buffers) {
    if (id === mountedId) continue;
    const data = buffer.latest();
    const pose = buffer.positionAt(nowMs);
    if (!data || !pose) continue;
    out.push({ ...data, ...pose });
  }
  return out;
}

const SHRIKE_COLOR = 0x4488cc;
const WILDCAT_COLOR = 0xcc8844;

/** A stretched box with two small wing boxes for the Shrike, a flattened box with a
 *  headlight-suggesting front taper for the Wildcat -- simple enough to write directly in
 *  Three.js primitives, no loader involved (M5 plan, Task 13). Used whenever the resolved
 *  shape tier is `procedural` (both real .glb tiers resolved this session, so this is a
 *  genuine fallback path, not the common case), and as the initial placeholder for the
 *  `glb`/`stl` tiers while their real geometry loads in asynchronously. */
function proceduralMesh(kind: VehicleKind): THREE.Group {
  const group = new THREE.Group();
  const color = kind === VehicleKind.Shrike ? SHRIKE_COLOR : WILDCAT_COLOR;
  const material = new THREE.MeshStandardMaterial({ color });
  if (kind === VehicleKind.Shrike) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 5.5), material);
    group.add(body);
    const wingGeometry = new THREE.BoxGeometry(3.5, 0.2, 1.2);
    const leftWing = new THREE.Mesh(wingGeometry, material);
    leftWing.position.set(0, 0, 0.5);
    const rightWing = leftWing.clone();
    group.add(leftWing, rightWing);
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.8, 3.2), material);
    group.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 4), material);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0, -2.0);
    group.add(nose);
  }
  return group;
}

/** Swaps every mesh in `group` for the real loaded shape's geometry once the fetch resolves
 *  -- same swallow-on-failure convention base-object-view.ts's loadRealShape already
 *  established (a missing/slow shape leaves the procedural placeholder on screen, never
 *  crashes the render loop). */
function loadRealShape(group: THREE.Group, shapeFileName: string): void {
  const url = shapeUrl(shapeFileName.replace(/\.glb$/, ''));
  try {
    new GLTFLoader().load(
      url,
      (gltf) => {
        group.clear();
        group.add(gltf.scene);
      },
      undefined,
      () => {
        // Swallowed -- the procedural placeholder already on `group` stays visible.
      },
    );
  } catch {
    // Swallowed -- see this function's own doc comment.
  }
}

function vehicleAssetFor(
  assets: Pick<KatabaticAssets, 'scene'>,
  kind: VehicleKind,
): { source: 'glb' | 'stl' | 'procedural'; shape: string } {
  return kind === VehicleKind.Shrike ? assets.scene.vehicles.shrike : assets.scene.vehicles.wildcat;
}

function createVehicleMesh(assets: Pick<KatabaticAssets, 'scene'>, kind: VehicleKind): THREE.Group {
  const group = proceduralMesh(kind);
  const asset = vehicleAssetFor(assets, kind);
  if (asset.source !== 'procedural') loadRealShape(group, asset.shape);
  return group;
}

function pruneVehicleMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Object3D>,
  liveIds: Set<number>,
): void {
  for (const id of [...meshes.keys()]) {
    if (liveIds.has(id)) continue;
    const mesh = meshes.get(id);
    if (mesh) scene.remove(mesh);
    meshes.delete(id);
  }
}

/** Positions/orients one vehicle mesh from its snapshot -- yaw/pitch/roll match the
 *  YXZ euler order aimCamera (app.ts) already uses for the player's own look. */
function placeVehicleMesh(mesh: THREE.Object3D, data: VehicleSnapshotData): void {
  mesh.position.set(data.x, data.y, data.z);
  mesh.rotation.set(data.pitch, data.yaw + Math.PI, data.roll, 'YXZ');
}

export function createVehicleView(
  scene: THREE.Scene,
  assets: Pick<KatabaticAssets, 'scene'>,
): VehicleView {
  const meshes = new Map<number, THREE.Object3D>();
  return {
    meshes,
    sync(vehicles: VehicleSnapshotData[]): void {
      // A destroyed vehicle disappears entirely (mirrors flag-view.ts's own disappearance-
      // based cleanup convention, M3) rather than staying visible in a "destroyed" material
      // the way a base object/turret does -- Task 7's ejection already flings the pilot
      // clear the same tick, so there is no reason for the husk to linger on screen.
      const live = vehicles.filter((v) => !v.destroyed);
      const liveIds = new Set(live.map((v) => v.id));
      pruneVehicleMeshes(scene, meshes, liveIds);
      for (const data of live) {
        let mesh = meshes.get(data.id);
        if (!mesh) {
          mesh = createVehicleMesh(assets, data.kind as VehicleKind);
          scene.add(mesh);
          meshes.set(data.id, mesh);
        }
        placeVehicleMesh(mesh, data);
      }
    },
  };
}

/** Single-player mode has no server snapshot; read the sim's own vehicle store directly --
 *  same convention flag-view.ts's flagsFromWorld and base-object-view.ts's
 *  baseObjectsFromWorld already use. */
function num(arr: Float64Array | Uint8Array | Int16Array, i: number): number {
  return arr[i] ?? 0;
}

function vehicleSnapshotFromStore(store: World['vehicles'], id: number): VehicleSnapshotData {
  const base = id * 3;
  return {
    id,
    kind: num(store.kind, id),
    team: num(store.team, id),
    x: num(store.position, base),
    y: num(store.position, base + 1),
    z: num(store.position, base + 2),
    vx: num(store.velocity, base),
    vy: num(store.velocity, base + 1),
    vz: num(store.velocity, base + 2),
    yaw: num(store.yaw, id),
    pitch: num(store.pitch, id),
    roll: num(store.roll, id),
    angVelYaw: num(store.angVel, base),
    angVelPitch: num(store.angVel, base + 1),
    angVelRoll: num(store.angVel, base + 2),
    energy: num(store.energy, id),
    damage: num(store.damage, id),
    destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
    driverId: num(store.driverId, id),
    padId: num(store.padId, id),
    weaponTimer: num(store.weaponTimer, id),
    onGround: (store.onGround[id] ? 1 : 0) as 0 | 1,
    wasJumpHeld: (store.wasJumpHeld[id] ? 1 : 0) as 0 | 1,
  };
}

export function vehiclesFromWorld(world: World): VehicleSnapshotData[] {
  const out: VehicleSnapshotData[] = [];
  const store = world.vehicles;
  for (let id = 0; id < store.count; id += 1) {
    if (store.active[id]) out.push(vehicleSnapshotFromStore(store, id));
  }
  return out;
}
