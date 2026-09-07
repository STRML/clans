import GUI from 'lil-gui';
import type { BotDebugSnapshotData } from '@clans/protocol';
import type { PlayerSnapshotData } from '@clans/sim';
import type { App } from './app.js';
import { activeProjectileCount, describeEvent, describePlayer, type DebugExtra } from './stats.js';

// BotState from @clans/bots -- this package doesn't depend on @clans/bots (the wire value
// is a plain number, see protocol/snapshot.ts's BotDebugSnapshotData comment), so the
// mapping is restated here rather than imported.
const BOT_STATE_IDLE = 0;
const BOT_STATE_ATTACK = 1;
const BOT_STATE_DEFEND = 2;

interface TeamBotCounts {
  total: number;
  idle: number;
  attack: number;
  defend: number;
}

/** Groups `bots` by team, looking each bot's team up via `remotePlayers` (the same
 *  defensive "missing id -> just skip it" style `findMountedVehicleId` in netclient.ts
 *  already uses for an id with no matching remote player) -- a bot id that hasn't shown
 *  up in remotePlayers yet (mid-join, or between this snapshot and the next) is simply
 *  not counted this frame rather than crashing or guessing a team. */
function countBotsByState(
  bots: BotDebugSnapshotData[],
  remotePlayers: Map<number, PlayerSnapshotData>,
  team: number,
): TeamBotCounts {
  const counts: TeamBotCounts = { total: 0, idle: 0, attack: 0, defend: 0 };
  for (const bot of bots) {
    if (remotePlayers.get(bot.playerId)?.team !== team) continue;
    counts.total += 1;
    if (bot.state === BOT_STATE_IDLE) counts.idle += 1;
    else if (bot.state === BOT_STATE_ATTACK) counts.attack += 1;
    else if (bot.state === BOT_STATE_DEFEND) counts.defend += 1;
  }
  return counts;
}

function formatTeamBots(team: number, counts: TeamBotCounts): string {
  return `Team ${String(team)}: ${String(counts.total)} bots (${String(counts.idle)} idle, ${String(counts.attack)} attack, ${String(counts.defend)} defend)`;
}

function botsByTeamFor(app: App): [string, string] {
  const bots = app.net?.bots ?? [];
  const remotePlayers = app.net?.remotePlayers ?? new Map<number, PlayerSnapshotData>();
  return [
    formatTeamBots(1, countBotsByState(bots, remotePlayers, 1)),
    formatTeamBots(2, countBotsByState(bots, remotePlayers, 2)),
  ];
}

export function extraFor(app: App): DebugExtra {
  const lastEvent = app.net?.recentEvents.at(-1);
  return {
    projectileCount: app.net ? app.net.projectiles.length : activeProjectileCount(app.world),
    lastEvent: lastEvent ? describeEvent(lastEvent) : 'none',
    botsByTeam: botsByTeamFor(app),
  };
}

/**
 * F1 toggles the overlay. The stats element updates every frame even while hidden so
 * automated tests can read it through its data attributes.
 */
export function createDebug(app: App, container: HTMLElement): { update(): void } {
  const stats = document.createElement('div');
  stats.id = 'debug-stats';
  stats.hidden = true;
  container.appendChild(stats);
  const rows = new Map<string, HTMLElement>();
  for (const row of describePlayer(app.world, app.playerId, app.stats, extraFor(app))) {
    const line = document.createElement('div');
    line.id = row.id;
    line.dataset['label'] = row.label;
    stats.appendChild(line);
    rows.set(row.id, line);
  }

  const gui = new GUI({ title: 'Clans debug' });
  gui.add(app, 'timeScale', 0.1, 4, 0.1);
  gui.add(app, 'paused');
  gui.add({ step: () => (app.stepOnce = true) }, 'step').name('step once');
  gui.add(app, 'freeCam').onChange((on: boolean) => {
    if (on) app.freeCamPosition.copy(app.camera.position);
  });
  gui.add(app, 'godMode').onChange((enabled: boolean) => {
    app.net?.setGodMode(enabled);
  });
  gui.hide();

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F1') return;
    event.preventDefault();
    stats.hidden = !stats.hidden;
    if (stats.hidden) gui.hide();
    else gui.show();
  });

  return {
    update(): void {
      for (const row of describePlayer(app.world, app.playerId, app.stats, extraFor(app))) {
        const line = rows.get(row.id);
        if (!line) continue;
        line.textContent = `${row.label}: ${row.text}`;
        line.dataset['value'] = String(row.value);
      }
      stats.dataset['ready'] = '1';
    },
  };
}
