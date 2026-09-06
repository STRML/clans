import { LIGHT_ARMOR } from './armor.js';
import type { PlayerStore, World } from './types.js';

export interface PlayerSnapshotData {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  energy: number;
  // Optional, not required: packages/protocol does not carry this field on the wire yet
  // (that lands with the weapons/CTF milestone's protocol task). A snapshot decoded from
  // the current wire format omits it, and deserializePlayer treats that as full health
  // rather than crediting a nonexistent hit.
  health?: number;
  weaponSlot: number;
  onGround: 0 | 1;
  ski: 0 | 1;
}

function num(arr: Float64Array | Uint8Array, i: number): number {
  return arr[i] ?? 0;
}

function bit(arr: Uint8Array, i: number): 0 | 1 {
  return num(arr, i) ? 1 : 0;
}

export function serializePlayer(world: World, id: number): PlayerSnapshotData {
  const p = world.players;
  const base = id * 3;
  return {
    id,
    team: num(p.team, id),
    x: num(p.position, base),
    y: num(p.position, base + 1),
    z: num(p.position, base + 2),
    vx: num(p.velocity, base),
    vy: num(p.velocity, base + 1),
    vz: num(p.velocity, base + 2),
    yaw: num(p.yaw, id),
    energy: num(p.energy, id),
    health: LIGHT_ARMOR.maxDamage - num(p.damage, id),
    weaponSlot: num(p.weaponSlot, id),
    onGround: bit(p.onGround, id),
    ski: bit(p.ski, id),
  };
}

export function serializeActivePlayers(world: World): PlayerSnapshotData[] {
  const out: PlayerSnapshotData[] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (world.players.active[id]) out.push(serializePlayer(world, id));
  }
  return out;
}

function growTo(players: PlayerStore, id: number): void {
  if (id >= players.energy.length)
    throw new RangeError(`Player id ${String(id)} exceeds store capacity`);
  while (players.count <= id) {
    players.active[players.count] = 0;
    players.count += 1;
  }
}

/** Writes a snapshot into its own id slot, growing the store if the id has not been seen yet. */
export function deserializePlayer(world: World, data: PlayerSnapshotData): void {
  const players = world.players;
  growTo(players, data.id);
  players.active[data.id] = 1;
  players.team[data.id] = data.team;
  players.position.set([data.x, data.y, data.z], data.id * 3);
  players.velocity.set([data.vx, data.vy, data.vz], data.id * 3);
  players.yaw[data.id] = data.yaw;
  players.energy[data.id] = data.energy;
  const health = data.health ?? LIGHT_ARMOR.maxDamage;
  players.damage[data.id] = LIGHT_ARMOR.maxDamage - health;
  players.alive[data.id] = health > 0 ? 1 : 0;
  players.weaponSlot[data.id] = data.weaponSlot;
  players.onGround[data.id] = data.onGround;
  players.ski[data.id] = data.ski;
}
