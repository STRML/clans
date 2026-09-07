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

export const DEFENDER_FRACTION = 0.25; // Ours — see this plan's "ours" numbers table.

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
  aimYaw: number;
  /** Rolled once per fresh target acquisition, not every tick — see combat.ts. */
  aimJitterDeg: number;
  engagedTargetId: number; // -1 = none
  stuckBaselinePosition: { x: number; z: number };
  stuckBaselineTick: number;
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
    aimYaw: 0,
    aimJitterDeg: 0,
    engagedTargetId: -1,
    stuckBaselinePosition: { x: 0, z: 0 },
    stuckBaselineTick: 0,
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
