import { sampleTerrain, type ArmorData, type PlayerInput, type Vec3, type World } from '@clans/sim';
import { findPath, nearestNode, type WaypointGraph } from './waypoints.js';
import type { BotRuntimeState } from './types.js';

export const WAYPOINT_REACHED_RADIUS = 4; // Ours.
export const STUCK_CHECK_TICKS = 60; // Ours.
export const STUCK_MIN_PROGRESS = 1; // Ours, meters.

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
  const needsNewPath =
    runtime.goalKey !== goalKey ||
    runtime.pathIndex >= runtime.path.length ||
    runtime.path.length === 0;
  if (!needsNewPath) return;
  const path = findPath(graph, world, team, from, goal);
  runtime.path = (path ?? [goal]).map((p) => ({ x: p.x, z: p.z }));
  runtime.pathIndex = 0;
  runtime.goalKey = goalKey;
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
  if (checkStuck(runtime, world, currentPosition)) {
    runtime.goalKey = null; // forces ensurePath to repath from the bot's actual position next call
    ensurePath(graph, world, team, runtime, currentPosition, goalPosition, goalKey);
  }
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
