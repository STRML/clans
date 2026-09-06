import * as THREE from 'three';
import type { PlayerSnapshotData } from '@clans/sim';

export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATE_MS = 50;
const HISTORY_LENGTH = 8;
const CAPSULE_RADIUS = 0.6;
const CAPSULE_HEIGHT = 1.2;
// A respawn (falling out of the world, or a disconnected id reused by a new player
// before an intervening snapshot) teleports a player instantly; the snapshot wire format
// carries no flag for that. Without this, the new position was appended to the same
// history as the old one, and positionAt() interpolated between them like ordinary
// movement -- an observer saw the player visibly slide from where they died to the spawn
// point instead of an instant snap. Max run speed is 15 m/s (armor.ts); even a fast ski
// run travels well under a meter in one snapshot interval, so any single-sample jump this
// large can only be a teleport, never legitimate movement.
const TELEPORT_DISTANCE_M = 15;

// WONTFIX (PR #4, M2 status table): Codex round 17 found this distance heuristic still
// smears a reused player id if the departed player's last position happened to be within
// TELEPORT_DISTANCE_M of the new player's spawn AND the reuse lands within a single
// snapshot interval -- both a spatial and a timing coincidence. Closing this fully needs a
// per-player generation or teleport flag on the wire (snapshot.ts), a protocol change, to
// tell "same player, still moving" apart from "id reused" with certainty. Lowering this
// threshold instead would trade a rare, momentary, cosmetic glitch (a slide) for a more
// common one: ordinary high-speed skiing bursts snapping unnecessarily. Not proportionate
// for M2; revisit alongside any future snapshot wire format change.
function distance(a: PlayerSnapshotData, b: PlayerSnapshotData): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

interface RemoteSample {
  atMs: number;
  data: PlayerSnapshotData;
}
interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function findBracket(
  samples: RemoteSample[],
  renderTime: number,
): { before: RemoteSample | undefined; after: RemoteSample | undefined } {
  let before = samples[0] ?? samples[samples.length - 1];
  let after = samples[samples.length - 1];
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    if (isBracket(a, b, renderTime)) {
      before = a;
      after = b;
      break;
    }
  }
  return { before, after };
}

function isBracket(
  a: RemoteSample | undefined,
  b: RemoteSample | undefined,
  renderTime: number,
): boolean {
  if (!a || !b) return false;
  return a.atMs <= renderTime && renderTime <= b.atMs;
}

function poseFromSample(sample: RemoteSample | undefined): RemotePose {
  return {
    x: sample?.data.x ?? 0,
    y: sample?.data.y ?? 0,
    z: sample?.data.z ?? 0,
    yaw: sample?.data.yaw ?? 0,
  };
}

function lerpPose(before: RemoteSample, after: RemoteSample, renderTime: number): RemotePose {
  const t = Math.max(0, Math.min(1, (renderTime - before.atMs) / (after.atMs - before.atMs)));
  return {
    x: before.data.x + (after.data.x - before.data.x) * t,
    y: before.data.y + (after.data.y - before.data.y) * t,
    z: before.data.z + (after.data.z - before.data.z) * t,
    yaw: before.data.yaw + (after.data.yaw - before.data.yaw) * t,
  };
}

export class RemoteBuffer {
  private samples: RemoteSample[] = [];

  push(atMs: number, data: PlayerSnapshotData): void {
    const previous = this.samples.at(-1);
    // A jump this large is a teleport (respawn, or a reused id's new player entirely),
    // not movement: discard the stale history instead of letting interpolate() smear a
    // straight line between two unrelated positions.
    if (previous && distance(previous.data, data) > TELEPORT_DISTANCE_M) this.samples.length = 0;
    this.samples.push({ atMs, data });
    if (this.samples.length > HISTORY_LENGTH) this.samples.shift();
  }

  positionAt(nowMs: number): RemotePose | null {
    const latest = this.samples.at(-1);
    if (!latest) return null;
    const renderTime = nowMs - INTERP_DELAY_MS;
    return renderTime >= latest.atMs
      ? this.extrapolate(latest, renderTime)
      : this.interpolate(renderTime);
  }

  private interpolate(renderTime: number): RemotePose {
    const { before, after } = findBracket(this.samples, renderTime);
    if (!before || !after || before.atMs === after.atMs) return poseFromSample(before ?? after);
    return lerpPose(before, after, renderTime);
  }

  private extrapolate(latest: RemoteSample, renderTime: number): RemotePose {
    const seconds = Math.min(renderTime - latest.atMs, MAX_EXTRAPOLATE_MS) / 1000;
    return {
      x: latest.data.x + latest.data.vx * seconds,
      y: latest.data.y + latest.data.vy * seconds,
      z: latest.data.z + latest.data.vz * seconds,
      yaw: latest.data.yaw,
    };
  }
}

export function createCapsule(): THREE.Mesh {
  const geometry = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT, 4, 8);
  const material = new THREE.MeshStandardMaterial({ color: 0x4488ff });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return mesh;
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const material = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const entry of material) entry.dispose();
}

function pruneMissing(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  buffers: Map<number, RemoteBuffer>,
): void {
  for (const id of [...meshes.keys()]) {
    if (buffers.has(id)) continue;
    const mesh = meshes.get(id);
    if (mesh) {
      scene.remove(mesh);
      // Every mesh here owns geometry and a material created just for it (createCapsule);
      // removing it from the scene alone leaves both allocated, so a disconnect/rejoin
      // cycle across a match leaks WebGL resources the GC never reclaims.
      disposeMesh(mesh);
    }
    meshes.delete(id);
  }
}

export function syncRemoteMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  buffers: Map<number, RemoteBuffer>,
  nowMs: number,
): void {
  pruneMissing(scene, meshes, buffers);
  for (const [id, buffer] of buffers) {
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = createCapsule();
      scene.add(mesh);
      meshes.set(id, mesh);
    }
    const pose = buffer.positionAt(nowMs);
    if (!pose) continue;
    mesh.position.set(pose.x, pose.y + CAPSULE_HEIGHT / 2 + CAPSULE_RADIUS, pose.z);
    mesh.rotation.y = pose.yaw + Math.PI;
  }
}
