import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BASE_OBJECT_DATA,
  BaseObjectKind,
  baseFor,
  type TurretBarrelId,
  type World,
} from '@clans/sim';
import type { BaseObjectSnapshotData, TurretSnapshotData } from '@clans/protocol';
import { shapeUrl, type KatabaticAssets } from './assets.js';

export interface BaseObjectView {
  baseObjectMeshes: Map<number, THREE.Object3D>;
  turretMeshes: Map<number, THREE.Object3D>;
  sync(baseObjects: BaseObjectSnapshotData[], turrets: TurretSnapshotData[]): void;
}

const DESTROYED_COLOR = new THREE.Color(0x1a1a1a);
const UNPOWERED_EMISSIVE = new THREE.Color(0x000000);
const POWERED_EMISSIVE = new THREE.Color(0x2266ff);
const FORCE_FIELD_KIND = 4; // Matches @clans/sim's BaseObjectKind.ForceField ordinal.
// forceField.cs:12-18 (defaultForceFieldBare): color, powerOffColor, baseTranslucency,
// powerOffTranslucency -- see the M4 plan's "ours" numbers table.
const FORCE_FIELD_POWERED_COLOR = new THREE.Color(0.0, 0.55, 0.99);
const FORCE_FIELD_UNPOWERED_COLOR = new THREE.Color(0x000000);
const FORCE_FIELD_TRANSLUCENCY = 0.3;

function placeholderMesh(): THREE.Mesh {
  // A box stands in for the shape until its real .glb resolves -- createBaseObjectView
  // returns synchronously (app.ts's frame loop must not block on network), and every
  // caller of `sync` already tolerates a mesh whose geometry swaps out later.
  return new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x888888, emissive: POWERED_EMISSIVE }),
  );
}

/** A flat, translucent quad standing in for the field's real `PhysicalZone` volume -- see
 *  the M4 plan's Task 3 for why the sim's own collider is the same two-triangle
 *  simplification. Sized from the placement's own `scale` (Torque Y-up: `scale.z`/
 *  `scale.y` give half-width/half-height once doubled), oriented from its `rotation`. */
function forceFieldMesh(placement: KatabaticAssets['scene']['baseObjects'][number]): THREE.Mesh {
  const scale = placement.scale ?? [1, 4, 6];
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(scale[2], scale[1]),
    new THREE.MeshBasicMaterial({
      color: FORCE_FIELD_POWERED_COLOR,
      transparent: true,
      opacity: FORCE_FIELD_TRANSLUCENCY,
      side: THREE.DoubleSide,
    }),
  );
  mesh.userData.isForceField = true;
  if (placement.rotation) {
    mesh.setRotationFromAxisAngle(
      new THREE.Vector3(
        placement.rotation.axis[0],
        placement.rotation.axis[1],
        placement.rotation.axis[2],
      ),
      (placement.rotation.degrees * Math.PI) / 180,
    );
  }
  return mesh;
}

/** Swaps `mesh`'s placeholder geometry for the real loaded shape once the fetch resolves.
 *  Failure is swallowed (not rethrown) rather than surfaced: a missing/slow shape leaves the
 *  placeholder box on screen instead of crashing the render loop or leaving an unhandled
 *  promise rejection, and this file's own tests never wait on a real network fetch. The
 *  `.load()` call itself is wrapped too, not just its error callback: three's `FileLoader`
 *  parses the URL as absolute internally and throws SYNCHRONOUSLY, before the error callback
 *  ever runs, in an environment with no document base URL to resolve a root-relative path
 *  against (Node's test environment, in particular) -- a try/catch here is what keeps that
 *  from crashing createBaseObjectView itself rather than just failing to load one shape. */
function loadRealShape(mesh: THREE.Mesh, shapeName: string | undefined): void {
  if (!shapeName) return;
  try {
    new GLTFLoader().load(
      shapeUrl(shapeName),
      (gltf) => {
        mesh.geometry.dispose();
        const real = gltf.scene.getObjectByProperty('type', 'Mesh') as THREE.Mesh | undefined;
        if (real) mesh.geometry = real.geometry;
      },
      undefined,
      () => {
        // Swallowed -- see this function's own doc comment.
      },
    );
  } catch {
    // Swallowed -- see this function's own doc comment.
  }
}

function addBaseObjectMesh(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Object3D>,
  assets: Pick<KatabaticAssets, 'scene'>,
  placement: KatabaticAssets['scene']['baseObjects'][number],
  id: number,
): void {
  const mesh = placement.kind === FORCE_FIELD_KIND ? forceFieldMesh(placement) : placeholderMesh();
  mesh.position.fromArray(placement.position);
  if (placement.kind !== FORCE_FIELD_KIND) {
    loadRealShape(mesh, assets.scene.shapesForBaseObjectKind[placement.kind]);
  }
  // Stashed for raycastAimedStructure below, which reads a raycast hit's own mesh back out
  // without needing to search baseObjectMeshes/turretMeshes for it.
  mesh.userData.structureKind = 'baseObject';
  mesh.userData.structureId = id;
  scene.add(mesh);
  meshes.set(id, mesh);
}

function addTurretMesh(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Object3D>,
  assets: Pick<KatabaticAssets, 'scene'>,
  placement: KatabaticAssets['scene']['turrets'][number],
  id: number,
): void {
  const mesh = placeholderMesh();
  mesh.position.fromArray(placement.position);
  loadRealShape(mesh, assets.scene.shapesForTurretBarrel[placement.barrel]);
  mesh.userData.structureKind = 'turret';
  mesh.userData.structureId = id;
  scene.add(mesh);
  meshes.set(id, mesh);
}

function syncForceField(mesh: THREE.Mesh, o: BaseObjectSnapshotData): void {
  const material = mesh.material as THREE.MeshBasicMaterial;
  material.color = o.powered ? FORCE_FIELD_POWERED_COLOR : FORCE_FIELD_UNPOWERED_COLOR;
  material.opacity = o.powered ? FORCE_FIELD_TRANSLUCENCY : 0; // powerOffTranslucency = 0.0.
}

function syncBaseObjects(
  meshes: Map<number, THREE.Object3D>,
  data: BaseObjectSnapshotData[],
): void {
  for (const o of data) {
    const mesh = meshes.get(o.id);
    if (!(mesh instanceof THREE.Mesh)) continue;
    if (mesh.userData.isForceField) {
      syncForceField(mesh, o);
      continue;
    }
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.color = o.destroyed ? DESTROYED_COLOR : new THREE.Color(0x888888);
    material.emissive = o.powered ? POWERED_EMISSIVE : UNPOWERED_EMISSIVE;
    mesh.userData.destroyed = o.destroyed === 1;
  }
}

function syncTurrets(meshes: Map<number, THREE.Object3D>, data: TurretSnapshotData[]): void {
  for (const t of data) {
    const mesh = meshes.get(t.id);
    if (!(mesh instanceof THREE.Mesh)) continue;
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.color = t.destroyed ? DESTROYED_COLOR : new THREE.Color(0x888888);
    material.emissive = t.powered ? POWERED_EMISSIVE : UNPOWERED_EMISSIVE;
    mesh.userData.destroyed = t.destroyed === 1;
    // Aim: the turret's own barrel data isn't on the wire (protocol's Task 7 deliberately
    // omits it -- see that task's "position is not on the wire" note); targetId alone
    // combined with the already-known remote/local player position is enough for the client
    // to face the mesh the same direction turrets.ts's own fireAt computes. Not implemented
    // this task -- the mesh's static orientation from placement is a reasonable stand-in
    // until a future pass wires target-facing rotation.
  }
}

export function createBaseObjectView(
  scene: THREE.Scene,
  assets: Pick<KatabaticAssets, 'scene'>,
): BaseObjectView {
  const baseObjectMeshes = new Map<number, THREE.Object3D>();
  const turretMeshes = new Map<number, THREE.Object3D>();
  assets.scene.baseObjects.forEach((placement, id) => {
    addBaseObjectMesh(scene, baseObjectMeshes, assets, placement, id);
  });
  assets.scene.turrets.forEach((placement, id) => {
    addTurretMesh(scene, turretMeshes, assets, placement, id);
  });

  return {
    baseObjectMeshes,
    turretMeshes,
    sync(baseObjects, turrets) {
      syncBaseObjects(baseObjectMeshes, baseObjects);
      syncTurrets(turretMeshes, turrets);
    },
  };
}

const BASE_OBJECT_NAME: Record<number, string> = {
  [BaseObjectKind.Generator]: 'Generator',
  [BaseObjectKind.Sensor]: 'Sensor',
  [BaseObjectKind.StationInventory]: 'Station',
  [BaseObjectKind.StationVehiclePad]: 'Vehicle Pad',
  [BaseObjectKind.ForceField]: 'Force Field',
};
const AIM_RANGE = 50; // Ours: a reasonable "aimed at" range for the HUD callout.

function healthPercentOf(damage: number, maxHealth: number): number {
  if (maxHealth <= 0) return 100;
  return Math.round(Math.max(0, 1 - damage / maxHealth) * 100);
}

function aimedBaseObjectInfo(world: World, id: number): { name: string; healthPercent: number } {
  const kind = (world.baseObjects.kind[id] ?? BaseObjectKind.Generator) as BaseObjectKind;
  const maxHealth = BASE_OBJECT_DATA[kind].maxHealth;
  return {
    name: BASE_OBJECT_NAME[kind] ?? 'Base Object',
    healthPercent: healthPercentOf(world.baseObjects.damage[id] ?? 0, maxHealth),
  };
}

function aimedTurretInfo(world: World, id: number): { name: string; healthPercent: number } {
  const barrel = (world.turrets.barrel[id] ?? 0) as TurretBarrelId;
  const maxHealth = baseFor(barrel).maxHealth;
  return {
    name: 'Turret',
    healthPercent: healthPercentOf(world.turrets.damage[id] ?? 0, maxHealth),
  };
}

/** Raycasts from the camera's forward direction against every base-object/turret mesh
 *  within `AIM_RANGE`, reading the hit's own stashed `userData` (set at mesh-creation time
 *  above) rather than searching `baseObjectMeshes`/`turretMeshes` for it. Feeds hud.ts's
 *  aimedStructure row. */
export function raycastAimedStructure(
  camera: THREE.Camera,
  view: Pick<BaseObjectView, 'baseObjectMeshes' | 'turretMeshes'>,
  world: World,
): { name: string; healthPercent: number } | null {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  raycaster.far = AIM_RANGE;
  const objects = [...view.baseObjectMeshes.values(), ...view.turretMeshes.values()];
  const hit = raycaster.intersectObjects(objects, false)[0];
  if (!hit) return null;
  const { structureKind, structureId } = hit.object.userData as {
    structureKind?: 'baseObject' | 'turret';
    structureId?: number;
  };
  if (structureId === undefined) return null;
  if (structureKind === 'baseObject') return aimedBaseObjectInfo(world, structureId);
  if (structureKind === 'turret') return aimedTurretInfo(world, structureId);
  return null;
}

/** Single-player has no server snapshot; read the sim's own base-object store directly --
 *  same convention flag-view.ts's flagsFromWorld already uses. */
export function baseObjectsFromWorld(world: World): BaseObjectSnapshotData[] {
  const out: BaseObjectSnapshotData[] = [];
  const store = world.baseObjects;
  for (let id = 0; id < store.count; id += 1) {
    out.push({
      id,
      damage: store.damage[id] ?? 0,
      destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
      powered: (store.powered[id] ? 1 : 0) as 0 | 1,
    });
  }
  return out;
}

/** Single-player equivalent of baseObjectsFromWorld, for turrets. */
export function turretsFromWorld(world: World): TurretSnapshotData[] {
  const out: TurretSnapshotData[] = [];
  const store = world.turrets;
  for (let id = 0; id < store.count; id += 1) {
    out.push({
      id,
      damage: store.damage[id] ?? 0,
      destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
      powered: (store.powered[id] ? 1 : 0) as 0 | 1,
      targetId: store.targetId[id] ?? -1,
      state: store.state[id] ?? 0,
    });
  }
  return out;
}
