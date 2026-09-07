import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VehicleKind, type World } from '@clans/sim';
import type { VehicleSnapshotData } from '@clans/protocol';
import { shapeUrl, type KatabaticAssets } from './assets.js';

export interface VehicleView {
  meshes: Map<number, THREE.Object3D>;
  sync(vehicles: VehicleSnapshotData[]): void;
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
    yaw: num(store.yaw, id),
    pitch: num(store.pitch, id),
    roll: num(store.roll, id),
    energy: num(store.energy, id),
    damage: num(store.damage, id),
    destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
    driverId: num(store.driverId, id),
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
