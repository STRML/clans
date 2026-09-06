import * as THREE from 'three';
import { FIXED_DT, FlagState, type World } from '@clans/sim';
import type { FlagSnapshotData } from '@clans/protocol';

const TEAM_COLOR: Record<number, number> = { 1: 0xdd3333, 2: 0x3366dd };
const CLOTH_SIZE = 0.6;
const POLE_HEIGHT = 1.8;
const CARRIED_LIFT = 2.0; // Ours: renders the flag over the carrier's head, no pole.
// Spec: "Flag return delay: 45 s after a drop, with a 2 s fade." The fade itself is not
// specified further, so this reads it as a warning fade on the cloth over the last 2 s
// before an unattended return, down to 25% opacity rather than fully invisible so the
// flag stays visible to a player closing in to reclaim it.
const RETURN_FADE_SECONDS = 2;
const RETURN_FADE_MIN_OPACITY = 0.25;

function createFlagMesh(team: number): THREE.Group {
  const group = new THREE.Group();
  const color = TEAM_COLOR[team] ?? 0xffffff;
  const cloth = new THREE.Mesh(
    new THREE.BoxGeometry(CLOTH_SIZE, CLOTH_SIZE, 0.05),
    new THREE.MeshStandardMaterial({ color, transparent: true }),
  );
  cloth.position.y = POLE_HEIGHT;
  cloth.name = 'cloth';
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, POLE_HEIGHT, 6),
    new THREE.MeshStandardMaterial({ color: 0x333333 }),
  );
  pole.position.y = POLE_HEIGHT / 2;
  pole.name = 'pole';
  group.add(pole, cloth);
  return group;
}

function disposeFlagGroup(group: THREE.Group): void {
  // Each group owns geometry and materials created just for it (createFlagMesh); removing
  // it from the scene alone leaves both allocated, so a capture/return cycle across a
  // match leaks WebGL resources the GC never reclaims. Same convention as remote.ts's
  // disposeMesh, applied to every mesh child rather than a single top-level mesh.
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    child.geometry.dispose();
    const material = Array.isArray(child.material) ? child.material : [child.material];
    for (const entry of material) entry.dispose();
  }
}

function pruneFlagMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Group>,
  liveIds: Set<number>,
): void {
  for (const id of [...meshes.keys()]) {
    if (liveIds.has(id)) continue;
    const group = meshes.get(id);
    if (group) {
      scene.remove(group);
      disposeFlagGroup(group);
    }
    meshes.delete(id);
  }
}

export function syncFlagMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Group>,
  flags: FlagSnapshotData[],
): void {
  const liveIds = new Set(flags.map((f) => f.id));
  pruneFlagMeshes(scene, meshes, liveIds);
  for (const flag of flags) {
    let group = meshes.get(flag.id);
    if (!group) {
      group = createFlagMesh(flag.team);
      scene.add(group);
      meshes.set(flag.id, group);
    }
    const carried = flag.state === FlagState.Carried;
    group.position.set(flag.x, flag.y + (carried ? CARRIED_LIFT : 0), flag.z);
    const pole = group.getObjectByName('pole');
    if (pole) pole.visible = !carried;
    applyReturnFade(group, flag);
  }
}

function applyReturnFade(group: THREE.Group, flag: FlagSnapshotData): void {
  const cloth = group.getObjectByName('cloth') as THREE.Mesh | undefined;
  const material = cloth?.material as THREE.MeshStandardMaterial | undefined;
  if (!material) return;
  const fading = flag.returnInS >= 0 && flag.returnInS <= RETURN_FADE_SECONDS;
  if (!fading) {
    material.opacity = 1;
    return;
  }
  const t = flag.returnInS / RETURN_FADE_SECONDS;
  material.opacity = RETURN_FADE_MIN_OPACITY + (1 - RETURN_FADE_MIN_OPACITY) * t;
}

/**
 * Single-player mode has no server snapshot; read the sim's own flag store directly.
 *
 * Codex review round 6, finding P3 (PR #9): this used to hardcode `returnInS: -1` regardless
 * of the flag's actual state, so `applyReturnFade` above -- which only fades a flag once its
 * `returnInS` reads a non-negative value at or under `RETURN_FADE_SECONDS` -- never saw
 * anything but "not counting down" here. The networked path never had this bug: the server
 * computes `returnInS` from `world.flags.returnAt` and the current tick (see
 * packages/server/src/net.ts's snapshotWorldFlag), and this reuses that exact formula so a
 * single-player dropped flag fades over its final two seconds before auto-return the same way
 * the networked one does.
 */
export function flagsFromWorld(world: World): FlagSnapshotData[] {
  const out: FlagSnapshotData[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const base = id * 3;
    const returnAt = world.flags.returnAt[id] ?? -1;
    out.push({
      id,
      team: world.flags.team[id] ?? 0,
      state: world.flags.state[id] ?? 0,
      x: world.flags.position[base] ?? 0,
      y: world.flags.position[base + 1] ?? 0,
      z: world.flags.position[base + 2] ?? 0,
      carrierId: world.flags.carrierId[id] ?? -1,
      returnInS: returnAt < 0 ? -1 : (returnAt - world.tick) * FIXED_DT,
    });
  }
  return out;
}
