import type { RandomState } from '@clans/sim';

export enum BotState {
  Idle = 0,
  Attack = 1,
  Defend = 2,
}

export enum BotRole {
  Attacker = 0,
  Defender = 1,
}

// Ours -- see this plan's "ours" numbers table, Task 1. Codex review round 1 flagged this
// against the design spec's own text ("two defenders per team"), which this deliberately
// overrides: an all-defensive-leaning bot team would stalemate the milestone's own
// required proof (Task 11's bot-only match must produce a kill or capture within a bounded
// tick count), so the plan biased toward offense on purpose. Not an oversight -- see the
// plan's own numbers table for the full reasoning.
export const DEFENDER_FRACTION = 0.25;

export interface BotRuntimeState {
  playerId: number;
  role: BotRole;
  state: BotState;
  /** The current waypoint path, world-space x/z only (y is sampled fresh from terrain
   *  each tick by steering.ts, since a stored y can go stale if a base object or a
   *  destroyed structure changes the ground under a queued waypoint). */
  path: Array<{ x: number; z: number }>;
  pathIndex: number;
  /** A cheap key identifying what goal produced `path` (e.g. `flag:1` or `station:4`),
   *  so steering.ts/brain.ts can tell "still the same goal" apart from "goal changed,
   *  repath" without diffing the path array itself. */
  goalKey: string | null;
  /** The world-space x/z of the goal that produced `path`/`goalKey` -- steering.ts's
   *  ensurePath compares this against each call's fresh `goal` to detect drift (an
   *  escort target or a flag carrier that moved) even when `goalKey` itself hasn't
   *  changed, since `goalKey` alone (e.g. `escort:4`) never reflects the target's actual
   *  current position (closes #33). null until the first path is computed. */
  goalPosition: { x: number; z: number } | null;
  aimYaw: number;
  /** Rolled once per fresh target acquisition, not every tick — see combat.ts. */
  aimJitterDeg: number;
  engagedTargetId: number; // -1 = none
  stuckBaselinePosition: { x: number; z: number };
  stuckBaselineTick: number;
  /** Codex review round 3, finding (P1): consecutive stuck detections against the same
   *  waypoint, without an intervening real waypoint reached. The coarse graph's edges
   *  carry no terrain/collision awareness (Task 2's own explicit scope), so a repath from
   *  the same stuck position to the same goal can recompute the identical unreachable
   *  route forever -- see steering.ts's steerToward for what this counter drives once it
   *  crosses STUCK_SKIP_THRESHOLD. */
  stuckStreak: number;
  /** The world-space key ("x,z", meter-rounded) of the waypoint the stuck baseline was
   *  last measured against. steering.ts's handleStuck resets the baseline immediately
   *  whenever this no longer matches the current waypoint's position (a new waypoint, a
   *  repath, or the very first check), so a target change is never misread as a burst of
   *  progress toward a DIFFERENT point than the one the baseline actually measured.
   *  Position, not pathIndex: on the interior-validated graph (#32) two repaths to the
   *  same goal can legally converge through different relay chains whose post-collapse
   *  indices differ, and an index comparison there resets the streak every window, so
   *  the skip threshold was unreachable exactly at the base structures this issue is
   *  about. Empty string = never measured yet. */
  stuckTargetKey: string;
  /** Issue #32: the deflection (degrees) local avoidance last chose while the straight
   *  direction to the current waypoint was blocked by real interior geometry. Steering
   *  re-tries this SAME deflection first on every subsequent blocked tick -- without that
   *  hysteresis a bot hugging a wall flip-flops between the +/- deflection candidates every
   *  tick (each single probe clears for one probe length before the wall re-blocks) and
   *  oscillates in place instead of walking along the wall. 0 = not currently deflecting;
   *  reset whenever the straight probe comes back clear. */
  avoidDeflectionDeg: number;
  /** Issue #32: consecutive steerToward calls where the bot barely moved (sub-0.15 m)
   *  while its current waypoint is still beyond WAYPOINT_REACHED_RADIUS -- the "pressed
   *  against a low lip the chest-height avoidance probe sails over" signature. Steering
   *  answers it with a cadenced hurdle jump; real Katabatic approaches (deck lips, shed
   *  ramp mouths, doorway thresholds) are full of waist-high ledges that block the feet
   *  sphere while leaving the 1.2 m probe ray clear, which the stall windows are far too
   *  slow (60 ticks) and too blunt to answer. */
  crawlTicks: number;
  /** Issue #32: the altitude the bot was at when its current pinned-jump sequence began
   *  (-1 = none in progress). Pinned hurdle jumps that gain no altitude while the goal
   *  sits far above mean the bot is UNDER a floor/walkway the 2D path happily crossed --
   *  the waypoint is not reachable by walking, only by flying -- so steering skips the
   *  waypoint and repaths instead of hopping in place forever (observed under Katabatic's
   *  base structures, whose rooms and ramps sit above crawl-height gaps the terrain
   *  graph cannot see). */
  crawlBaseY: number;
  /** Issue #32: consecutive under-floor waypoint skips without the bot escaping the
   *  pocket it is pinned in. Two skips in a row means the repath-from-here loop is not
   *  converging -- the bot fell through a hole into a space the graph has no node for --
   *  which arms the jet-escape below: hold jets and rise back out the way it fell in. */
  underFloorSkips: number;
  /** Ticks of committed jet-escape remaining. > 0 makes steerToward hold jets (and keep
   *  pressing toward the waypoint) so a vertical exit attempt actually accumulates
   *  upward velocity instead of resetting every call. */
  escapeJetTicks: number;
  /** Issue #32: which station the bot's current heal chase is against ("heal:<id>") and
   *  the tick it started -- brain.ts's decideHealGoal gives up on a station it cannot
   *  actually reach (see HEAL_CHASE_GIVEUP_TICKS) instead of wedged-chasing it forever.
   *  null = no chase in progress. */
  healChaseKey: string | null;
  healChaseSinceTick: number;
  /** Issue #32: until this tick, decideHealGoal keeps returning null after a give-up --
   *  the commitment window that lets a wounded carrier actually walk its flag home
   *  instead of re-chasing every station it passes. Cleared whenever health recovers. */
  healChaseCooldownUntilTick: number;
  /** The position steerToward was last called with, for the crawl measurement above.
   *  null until the first call. */
  lastSteerPosition: { x: number; z: number } | null;
  /** Issue #32: which side (-1 left / +1 right) the last stuck-skip fallback offset its
   *  escape goal to. Consecutive skips alternate sides -- re-ramming the same wall from the
   *  same side on every skip is exactly the "repath recomputes the identical unreachable
   *  route" failure the original skip fallback was written against, one level down. */
  stuckSkipSide: 1 | -1;
  random: RandomState;
}

export function createBotRuntimeState(
  playerId: number,
  role: BotRole,
  seed: number,
): BotRuntimeState {
  return {
    playerId,
    role,
    state: BotState.Idle,
    path: [],
    pathIndex: 0,
    goalKey: null,
    goalPosition: null,
    aimYaw: 0,
    aimJitterDeg: 0,
    engagedTargetId: -1,
    stuckBaselinePosition: { x: 0, z: 0 },
    stuckBaselineTick: 0,
    stuckTargetKey: '',
    stuckStreak: 0,
    avoidDeflectionDeg: 0,
    crawlTicks: 0,
    crawlBaseY: -1,
    healChaseKey: null,
    healChaseSinceTick: -1,
    healChaseCooldownUntilTick: 0,
    underFloorSkips: 0,
    escapeJetTicks: 0,
    lastSteerPosition: null,
    stuckSkipSide: 1,
    random: { value: seed || 1 },
  };
}

/** Deterministic in input order: the first `defenderCount` ids (by array order, not by
 *  numeric id) become Defenders. Callers that want a stable assignment across a
 *  rebalance should pass ids in a stable order (e.g. ascending by id) themselves —
 *  this function does not sort, so re-ordering the input re-assigns roles. */
export function assignRoles(
  botIds: readonly number[],
  defenderFraction = DEFENDER_FRACTION,
): Map<number, BotRole> {
  const roles = new Map<number, BotRole>();
  const defenderCount = Math.min(botIds.length, Math.round(botIds.length * defenderFraction));
  botIds.forEach((id, index) => {
    roles.set(id, index < defenderCount ? BotRole.Defender : BotRole.Attacker);
  });
  return roles;
}
