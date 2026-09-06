import {
  FIXED_DT,
  FlagState,
  GameOverReason,
  WeaponId,
  ammoIndex,
  armorFor,
  type World,
} from '@clans/sim';
import { EventKind, type EventMessage, type FlagSnapshotData } from '@clans/protocol';

export interface HudSource {
  world: World;
  playerId: number;
  /**
   * Codex review round 5, finding 4 (PR #9): `playerId` above indexes this client's own
   * predicted state in `world.players`, which is always the fixed local-prediction slot
   * (0) for a networked game -- it has nothing to do with the id the server actually
   * assigned this connection. Wire data like `flags[].carrierId` carries that real,
   * server-assigned id instead, so comparing it against `playerId` was only ever correct
   * for the very first player to join a server (whose local slot and network id both
   * happen to be 0). This field is that real id: `net.playerId` when networked, the same
   * value as `playerId` in single-player (which has no separate network identity).
   */
  networkPlayerId: number;
  teamScores: [number, number];
  flags: FlagSnapshotData[];
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number;
  gameOverReason: GameOverReason;
  recentEvents: EventMessage[];
}
export interface HudRow {
  id: string;
  text: string;
}

const WEAPON_NAME: Record<number, string> = {
  [WeaponId.Spinfusor]: 'Spinfusor',
  [WeaponId.Chaingun]: 'Chaingun',
  [WeaponId.Mortar]: 'Mortar',
  [WeaponId.LaserRifle]: 'Laser Rifle',
  [WeaponId.Blaster]: 'Blaster',
};
export const KILL_FEED_LINES = 5;

function percent(value: number, max: number): number {
  return max > 0 ? Math.round((value / max) * 100) : 0;
}

function healthRow(source: HudSource): HudRow {
  const armor = armorFor(source.world, source.playerId);
  const health = armor.maxDamage - (source.world.players.damage[source.playerId] ?? 0);
  return { id: 'hud-health', text: `${String(percent(health, armor.maxDamage))}%` };
}

function energyRow(source: HudSource): HudRow {
  const armor = armorFor(source.world, source.playerId);
  const energy = source.world.players.energy[source.playerId] ?? 0;
  return { id: 'hud-energy', text: `${String(percent(energy, armor.maxEnergy))}%` };
}

function weaponAmmoRows(source: HudSource): HudRow[] {
  const players = source.world.players;
  const weaponSlot = (players.weaponSlot[source.playerId] ?? WeaponId.Blaster) as WeaponId;
  const ammo = players.ammo[ammoIndex(source.playerId, weaponSlot)] ?? 0;
  return [
    { id: 'hud-weapon', text: WEAPON_NAME[weaponSlot] ?? 'Unknown' },
    { id: 'hud-ammo', text: ammo < 0 ? '∞' : String(ammo) },
    { id: 'hud-grenades', text: String(players.grenades[source.playerId] ?? 0) },
  ];
}

function teamScoresRow(source: HudSource): HudRow {
  const [team1, team2] = source.teamScores;
  return { id: 'hud-team-scores', text: `Team 1: ${String(team1)} — Team 2: ${String(team2)}` };
}

/** Failure matrix row 3's caller-visible message: a carrier whose own flag is away cannot
 * capture, and the HUD is the only place this milestone surfaces why. */
function flagStatusRow(source: HudSource): HudRow {
  const team = source.world.players.team[source.playerId] ?? 0;
  const own = source.flags.find((flag) => flag.team === team);
  const enemy = source.flags.find((flag) => flag.team !== team && flag.team !== 0);
  const carryingEnemy = enemy?.carrierId === source.networkPlayerId;
  if (carryingEnemy && own && own.state !== FlagState.Home) {
    return { id: 'hud-flag-status', text: 'your flag is not home' };
  }
  if (carryingEnemy) return { id: 'hud-flag-status', text: 'carrying the enemy flag' };
  if (own && own.state !== FlagState.Home)
    return { id: 'hud-flag-status', text: 'your flag is away' };
  return { id: 'hud-flag-status', text: '' };
}

function respawnRow(source: HudSource): HudRow {
  const players = source.world.players;
  if (players.alive[source.playerId]) return { id: 'hud-respawn', text: '' };
  const ticksLeft = Math.max(0, (players.respawnAt[source.playerId] ?? 0) - source.world.tick);
  const secondsLeft = Math.ceil(ticksLeft * FIXED_DT);
  return { id: 'hud-respawn', text: `respawning in ${String(secondsLeft)}s` };
}

/** Names why the match ended: a capture-limit win always has a winner (only the time limit can
 * end in a tie, since a capture-limit win requires one specific team to reach `WIN_SCORE`). */
function gameOverRow(source: HudSource): HudRow {
  if (!source.gameOver) return { id: 'hud-game-over', text: '' };
  if (source.winnerTeam === 0) return { id: 'hud-game-over', text: 'Tie game' };
  const suffix = source.gameOverReason === GameOverReason.TimeLimit ? ' on time' : '';
  return { id: 'hud-game-over', text: `Team ${String(source.winnerTeam)} wins${suffix}` };
}

function clockRow(source: HudSource): HudRow {
  const totalSeconds = Math.max(0, Math.ceil(source.timeRemainingS));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return { id: 'hud-clock', text: `${String(minutes)}:${seconds.toString().padStart(2, '0')}` };
}

export function describeHud(source: HudSource): HudRow[] {
  return [
    healthRow(source),
    energyRow(source),
    ...weaponAmmoRows(source),
    teamScoresRow(source),
    flagStatusRow(source),
    respawnRow(source),
    clockRow(source),
    gameOverRow(source),
  ];
}

function killFeedLine(event: EventMessage): string | null {
  if (event.kind !== EventKind.PlayerKilled) return null;
  return event.a < 0
    ? `P${String(event.b)} died`
    : `P${String(event.a)} eliminated P${String(event.b)}`;
}

export function describeKillFeed(source: HudSource): string[] {
  const lines: string[] = [];
  for (const event of source.recentEvents) {
    const line = killFeedLine(event);
    if (line) lines.push(line);
  }
  return lines.slice(-KILL_FEED_LINES);
}

/**
 * DOM wiring, exercised by Task 14's Playwright spec rather than Vitest (the client project
 * runs `environment: 'node'`; see `debug.ts` for the same split against `stats.ts`).
 */
export function createHud(
  container: HTMLElement,
  initialSource: HudSource,
): { update(source: HudSource): void } {
  const hud = document.createElement('div');
  hud.id = 'hud';
  container.appendChild(hud);
  const rows = new Map<string, HTMLElement>();
  for (const row of describeHud(initialSource)) {
    const el = document.createElement('div');
    el.id = row.id;
    hud.appendChild(el);
    rows.set(row.id, el);
  }
  const killFeed = document.createElement('div');
  killFeed.id = 'hud-kill-feed';
  hud.appendChild(killFeed);

  function update(source: HudSource): void {
    for (const row of describeHud(source)) {
      const el = rows.get(row.id);
      if (!el) continue;
      el.textContent = row.text;
      el.dataset['value'] = row.text;
    }
    killFeed.textContent = describeKillFeed(source).join(' | ');
    hud.dataset['ready'] = '1';
  }
  update(initialSource);
  return { update };
}
