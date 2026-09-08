import {
  BASE_OBJECT_DATA,
  BaseObjectKind,
  engagementRange,
  hasLineOfSight,
  sampleTerrain,
  type TurretBarrelId,
  type World,
} from '@clans/sim';
import { OrderKind, type OrderSnapshotData } from '@clans/protocol';
import type { KatabaticAssets } from './assets.js';

export interface SensorCircle {
  x: number;
  z: number;
  radius: number;
}

function sensorCirclesFromBaseObjects(world: World, localTeam: number): SensorCircle[] {
  const circles: SensorCircle[] = [];
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] !== BaseObjectKind.Sensor) continue;
    if (bases.team[id] !== localTeam || bases.destroyed[id] || !bases.powered[id]) continue;
    const base = id * 3;
    circles.push({
      x: bases.position[base] ?? 0,
      z: bases.position[base + 2] ?? 0,
      radius: BASE_OBJECT_DATA[BaseObjectKind.Sensor].detectRadius,
    });
  }
  return circles;
}

function sensorCirclesFromTurrets(world: World, localTeam: number): SensorCircle[] {
  const circles: SensorCircle[] = [];
  const turrets = world.turrets;
  for (let id = 0; id < turrets.count; id += 1) {
    if (turrets.team[id] !== localTeam || turrets.destroyed[id] || !turrets.powered[id]) continue;
    const base = id * 3;
    circles.push({
      x: turrets.position[base] ?? 0,
      z: turrets.position[base + 2] ?? 0,
      radius: engagementRange((turrets.barrel[id] ?? 0) as TurretBarrelId),
    });
  }
  return circles;
}

export function friendlySensorCircles(world: World, localTeam: number): SensorCircle[] {
  return [
    ...sensorCirclesFromBaseObjects(world, localTeam),
    ...sensorCirclesFromTurrets(world, localTeam),
  ];
}

function insideAnyCircle(x: number, z: number, circles: readonly SensorCircle[]): boolean {
  return circles.some((c) => Math.hypot(x - c.x, z - c.z) <= c.radius);
}

/**
 * Codex round 2 review of PR #11: a NetClient's own prediction world only ever holds the
 * LOCAL player (netclient.ts's `createWorld(terrain, 1, 1)` -- capacity 1); every remote
 * player's position lives entirely in `net.remotePlayers`, decoded straight off the wire, and
 * never gets written into `world.players` (movement prediction has no use for another
 * player's exact position the way it does its own). sensedEnemyIds/drawPlayers below used to
 * read `world.players` directly, so a networked client's commander map never showed a single
 * enemy or teammate other than the local player. Both now take an explicit list built by the
 * caller (app.ts's `commanderMapPlayers`), which merges `playersFromWorld` (below, for
 * single-player and the local player) with `net.remotePlayers` when connected.
 */
export interface PlayerPosition {
  id: number;
  team: number;
  x: number;
  z: number;
  alive: boolean;
}

/** Single-player has every player (bots included) in `world.players` directly; a NetClient's
 *  own `world.players` holds only the local player, so callers merge this with the net's own
 *  remote-player snapshots (see `PlayerPosition`'s own comment) for a full roster. */
export function playersFromWorld(world: World): PlayerPosition[] {
  const out: PlayerPosition[] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id]) continue;
    const base = id * 3;
    out.push({
      id,
      team: world.players.team[id] ?? 0,
      x: world.players.position[base] ?? 0,
      z: world.players.position[base + 2] ?? 0,
      alive: (world.players.alive[id] ?? 0) === 1,
    });
  }
  return out;
}

// Ours -- matches turrets.ts's own TURRET_EYE_HEIGHT. Ground level (y=0 relative to the
// terrain sample right there) has to be given some eye-height offset above the terrain at the
// observer's own position: without it, the from/to interpolated path height sits exactly at
// "ground" for its whole length and hasLineOfSight's own march (`sample.height >= interpolated
// y`) degenerates to "is there any terrain at or above ground between us", which is true
// almost everywhere on non-flat terrain -- it would make the sensor system fail closed on
// anything but dead-flat ground, not just when a real ridge sits in the way.
const SENSOR_EYE_HEIGHT = 2;

function groundY(world: World, x: number, z: number): number {
  const sample = sampleTerrain(world.terrain, x, z);
  return sample.empty ? 0 : sample.height;
}

export function sensedEnemyIds(
  players: readonly PlayerPosition[],
  localTeam: number,
  circles: readonly SensorCircle[],
  world: World,
): number[] {
  const ids: number[] = [];
  for (const player of players) {
    if (!player.alive || player.team === localTeam) continue;
    if (!insideAnyCircle(player.x, player.z, circles)) continue;
    // Reuse each covering sensor circle's own center as the observing point -- a sensor
    // detects along its own line of sight, not the local player's. Every circle covering this
    // enemy is checked; one clear line from any of them is enough (closes #19).
    const clear = circles.some((c) => {
      if (Math.hypot(player.x - c.x, player.z - c.z) > c.radius) return false;
      const eye = { x: c.x, y: groundY(world, c.x, c.z) + SENSOR_EYE_HEIGHT, z: c.z };
      const target = { x: player.x, y: groundY(world, player.x, player.z), z: player.z };
      return hasLineOfSight(world, eye, target);
    });
    if (clear) ids.push(player.id);
  }
  return ids;
}

export function canvasToWorld(
  ctx: CanvasRenderingContext2D,
  missionArea: { minX: number; minZ: number; width: number; depth: number },
  canvasX: number,
  canvasY: number,
): { x: number; z: number } {
  const { width, height } = ctx.canvas;
  return {
    x: missionArea.minX + (canvasX / width) * missionArea.width,
    z: missionArea.minZ + (canvasY / height) * missionArea.depth,
  };
}

export function drawOrderMarkers(
  ctx: CanvasRenderingContext2D,
  orders: readonly OrderSnapshotData[],
  localTeam: number,
  toCanvas: (x: number, z: number) => [number, number],
): void {
  const own = orders.find((o) => o.team === localTeam);
  if (!own) return;
  const [cx, cy] = toCanvas(own.x, own.z);
  ctx.strokeStyle =
    own.kind === OrderKind.Attack
      ? '#ff4444'
      : own.kind === OrderKind.Defend
        ? '#44aaff'
        : '#44ff88';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.stroke();
}

const TEAM_COLOR: Record<number, string> = { 1: '#dd3333', 2: '#3366dd' };

function drawBaseObjects(
  ctx: CanvasRenderingContext2D,
  world: World,
  localTeam: number,
  toCanvas: (x: number, z: number) => [number, number],
): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.team[id] !== localTeam) continue;
    const base = id * 3;
    const [cx, cz] = toCanvas(bases.position[base] ?? 0, bases.position[base + 2] ?? 0);
    ctx.fillStyle = bases.destroyed[id] ? '#552222' : bases.powered[id] ? '#33cc66' : '#888888';
    ctx.fillRect(cx - 3, cz - 3, 6, 6);
  }
}

function drawPlayers(
  ctx: CanvasRenderingContext2D,
  players: readonly PlayerPosition[],
  localTeam: number,
  sensedIds: readonly number[],
  toCanvas: (x: number, z: number) => [number, number],
): void {
  for (const player of players) {
    if (!player.alive) continue;
    const isEnemy = player.team !== localTeam;
    if (isEnemy && !sensedIds.includes(player.id)) continue;
    const [cx, cz] = toCanvas(player.x, player.z);
    ctx.fillStyle = TEAM_COLOR[player.team] ?? '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cz, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawCommanderMap(
  ctx: CanvasRenderingContext2D,
  assets: Pick<KatabaticAssets, 'scene'>,
  world: World,
  players: readonly PlayerPosition[],
  localTeam: number,
  sensedIds: readonly number[],
): void {
  const { width, height } = ctx.canvas;
  const { minX, minZ, width: areaWidth, depth: areaDepth } = assets.scene.missionArea;
  const toCanvas = (x: number, z: number): [number, number] => [
    ((x - minX) / areaWidth) * width,
    ((z - minZ) / areaDepth) * height,
  ];
  ctx.fillStyle = '#0b1420';
  ctx.fillRect(0, 0, width, height);
  drawBaseObjects(ctx, world, localTeam, toCanvas);
  drawPlayers(ctx, players, localTeam, sensedIds, toCanvas);
}
