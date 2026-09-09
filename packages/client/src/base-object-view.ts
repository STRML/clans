import * as THREE from 'three';
import { loadShapeInto } from './shape-loader.js';
import { mountTurretBarrel } from './turret-mount.js';
import {
  BASE_OBJECT_DATA,
  BaseObjectKind,
  baseFor,
  type TurretBarrelId,
  type World,
} from '@clans/sim';
import type { BaseObjectSnapshotData, TurretSnapshotData } from '@clans/protocol';
import { type KatabaticAssets } from './assets.js';

export interface BaseObjectView {
  baseObjectMeshes: Map<number, THREE.Object3D>;
  turretMeshes: Map<number, THREE.Object3D>;
  /** Codex round 1, finding 6: interior-collision.ts already loads the collision binaries for
   *  these same placements (world.interiors, for movement collision), but nothing ever added a
   *  visible mesh for them -- every interior (sbunk2, the station buildings, etc.) was
   *  invisible geometry a player could walk through the collision of but never see. */
  interiorMeshes: Map<number, THREE.Object3D>;
  sync(baseObjects: BaseObjectSnapshotData[], turrets: TurretSnapshotData[]): void;
}

const DESTROYED_COLOR = new THREE.Color(0x1a1a1a);
const FORCE_FIELD_KIND = 4; // Matches @clans/sim's BaseObjectKind.ForceField ordinal.
// forceField.cs:12-18 (defaultForceFieldBare): color, powerOffColor, baseTranslucency,
// powerOffTranslucency -- see the M4 plan's "ours" numbers table.
const FORCE_FIELD_POWERED_COLOR = new THREE.Color(0.0, 0.55, 0.99);
const FORCE_FIELD_UNPOWERED_COLOR = new THREE.Color(0x000000);
const FORCE_FIELD_TRANSLUCENCY = 0.3;

function placeholderMesh(): THREE.Group {
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x888888 }),
    ),
  );
  return group;
}

/** A flat, translucent quad standing in for the field's real `PhysicalZone` volume -- see
 *  the M4 plan's Task 3 for why the sim's own collider is the same two-triangle
 *  simplification. Sized from the placement's own `scale` (Torque Y-up: `scale.z`/
 *  `scale.y` give half-width/half-height once doubled), oriented from its `rotation`. */
function forceFieldMesh(placement: KatabaticAssets['scene']['baseObjects'][number]): THREE.Mesh {
  const scale = placement.scale ?? [1, 4, 6];
  // PlaneGeometry's untransformed default lies in the local XY plane (normal along local
  // +Z). The real collider, sim/baseObjects.ts's forceFieldQuad, has every vertex at
  // local x = 0 -- it lies in the local YZ plane, normal along local +X. Rotate the
  // geometry itself (not the mesh) to match, BEFORE placement.rotation is applied below,
  // the same order the collider's own position+rotation pipeline composes them.
  const geometry = new THREE.PlaneGeometry(scale[2], scale[1]);
  geometry.rotateY(Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
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

function applyShapeTransform(
  mesh: THREE.Object3D,
  placement: {
    rotation?: { axis: [number, number, number]; degrees: number };
    scale?: [number, number, number];
  },
): void {
  if (placement.rotation) {
    mesh.setRotationFromAxisAngle(
      new THREE.Vector3(...placement.rotation.axis).normalize(),
      (placement.rotation.degrees * Math.PI) / 180,
    );
  }
  if (placement.scale) mesh.scale.fromArray(placement.scale);
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
    applyShapeTransform(mesh, placement);
    loadShapeInto(mesh, assets.scene.shapesForBaseObjectKind[placement.kind], Math.PI);
  }
  // Stashed for raycastAimedStructure below, which reads a raycast hit's own mesh back out
  // without needing to search baseObjectMeshes/turretMeshes for it.
  mesh.userData.structureKind = 'baseObject';
  mesh.userData.structureId = id;
  scene.add(mesh);
  meshes.set(id, mesh);
}

/** Positions and orients a placeholder mesh from an interior placement's own `position`/
 *  `rotation` -- the same fields interior-collision.ts's `loadInteriorColliders` already reads
 *  to build that same interior's collision geometry, so the visible mesh and the invisible
 *  collider it stands over always agree on where the interior actually is. */
function addInteriorMesh(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Object3D>,
  placement: KatabaticAssets['scene']['interiors'][number],
  id: number,
): void {
  const mesh = placeholderMesh();
  mesh.position.fromArray(placement.position);
  mesh.setRotationFromAxisAngle(
    new THREE.Vector3(
      placement.rotation.axis[0],
      placement.rotation.axis[1],
      placement.rotation.axis[2],
    ),
    (placement.rotation.degrees * Math.PI) / 180,
  );
  loadShapeInto(mesh, placement.shape);
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
  const mesh = new THREE.Group();
  mesh.position.fromArray(placement.position);
  applyShapeTransform(mesh, placement);
  const barrel = placeholderMesh();
  // Large turret GLBs contain only the barrel; the mission uses a separate shared pedestal.
  mesh.add(barrel);
  loadShapeInto(
    barrel,
    assets.scene.shapesForTurretBarrel[placement.barrel],
    placement.barrel === 2 ? Math.PI : 0,
  );
  if (placement.barrel !== 2) {
    const base = placeholderMesh();
    mesh.add(base);
    loadShapeInto(base, 'turret_base_large', Math.PI);
  }
  mesh.userData.structureKind = 'turret';
  mesh.userData.structureId = id;
  scene.add(mesh);
  meshes.set(id, mesh);
}

function syncForceField(mesh: THREE.Mesh, o: BaseObjectSnapshotData): void {
  const material = mesh.material as THREE.MeshBasicMaterial;
  mesh.visible = o.powered === 1;
  material.color = o.powered ? FORCE_FIELD_POWERED_COLOR : FORCE_FIELD_UNPOWERED_COLOR;
  material.opacity = o.powered ? FORCE_FIELD_TRANSLUCENCY : 0; // powerOffTranslucency = 0.0.
}

// Save authored colors per material, so repair restores the model rather than painting it gray.
const originalColors = new WeakMap<THREE.Material, THREE.Color>();
function syncVisibility(node: THREE.Object3D, destroyed: boolean, powered: boolean): void {
  const visibility = node.userData.vis_keyframes_visibility as number[] | undefined;
  if (visibility?.length) node.visible = (destroyed ? visibility.at(-1)! : visibility[0]!) > 0;
  if (node.userData.vis_keyframes_power) node.visible = powered && !destroyed;
}

function syncStructure(root: THREE.Object3D, destroyed: boolean, powered: boolean): void {
  root.userData.destroyed = destroyed;
  root.userData.powered = powered;
  root.traverse((node) => {
    syncVisibility(node, destroyed, powered);
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!(
        material instanceof THREE.MeshStandardMaterial ||
        material instanceof THREE.MeshBasicMaterial
      ))
        continue;
      if (!originalColors.has(material)) originalColors.set(material, material.color.clone());
      material.color.copy(destroyed ? DESTROYED_COLOR : originalColors.get(material)!);
    }
  });
}

function syncBaseObjects(
  meshes: Map<number, THREE.Object3D>,
  data: BaseObjectSnapshotData[],
): void {
  for (const o of data) {
    const mesh = meshes.get(o.id);
    if (!mesh) continue;
    if (mesh instanceof THREE.Mesh && mesh.userData.isForceField) {
      syncForceField(mesh, o);
    } else {
      syncStructure(mesh, o.destroyed === 1, o.powered === 1);
    }
  }
}

function syncTurrets(meshes: Map<number, THREE.Object3D>, data: TurretSnapshotData[]): void {
  for (const t of data) {
    const mesh = meshes.get(t.id);
    if (mesh) {
      mountTurretBarrel(mesh);
      syncStructure(mesh, t.destroyed === 1, t.powered === 1);
    }
  }
}

export function createBaseObjectView(
  scene: THREE.Scene,
  assets: Pick<KatabaticAssets, 'scene'>,
): BaseObjectView {
  const baseObjectMeshes = new Map<number, THREE.Object3D>();
  const vehicleStationMeshes = new Map<number, THREE.Object3D>();
  const turretMeshes = new Map<number, THREE.Object3D>();
  const interiorMeshes = new Map<number, THREE.Object3D>();
  assets.scene.baseObjects.forEach((placement, id) => {
    addBaseObjectMesh(scene, baseObjectMeshes, assets, placement, id);
    if (placement.kind === BaseObjectKind.StationVehiclePad && placement.usePosition) {
      const station = placeholderMesh();
      station.name = 'vehicle-control-station';
      station.position.fromArray(placement.usePosition);
      applyShapeTransform(station, placement);
      loadShapeInto(station, 'vehicle_pad_station', Math.PI);
      station.userData.structureKind = 'baseObject';
      station.userData.structureId = id;
      scene.add(station);
      vehicleStationMeshes.set(id, station);
    }
  });
  assets.scene.turrets.forEach((placement, id) => {
    addTurretMesh(scene, turretMeshes, assets, placement, id);
  });
  assets.scene.interiors.forEach((placement, id) => {
    addInteriorMesh(scene, interiorMeshes, placement, id);
  });

  return {
    baseObjectMeshes,
    turretMeshes,
    interiorMeshes,
    sync(baseObjects, turrets) {
      syncBaseObjects(baseObjectMeshes, baseObjects);
      syncBaseObjects(vehicleStationMeshes, baseObjects);
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
function isVisible(object: THREE.Object3D): boolean {
  if (!object.visible) return false;
  return object.parent ? isVisible(object.parent) : true;
}

export function raycastAimedStructure(
  camera: THREE.Camera,
  view: Pick<BaseObjectView, 'baseObjectMeshes' | 'turretMeshes'>,
  world: World,
): { name: string; healthPercent: number } | null {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  raycaster.far = AIM_RANGE;
  const objects = [...view.baseObjectMeshes.values(), ...view.turretMeshes.values()];
  const hit = raycaster.intersectObjects(objects, true).find((hit) => isVisible(hit.object));
  if (!hit) return null;
  let root: THREE.Object3D = hit.object;
  while (root.parent && root.userData.structureId === undefined) root = root.parent;
  const { structureKind, structureId } = root.userData as {
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
