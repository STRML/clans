import type { RosterEntryMessage } from '@clans/protocol';
import type { World } from '@clans/sim';

/**
 * The scoreboard roster's server-side half (see protocol's RosterMessage for the wire
 * shape). Everything the roster shows is server runtime memory the sim does not model:
 *
 * - kills/deaths: the sim tracks a signed `score` only (damage.ts's scoreForDeath), never
 *   per-player death counts, so the board tallies the same lethal events net.ts already
 *   broadcasts as EventKind.PlayerKilled -- applied at the broadcast point, AFTER lag
 *   compensation, so a hit rejectLiveHit reversed (unkillPlayer removes the pendingDeaths
 *   entry) never counts on the scoreboard either;
 * - names: a JoinMessage carries no name, so the server assigns display names --
 *   "Player <id>" for humans, "Bot <id>" for bots (BotManager.botIds is the split);
 * - ping: the caller's own per-connection RTT accessor (net.ts's ClientEntry.pingMs); 0
 *   for every bot and for any id whose socket has already closed, which is honest -- there
 *   is nothing to measure.
 *
 * Runtime memory only, never World/hashWorld (the same convention OrderBoard and
 * BotManager already follow, M6 Global Constraints), and cleared by startNextMatch
 * alongside the sim's own score zeroing (sim/match.ts: GameCore::startGame zeroes every
 * client's score/kills/deaths).
 */

export interface RosterTally {
  kills: number;
  deaths: number;
}

export interface RosterBoard {
  /** Per-player tallies, keyed by player id. Entries for ids that leave the world are
   *  pruned at build time and deleted on a human disconnect, so a reused id can never
   *  inherit the previous occupant's counts. */
  tallies: Map<number, RosterTally>;
}

export function createRosterBoard(): RosterBoard {
  return { tallies: new Map() };
}

/** The display name for `playerId`: derived, never stored, so there is no name state to
 *  clean up on leave and no chance of a stale name surviving an id reuse. */
export function rosterNameFor(playerId: number, isBot: boolean): string {
  return `${isBot ? 'Bot' : 'Player'} ${String(playerId)}`;
}

/** Tallies one tick's lethal events -- the same `world.pendingDeaths` array the
 *  PlayerKilled broadcasts are built from, read after lag compensation has had its chance
 *  to remove entries. A suicide credits the victim's death column only; an attributed kill
 *  credits the killer's kill column even on a team kill (the scoreboard counts kills, the
 *  signed score carries the -10 penalty -- the same split the source's own score screen
 *  makes between Kills/Deaths and Score). */
export function applyRosterDeaths(
  board: RosterBoard,
  pendingDeaths: ReadonlyArray<{ id: number; attackerId: number }>,
): void {
  for (const { id, attackerId } of pendingDeaths) {
    const victim = board.tallies.get(id) ?? { kills: 0, deaths: 0 };
    victim.deaths += 1;
    board.tallies.set(id, victim);
    if (attackerId < 0 || attackerId === id) continue;
    const killer = board.tallies.get(attackerId) ?? { kills: 0, deaths: 0 };
    killer.kills += 1;
    board.tallies.set(attackerId, killer);
  }
}

/** Builds the full visible roster from the world's active players. Tallies for inactive
 *  ids are pruned here -- a bot removed by rebalancing never went through handleClose, so
 *  this is the one sweep that catches every departure -- and each entry's name/ping are
 *  resolved at build time from the caller's bot set and per-connection ping accessor. */
export function buildRosterEntries(
  world: World,
  board: RosterBoard,
  botIds: ReadonlySet<number>,
  pingFor: (playerId: number) => number,
): RosterEntryMessage[] {
  const entries: RosterEntryMessage[] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id]) {
      board.tallies.delete(id);
      continue;
    }
    const tally = board.tallies.get(id) ?? { kills: 0, deaths: 0 };
    entries.push({
      playerId: id,
      team: world.players.team[id] ?? 0,
      kills: tally.kills,
      deaths: tally.deaths,
      ping: pingFor(id),
      name: rosterNameFor(id, botIds.has(id)),
    });
  }
  return entries;
}
