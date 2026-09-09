import { sampleTerrain, type ArmorData, type PlayerInput, type Vec3, type World } from '@clans/sim';
import { findPath, nearestNode, type WaypointGraph } from './waypoints.js';
import type { BotRuntimeState } from './types.js';

export const WAYPOINT_REACHED_RADIUS = 4; // Ours.
export const STUCK_CHECK_TICKS = 60; // Ours.
export const STUCK_MIN_PROGRESS = 1; // Ours, meters.
// Codex review round 3, finding (P1): the coarse waypoint graph's edges carry no terrain
// or collision awareness (Task 2's own explicit scope -- "no full navmesh"), so a single
// edge that happens to cross a wall, a cliff, or any other real 3D obstacle a 2D
// straight-line edge can't see leaves a bot stuck: repathing from the same position to the
// same goal recomputes the identical unreachable route every time. A real production run
// against the full landmark graph (every spawn, flag stand, and base object) found a bot
// frozen at one such waypoint for the rest of a 5,000-tick match. After this many
// consecutive stuck detections against the same waypoint, skip it and try the next node in
// the already-computed path instead of retrying the identical route -- bounded resilience,
// not a navmesh.
export const STUCK_SKIP_THRESHOLD = 3; // Ours.
// Ours -- bigger than WAYPOINT_REACHED_RADIUS (4 m), small enough that a carrier or
// chased flag moving even a few strides forces a fresh path, not just a full waypoint's
// worth of drift. Closes #33: an escort/flag-chase goalKey (e.g. `escort:4`) never
// changes just because the target moved, so without this the path keeps heading toward
// wherever the target was on the FIRST steerToward call for that goalKey.
export const GOAL_DRIFT_REPATH_M = 6; // Ours.

/** Projects a world-space unit direction onto the yaw-relative forward/right frame
 *  movement.ts's own desiredVelocity uses (forward = (sin yaw, 0, cos yaw), right =
 *  (-cos yaw, 0, sin yaw)) -- the inverse of that construction, so a bot can hold a yaw
 *  aimed at an enemy while still strafing toward a waypoint that isn't directly ahead. */
export function worldDirectionToLocalMove(
  direction: Vec3,
  yaw: number,
): { moveX: number; moveZ: number } {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const forwardX = sin,
    forwardZ = cos;
  const rightX = -cos,
    rightZ = sin;
  return {
    moveZ: direction.x * forwardX + direction.z * forwardZ,
    moveX: direction.x * rightX + direction.z * rightZ,
  };
}

/** Ours, simple slope read rather than the spec's own "nav cost function rewards
 *  descent": samples terrain height a short probe distance ahead along the movement
 *  heading and compares it to the current height. Downhill beyond the armor's own
 *  runSurfaceAngle-adjacent slope -> ski (hold jump); steep uphill with energy to spare
 *  -> jet; otherwise neither. */
const SLOPE_PROBE_DISTANCE = 3; // Ours, meters.

export function slopeAssist(
  world: World,
  x: number,
  z: number,
  headingYaw: number,
  energy: number,
  armor: ArmorData,
): { jump: boolean; jet: boolean } {
  const here = sampleTerrain(world.terrain, x, z);
  const aheadX = x + Math.sin(headingYaw) * SLOPE_PROBE_DISTANCE;
  const aheadZ = z + Math.cos(headingYaw) * SLOPE_PROBE_DISTANCE;
  const ahead = sampleTerrain(world.terrain, aheadX, aheadZ);
  if (here.empty || ahead.empty) return { jump: false, jet: false };
  const drop = here.height - ahead.height; // positive = downhill ahead
  if (drop > 0.5) return { jump: true, jet: false };
  if (drop < -1.5 && energy > armor.minJetEnergy * 2) return { jump: false, jet: true };
  return { jump: false, jet: false };
}

/** Resets (and reports false) whenever the goal changed since the last check -- a fresh
 *  goal always gets a fresh baseline, never inherits a stale one from a previous, now-
 *  abandoned goal. Reports true, and immediately resets its own baseline to the CURRENT
 *  tick/position (failure matrix row 17), once STUCK_CHECK_TICKS have passed with less
 *  than STUCK_MIN_PROGRESS of net movement from the baseline. */
export function checkStuck(
  runtime: BotRuntimeState,
  world: Pick<World, 'tick'>,
  currentPosition: Vec3,
): boolean {
  const elapsed = world.tick - runtime.stuckBaselineTick;
  if (elapsed < STUCK_CHECK_TICKS) {
    if (elapsed < 0) {
      runtime.stuckBaselineTick = world.tick;
      runtime.stuckBaselinePosition = { x: currentPosition.x, z: currentPosition.z };
    }
    return false;
  }
  const progress = Math.hypot(
    currentPosition.x - runtime.stuckBaselinePosition.x,
    currentPosition.z - runtime.stuckBaselinePosition.z,
  );
  const stuck = progress < STUCK_MIN_PROGRESS;
  runtime.stuckBaselineTick = world.tick;
  runtime.stuckBaselinePosition = { x: currentPosition.x, z: currentPosition.z };
  return stuck;
}

function ensurePath(
  graph: WaypointGraph,
  world: World,
  team: number,
  runtime: BotRuntimeState,
  from: Vec3,
  goal: Vec3,
  goalKey: string,
): void {
  const drifted =
    runtime.goalPosition !== null &&
    Math.hypot(runtime.goalPosition.x - goal.x, runtime.goalPosition.z - goal.z) >
      GOAL_DRIFT_REPATH_M;
  const needsNewPath =
    runtime.goalKey !== goalKey ||
    runtime.pathIndex >= runtime.path.length ||
    runtime.path.length === 0 ||
    drifted;
  if (!needsNewPath) return;
  const path = findPath(graph, world, team, from, goal);
  runtime.path = (path ?? [goal]).map((p) => ({ x: p.x, z: p.z }));
  runtime.pathIndex = 0;
  runtime.goalKey = goalKey;
  runtime.goalPosition = { x: goal.x, z: goal.z };
}

function advancePastReachedWaypoints(
  runtime: BotRuntimeState,
  currentPosition: Vec3,
): { x: number; z: number } | undefined {
  let target = runtime.path[runtime.pathIndex];
  while (
    target &&
    Math.hypot(currentPosition.x - target.x, currentPosition.z - target.z) <
      WAYPOINT_REACHED_RADIUS &&
    runtime.pathIndex < runtime.path.length - 1
  ) {
    runtime.pathIndex += 1;
    target = runtime.path[runtime.pathIndex];
  }
  return target;
}

/** Bypasses the graph entirely once stuck STUCK_SKIP_THRESHOLD times in a row against the
 *  same goal: repathing from the same position to the same goal only recomputes the
 *  identical route (a coarse graph's edges carry no terrain/collision awareness -- Task
 *  2's own explicit scope), so a skip within that same route can land on another equally
 *  unreachable node. Steering straight at the literal goal is the same fallback
 *  `ensurePath` already uses when `findPath` finds no route at all -- reusing it here
 *  means a bot that the graph can't route escapes the loop instead of cycling through it
 *  forever. `goalKey` is left unchanged (not the fabricated single-node path itself), so
 *  the very next real goal change still triggers a normal repath through `ensurePath`.
 *  Returns true if it acted -- the caller should not also repath the same tick. Resets
 *  the streak on a genuine, non-stuck tick. */
function handleStuck(
  graph: WaypointGraph,
  world: World,
  team: number,
  runtime: BotRuntimeState,
  goalPosition: Vec3,
  goalKey: string,
  currentPosition: Vec3,
): boolean {
  // Codex review round 3, finding (P1): checkStuck's own progress metric is raw
  // displacement from a baseline world position, which a bot bouncing/skiing in a small
  // area (real Katabatic terrain -- a step, a slope, a doorway threshold) can satisfy
  // every STUCK_CHECK_TICKS window without ever getting closer to its actual target.
  // Verified directly against a real production run: a bot sat within a few meters of its
  // target for 20,000 ticks (640 s) with checkStuck never once reporting stuck. Feeding
  // checkStuck the scalar distance-to-target instead of the real world position reuses its
  // exact existing, already-tested progress-window logic to measure what actually matters
  // -- "did the gap to the current waypoint shrink" -- without changing its signature or
  // its own unit tests at all.
  const target = runtime.path[runtime.pathIndex];
  if (!target) return false;
  const distanceToTarget = Math.hypot(currentPosition.x - target.x, currentPosition.z - target.z);
  if (runtime.stuckTargetIndex !== runtime.pathIndex) {
    // The target changed since the last check (a new waypoint just reached, a repath, or
    // the very first call this goal) -- reset the baseline immediately instead of
    // comparing against a distance measured against a DIFFERENT target, which would
    // misread the change itself as a burst of progress.
    runtime.stuckTargetIndex = runtime.pathIndex;
    runtime.stuckBaselineTick = world.tick;
    runtime.stuckBaselinePosition = { x: distanceToTarget, z: 0 };
    runtime.stuckStreak = 0;
    return false;
  }
  const elapsed = world.tick - runtime.stuckBaselineTick;
  if (!checkStuck(runtime, world, { x: distanceToTarget, y: 0, z: 0 })) {
    // A false result before the next check window is not progress. Resetting here erased
    // the streak on the tick immediately after every detected stall, so the configured
    // consecutive-stall threshold was unreachable during normal per-tick stepping.
    // checkStuck resets its baseline only after a completed window; that is the one case
    // where false means the bot made enough progress and should earn a fresh streak.
    if (elapsed >= STUCK_CHECK_TICKS) runtime.stuckStreak = 0;
    return false;
  }
  runtime.stuckStreak += 1;
  if (runtime.stuckStreak >= STUCK_SKIP_THRESHOLD) {
    runtime.path = [{ x: goalPosition.x, z: goalPosition.z }];
    runtime.pathIndex = 0;
    runtime.stuckStreak = 0;
    // Forces the next call's target-change check above to reset the baseline fresh
    // rather than comparing against the OLD target's distance under a coincidentally
    // identical pathIndex (both this fallback and the pre-fallback path can land on
    // index 0).
    runtime.stuckTargetIndex = -1;
    return true;
  }
  runtime.goalKey = null; // forces ensurePath to repath from the bot's actual position next call
  ensurePath(graph, world, team, runtime, currentPosition, goalPosition, goalKey);
  // stuckTargetIndex is deliberately NOT reset here (unlike the fallback branch below):
  // a plain repath from an unchanged position to an unchanged goal recomputes the
  // identical route on a static graph, so pathIndex converges back to the same target --
  // the streak needs to keep counting across repaths, or it would never reach
  // STUCK_SKIP_THRESHOLD at all (every repath would look like "a new target" and reset
  // it to 0 first).
  return true;
}

/** Advances along the current path, repathing on a stale/exhausted path, a changed
 *  goal, or a detected stall (failure matrix row 17). Returns only movement fields --
 *  yaw is decided once, by brain.ts, shared with combat aim (Global Constraints). */
export function steerToward(
  graph: WaypointGraph,
  world: World,
  team: number,
  runtime: BotRuntimeState,
  botId: number,
  goalPosition: Vec3,
  goalKey: string,
  currentPosition: Vec3,
  armor: ArmorData,
  energy: number,
): Partial<PlayerInput> & { headingYaw: number } {
  void botId; // The bot's own id doesn't change the path -- kept for interface symmetry with combat.ts/brain.ts.
  ensurePath(graph, world, team, runtime, currentPosition, goalPosition, goalKey);
  // Resolve pathIndex to the real current target BEFORE handleStuck measures progress
  // against it -- otherwise handleStuck would read the stale, not-yet-collapsed index a
  // fresh path or repath always starts at (0), permanently one call behind the target
  // advancePastReachedWaypoints's own collapsing loop just settled on.
  advancePastReachedWaypoints(runtime, currentPosition);
  handleStuck(graph, world, team, runtime, goalPosition, goalKey, currentPosition);
  const target = advancePastReachedWaypoints(runtime, currentPosition);
  if (!target) return { moveX: 0, moveZ: 0, jump: false, jet: false, headingYaw: 0 };
  const dx = target.x - currentPosition.x,
    dz = target.z - currentPosition.z;
  const length = Math.hypot(dx, dz) || 1;
  const direction = { x: dx / length, y: 0, z: dz / length };
  const headingYaw = Math.atan2(direction.x, direction.z);
  const { jump, jet } = slopeAssist(
    world,
    currentPosition.x,
    currentPosition.z,
    headingYaw,
    energy,
    armor,
  );
  const { moveX, moveZ } = worldDirectionToLocalMove(direction, headingYaw);
  return { moveX, moveZ, jump, jet, headingYaw };
}

export { nearestNode };
