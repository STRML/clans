import {
  GRAVITY,
  raycastInteriors,
  sampleTerrain,
  type ArmorData,
  type PlayerInput,
  type Vec3,
  type World,
} from '@clans/sim';
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

// Issue #32 -- the graph's edges and findPath's final leg are now interior-validated at
// build/route time, but a route is only as straight-line clean as its weakest sample:
// a moving goal (a carried flag, an escort target) re-pathes straight at wherever it is
// NOW, and a bot mid-corridor can still face a wall no graph edge ever crossed. Before
// committing each tick's movement direction, steering probes it against real interiors
// and deflects along the first clear candidate -- local wall-slide, not a navmesh.
const AVOIDANCE_PROBE_DISTANCE = 4; // Ours, meters: ~two bot radii past the nose, far
// enough that a deflection chosen at the wall's face is still valid for a few ticks.
const AVOIDANCE_PROBE_HEIGHT = 1.2; // Ours, meters above feet: chest height -- low
// enough to step over sills/ramp lips, high enough that walls and shed sides block it.
// Alternating left/right, widening to a full about-face; every candidate is probed
// against the same interiors the sim's own movement resolves against.
const AVOIDANCE_DEFLECTIONS_DEG = [40, -40, 80, -80, 120, -120, 180]; // Ours.
// How far a stuck-skip escape goal sits from the approach line -- bigger than
// WAYPOINT_REACHED_RADIUS so the escape point is a real intermediate waypoint, small
// enough that the escape hugs the local wall instead of aborting the approach entirely.
export const STUCK_ESCAPE_OFFSET_M = 12; // Ours, meters.
// A blocked direction with the goal this much ABOVE the bot is worth jets: the classic
// Katabatic case is the base deck and its approaches, where the straight route ends at
// a lip rather than a dead wall -- measured deck lips sit ~1.2 m above the approach
// terrain (team 2's stand: approach y 88.4 vs deck 89.6), so the gate must clear that.
const CLIMB_JET_MIN_RISE_M = 1; // Ours, meters.
// Crawl detection: under this per-tick displacement (vs a ~10 m/s run, ~0.3 m/tick) the
// bot is pinned by geometry, not just climbing slowly; this many consecutive pinned
// ticks (~1/3 s) trigger one hurdle jump. Long enough that a single slow frame or a
// bump against a teammate doesn't fire it, short enough to clear a lip before the
// 60-tick stall window ever sees the pinning.
const CRAWL_MAX_STEP_M = 0.15; // Ours, meters per tick.
const CRAWL_JUMP_TICKS = 10; // Ours, ticks.
// Altitude tolerance across consecutive pinned jumps: more than this and the jump
// sequence is gaining height (a live climb), not wedged under something.
const CRAWL_ALT_GAIN_M = 0.5; // Ours, meters.
// Goal rise that turns "wedged under geometry" into "skip this waypoint": the base
// decks and deck-level rooms this targets sit 4-17 m above the crawlspaces bots fall
// into; a mountable lip is 1-3 m and never trips this.
const UNDER_FLOOR_MIN_RISE_M = 4; // Ours, meters.
// Under-floor skips tolerated before arming the jet-escape: one skip may be a single
// bad waypoint in a route the next one fixes; consecutive skips mean the repath loop
// is not converging.
const UNDER_FLOOR_JET_SKIPS = 2; // Ours.
// How long the jet-escape holds thrust: at LIGHT's ~26 m/s^2 jet force minus gravity,
// ~1.6 s climbs several meters -- enough to rise back through a fall-in hole without
// dumping the whole energy pool (the energy floor guard below still bounds the drain).
const ESCAPE_JET_TICKS = 50; // Ours, ticks.

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

/** Rotates an (assumed unit-length) x/z direction around the vertical axis by `degrees`.
 *  Named for the formula it carries -- the standard y-rotation for a left-handed y-up
 *  frame -- rather than for any behavior a reader could skip. */
function rotateXZDirection(direction: Vec3, degrees: number): Vec3 {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: direction.x * cos + direction.z * sin,
    y: 0,
    z: -direction.x * sin + direction.z * cos,
  };
}

function directionClearOfInteriors(world: World, origin: Vec3, direction: Vec3): boolean {
  return raycastInteriors(world.interiors, origin, direction, AVOIDANCE_PROBE_DISTANCE) === null;
}

/** Issue #32: returns `direction` unchanged when the straight probe is clear; otherwise
 *  the first deflected candidate that is clear, with hysteresis -- once a deflection is
 *  chosen it is re-tried FIRST on every subsequent blocked tick (see
 *  BotRuntimeState.avoidDeflectionDeg), because re-evaluating all candidates fresh every
 *  tick lets a bot oscillate between +40 and -40 at a wall face it should be walking
 *  along. When nothing is clear the bot is truly boxed in; it keeps pressing (the sim's
 *  own collision resolution holds it in place) and the stuck escalation below owns the
 *  recovery. Only ever called with world.interiors possibly non-empty -- on an
 *  interior-less world raycastInteriors returns null and this is a straight pass-through,
 *  so the flat-terrain tests' behavior is unchanged. */
function avoidInteriors(
  world: World,
  runtime: BotRuntimeState,
  currentPosition: Vec3,
  direction: Vec3,
): Vec3 {
  if (world.interiors.length === 0) return direction;
  const origin = {
    x: currentPosition.x,
    y: currentPosition.y + AVOIDANCE_PROBE_HEIGHT,
    z: currentPosition.z,
  };
  if (directionClearOfInteriors(world, origin, direction)) {
    runtime.avoidDeflectionDeg = 0;
    return direction;
  }
  const previous = runtime.avoidDeflectionDeg;
  const candidates =
    previous !== 0
      ? [previous, ...AVOIDANCE_DEFLECTIONS_DEG.filter((deg) => deg !== previous)]
      : AVOIDANCE_DEFLECTIONS_DEG;
  for (const degrees of candidates) {
    const deflected = rotateXZDirection(direction, degrees);
    if (directionClearOfInteriors(world, origin, deflected)) {
      runtime.avoidDeflectionDeg = degrees;
      return deflected;
    }
  }
  return direction;
}

/** Issue #32: simple slope read rather than the spec's own "nav cost function rewards
 *  descent": samples terrain height a short probe distance ahead along the movement
 *  heading and compares it to the current height. Downhill beyond the armor's own
 *  runSurfaceAngle-adjacent slope -> ski (hold jump); steep uphill with energy to spare
 *  -> jet; otherwise neither. */
const SLOPE_PROBE_DISTANCE = 3; // Ours, meters.
/** Fraction of the energy pool slopeAssist refuses to spend on climbing. The production
 *  #32 carrier traces show the kill chain: the ~190 m central-ridge climb drains the
 *  pool (the old gate, `minJetEnergy * 2` = 2 of 60, is "always"), the carrier crests
 *  with 2-8 energy, and the far-side descent then launches it at 60-90 m/s with too
 *  little left for fallArrestWanted to matter -- measured deaths at 70% -> 0% health,
 *  `attackerId -1`, mid-route at the ridge. Holding this reserve back costs a little
 *  climb speed (the reserve portion is walked, not jetted) and buys a real arrest on
 *  every convex descent: at the 0.35 floor a Light still carries 21 energy, ~26 ticks
 *  of arrest jets, worth roughly 5 m/s of landing speed. */
const CLIMB_ENERGY_RESERVE_FRACTION = 0.35; // Ours.
/** The same floor for bots NOT carrying a flag. The carrier is the only bot whose
 *  fall-arrest insurance is match-critical: a lone escort or attacker who crests the
 *  ridge empty simply walks the descent and eats a survivable 0.1-0.2 landing hit,
 *  while an escort that reaches the crest FAST stays with the carrier it is guarding --
 *  measured: escorts pacing 7-11 m off their carrier at the enemy base fell 150-260 m
 *  behind crossing the ridge, leaving the carrier alone against the chaser stream
 *  through the whole midfield. Spending down to a token floor closes exactly that gap. */
const NONCARRIER_CLIMB_ENERGY_FRACTION = 0.1; // Ours.

/** True when this bot is carrying the enemy flag -- the walk home is the match's whole
 *  objective and its fall arrest is the scarce resource, so only this bot pays the full
 *  climb reserve. */
function isCarryingFlag(world: World, botId: number): boolean {
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    if (world.flags.carrierId[flagId] === botId) return true;
  }
  return false;
}

/** `reserveFraction` is the caller's climb-energy floor: steerToward passes the full
 *  carrier reserve for a flag carrier and the token non-carrier floor for everyone
 *  else (see the constants above). Kept a parameter, not a world read inside, so the
 *  function stays a pure slope/energy query. */
export function slopeAssist(
  world: World,
  x: number,
  z: number,
  headingYaw: number,
  energy: number,
  armor: ArmorData,
  reserveFraction: number,
): { jump: boolean; jet: boolean } {
  const here = sampleTerrain(world.terrain, x, z);
  const aheadX = x + Math.sin(headingYaw) * SLOPE_PROBE_DISTANCE;
  const aheadZ = z + Math.cos(headingYaw) * SLOPE_PROBE_DISTANCE;
  const ahead = sampleTerrain(world.terrain, aheadX, aheadZ);
  if (here.empty || ahead.empty) return { jump: false, jet: false };
  const drop = here.height - ahead.height; // positive = downhill ahead
  if (drop > 0.5) return { jump: true, jet: false };
  if (drop < -1.5 && energy > armor.maxEnergy * reserveFraction) {
    return { jump: false, jet: true };
  }
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
  // The waypoint y rides along (issue #32): the pocket detector needs to know when the
  // current waypoint stands far overhead -- unreachable by walking -- which raw x/z threw
  // away. Steering still moves on x/z only.
  runtime.path = (path ?? [goal]).map((p) => ({ x: p.x, z: p.z, y: p.y }));
  runtime.pathIndex = 0;
  runtime.goalKey = goalKey;
  runtime.goalPosition = { x: goal.x, z: goal.z };
}

function advancePastReachedWaypoints(
  runtime: BotRuntimeState,
  currentPosition: Vec3,
): { x: number; z: number; y?: number } | undefined {
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

/** Issue #32: the under-deck pocket detector. A waypoint standing far OVERHEAD is not
 *  reachable by walking; give the bot POCKET_WINDOW_TICKS to close most of the 2D gap to
 *  it, and when the gap barely moved, skip the waypoint (applyUnderFloorSkip advances the
 *  path and arms the jet-escape after repeated skips, as before). This replaces the old
 *  requirement that the bot be nearly motionless first: the measured pocket failure had
 *  the carrier ORBITING its overhead waypoint -- displacement well above the crawl floor,
 *  gap oscillating instead of closing -- so every existing ladder stayed silent for 4700
 *  ticks. Legs that are legitimately steep climbs close the gap quickly and are never
 *  skipped; gap closure, not raw movement, is the whole test. */
const POCKET_WINDOW_TICKS = 90; // Ours, ticks (~3 s).
const POCKET_MIN_CLOSURE_M = 4; // Ours, meters of gap closure per window.

function updatePocketState(
  runtime: BotRuntimeState,
  target: { x: number; z: number; y?: number } | undefined,
  targetDistance: number,
  overhead: boolean,
): boolean {
  if (!target || !overhead || runtime.escapeJetTicks > 0) {
    runtime.pocketTicks = 0;
    return false;
  }
  if (runtime.pocketTicks === 0) runtime.pocketBaseGap = targetDistance;
  runtime.pocketTicks += 1;
  if (runtime.pocketTicks < POCKET_WINDOW_TICKS) return false;
  const closed = runtime.pocketBaseGap - targetDistance;
  runtime.pocketTicks = 0;
  return closed < POCKET_MIN_CLOSURE_M;
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
  // Meter-rounded position key, not pathIndex (see BotRuntimeState.stuckTargetKey): on
  // the interior-validated graph two repaths to the same goal legally converge through
  // different relay chains whose post-collapse indices differ, and an index comparison
  // reset the streak every window -- the skip threshold was unreachable exactly at the
  // base structures this issue is about (verified in a production-landmark match: a bot
  // sat wedged at its own base for 44 straight stall windows with the streak frozen at 1).
  const targetKey = `${Math.round(target.x)},${Math.round(target.z)}`;
  if (runtime.stuckTargetKey !== targetKey) {
    // The target changed since the last check (a new waypoint just reached, a repath, or
    // the very first call this goal) -- reset the baseline immediately instead of
    // comparing against a distance measured against a DIFFERENT target, which would
    // misread the change itself as a burst of progress.
    runtime.stuckTargetKey = targetKey;
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
    // Issue #32: the pre-#32 fallback replaced the path with the literal goal -- which is
    // exactly the wall the bot has been wedged against for three straight windows, so the
    // escape re-rammed the same face at full throttle. Steer instead at a point offset
    // PERPENDICULAR to the approach line, alternating sides between skips, then at the
    // goal from the new side: the escape walks the bot ALONG the wall it is stuck on
    // (local avoidance clears the walk), and two consecutive failures probe opposite
    // faces instead of grinding one. Two-point path, not one, so reaching the offset
    // point advances the path to the real goal rather than orbiting the offset forever.
    runtime.stuckSkipSide = runtime.stuckSkipSide === 1 ? -1 : 1;
    const toGoalX = goalPosition.x - currentPosition.x;
    const toGoalZ = goalPosition.z - currentPosition.z;
    const approachLength = Math.hypot(toGoalX, toGoalZ) || 1;
    // Left normal of the approach direction (right-handed y-up), scaled by side.
    const offsetX = (-toGoalZ / approachLength) * STUCK_ESCAPE_OFFSET_M * runtime.stuckSkipSide;
    const offsetZ = (toGoalX / approachLength) * STUCK_ESCAPE_OFFSET_M * runtime.stuckSkipSide;
    runtime.path = [
      { x: currentPosition.x + offsetX, z: currentPosition.z + offsetZ },
      { x: goalPosition.x, z: goalPosition.z },
    ];
    runtime.pathIndex = 0;
    runtime.stuckStreak = 0;
    // Forces the next call's target-change check above to reset the baseline fresh
    // rather than comparing against the OLD target's distance: the escape path starts
    // from a different point and a different first waypoint, so the old baseline's
    // distance says nothing about the escape's progress.
    runtime.stuckTargetKey = '';
    return true;
  }
  runtime.goalKey = null; // forces ensurePath to repath from the bot's actual position next call
  ensurePath(graph, world, team, runtime, currentPosition, goalPosition, goalKey);
  // stuckTargetKey is deliberately NOT reset here (unlike the fallback branch above):
  // a plain repath from an unchanged position to an unchanged goal recomputes the
  // identical route on a static graph, so the converged waypoint is the same target --
  // the streak needs to keep counting across repaths, or it would never reach
  // STUCK_SKIP_THRESHOLD at all (every repath would look like "a new target" and reset
  // it to 0 first). The position-key comparison above keeps this correct even when the
  // recomputed route legally converges through a DIFFERENT relay chain (#32's graph):
  // a different chain ending at the same waypoint is still the same target.
  return true;
}

/** Result of the per-tick pinning ladder: whether this tick's jump is a hurdle jump,
 *  whether the ladder decided the bot is under unreachable floor (skip the waypoint),
 *  and whether a jet-escape window is currently open. */
interface PinVerdict {
  hurdleJump: boolean;
  underFloorSkip: boolean;
  escaping: boolean;
  /** Set by steerToward after local avoidance runs: the straight probe was blocked and
   *  a deflection is active this tick. Lives here so the vertical-input helpers below
   *  see one snapshot of the tick's navigation state. */
  deflected: boolean;
}
/** Issue #32: measure pinning against the PREVIOUS call's position, before anything
 *  else touches movement -- a bot can be physically wedged (feet sphere against a lip)
 *  while every probe and stall window above still reads healthy. Advances the
 *  crawl/pin/escape state machine and reports this tick's verdict. */
function updatePinState(
  runtime: BotRuntimeState,
  currentPosition: Vec3,
  targetDistance: number,
  goalPosition: Vec3,
): PinVerdict {
  const escaping = advanceEscapeWindow(runtime);
  if (escaping)
    return { hurdleJump: false, underFloorSkip: false, escaping: true, deflected: false };
  const moved =
    runtime.lastSteerPosition === null
      ? Infinity
      : Math.hypot(
          currentPosition.x - runtime.lastSteerPosition.x,
          currentPosition.z - runtime.lastSteerPosition.z,
        );
  runtime.lastSteerPosition = { x: currentPosition.x, z: currentPosition.z };
  const pinned = moved < CRAWL_MAX_STEP_M && targetDistance > WAYPOINT_REACHED_RADIUS;
  if (!pinned) {
    // Free movement: the pocket escape (if any was in progress) succeeded or the bot
    // was never pinned; the whole pinning ladder resets.
    runtime.crawlTicks = 0;
    runtime.crawlBaseY = -1;
    runtime.underFloorSkips = 0;
    return { hurdleJump: false, underFloorSkip: false, escaping: false, deflected: false };
  }
  runtime.crawlTicks += 1;
  if (runtime.crawlTicks < CRAWL_JUMP_TICKS) {
    return { hurdleJump: false, underFloorSkip: false, escaping: false, deflected: false };
  }
  runtime.crawlTicks = 0;
  const underFloorSkip = classifyHurdleJump(runtime, currentPosition, goalPosition);
  if (underFloorSkip) applyUnderFloorSkip(runtime);
  return { hurdleJump: true, underFloorSkip, escaping: false, deflected: false };
}

/** Consumes one tick of an open jet-escape window, if any. */
function advanceEscapeWindow(runtime: BotRuntimeState): boolean {
  if (runtime.escapeJetTicks <= 0) return false;
  runtime.escapeJetTicks -= 1;
  runtime.crawlTicks = 0;
  return true;
}

/** Issue #32: a pinned jump that gains no altitude, twice in a row, with the goal far
 *  overhead, means the bot is under the floor/walkway its 2D path crossed -- hopping
 *  harder is not going to help. A genuine altitude gain resets the baseline instead --
 *  that is a climb in progress, e.g. mounting a deck lip, which the next jump should
 *  continue. */
function classifyHurdleJump(
  runtime: BotRuntimeState,
  currentPosition: Vec3,
  goalPosition: Vec3,
): boolean {
  if (runtime.crawlBaseY < 0) {
    runtime.crawlBaseY = currentPosition.y;
    return false;
  }
  if (Math.abs(currentPosition.y - runtime.crawlBaseY) > CRAWL_ALT_GAIN_M) {
    runtime.crawlBaseY = currentPosition.y;
    return false;
  }
  return goalPosition.y - currentPosition.y > UNDER_FLOOR_MIN_RISE_M;
}

/** Skips the unreachable waypoint and, when the skips stop converging (the repath loop
 *  keeps diving back into the floor above -- the bot fell through a hole into a space
 *  with no graph nodes), arms the jet-escape: hold jets and climb back out the way it
 *  fell in -- the hole is the one opening it knows is overhead. */
function applyUnderFloorSkip(runtime: BotRuntimeState): void {
  runtime.crawlBaseY = -1;
  runtime.pathIndex += 1;
  if (runtime.pathIndex >= runtime.path.length) runtime.goalKey = null;
  runtime.underFloorSkips += 1;
  if (runtime.underFloorSkips >= UNDER_FLOOR_JET_SKIPS) {
    runtime.escapeJetTicks = ESCAPE_JET_TICKS;
    runtime.underFloorSkips = 0;
  }
}

/** Issue #32: a deflected (wall-blocked) approach with the goal meaningfully overhead
 *  is the base-deck/ramp-parapet shape -- hold jets to gain height along the wall until
 *  either the probe clears or the energy floor (same guard slopeAssist uses) stops the
 *  climb. On flat goals this never fires: the rise test gates it. */
function climbJetWanted(
  pin: PinVerdict,
  goalPosition: Vec3,
  currentPosition: Vec3,
  armor: ArmorData,
  energy: number,
): boolean {
  return (
    pin.deflected &&
    goalPosition.y - currentPosition.y > CLIMB_JET_MIN_RISE_M &&
    energy > armor.minJetEnergy * 2
  );
}

/** Issue #32: fall damage is the single biggest carrier killer on real Katabatic -- in a
 *  12k-tick seed-1 production match every carrier death was `attackerId -1`, and the
 *  damage ledger shows the shape: cumulative landing hits of 0.05-0.29 at landing speeds
 *  of 30-90 m/s as the route launches off convex ridge rolls and deck lips at ski speed.
 *  No enemy ever landed the killing blow on a carrier in that trace. Landing speed is the
 *  whole story (applyFallDamage: (landingSpeed - minJumpSpeed) * speedDamageScale), and a
 *  jet is worth +jetForce/mass - GRAVITY ~= 6 m/s of impact-speed reduction per second,
 *  so jetting the fall takes the 0.1-0.2 hits off the board even when it cannot fully
 *  arrest a 90 m/s ridge drop. Predicts the landing speed from the current vertical
 *  velocity plus the measured height above terrain, and only spends energy when that
 *  prediction clears the damage-free landing speed by a real margin -- hops and short
 *  skis (the ski hop's whole point) never trigger it, so energy stays available for
 *  climbing and combat. Terrain-height based: over a base interior it reads the ground
 *  UNDER the building, overestimating the fall -- the safe direction, and the base decks
 *  are exactly where un-arrested drops hurt. */
const FALL_ARREST_VY = -10; // Ours, m/s: rising or near-apex falls need no help.
const FALL_ARREST_MIN_HEIGHT_M = 6; // Ours, meters: anything shorter lands before jets matter.
// Predicted landings above minJumpSpeed * this get jets: minJumpSpeed is the exact
// damage-free landing speed, so 1.3x tolerates cosmetic hop damage (0.02-0.04) while
// catching the 0.1+ falls that actually kill carriers over a 1 km return.
const FALL_ARREST_IMPACT_FACTOR = 1.3; // Ours.

function fallArrestWanted(
  world: World,
  botId: number,
  currentPosition: Vec3,
  armor: ArmorData,
  energy: number,
): boolean {
  if (world.players.onGround[botId] === 1) return false;
  const vy = world.players.velocity[botId * 3 + 1] ?? 0;
  if (vy > FALL_ARREST_VY) return false;
  const ground = sampleTerrain(world.terrain, currentPosition.x, currentPosition.z);
  if (ground.empty) return false;
  const height = currentPosition.y - (ground.height ?? 0);
  if (height < FALL_ARREST_MIN_HEIGHT_M) return false;
  const predictedImpact = Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(0, height));
  return (
    predictedImpact > armor.minJumpSpeed * FALL_ARREST_IMPACT_FACTOR &&
    energy > armor.minJetEnergy * 2
  );
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
  // botId drives fall arrest (issue #32): the ground-contact and vertical-velocity reads
  // it needs are per-bot world-store reads, not path inputs.
  ensurePath(graph, world, team, runtime, currentPosition, goalPosition, goalKey);
  // Resolve pathIndex to the real current target BEFORE handleStuck measures progress
  // against it -- otherwise handleStuck would read the stale, not-yet-collapsed index a
  // fresh path or repath always starts at (0), permanently one call behind the target
  // advancePastReachedWaypoints's own collapsing loop just settled on.
  advancePastReachedWaypoints(runtime, currentPosition);
  handleStuck(graph, world, team, runtime, goalPosition, goalKey, currentPosition);
  const target = advancePastReachedWaypoints(runtime, currentPosition);
  const targetDistance =
    target === undefined
      ? Infinity
      : Math.hypot(currentPosition.x - target.x, currentPosition.z - target.z);
  const pin = updatePinState(runtime, currentPosition, targetDistance, goalPosition);
  // Issue #32: a waypoint far overhead whose 2D gap stopped closing is an under-deck
  // pocket -- skip it regardless of how much the bot is moving (the measured failure had
  // the carrier orbiting, not frozen). Runs after the pin ladder, never mid-escape.
  const overhead = (target?.y ?? 0) - currentPosition.y > UNDER_FLOOR_MIN_RISE_M;
  const pocketSkip = updatePocketState(runtime, target, targetDistance, overhead && !pin.escaping);
  if (pocketSkip) applyUnderFloorSkip(runtime);
  if (!target || pocketSkip) return holdInput(pin.escaping);
  const dx = target.x - currentPosition.x,
    dz = target.z - currentPosition.z;
  const length = Math.hypot(dx, dz) || 1;
  const straight = { x: dx / length, y: 0, z: dz / length };
  // Issue #32: probe the straight direction against real interiors before committing.
  // The deflected result drives BOTH the movement frame and the heading below -- a bot
  // sliding along a wall should face along its motion, the same as it would in the open.
  const direction = avoidInteriors(world, runtime, currentPosition, straight);
  pin.deflected = runtime.avoidDeflectionDeg !== 0;
  const headingYaw = Math.atan2(direction.x, direction.z);
  const slope = slopeAssist(
    world,
    currentPosition.x,
    currentPosition.z,
    headingYaw,
    energy,
    armor,
    isCarryingFlag(world, runtime.playerId)
      ? CLIMB_ENERGY_RESERVE_FRACTION
      : NONCARRIER_CLIMB_ENERGY_FRACTION,
  );
  const fallArrest = fallArrestWanted(world, runtime.playerId, currentPosition, armor, energy);
  const { moveX, moveZ } = worldDirectionToLocalMove(direction, headingYaw);
  return {
    moveX,
    moveZ,
    headingYaw,
    ...jumpJetFor(slope, pin, fallArrest, goalPosition, currentPosition, armor, energy),
  };
}

/** No usable waypoint this tick (path exhausted, or the under-floor skip just advanced
 *  past it): stand still except for any open jet-escape window. */
function holdInput(escaping: boolean): Partial<PlayerInput> & { headingYaw: number } {
  return { moveX: 0, moveZ: 0, jump: false, jet: escaping, headingYaw: 0 };
}

/** Vertical inputs for this tick: terrain slope assist plus the #32 ladder (hurdle
 *  jumps, open jet-escape windows, deck-parapet climb jets) plus fall arrest. An active
 *  fall arrest owns the tick's vertical inputs: it forces jets (you cannot climb and
 *  arrest a fall at once, and the arrest is the more urgent of the two) and suppresses
 *  jump -- a held jump does nothing airborne except schedule the landing ski-hop, and
 *  that hop re-launches the very fall the arrest just spent energy softening. */
function jumpJetFor(
  slope: { jump: boolean; jet: boolean },
  pin: PinVerdict,
  fallArrest: boolean,
  goalPosition: Vec3,
  currentPosition: Vec3,
  armor: ArmorData,
  energy: number,
): { jump: boolean; jet: boolean } {
  const climbJet = climbJetWanted(pin, goalPosition, currentPosition, armor, energy);
  return {
    jump: fallArrest ? false : slope.jump || pin.hurdleJump || pin.escaping,
    jet:
      slope.jet ||
      climbJet ||
      pin.escaping ||
      fallArrest ||
      (pin.hurdleJump && energy > armor.minJetEnergy * 2),
  };
}

export { nearestNode };
