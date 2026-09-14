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

/** The terrain raster under the markers, and the one part of the spec's command circuit this
 *  canvas was missing: "a 2D top-down canvas of the mission area with terrain shading, base
 *  assets with power state, teammates, and enemy contacts inside your team's sensor coverage"
 *  (design spec, Client section). Base assets, players and sensor envelopes were built; the
 *  shading is this.
 *
 *  The raster is sampled heights -- `sampleTerrain` over a steps x steps grid covering the
 *  mission area -- shaded by the scene's own sun direction (committed scene data, the same
 *  vector the 3D terrain's material uses), with brightness carrying both altitude and slope:
 *  a slope facing the sun reads lighter, a lee slope darker, which is what makes ridges read
 *  as ridges on a map this small. Output is normalized 0..1 brightness per cell, row-major
 *  from the mission area's top-left, so the canvas layer and the tests share one definition. */
export const TERRAIN_SHADE_STEPS = 96; // Ours: 96 x 96 samples over the mission area.

function sampleHeights(
  world: World,
  missionArea: { minX: number; minZ: number; width: number; depth: number },
  steps: number,
): Float32Array {
  const heights = new Float32Array(steps * steps);
  const cellW = missionArea.width / (steps - 1);
  const cellD = missionArea.depth / (steps - 1);
  for (let j = 0; j < steps; j += 1) {
    for (let i = 0; i < steps; i += 1) {
      heights[j * steps + i] =
        sampleTerrain(world.terrain, missionArea.minX + i * cellW, missionArea.minZ + j * cellD)
          .height ?? 0;
    }
  }
  return heights;
}

function rangeOf(values: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max: max === -Infinity ? min : max };
}

/** One cell's brightness from its neighbours' heights: slope-lit by the scene sun, then
 *  mixed with the normalized altitude. */
function cellShade(
  heights: Float32Array,
  steps: number,
  sun: { x: number; y: number; z: number },
  worldPerCell: number,
  min: number,
  span: number,
  i: number,
  j: number,
): number {
  const at = (ii: number, jj: number): number => heights[jj * steps + ii] ?? 0;
  const hL = at(Math.max(0, i - 1), j);
  const hR = at(Math.min(steps - 1, i + 1), j);
  const hD = at(i, Math.max(0, j - 1));
  const hU = at(i, Math.min(steps - 1, j + 1));
  const dhx = (hR - hL) / (2 * worldPerCell);
  const dhz = (hU - hD) / (2 * worldPerCell);
  const normalLen = Math.hypot(dhx, 1, dhz);
  const light = Math.max(0, (-dhx * sun.x + sun.y - dhz * sun.z) / normalLen);
  const altitude = (at(i, j) - min) / span;
  return Math.min(1, 0.22 + 0.4 * altitude + 0.38 * light);
}

export function terrainShades(
  world: World,
  missionArea: { minX: number; minZ: number; width: number; depth: number },
  sunDirection: readonly [number, number, number],
  steps: number,
): Float32Array {
  const heights = sampleHeights(world, missionArea, steps);
  const { min, max } = rangeOf(heights);
  const span = max - min || 1;
  const cellW = missionArea.width / (steps - 1);
  const cellD = missionArea.depth / (steps - 1);
  const worldPerCell = Math.hypot(cellW, cellD) || 1;
  // Slope from central differences; the sun is normalized once here so the per-cell dot is
  // just multiplies. Lighting above the horizon only: a sun below it would invert the map.
  const sunLen = Math.hypot(sunDirection[0], sunDirection[1], sunDirection[2]) || 1;
  const sun = {
    x: sunDirection[0] / sunLen,
    y: sunDirection[1] / sunLen,
    z: sunDirection[2] / sunLen,
  };
  const shade = new Float32Array(steps * steps);
  for (let j = 0; j < steps; j += 1) {
    for (let i = 0; i < steps; i += 1) {
      shade[j * steps + i] = cellShade(heights, steps, sun, worldPerCell, min, span, i, j);
    }
  }
  return shade;
}

let terrainLayer: { key: string; canvas: HTMLCanvasElement } | null = null;

/** Paints (or reuses) the cached raster. The heightfield never changes mid-match, so the cache
 *  key is the canvas size, the sample count and a checksum of the samples themselves -- a
 *  different world repaints, the same world blits. */
function drawCommanderTerrain(
  ctx: CanvasRenderingContext2D,
  world: World,
  missionArea: { minX: number; minZ: number; width: number; depth: number },
  sunDirection: readonly [number, number, number],
): void {
  const { width, height } = ctx.canvas;
  const steps = TERRAIN_SHADE_STEPS;
  const shade = terrainShades(world, missionArea, sunDirection, steps);
  let checksum = 0;
  for (let i = 0; i < shade.length; i += 97) checksum += shade[i] ?? 0;
  const key = `${String(width)}x${String(height)}:${String(steps)}:${checksum.toFixed(4)}`;
  if (!terrainLayer || terrainLayer.key !== key) {
    const canvas = document.createElement('canvas');
    canvas.width = steps;
    canvas.height = steps;
    const raster = canvas.getContext('2d');
    if (!raster) return;
    const image = raster.createImageData(steps, steps);
    for (let cell = 0; cell < steps * steps; cell += 1) {
      const v = shade[cell] ?? 0;
      // The ice palette the HUD already uses: near-background deep blue at the lows, snow at
      // the highs, so markers and the sensor envelopes keep their contrast against it.
      image.data[cell * 4] = Math.round(14 + 193 * v);
      image.data[cell * 4 + 1] = Math.round(26 + 190 * v);
      image.data[cell * 4 + 2] = Math.round(40 + 184 * v);
      image.data[cell * 4 + 3] = 255;
    }
    raster.putImageData(image, 0, 0);
    terrainLayer = { key, canvas };
  }
  ctx.drawImage(terrainLayer.canvas, 0, 0, width, height);
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
  drawCommanderTerrain(ctx, world, assets.scene.missionArea, assets.scene.sun.direction);
  drawBaseObjects(ctx, world, localTeam, toCanvas);
  drawPlayers(ctx, players, localTeam, sensedIds, toCanvas);
}
