import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createWorld,
  GameOverReason,
  LIGHT_ARMOR,
  WeaponId,
  type Heightfield,
} from '@clans/sim';
import { EventKind, type EventMessage, type FlagSnapshotData } from '@clans/protocol';
import { describeHud, describeKillFeed, type HudSource } from './hud.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function baseSource(overrides: Partial<HudSource> = {}): HudSource {
  const world = createWorld(flat, 1);
  const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
  return {
    world,
    playerId,
    networkPlayerId: playerId,
    teamScores: [0, 0],
    flags: [],
    gameOver: false,
    winnerTeam: 0,
    timeRemainingS: 0,
    gameOverReason: GameOverReason.CaptureLimit,
    recentEvents: [],
    aimedStructure: null,
    ...overrides,
  };
}
function rowsOf(source: HudSource): Record<string, string> {
  return Object.fromEntries(describeHud(source).map((row) => [row.id, row.text]));
}

describe('describeHud', () => {
  it('reports health and energy as percentages of the armor max', () => {
    const source = baseSource();
    source.world.players.damage[source.playerId] = LIGHT_ARMOR.maxDamage / 2;
    source.world.players.energy[source.playerId] = LIGHT_ARMOR.maxEnergy / 4;
    const rows = rowsOf(source);
    expect(rows['hud-health']).toBe('50%');
    expect(rows['hud-energy']).toBe('25%');
  });

  it('names the held weapon and reports infinite ammo as the infinity symbol', () => {
    const source = baseSource();
    source.world.players.weaponSlot[source.playerId] = WeaponId.LaserRifle;
    const rows = rowsOf(source);
    expect(rows['hud-weapon']).toBe('Laser Rifle');
    expect(rows['hud-ammo']).toBe('∞');
  });

  it('reports finite ammo as a count, e.g. a fresh Spinfusor loadout of 15', () => {
    const source = baseSource();
    source.world.players.weaponSlot[source.playerId] = WeaponId.Spinfusor;
    expect(rowsOf(source)['hud-ammo']).toBe(String(LIGHT_ARMOR.discAmmo));
  });

  it('shows the team scores line', () => {
    expect(rowsOf(baseSource({ teamScores: [300, 100] }))['hud-team-scores']).toBe(
      'Team 1: 300 — Team 2: 100',
    );
  });

  it('warns "your flag is not home" only while carrying the enemy flag with your own away (failure matrix row 3)', () => {
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 1, x: 0, y: 0, z: 0, carrierId: 99, returnInS: -1 }, // ours, stolen
      { id: 1, team: 2, state: 1, x: 0, y: 0, z: 0, carrierId: 0, returnInS: -1 }, // enemy, carried by us
    ];
    expect(rowsOf(baseSource({ flags }))['hud-flag-status']).toBe('your flag is not home');
  });

  it('shows "carrying the enemy flag" when the real network player id carries it, even though the local prediction slot is 0 (Codex review round 5, finding 4)', () => {
    // The dev server starts with 31 bots already connected, so a joining human is very
    // likely assigned a real id other than 0 (e.g. 31) -- but this client's own predicted
    // state always lives at world.players slot 0 (the fixed local-prediction convention),
    // regardless of that real id. Before this fix, flagStatusRow compared carrierId
    // against `playerId` (always 0 for the local slot), so this case never matched and the
    // HUD stayed blank even though the server-side flag really is Carried by this player.
    const source = baseSource({ playerId: 0, networkPlayerId: 31 });
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 }, // ours, home
      { id: 1, team: 2, state: 1, x: 0, y: 0, z: 0, carrierId: 31, returnInS: -1 }, // enemy, carried by us
    ];
    expect(rowsOf({ ...source, flags })['hud-flag-status']).toBe('carrying the enemy flag');
  });

  it('shows a respawn countdown only while dead', () => {
    const source = baseSource();
    expect(rowsOf(source)['hud-respawn']).toBe('');
    source.world.players.alive[source.playerId] = 0;
    source.world.players.respawnAt[source.playerId] = 100;
    source.world.tick = 50;
    expect(rowsOf(source)['hud-respawn']).toBe('respawning in 2s');
  });

  it('names a capture-limit win plainly', () => {
    const source = baseSource({
      gameOver: true,
      winnerTeam: 2,
      gameOverReason: GameOverReason.CaptureLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Team 2 wins');
  });

  it('names a time-limit win with "on time"', () => {
    const source = baseSource({
      gameOver: true,
      winnerTeam: 1,
      gameOverReason: GameOverReason.TimeLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Team 1 wins on time');
  });

  it('names a time-limit tie as a tie, not a team win', () => {
    const source = baseSource({
      gameOver: true,
      winnerTeam: 0,
      gameOverReason: GameOverReason.TimeLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Tie game');
  });

  it('shows nothing before the game ends', () => {
    expect(rowsOf(baseSource())['hud-game-over']).toBe('');
  });

  it('formats the match clock as minutes:seconds, rounded up to the next second', () => {
    expect(rowsOf(baseSource({ timeRemainingS: 90 }))['hud-clock']).toBe('1:30');
    expect(rowsOf(baseSource({ timeRemainingS: 5.2 }))['hud-clock']).toBe('0:06');
    expect(rowsOf(baseSource({ timeRemainingS: -1 }))['hud-clock']).toBe('0:00'); // clamped
  });

  it('shows a base-object health row when aimedStructure is set, and nothing when it is null', () => {
    expect(rowsOf(baseSource({ aimedStructure: null }))['hud-aimed']).toBe('');
    expect(
      rowsOf(baseSource({ aimedStructure: { name: 'Generator', healthPercent: 62 } }))['hud-aimed'],
    ).toBe('Generator 62%');
  });
});

describe('describeKillFeed', () => {
  it('formats a kill line and an environment-death line, keeping only the last 5', () => {
    const events: EventMessage[] = [
      { type: 6, kind: EventKind.PlayerKilled, a: 3, b: 9 },
      { type: 6, kind: EventKind.PlayerKilled, a: -1, b: 2 },
      { type: 6, kind: EventKind.FlagTouched, a: 1, b: 0 },
    ];
    expect(describeKillFeed(baseSource({ recentEvents: events }))).toEqual([
      'P3 eliminated P9',
      'P2 died',
    ]);
  });
});
