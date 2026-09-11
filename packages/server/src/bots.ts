import {
  assignRoles,
  buildWaypointGraph,
  createBotRuntimeState,
  stepBots,
  type BotRuntimeState,
  type WaypointGraph,
} from '@clans/bots';
import { removePlayer, type PlayerInput, type Vec3, type World } from '@clans/sim';
import type { TeamOrder } from '@clans/protocol';
import { currentOrder, type OrderBoard } from './orders.js';
import { addOneBot, dropFlagsCarriedBy, smallerTeam, teamCount, type SceneSpawn } from './world.js';

export const TARGET_TEAM_SIZE = 16; // Spec's own "16 versus 16" -- cited, not ours.

export interface BotManager {
  botIds: Set<number>;
  runtimes: Map<number, BotRuntimeState>;
  graph: WaypointGraph;
  maxBots: number;
  /** Per-team seat cap for every seating path in this module: rebalanceTeams' shed/backfill
   *  loop and joinableTeam's human-join gate both read it here, so one number moves both
   *  together. Resolved once at construction -- TARGET_TEAM_SIZE (the spec's own "16 versus
   *  16", cited, not ours) unless createBotManager's `teamSize` argument raises it, which a
   *  48-bot 24-versus-24 match needs (24). Held on the manager rather than consulted from
   *  the module constant at each site so the default stays exactly 16 for every existing
   *  caller while a single match can raise its own cap. */
  teamSize: number;
  nextSeed: number;
}

function reassignTeamRoles(manager: BotManager, world: World, team: number): void {
  const teamBotIds = [...manager.botIds]
    .filter((id) => world.players.active[id] && world.players.team[id] === team)
    .sort((a, b) => a - b);
  const roles = assignRoles(teamBotIds);
  for (const id of teamBotIds) {
    const runtime = manager.runtimes.get(id);
    const role = roles.get(id);
    if (runtime && role !== undefined) runtime.role = role;
  }
}

function addBotToTeam(manager: BotManager, world: World, spawns: SceneSpawn[], team: number): void {
  const id = addOneBot(world, spawns, team);
  manager.botIds.add(id);
  manager.nextSeed += 1;
  manager.runtimes.set(id, createBotRuntimeState(id, 0, manager.nextSeed));
  reassignTeamRoles(manager, world, team);
}

/** True when `candidate` should replace `current` as the removal pick: lowest score
 *  first (least-established bot loses its slot), tied by highest player id (the most
 *  recently added bot among equally-low scores). */
function isBetterRemovalPick(world: World, candidate: number, current: number): boolean {
  const candidateScore = world.players.score[candidate] ?? 0;
  const currentScore = world.players.score[current] ?? 0;
  if (candidateScore !== currentScore) return candidateScore < currentScore;
  return candidate > current;
}

function pickBotToRemove(world: World, manager: BotManager, team: number): number | null {
  let best: number | null = null;
  for (const id of manager.botIds) {
    if (!world.players.active[id] || world.players.team[id] !== team) continue;
    if (best === null || isBetterRemovalPick(world, id, best)) best = id;
  }
  return best;
}

/** A bot's own "disconnect" during rebalancing matches how a real player disconnect is
 *  handled (net.ts's handleClose): drop whatever flag it's carrying before removing it,
 *  so a carried flag never ends up pointing at a removed, no-longer-active carrierId. */
function removeBotFromTeam(manager: BotManager, world: World, team: number): boolean {
  const id = pickBotToRemove(world, manager, team);
  if (id === null) return false;
  dropFlagsCarriedBy(world, id);
  removePlayer(world, id);
  manager.botIds.delete(id);
  manager.runtimes.delete(id);
  reassignTeamRoles(manager, world, team);
  return true;
}

/** Called after every join/leave (Global Constraints), never on a tick timer. Removes a
 *  bot from a team before it would exceed the manager's per-team cap (`manager.teamSize`),
 *  and backfills a team under that cap from `manager.maxBots`'s remaining budget -- never
 *  more, never fewer than that budget allows (failure matrix rows 12-14).
 *
 *  Codex review round 1 (P1): this can only remove a bot to make room, never a human --
 *  a team can still exceed the cap if it fills past it with humans alone
 *  (e.g. `--bots 0`, or the team's own bot budget already exhausted). This is not a
 *  regression this milestone introduces: no version of this server has ever capped human
 *  team membership, before or after M6 -- `--bots` was always a bot-count budget, never a
 *  matchmaking limit. The join-side half of that finding is now handled upstream of this
 *  function (issue #31): net.ts's handleJoin consults joinableTeam below and refuses the
 *  join with a team-full Welcome status when no team can take a human, so this loop only
 *  ever sees an over-cap team that still has a bot of its own to shed. */
/** The team under the manager's per-team cap with fewer players, or null once both are
 *  full. Codex review round 1, finding (P2): the old backfill loop filled team 1 completely
 *  before ever considering team 2, so a small `--bots` budget (e.g. 2) landed both bots
 *  on team 1 -- unlike the pre-M6 `addBots`, which alternated via `smallerTeam` every
 *  call. This mirrors that alternation while also respecting the per-team cap
 *  `smallerTeam` alone doesn't know about. */
function smallerEligibleTeam(world: World, teamSize: number): 1 | 2 | null {
  const t1 = teamCount(world, 1);
  const t2 = teamCount(world, 2);
  const t1Eligible = t1 < teamSize;
  const t2Eligible = t2 < teamSize;
  if (!t1Eligible && !t2Eligible) return null;
  if (!t2Eligible) return 1;
  if (!t1Eligible) return 2;
  return t1 <= t2 ? 1 : 2;
}

export function rebalanceTeams(manager: BotManager, world: World, spawns: SceneSpawn[]): void {
  const teamSize = manager.teamSize;
  for (const team of [1, 2]) {
    while (teamCount(world, team) > teamSize) {
      if (!removeBotFromTeam(manager, world, team)) break; // no bot left to remove -- humans over cap, not this manager's problem
    }
  }
  let remainingBudget = manager.maxBots - manager.botIds.size;
  while (remainingBudget > 0) {
    const team = smallerEligibleTeam(world, teamSize);
    if (team === null) break;
    addBotToTeam(manager, world, spawns, team);
    remainingBudget -= 1;
  }
}

/** The team an incoming HUMAN may join, or null when no team can take one -- issue #31,
 *  the join-side half of rebalanceTeams's own Codex-round-1 P1 finding above. Order
 *  follows smallerTeam's pick (its tie goes to team 1, matching every existing join and
 *  respawn call site), then the alternate team. A team under the manager's per-team cap
 *  (`manager.teamSize`, 16 unless createBotManager was given a larger one) always has a
 *  slot; a team exactly at the cap still does when it carries a bot, because the
 *  rebalanceTeams call handleJoin makes right after addPlayer sheds exactly that bot
 *  (failure matrix row 12's own mechanic). A team OVER the cap never qualifies, even
 *  with a bot to spare: shedding one bot cannot bring count+1 back to the cap, and no
 *  join may deepen an over-cap team. With `--bots 0` and both teams full of humans this
 *  returns null and the join is refused on the wire instead of silently pushing a team
 *  to 17 humans, which this function's absence let happen before (nothing below 33
 *  players ever tripped rebalanceTeams' over-cap loop with a botless team). */
export function joinableTeam(world: World, manager: BotManager): 1 | 2 | null {
  const t1 = teamCount(world, 1);
  const t2 = teamCount(world, 2);
  const preferred: 1 | 2 = t1 <= t2 ? 1 : 2;
  const alternate: 1 | 2 = preferred === 1 ? 2 : 1;
  if (teamHasJoinSlot(world, manager, preferred)) return preferred;
  if (teamHasJoinSlot(world, manager, alternate)) return alternate;
  return null;
}

/** One team's slot test per joinableTeam's contract: strictly under the manager's cap, or
 *  exactly at the cap with a bot pickBotToRemove can actually produce (an empty manager --
 *  the `--bots 0` case -- offers nothing, which is exactly when #31 could bite). */
function teamHasJoinSlot(world: World, manager: BotManager, team: 1 | 2): boolean {
  const count = teamCount(world, team);
  if (count < manager.teamSize) return true;
  return count === manager.teamSize && pickBotToRemove(world, manager, team) !== null;
}

/** `teamSize` is the match's per-team seat cap, defaulting to TARGET_TEAM_SIZE so every
 *  existing caller -- and the deployed server's own default -- keeps a 16-seat team
 *  exactly as before. Pass 24 alongside `maxBots` 48 (cli.ts's `--team-size`) to seat the
 *  project's 24-versus-24 target: rebalanceTeams then fills 24 per team instead of 16,
 *  and joinableTeam admits humans up to that same cap (issue #31's semantics, unchanged
 *  otherwise). One cap for both halves of seating is the point -- a match that seats 24
 *  bots must also admit 24 humans, or the two would disagree about what "full" means. */
export function createBotManager(
  world: World,
  spawns: SceneSpawn[],
  landmarks: Array<{ position: Vec3; label: string }>,
  maxBots: number,
  teamSize: number = TARGET_TEAM_SIZE,
): BotManager {
  const manager: BotManager = {
    botIds: new Set(),
    runtimes: new Map(),
    // Issue #32: the production landmark set (every base object alongside spawns and flag
    // stands) is mostly INDOOR points, so the graph must be built against the real
    // interiors -- without them edges and final legs validated to nothing and bots
    // routed straight through base walls (verified: 20k-tick production-landmark run,
    // zero kills/captures, bots wedged against shed walls).
    graph: buildWaypointGraph(landmarks, world),
    maxBots,
    teamSize,
    // Issue #32 seed truth: bot randomness must come from the WORLD's seed, or the
    // acceptance sweep's `[1, 2, 3]` is one scenario run three times. This used to start at
    // a hardcoded 0 and only ever increment per join, which made every seed's manager stream
    // identical -- bot RNG (combat.ts's aim jitter, its only consumer) was therefore
    // seed-independent, and the three "different" matches were bit-for-bit the same match.
    // `world.random.value` IS the seed createWorld was built with, before any tick consumes
    // a draw, and in a vehicle-less bot match nothing else ever draws from it (vehicles.ts's
    // destruction scatter is the stream's only other consumer in the whole sim).
    //
    // The per-bot `+= 1` in addBotToTeam stays on top of this, so bots still differ from
    // each other inside one match -- and because an xorshift stream advanced by one draw is
    // a different stream, seed S and seed S+1 disagree from the first jitter draw. A fixed
    // seed remains fully deterministic: same world seed, same manager stream, same match.
    nextSeed: world.random.value,
  };
  rebalanceTeams(manager, world, spawns);
  return manager;
}

/** Resolves each team's current order (`currentOrder`'s own fresh expiry check, failure
 *  matrix row 21) before handing off to `@clans/bots`'s `stepBots` -- `OrderBoard` and
 *  `currentOrder` are server-only (this package's own `orders.ts`), never importable from
 *  `@clans/bots`, which depends only on `@clans/sim` and `@clans/protocol` (that dependency
 *  runs the other way: this package already depends on `@clans/bots`). */
export function stepBotManager(
  manager: BotManager,
  world: World,
  board: OrderBoard,
): Map<number, PlayerInput> {
  const orders = new Map<number, TeamOrder | null>([
    [1, currentOrder(board, 1, world.tick)],
    [2, currentOrder(board, 2, world.tick)],
  ]);
  return stepBots(world, manager.graph, manager.runtimes, orders);
}

export { smallerTeam };
