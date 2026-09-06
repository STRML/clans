import type { World } from './types.js';

const FNV_PRIME = 0x01000193;

/**
 * Folds one number into the running hash. Positions and velocities are rounded to the
 * millimetre before mixing: the wire format quantizes them to f32, and at the map's
 * largest coordinates f32 round trip error stays under 0.001 m, so this rounding survives
 * an encode/decode cycle without changing the hash.
 */
function mix(hash: number, value: number): number {
  // All four bytes of the millimetre integer: positions reach 1024 m (20 bits).
  const bits = Math.round(value * 1000) | 0;
  let h = hash;
  for (let shift = 0; shift < 32; shift += 8) {
    h = (h ^ ((bits >>> shift) & 0xff)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

function num(arr: Float64Array | Uint8Array, i: number): number {
  return arr[i] ?? 0;
}

function mixPlayer(hash: number, players: World['players'], id: number): number {
  const base = id * 3;
  let h = mix(hash, id);
  h = mix(h, num(players.team, id));
  h = mix(h, num(players.position, base));
  h = mix(h, num(players.position, base + 1));
  h = mix(h, num(players.position, base + 2));
  h = mix(h, num(players.velocity, base));
  h = mix(h, num(players.velocity, base + 1));
  h = mix(h, num(players.velocity, base + 2));
  h = mix(h, num(players.yaw, id));
  h = mix(h, num(players.energy, id));
  h = mix(h, num(players.damage, id));
  return h;
}

export function hashWorld(world: World): number {
  let hash = 0x811c9dc5;
  hash = mix(hash, world.tick);
  const p = world.players;
  for (let id = 0; id < p.count; id += 1) {
    if (!p.active[id]) continue;
    hash = mixPlayer(hash, p, id);
  }
  return hash >>> 0;
}
