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
  /** The `pathIndex` the stuck baseline was last measured against. steering.ts's
   *  handleStuck resets the baseline immediately whenever this no longer matches the
   *  current `pathIndex` (a new waypoint, a repath, or the very first check), so a target
   *  change is never misread as a burst of "progress" toward a DIFFERENT point than the
   *  one the baseline actually measured. -1 = never measured yet. */
  stuckTargetIndex: number;
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
    stuckStreak: 0,
    stuckTargetIndex: -1,
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
