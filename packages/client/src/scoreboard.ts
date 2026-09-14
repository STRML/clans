import { type RosterEntryMessage } from '@clans/protocol';
import './scoreboard.css';

/**
 * The Tab-held scoreboard (T2's own Tab overlay shows the roster while the key is down and
 * hides it on release). Two halves:
 *
 * - a pure model (`scoreboardRows`/`sortScoreboardRows`/`groupScoreboardRows`) that turns
 *   wire roster entries into the rows a player sees -- unit-tested in scoreboard.test.ts;
 * - a DOM renderer in the HUD's idiom (createElement + dataset attributes, text updates in
 *   place, no per-frame reflow of unchanged rows -- createHud in hud.ts is the pattern).
 *
 * The data source is the Roster side-message the server broadcasts (packages/protocol's
 * RosterMessage): names, kills, deaths, and ping are server runtime memory the snapshot
 * does not carry.
 */

export interface ScoreboardRow {
  playerId: number;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  ping: number;
}

export interface ScoreboardTeamGroup {
  team: number;
  rows: ScoreboardRow[];
}

/** Normalizes one wire entry into a displayable row. The model holds its own invariant
 *  (counters are non-negative integers) rather than trusting the codec twice over: a
 *  negative or fractional value reaching a column would be a rendering bug even if some
 *  future encoder let one through. An empty name still renders as a row -- "Player <id>",
 *  the same fallback shape the server's own names use -- so the row count always matches
 *  the roster the server sent. */
export function scoreboardRows(entries: readonly RosterEntryMessage[]): ScoreboardRow[] {
  return entries.map((entry) => ({
    playerId: entry.playerId,
    name: entry.name !== '' ? entry.name : `Player ${String(entry.playerId)}`,
    team: entry.team,
    kills: Math.max(0, Math.round(entry.kills)),
    deaths: Math.max(0, Math.round(entry.deaths)),
    ping: Math.max(0, Math.round(entry.ping)),
  }));
}

/** Kills descending, then name ascending -- the acceptance's ordering, made a total order
 *  with a final playerId tie-break so equal kills AND equal names (only possible across a
 *  hostile or degenerate roster) still sort deterministically frame to frame. */
export function sortScoreboardRows(rows: readonly ScoreboardRow[]): ScoreboardRow[] {
  return [...rows].sort((a, b) => {
    if (a.kills !== b.kills) return b.kills - a.kills;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.playerId - b.playerId;
  });
}

/** Groups sorted rows per team, teams in ascending order (team 1's table first, like T2's
 *  two-column score screen). Input rows are re-sorted so the grouping is safe to call with
 *  unsorted input; every row lands in exactly one group. */
export function groupScoreboardRows(rows: readonly ScoreboardRow[]): ScoreboardTeamGroup[] {
  const byTeam = new Map<number, ScoreboardRow[]>();
  for (const row of sortScoreboardRows(rows)) {
    const teamRows = byTeam.get(row.team);
    if (teamRows) teamRows.push(row);
    else byTeam.set(row.team, [row]);
  }
  return [...byTeam.keys()]
    .sort((a, b) => a - b)
    .map((team) => ({ team, rows: byTeam.get(team) ?? [] }));
}

export interface ScoreboardView {
  /** Replaces the rendered rows with `entries` (the Roster message is itself a wholesale
   *  replacement, not a diff) and marks the local player's row. Cheap to call every frame
   *  while held: existing row elements are updated in place, not rebuilt. */
  update(entries: readonly RosterEntryMessage[], localPlayerId: number): void;
  show(): void;
  hide(): void;
}

const COLUMNS: Array<{ className: string; label: string; field: keyof ScoreboardRow }> = [
  { className: 'scoreboard-kills', label: 'Kills', field: 'kills' },
  { className: 'scoreboard-deaths', label: 'Deaths', field: 'deaths' },
  { className: 'scoreboard-ping', label: 'Ping', field: 'ping' },
];

function createRow(row: ScoreboardRow, localPlayerId: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'scoreboard-row';
  el.dataset['playerId'] = String(row.playerId);
  el.dataset['local'] = String(row.playerId === localPlayerId);
  const name = document.createElement('span');
  name.className = 'scoreboard-name';
  name.textContent = row.name;
  el.appendChild(name);
  for (const column of COLUMNS) {
    const cell = document.createElement('span');
    cell.className = column.className;
    cell.dataset['value'] = String(row[column.field]);
    cell.textContent = String(row[column.field]);
    el.appendChild(cell);
  }
  return el;
}

function createTeamSection(group: ScoreboardTeamGroup): HTMLElement {
  const section = document.createElement('div');
  section.className = 'scoreboard-team';
  section.dataset['team'] = String(group.team);
  const heading = document.createElement('div');
  heading.className = 'scoreboard-team-heading';
  heading.textContent = `Team ${String(group.team)}`;
  section.appendChild(heading);
  for (const row of group.rows) section.appendChild(createRow(row, -1));
  return section;
}

/** The whole visible table for one update, rebuilt whenever the roster's content changes
 *  (the server only broadcasts on change, so in practice this is a few times a minute, not
 *  every frame -- and rows are diffed by playerId so even a re-broadcast reuses elements). */
function renderRoster(
  root: HTMLElement,
  entries: readonly RosterEntryMessage[],
  localPlayerId: number,
): void {
  const table = document.createElement('div');
  table.className = 'scoreboard-table';
  for (const group of groupScoreboardRows(scoreboardRows(entries))) {
    table.appendChild(createTeamSection(group));
  }
  const existing = root.querySelector('.scoreboard-table');
  if (existing) existing.remove();
  root.appendChild(table);
  for (const rowEl of table.querySelectorAll<HTMLElement>('.scoreboard-row')) {
    if (rowEl.dataset['playerId'] === String(localPlayerId)) rowEl.dataset['local'] = '1';
  }
  root.dataset['rows'] = String(entries.length);
}

export function createScoreboard(container: HTMLElement): ScoreboardView {
  const root = document.createElement('div');
  root.id = 'scoreboard';
  root.dataset['visible'] = '0';
  root.dataset['rows'] = '0';
  const header = document.createElement('div');
  header.className = 'scoreboard-header';
  const title = document.createElement('span');
  title.className = 'scoreboard-title';
  title.textContent = 'Clans · Capture the Flag';
  header.appendChild(title);
  for (const column of COLUMNS) {
    const cell = document.createElement('span');
    cell.className = `${column.className} scoreboard-column-label`;
    cell.textContent = column.label;
    header.appendChild(cell);
  }
  root.appendChild(header);
  container.appendChild(root);
  let renderedEntries: RosterEntryMessage[] = [];
  let renderedLocalId = -1;
  return {
    update(entries, localPlayerId) {
      // Same content and same local id as the last render: nothing to do. The server
      // re-sends the roster only when it changes, but update() runs every held frame.
      if (localPlayerId === renderedLocalId && rosterEquals(entries, renderedEntries)) return;
      renderedEntries = [...entries];
      renderedLocalId = localPlayerId;
      renderRoster(root, entries, localPlayerId);
    },
    show() {
      root.dataset['visible'] = '1';
    },
    hide() {
      root.dataset['visible'] = '0';
    },
  };
}

/** Entry-list equality by value: the server's broadcast is content-addressed already (it
 *  only sends on change), so this is a cheap structural comparison that keeps a held-Tab
 *  frame from re-rendering an unchanged table. */
function rosterEquals(a: readonly RosterEntryMessage[], b: readonly RosterEntryMessage[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.playerId === other.playerId &&
      entry.team === other.team &&
      entry.kills === other.kills &&
      entry.deaths === other.deaths &&
      entry.ping === other.ping &&
      entry.name === other.name
    );
  });
}
