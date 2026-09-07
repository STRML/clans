import {
  assignRoles,
  buildWaypointGraph,
  createBotRuntimeState,
  stepBots,
  type BotRuntimeState,
  type WaypointGraph,
} from '@clans/bots';
import { removePlayer, type PlayerInput, type Vec3, type World } from '@clans/sim';
import { addOneBot, dropFlagsCarriedBy, smallerTeam, teamCount, type SceneSpawn } from './world.js';

export const TARGET_TEAM_SIZE = 16; // Spec's own "16 versus 16" -- cited, not ours.

export interface BotManager {
  botIds: Set<number>;
  runtimes: Map<number, BotRuntimeState>;
  graph: WaypointGraph;
  maxBots: number;
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
 *  bot from a team before it would exceed TARGET_TEAM_SIZE, and backfills a team under
 *  TARGET_TEAM_SIZE from `manager.maxBots`'s remaining budget -- never more, never
 *  fewer than that budget allows (failure matrix rows 12-14). */
export function rebalanceTeams(manager: BotManager, world: World, spawns: SceneSpawn[]): void {
  for (const team of [1, 2]) {
    while (teamCount(world, team) > TARGET_TEAM_SIZE) {
      if (!removeBotFromTeam(manager, world, team)) break; // no bot left to remove -- humans over cap, not this manager's problem
    }
  }
  let remainingBudget = manager.maxBots - manager.botIds.size;
  for (const team of [1, 2]) {
    while (teamCount(world, team) < TARGET_TEAM_SIZE && remainingBudget > 0) {
      addBotToTeam(manager, world, spawns, team);
      remainingBudget -= 1;
    }
  }
}

export function createBotManager(
  world: World,
  spawns: SceneSpawn[],
  landmarks: Array<{ position: Vec3; label: string }>,
  maxBots: number,
): BotManager {
  const manager: BotManager = {
    botIds: new Set(),
    runtimes: new Map(),
    graph: buildWaypointGraph(landmarks),
    maxBots,
    nextSeed: 0,
  };
  rebalanceTeams(manager, world, spawns);
  return manager;
}

export function stepBotManager(manager: BotManager, world: World): Map<number, PlayerInput> {
  return stepBots(world, manager.graph, manager.runtimes);
}

export { smallerTeam };
