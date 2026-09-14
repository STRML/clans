import { describe, expect, it } from 'vitest';
import type { RosterEntryMessage } from '@clans/protocol';
import {
  groupScoreboardRows,
  scoreboardRows,
  sortScoreboardRows,
  type ScoreboardRow,
} from './scoreboard.js';

const entry = (over: Partial<RosterEntryMessage>): RosterEntryMessage => ({
  playerId: 0,
  team: 1,
  kills: 0,
  deaths: 0,
  ping: 0,
  name: '',
  ...over,
});

describe('scoreboardRows', () => {
  it('normalizes a wire entry into a displayable row, filling an empty name', () => {
    expect(
      scoreboardRows([entry({ playerId: 7, name: '', kills: 3, deaths: 1, ping: 42 })]),
    ).toEqual([{ playerId: 7, name: 'Player 7', team: 1, kills: 3, deaths: 1, ping: 42 }]);
  });

  it('clamps negative counters to zero -- the column never renders a negative count', () => {
    const rows = scoreboardRows([entry({ kills: -5, deaths: -1, ping: -3 })]);
    expect(rows[0]).toMatchObject({ kills: 0, deaths: 0, ping: 0 });
  });

  it('keeps every entry, even a zeroed one, so the row count matches the roster', () => {
    const entries = [entry({ playerId: 1 }), entry({ playerId: 2 }), entry({ playerId: 3 })];
    expect(scoreboardRows(entries)).toHaveLength(3);
  });
});

describe('sortScoreboardRows', () => {
  const rows: ScoreboardRow[] = [
    { playerId: 1, name: 'Beta', team: 1, kills: 2, deaths: 0, ping: 0 },
    { playerId: 2, name: 'Alpha', team: 1, kills: 5, deaths: 0, ping: 0 },
    { playerId: 3, name: 'Zulu', team: 2, kills: 5, deaths: 0, ping: 0 },
    { playerId: 4, name: 'Aardvark', team: 2, kills: 0, deaths: 9, ping: 0 },
  ];

  it('sorts by kills descending, then name ascending', () => {
    expect(sortScoreboardRows(rows).map((row) => row.name)).toEqual([
      'Alpha',
      'Zulu',
      'Beta',
      'Aardvark',
    ]);
  });

  it('is a total order: equal kills and names fall back to playerId', () => {
    const twins: ScoreboardRow[] = [
      { playerId: 9, name: 'Twin', team: 1, kills: 1, deaths: 0, ping: 0 },
      { playerId: 4, name: 'Twin', team: 2, kills: 1, deaths: 0, ping: 0 },
    ];
    expect(sortScoreboardRows(twins).map((row) => row.playerId)).toEqual([4, 9]);
  });

  it('does not mutate the input array', () => {
    const before = [...rows];
    sortScoreboardRows(rows);
    expect(rows).toEqual(before);
  });
});

describe('groupScoreboardRows', () => {
  it('groups by team in ascending order, rows sorted within each group', () => {
    const rows: ScoreboardRow[] = [
      { playerId: 1, name: 'B', team: 2, kills: 1, deaths: 0, ping: 0 },
      { playerId: 2, name: 'A', team: 2, kills: 4, deaths: 0, ping: 0 },
      { playerId: 3, name: 'C', team: 1, kills: 0, deaths: 0, ping: 0 },
    ];
    const groups = groupScoreboardRows(rows);
    expect(groups.map((group) => group.team)).toEqual([1, 2]);
    expect(groups[1]?.rows.map((row) => row.name)).toEqual(['A', 'B']);
  });

  it('puts every row in exactly one group', () => {
    const rows: ScoreboardRow[] = [
      { playerId: 1, name: 'A', team: 1, kills: 0, deaths: 0, ping: 0 },
      { playerId: 2, name: 'B', team: 2, kills: 0, deaths: 0, ping: 0 },
    ];
    const total = groupScoreboardRows(rows).reduce((sum, group) => sum + group.rows.length, 0);
    expect(total).toBe(rows.length);
  });
});
