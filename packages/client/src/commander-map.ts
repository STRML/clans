import {
  BASE_OBJECT_DATA,
  BaseObjectKind,
  engagementRange,
  type TurretBarrelId,
  type World,
} from '@clans/sim';
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

export function sensedEnemyIds(
  world: World,
  localTeam: number,
  circles: readonly SensorCircle[],
): number[] {
  const ids: number[] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    if (world.players.team[id] === localTeam) continue;
    const base = id * 3;
    if (
      insideAnyCircle(
        world.players.position[base] ?? 0,
        world.players.position[base + 2] ?? 0,
        circles,
      )
    ) {
      ids.push(id);
    }
  }
  return ids;
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
  world: World,
  localTeam: number,
  sensedIds: readonly number[],
  toCanvas: (x: number, z: number) => [number, number],
): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const team = world.players.team[id] ?? 0;
    const isEnemy = team !== localTeam;
    if (isEnemy && !sensedIds.includes(id)) continue;
    const base = id * 3;
    const [cx, cz] = toCanvas(
      world.players.position[base] ?? 0,
      world.players.position[base + 2] ?? 0,
    );
    ctx.fillStyle = TEAM_COLOR[team] ?? '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cz, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawCommanderMap(
  ctx: CanvasRenderingContext2D,
  assets: Pick<KatabaticAssets, 'scene'>,
  world: World,
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
  drawPlayers(ctx, world, localTeam, sensedIds, toCanvas);
}
