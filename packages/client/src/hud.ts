import {
  FIXED_DT,
  FlagState,
  GameOverReason,
  VEHICLE_DATA,
  WeaponId,
  ammoIndex,
  sampleTerrain,
  armorFor,
  VehicleKind,
  type World,
} from '@clans/sim';
import { EventKind, type EventMessage, type FlagSnapshotData } from '@clans/protocol';
import { assetUrl } from './assets.js';

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
  /** The base object or turret the local player is currently aimed at within a short range,
   *  or null. Set by app.ts's raycastAimedStructure (base-object-view.ts). */
  aimedStructure: { name: string; healthPercent: number } | null;
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
  if (source.winnerTeam === 0)
    return { id: 'hud-game-over', text: 'Match ended: tie game. Movement is paused.' };
  const suffix = source.gameOverReason === GameOverReason.TimeLimit ? ' on time' : '';
  return {
    id: 'hud-game-over',
    text: `Match ended: Team ${String(source.winnerTeam)} wins${suffix}. Movement is paused.`,
  };
}

function clockRow(source: HudSource): HudRow {
  const totalSeconds = Math.max(0, Math.ceil(source.timeRemainingS));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return { id: 'hud-clock', text: `${String(minutes)}:${seconds.toString().padStart(2, '0')}` };
}

function aimedStructureRow(source: HudSource): HudRow {
  if (!source.aimedStructure) return { id: 'hud-aimed', text: '' };
  const { name, healthPercent } = source.aimedStructure;
  return { id: 'hud-aimed', text: `${name} ${String(healthPercent)}%` };
}

/** M5, Task 14: vehicle health/speed row, shown only while the local player is mounted.
 *  Health follows the player health row's own convention (1 - damage/maxDamage); speed is
 *  the vehicle's own velocity magnitude in m/s, not the player's (a mounted player's own
 *  velocity is zeroed every tick -- seatDriver in vehicles.ts's stepVehicles -- so reading
 *  world.players.velocity here would always show 0). */
function vehicleRow(source: HudSource): HudRow {
  const vehicleId = source.world.players.mountedVehicleId[source.playerId] ?? -1;
  if (vehicleId === -1) return { id: 'hud-vehicle', text: '' };
  const vehicles = source.world.vehicles;
  const data = VEHICLE_DATA[vehicles.kind[vehicleId] as VehicleKind];
  const health = data.maxDamage - (vehicles.damage[vehicleId] ?? 0);
  const base = vehicleId * 3;
  const speed = Math.hypot(
    vehicles.velocity[base] ?? 0,
    vehicles.velocity[base + 1] ?? 0,
    vehicles.velocity[base + 2] ?? 0,
  );
  return {
    id: 'hud-vehicle',
    text: `Hull ${String(percent(health, data.maxDamage))}% · Shield ${String(percent(vehicles.energy[vehicleId] ?? 0, data.maxEnergy))}% — ${speed.toFixed(1)} m/s`,
  };
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
    aimedStructureRow(source),
    vehicleRow(source),
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

const WEAPON_ICON = [
  'hud_new_disc.png',
  'hud_new_chaingun.png',
  'hud_new_mortar.png',
  'hud_new_sniper.png',
  'hud_new_blaster.png',
];
const WEAPON_RETICLE = [
  'RET_disc.png',
  'RET_chaingun.png',
  'RET_mortor.png',
  'hud_ret_sniper.png',
  'RET_blaster.png',
];

function createWeaponRack(hud: HTMLElement): HTMLElement[] {
  const rack = document.createElement('div');
  rack.id = 'hud-weapon-rack';
  hud.append(rack);
  return WEAPON_ICON.map((image, slot) => {
    const item = document.createElement('div');
    item.className = 'hud-weapon-slot';
    item.title = `${String(slot + 1)}: ${WEAPON_NAME[slot] ?? ''}`;
    const icon = document.createElement('img');
    icon.src = assetUrl(`gui/${image}`);
    icon.alt = '';
    const ammo = document.createElement('span');
    item.append(icon, ammo);
    rack.append(item);
    return item;
  });
}

function updateRack(items: HTMLElement[], source: HudSource): void {
  for (const [slot, item] of items.entries()) {
    const ammo = source.world.players.ammo[ammoIndex(source.playerId, slot)] ?? 0;
    item.lastElementChild!.textContent = ammo < 0 ? '∞' : String(ammo);
    item.dataset['selected'] = String(source.world.players.weaponSlot[source.playerId] === slot);
  }
  const vehicleId = source.world.players.mountedVehicleId[source.playerId] ?? -1;
  const weapon = source.world.players.weaponSlot[source.playerId] ?? WeaponId.Blaster;
  const crosshair = document.getElementById('crosshair');
  if (crosshair) {
    const reticle =
      vehicleId !== -1 && source.world.vehicles.kind[vehicleId] === VehicleKind.Shrike
        ? 'hud_ret_shrike.png'
        : (WEAPON_RETICLE[weapon] ?? 'RET_blaster.png');
    crosshair.style.backgroundImage = `url(${assetUrl(`gui/${reticle}`)})`;
  }
}

function updateVehicleInstruments(el: HTMLElement, source: HudSource): void {
  const id = source.world.players.mountedVehicleId[source.playerId] ?? -1;
  if (id === -1) {
    el.replaceChildren();
    return;
  }
  if (!el.querySelector('.vehicle-dash')) {
    el.innerHTML = `<div class="vehicle-left"><span class="vehicle-speed"></span><div class="vehicle-meter shield"><i></i></div></div><div class="vehicle-dash"><img src="${assetUrl('gui/hud_veh_new_dash.png')}" alt=""/><img class="vehicle-icon" src="${assetUrl('gui/hud_veh_icon_shrike.png')}" alt=""/></div><div class="vehicle-right"><span class="vehicle-altitude"></span><div class="vehicle-meter hull"><i></i></div></div>`;
  }
  const v = source.world.vehicles,
    base = id * 3;
  const data = VEHICLE_DATA[v.kind[id] as VehicleKind];
  (el.querySelector('.vehicle-icon') as HTMLImageElement).src = assetUrl(
    `gui/${v.kind[id] === VehicleKind.Wildcat ? 'hud_veh_icon_hoverbike.png' : 'hud_veh_icon_shrike.png'}`,
  );
  const speed = Math.hypot(v.velocity[base]!, v.velocity[base + 1]!, v.velocity[base + 2]!);
  const altitude = Math.max(
    0,
    v.position[base + 1]! -
      sampleTerrain(source.world.terrain, v.position[base]!, v.position[base + 2]!).height,
  );
  el.querySelector('.vehicle-speed')!.textContent = `${(speed * 3.6).toFixed(0)} KPH`;
  el.querySelector('.vehicle-altitude')!.textContent = `${altitude.toFixed(0)} m`;
  (el.querySelector('.shield i') as HTMLElement).style.width =
    `${String(percent(v.energy[id]!, data.maxEnergy))}%`;
  (el.querySelector('.hull i') as HTMLElement).style.width =
    `${String(percent(data.maxDamage - v.damage[id]!, data.maxDamage))}%`;
  el.setAttribute('aria-label', el.dataset['value'] ?? 'Vehicle instruments');
}

function updateCompass(el: HTMLElement, source: HudSource): void {
  const vehicleId = source.world.players.mountedVehicleId[source.playerId] ?? -1;
  const yaw =
    vehicleId === -1
      ? (source.world.players.yaw[source.playerId] ?? 0)
      : (source.world.vehicles.yaw[vehicleId] ?? 0);
  (el.querySelector('.hud-compass-labels') as HTMLElement).style.transform = `rotate(${-yaw}rad)`;
}

export function createHud(
  container: HTMLElement,
  initialSource: HudSource,
): { update(source: HudSource): void } {
  const hud = document.createElement('div');
  hud.id = 'hud';
  container.appendChild(hud);
  const statusArt = document.createElement('div');
  statusArt.id = 'hud-status-art';
  statusArt.style.backgroundImage = `url(${assetUrl('gui/hud_new_cog.png')})`;
  hud.append(statusArt);
  const rows = new Map<string, HTMLElement>();
  for (const row of describeHud(initialSource)) {
    const el = document.createElement('div');
    el.id = row.id;
    if (row.id === 'hud-clock') {
      const dial = document.createElement('img');
      dial.className = 'hud-clock-dial';
      dial.src = assetUrl('gui/hud_new_compass.png');
      dial.alt = '';
      const time = document.createElement('span');
      time.className = 'hud-clock-time';
      const labels = document.createElement('img');
      labels.className = 'hud-compass-labels';
      labels.src = assetUrl('gui/hud_new_NSEW.png');
      labels.alt = '';
      el.append(dial, labels, time);
    }
    hud.appendChild(el);
    rows.set(row.id, el);
  }
  const rack = createWeaponRack(hud);
  const killFeed = document.createElement('div');
  killFeed.id = 'hud-kill-feed';
  hud.appendChild(killFeed);

  function update(source: HudSource): void {
    const mounted = (source.world.players.mountedVehicleId[source.playerId] ?? -1) !== -1;
    hud.dataset['piloting'] = String(mounted);
    for (const row of describeHud(source)) {
      const el = rows.get(row.id)!;
      el.dataset['value'] = row.text;
      if (row.id === 'hud-vehicle') {
        updateVehicleInstruments(el, source);
        continue;
      }
      if (row.id === 'hud-clock') {
        el.querySelector('.hud-clock-time')!.textContent = row.text;
        updateCompass(el, source);
      } else {
        el.textContent = row.text;
      }
      if (row.id === 'hud-health' || row.id === 'hud-energy') {
        el.style.setProperty('--fill', row.text);
        el.setAttribute(
          'aria-label',
          `${row.id === 'hud-health' ? 'Health' : 'Energy'} ${row.text}`,
        );
      }
    }
    const scores = rows.get('hud-team-scores')!;
    scores.textContent = source.teamScores
      .map((score, i) => {
        const flag = source.flags.find((f) => f.team === i + 1);
        const status = flag?.state === FlagState.Home ? '<At Base>' : '<Away>';
        return `Team ${String(i + 1)}   ${String(score)}   FLAG  ${status}`;
      })
      .join('\n');
    updateRack(rack, source);
    const messages = describeKillFeed(source);
    killFeed.textContent = messages.length ? messages.join('\n') : 'Clans · Capture the Flag';
    hud.dataset['ready'] = '1';
  }
  update(initialSource);
  return { update };
}
