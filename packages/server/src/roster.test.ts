import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, removePlayer, type Heightfield } from '@clans/sim';
import {
  applyRosterDeaths,
  buildRosterEntries,
  createRosterBoard,
  rosterNameFor,
} from './roster.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

const noPing = (): number => 0;

describe('applyRosterDeaths', () => {
  it('credits an enemy kill to the attacker and a death to the victim', () => {
    const board = createRosterBoard();
    applyRosterDeaths(board, [{ id: 4, attackerId: 2 }]);
    expect(board.tallies.get(2)).toEqual({ kills: 1, deaths: 0 });
    expect(board.tallies.get(4)).toEqual({ kills: 0, deaths: 1 });
  });

  it('credits a team kill to the killer -- the signed score carries the penalty, not this column', () => {
    const board = createRosterBoard();
    applyRosterDeaths(board, [{ id: 3, attackerId: 1 }]);
    expect(board.tallies.get(1)).toEqual({ kills: 1, deaths: 0 });
  });

  it('counts a suicide as a death only, and an environmental death as nobody kill', () => {
    const board = createRosterBoard();
    applyRosterDeaths(board, [
      { id: 5, attackerId: 5 },
      { id: 6, attackerId: -1 },
    ]);
    expect(board.tallies.get(5)).toEqual({ kills: 0, deaths: 1 });
    expect(board.tallies.get(6)).toEqual({ kills: 0, deaths: 1 });
  });
});

describe('buildRosterEntries', () => {
  it('lists every active player with team, tallies, ping, and a bot/human name', () => {
    const world = createWorld(terrain, 1);
    const bot = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const human = addPlayer(world, { x: 1, y: 0, z: 1 }, 2);
    const board = createRosterBoard();
    applyRosterDeaths(board, [{ id: human, attackerId: bot }]);
    const entries = buildRosterEntries(world, board, new Set([bot]), (id) =>
      id === human ? 42 : 0,
    );
    expect(entries).toEqual([
      {
        playerId: bot,
        team: 1,
        kills: 1,
        deaths: 0,
        ping: 0,
        name: rosterNameFor(bot, true),
      },
      {
        playerId: human,
        team: 2,
        kills: 0,
        deaths: 1,
        ping: 42,
        name: rosterNameFor(human, false),
      },
    ]);
  });

  it('drops removed players from the roster and prunes their tallies', () => {
    const world = createWorld(terrain, 1);
    const gone = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const board = createRosterBoard();
    applyRosterDeaths(board, [{ id: gone, attackerId: -1 }]);
    removePlayer(world, gone);
    expect(buildRosterEntries(world, board, new Set(), noPing)).toEqual([]);
    // The pruned tally must not resurface if the id is reused by a later join.
    expect(board.tallies.has(gone)).toBe(false);
  });

  it('renders a never-tallied player at zero without allocating a tally entry', () => {
    const world = createWorld(terrain, 1);
    const fresh = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const board = createRosterBoard();
    const entries = buildRosterEntries(world, board, new Set(), noPing);
    expect(entries[0]).toMatchObject({ playerId: fresh, kills: 0, deaths: 0, ping: 0 });
    expect(board.tallies.size).toBe(0);
  });
});
