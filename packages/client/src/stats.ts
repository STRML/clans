import { LIGHT_ARMOR, type World } from '@clans/sim';
import { EventKind, type EventMessage } from '@clans/protocol';
import type { AppStats } from './app.js';

export interface DebugRow {
  id: string;
  label: string;
  text: string;
  value: number;
}
export interface DebugExtra {
  projectileCount: number;
  lastEvent: string;
}

const fixed = (value: number, digits = 1): string => value.toFixed(digits);

/** Reads a Vec3-shaped slice out of a flat Float64Array, defaulting missing components to 0. */
function vec3At(arr: Float64Array, base: number): [number, number, number] {
  return [arr[base] ?? 0, arr[base + 1] ?? 0, arr[base + 2] ?? 0];
}

export function activeProjectileCount(world: World): number {
  let count = 0;
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (world.projectiles.active[id]) count += 1;
  }
  return count;
}

export function describeEvent(event: EventMessage): string {
  return `${EventKind[event.kind] ?? String(event.kind)} a=${String(event.a)} b=${String(event.b)}`;
}

export function describePlayer(
  world: World,
  playerId: number,
  stats: AppStats,
  extra: DebugExtra,
): DebugRow[] {
  const base = playerId * 3;
  const p = world.players;
  const [x, y, z] = vec3At(p.position, base);
  const [vx, vy, vz] = vec3At(p.velocity, base);
  const speed = Math.hypot(vx, vz);
  const energy = p.energy[playerId] ?? 0;
  const health = LIGHT_ARMOR.maxDamage - (p.damage[playerId] ?? 0);
  const onGround = p.onGround[playerId] ?? 0;
  const ski = p.ski[playerId] ?? 0;
  return [
    { id: 'debug-fps', label: 'fps', text: fixed(stats.fps, 0), value: stats.fps },
    {
      id: 'debug-frame-ms',
      label: 'frame',
      text: `${fixed(stats.frameMs, 2)} ms`,
      value: stats.frameMs,
    },
    { id: 'debug-sim-ms', label: 'sim', text: `${fixed(stats.simMs, 2)} ms`, value: stats.simMs },
    { id: 'debug-tick', label: 'tick', text: String(world.tick), value: world.tick },
    { id: 'debug-pos', label: 'pos', text: `${fixed(x)}, ${fixed(y)}, ${fixed(z)}`, value: y },
    { id: 'debug-vel', label: 'vel', text: `${fixed(vx)}, ${fixed(vy)}, ${fixed(vz)}`, value: vy },
    { id: 'debug-speed', label: 'speed', text: `${fixed(speed)} m/s`, value: speed },
    { id: 'debug-energy', label: 'energy', text: fixed(energy), value: energy },
    { id: 'debug-health', label: 'health', text: fixed(health, 2), value: health },
    { id: 'debug-ground', label: 'ground', text: String(onGround), value: onGround },
    { id: 'debug-ski', label: 'ski', text: String(ski), value: ski },
    { id: 'debug-ping', label: 'ping', text: `${fixed(stats.ping, 0)} ms`, value: stats.ping },
    {
      id: 'debug-bps',
      label: 'snapshot B/s',
      text: fixed(stats.bytesPerSecond, 0),
      value: stats.bytesPerSecond,
    },
    {
      id: 'debug-loss',
      label: 'loss',
      text: `${fixed(stats.packetLossEstimate * 100, 1)}%`,
      value: stats.packetLossEstimate,
    },
    {
      id: 'debug-prediction-error',
      label: 'predict err',
      text: `${fixed(stats.predictionErrorM, 2)} m`,
      value: stats.predictionErrorM,
    },
    {
      id: 'debug-entities',
      label: 'entities',
      text: String(stats.entityCount),
      value: stats.entityCount,
    },
    {
      id: 'debug-projectiles',
      label: 'projectiles',
      text: String(extra.projectileCount),
      value: extra.projectileCount,
    },
    { id: 'debug-last-event', label: 'last event', text: extra.lastEvent, value: 0 },
  ];
}
