import * as THREE from 'three';
import { FIXED_TICK_MS, type PlayerSnapshotData } from '@clans/sim';
import { SNAPSHOT_EVERY_N_TICKS } from '@clans/protocol';
import { PlayerView } from './players-view.js';

export const INTERP_DELAY_MS = 100;
/** The snapshot cadence itself: the server sends one every SNAPSHOT_EVERY_N_TICKS ticks
 *  (server/src/net.ts). 64 ms at the sim's 32 ms tick. */
const SNAPSHOT_INTERVAL_MS = FIXED_TICK_MS * SNAPSHOT_EVERY_N_TICKS;
/** How long a remote's pose may be carried on its last known velocity past the last sample
 *  that actually moved it. Not a tuning knob: it has to cover the longest silence the
 *  server's own relevance policy can leave in a player's stream. A player beyond
 *  RELEVANCE_RADIUS_M is resent from the server's stale copy -- a position identical to the
 *  one already on the wire (server/src/snapshot-policy.ts's DISTANT_PLAYER_UPDATE_EVERY), so
 *  its position changes only every 4 snapshots, 256 ms -- plus one snapshot interval of
 *  slack for a sample that arrives after the render time has already crossed it. Past this
 *  the pose freezes rather than gliding on forever from a connection that has gone quiet,
 *  3.8 m at the 12 m/s a bot skies at. */
export const MAX_EXTRAPOLATE_MS = SNAPSHOT_INTERVAL_MS * 4 + SNAPSHOT_INTERVAL_MS; // 320 ms
/** Two samples this close are the same position on the wire, not movement: the server's
 *  stale-copy resend for a distant player repeats the float32s bit for bit. The tolerance
 *  is there for a player creeping slower than 15 cm/s, which no amount of interpolation or
 *  dead reckoning can tell apart from standing still anyway. */
const REPEAT_EPSILON_M = 0.01;
/** Time constant for relaxing the residual described on RemoteBuffer.correction. Long enough
 *  that a corrected pose never moves faster than a skiing player does, short enough that the
 *  correction is invisible: at 120 ms the residual is down to 5% after 0.36 s. */
const CORRECTION_TAU_MS = 200;
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
  /** Whether this sample carried position information of its own: a repeated copy of the
   *  previous one (see REPEAT_EPSILON_M) did not, and says nothing about where the player
   *  is between them. */
  fresh: boolean;
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

/** The newest sample at or before `sample` that carried motion of its own -- the sample a
 *  repeated-copy run has to be dead-reckoned from. Undefined when the history has already
 *  trimmed past it, which leaves the caller with the repeat itself. */
function freshAnchor(samples: RemoteSample[], sample: RemoteSample): RemoteSample | undefined {
  let anchor: RemoteSample | undefined;
  for (const candidate of samples) {
    if (!candidate.fresh) continue;
    anchor = candidate;
    if (candidate === sample) break;
  }
  return anchor;
}

function poseFromSample(sample: RemoteSample | undefined): RemotePose {
  return {
    x: sample?.data.x ?? 0,
    y: sample?.data.y ?? 0,
    z: sample?.data.z ?? 0,
    yaw: sample?.data.yaw ?? 0,
  };
}

/** Yaw taken the short way round. A bot's heading comes off an atan2 (bots/src/steering.ts
 *  computes it from the route direction, combat.ts from the aim vector), so it wraps at the
 *  +/-PI seam; lerping the raw difference spun the model the long way round -- 2.09 rad in
 *  one 16.7 ms frame of the measured runs, against the 0.016 rad a bot actually turns in a
 *  snapshot -- every time a course crossed the seam. The short way is safe for a human's own
 *  yaw, which accumulates without a wrap (input.ts): the shortest arc between two samples one
 *  snapshot apart is never the long way round at any speed a player can turn. */
function lerpYaw(before: number, after: number, t: number): number {
  const delta = Math.atan2(Math.sin(after - before), Math.cos(after - before));
  return before + delta * t;
}

function lerpPose(before: RemoteSample, after: RemoteSample, renderTime: number): RemotePose {
  const t = Math.max(0, Math.min(1, (renderTime - before.atMs) / (after.atMs - before.atMs)));
  return {
    x: before.data.x + (after.data.x - before.data.x) * t,
    y: before.data.y + (after.data.y - before.data.y) * t,
    z: before.data.z + (after.data.z - before.data.z) * t,
    yaw: lerpYaw(before.data.yaw, after.data.yaw, t),
  };
}

export class RemoteBuffer {
  private samples: RemoteSample[] = [];
  /** The gap between where the newest data says the player is and where the last few frames
   *  drew them: the error a repeated-copy run or a stalled stream accumulated while dead
   *  reckoning, held here instead of applied as one jump and relaxed away over
   *  CORRECTION_TAU_MS. Measured on the same runs as the rest of this file, correcting the
   *  pose in a single frame cost 0.18 m of visible step at the 64 ms cadence and 2.35 m after
   *  a stalled stream, for a player the sim had been reporting at 12 m/s; relaxed over the
   *  time constant below, every frame of the correction stays within the movement the player
   *  was actually making. */
  private correction: RemotePose = { x: 0, y: 0, z: 0, yaw: 0 };
  /** The render time of the last pose handed out, and the render time the correction has
   *  been relaxed up to. Both start unset: nothing has been drawn, so there is nothing to
   *  keep continuous, and no elapsed render time to relax over. */
  private renderedAtMs = Number.NEGATIVE_INFINITY;
  private correctedAtMs = Number.NEGATIVE_INFINITY;

  push(atMs: number, data: PlayerSnapshotData): void {
    const previous = this.samples.at(-1);
    // A jump this large is a teleport (respawn, or a reused id's new player entirely),
    // not movement: discard the stale history instead of letting interpolate() smear a
    // straight line between two unrelated positions.
    const teleported =
      previous !== undefined && distance(previous.data, data) > TELEPORT_DISTANCE_M;
    // respawnSeq increments on every respawn, including a freed id's first spawn as a new
    // player -- catches the case the distance heuristic alone misses, where a reused id's
    // new spawn happens to land close to the departed player's last position (closes #8).
    const respawned = previous !== undefined && previous.data.respawnSeq !== data.respawnSeq;
    // The pose drawn last frame, from the history as it stands before this sample lands.
    // Sampled here because the push below replaces that history.
    const shown =
      this.renderedAtMs > Number.NEGATIVE_INFINITY ? this.pathAt(this.renderedAtMs) : null;
    // A false "moved" is a repeated stale copy for a distant player, not motion;
    // everything below keys room for classification off `moved` (see interpolate()).
    const moved = previous === undefined || distance(previous.data, data) > REPEAT_EPSILON_M;
    const cut = teleported || respawned;
    if (cut) this.samples.length = 0;
    this.fileSample(atMs, data, moved, cut);
    this.holdPoseStill(shown, cut);
  }

  /** Files one classified sample into (a possibly reset) history: stamp clamping and the
   *  history cap live here, split from push() to hold both under the complexity gate. */
  private fileSample(atMs: number, data: PlayerSnapshotData, moved: boolean, cut: boolean): void {
    // The wire carries one snapshot every SNAPSHOT_INTERVAL_MS -- the server sends on
    // SNAPSHOT_EVERY_N_TICKS ticks -- so two samples stamped closer together than that are
    // the caller's arrival clock, not the server's: app.ts anchors each drained batch's
    // newest sample to the frame it arrived on, and once a stalled socket releases its
    // backlog, two batches one frame apart put two samples that are 64 ms apart *on the
    // wire* 17 ms apart on the clock. Interpolated at face value the player sprints across
    // that segment at 3.8x their real speed and then stands still for the rest of it -- the
    // 0.77 m single-frame step measured in remote.test.ts's stalled-stream case. Keeping the
    // protocol's own spacing instead leaves the segment the same length in render time as it
    // was on the server.
    const last = this.samples.at(-1);
    const stampedAtMs = last ? Math.max(atMs, last.atMs + SNAPSHOT_INTERVAL_MS) : atMs;
    this.samples.push({ atMs: stampedAtMs, data, fresh: moved || cut });
    if (this.samples.length > HISTORY_LENGTH) this.samples.shift();
  }

  /** Keeps the pose continuous across a push: however far this sample moved the path at the
   *  render time already on screen becomes a residual, which positionAt relaxes away instead
   *  of the frame taking it as a jump.
   *
   *  A respawn or a reused id is a cut, not a correction -- the player is somewhere else
   *  entirely, and the whole point of the history reset above is that they appear there at
   *  once -- so that case drops whatever residual was riding instead of carrying it across. */
  private holdPoseStill(shown: RemotePose | null, reset: boolean): void {
    const after = reset ? null : this.pathAt(this.renderedAtMs);
    if (!shown || !after) {
      this.resetCorrection();
      return;
    }
    this.correction.x += shown.x - after.x;
    this.correction.y += shown.y - after.y;
    this.correction.z += shown.z - after.z;
    // The same short-way-round rule lerpYaw uses, for the same reason: the difference
    // between two wrapped yaws is an arc, not a subtraction.
    this.correction.yaw += Math.atan2(
      Math.sin(shown.yaw - after.yaw),
      Math.cos(shown.yaw - after.yaw),
    );
  }

  private resetCorrection(): void {
    this.correction.x = 0;
    this.correction.y = 0;
    this.correction.z = 0;
    this.correction.yaw = 0;
  }

  positionAt(nowMs: number): RemotePose | null {
    const renderTime = nowMs - INTERP_DELAY_MS;
    const pose = this.pathAt(renderTime);
    if (!pose) return null;
    this.relaxCorrection(renderTime);
    this.renderedAtMs = renderTime;
    return {
      x: pose.x + this.correction.x,
      y: pose.y + this.correction.y,
      z: pose.z + this.correction.z,
      yaw: pose.yaw + this.correction.yaw,
    };
  }

  /** The newest raw sample, never interpolated: the discrete half of a remote player's state
   *  (armour, onGround, ski, health, velocity) is logical truth as of the last snapshot and
   *  must not be blended the way position and yaw are. Same split, and the same reasoning, as
   *  vehicle-view.ts's VehicleBuffer.latest. */
  latest(): PlayerSnapshotData | null {
    return this.samples.at(-1)?.data ?? null;
  }

  /** Where the samples on their own put the player at `renderTime`, before any residual is
   *  added back. Kept apart from positionAt so a push can measure how far the newest sample
   *  moved this path. */
  private pathAt(renderTime: number): RemotePose | null {
    const latest = this.samples.at(-1);
    if (!latest) return null;
    // Past the newest sample it is still the newest *moving* sample that has to carry the
    // pose: a repeat's own timestamp says nothing about where the player got to, and
    // switching from the fresh anchor to the repeat the moment the render time crossed it
    // snapped the pose back to the stale position -- 2.00 m in a single frame of the
    // measured runs, with no sample having arrived to explain it.
    const anchor = freshAnchor(this.samples, latest) ?? latest;
    return renderTime >= latest.atMs
      ? this.extrapolate(anchor, renderTime)
      : this.interpolate(renderTime);
  }

  private interpolate(renderTime: number): RemotePose {
    const { before, after } = findBracket(this.samples, renderTime);
    if (!before || !after || before.atMs === after.atMs) return poseFromSample(before ?? after);
    // Interpolating is only meaningful between two samples that each moved the player: a
    // repeated copy's segment is a constant, and rendering it as one is what put a distant
    // player (256 ms between real updates) into a staircase -- 74% of frames rendered frozen
    // and the remaining 25% sprinted at up to 5x the player's own speed to catch up, measured
    // across seeds in remote.test.ts's distant-player case. Dead reckoning from the last
    // sample that did move instead carries the player through the silence at the speed the
    // sim itself reported, and the segment after it -- the repeated copies leading into the
    // next real one -- is measured the same way rather than as a lurch from the stale
    // position, which is why this tests the earlier endpoint too.
    if (before.fresh && after.fresh) return lerpPose(before, after, renderTime);
    return this.extrapolate(freshAnchor(this.samples, before) ?? before, renderTime);
  }

  /** Dead reckoning: the player keeps moving on the velocity of the last sample that
   *  carried motion, for a bounded stretch past it. Used both when the render time has run
   *  past the newest sample at all (a stalled or lossy stream, where the alternative was a
   *  50 ms glide and then a frozen model) and for the repeated-copy runs above. */
  private extrapolate(anchor: RemoteSample, renderTime: number): RemotePose {
    const seconds = Math.min(renderTime - anchor.atMs, MAX_EXTRAPOLATE_MS) / 1000;
    return {
      x: anchor.data.x + anchor.data.vx * seconds,
      y: anchor.data.y + anchor.data.vy * seconds,
      z: anchor.data.z + anchor.data.vz * seconds,
      yaw: anchor.data.yaw,
    };
  }

  /** Decays whatever residual the last push left, by the render time that has passed since
   *  the previous call -- exponential, so the correction is half gone after 83 ms and below
   *  a centimetre of a two metre one within 640 ms, and never arrives as a step of its own. */
  private relaxCorrection(renderTime: number): void {
    const elapsedMs = Math.max(0, renderTime - this.correctedAtMs);
    this.correctedAtMs = renderTime;
    if (elapsedMs === 0) return;
    const factor = Math.exp(-elapsedMs / CORRECTION_TAU_MS);
    this.correction.x *= factor;
    this.correction.y *= factor;
    this.correction.z *= factor;
    this.correction.yaw *= factor;
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
