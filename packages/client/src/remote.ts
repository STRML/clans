import * as THREE from 'three';
import type { PlayerSnapshotData } from '@clans/sim';
import { PlayerView } from './players-view.js';

export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATE_MS = 50;
const HISTORY_LENGTH = 8;
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
/** A remote player's interpolated transform, in the client's own frame: the position the
 *  player model is placed at (feet on the ground) and the yaw its root turns to. */
export interface RemotePose {
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
    const teleported = previous ? distance(previous.data, data) > TELEPORT_DISTANCE_M : false;
    // respawnSeq increments on every respawn, including a freed id's first spawn as a new
    // player -- catches the case the distance heuristic alone misses, where a reused id's
    // new spawn happens to land close to the departed player's last position (closes #8).
    const respawned = previous ? previous.data.respawnSeq !== data.respawnSeq : false;
    if (teleported || respawned) this.samples.length = 0;
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

  /** The newest raw sample, never interpolated: the discrete half of a remote player's state
   *  (armour, onGround, ski, health, velocity) is logical truth as of the last snapshot and
   *  must not be blended the way position and yaw are. Same split, and the same reasoning, as
   *  vehicle-view.ts's VehicleBuffer.latest. */
  latest(): PlayerSnapshotData | null {
    return this.samples.at(-1)?.data ?? null;
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

function pruneMissing(
  scene: THREE.Scene,
  views: Map<number, PlayerView>,
  buffers: Map<number, RemoteBuffer>,
): void {
  for (const id of [...views.keys()]) {
    if (buffers.has(id)) continue;
    const view = views.get(id);
    if (view) {
      scene.remove(view.root);
      // A view owns the GPU resources it created just for itself -- the fallback capsule's
      // geometry and material, and the loaded model's meshes, textures and clips -- so
      // removing it from the scene alone leaves all of them allocated and a
      // disconnect/rejoin cycle across a match leaks what the GC never reclaims.
      view.dispose();
    }
    views.delete(id);
  }
}

/**
 * Draws every remote player's interpolated pose: one `PlayerView` per live id, holding the
 * armour model (players-view.ts) and falling back to the capsule until -- or unless -- it
 * loads. Position and yaw come from `RemoteBuffer.positionAt`, the discrete inputs the clip
 * choice needs from its `latest()` sample, and both are stamped with the caller's clock.
 */
export function syncRemotePlayers(
  scene: THREE.Scene,
  views: Map<number, PlayerView>,
  buffers: Map<number, RemoteBuffer>,
  nowMs: number,
): void {
  pruneMissing(scene, views, buffers);
  for (const [id, buffer] of buffers) {
    const sample = buffer.latest();
    const pose = buffer.positionAt(nowMs);
    if (!sample || !pose) continue;
    let view = views.get(id);
    if (!view) {
      view = new PlayerView(id);
      scene.add(view.root);
      views.set(id, view);
    }
    view.sync(sample, pose, nowMs);
  }
}
