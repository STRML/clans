import type { World } from './types.js';
import { ammoIndex, WeaponId } from './weapons.js';

const FNV_PRIME = 0x01000193;

/**
 * Folds one number into the running hash. Positions and velocities are rounded to the
 * millimetre before mixing: the wire format quantizes them to f32, and at the map's
 * largest coordinates f32 round trip error stays under 0.001 m, so this rounding survives
 * an encode/decode cycle without changing the hash. The same rounding is harmless for the
 * plain integers mixed below (ids, states, team numbers) -- scaling an exact integer by 1000
 * is still an exact, deterministic function of it.
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

function num(arr: Float64Array | Uint8Array | Uint16Array | Int16Array, i: number): number {
  return arr[i] ?? 0;
}

/**
 * Mixes in every field of PlayerStore that is real simulation state, not just position/
 * velocity/yaw/energy/damage/weaponSlot. Through round 11 this stopped at weaponSlot and
 * never touched ammo, grenades, or the weapon/grenade state machines (weaponState,
 * weaponTimer, spunUp, grenadeCooldown) -- all of which stepWeapons (weapons.ts) mutates
 * every tick and all of which are now wired onto the wire snapshot (snapshot.ts) precisely
 * because they can diverge between client prediction and the server. A hash that never
 * mixed them in could report two worlds identical when their weapon state had actually
 * drifted apart, silently defeating the determinism check the spec's Testing section
 * documents. Codex review round 12 (PR #9), finding 2.
 */
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
  h = mix(h, num(players.weaponSlot, id));
  h = mix(h, num(players.ammo, ammoIndex(id, WeaponId.Spinfusor)));
  h = mix(h, num(players.ammo, ammoIndex(id, WeaponId.Chaingun)));
  h = mix(h, num(players.ammo, ammoIndex(id, WeaponId.Mortar)));
  h = mix(h, num(players.grenades, id));
  h = mix(h, num(players.weaponState, id));
  h = mix(h, num(players.weaponTimer, id));
  h = mix(h, num(players.spunUp, id));
  h = mix(h, num(players.grenadeCooldown, id));
  return h;
}

function mixProjectiles(hash: number, world: World): number {
  let h = hash;
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    const base = id * 3;
    h = mix(h, id);
    h = mix(h, num(world.projectiles.type, id));
    h = mix(h, num(world.projectiles.weaponId, id));
    h = mix(h, num(world.projectiles.position, base));
    h = mix(h, num(world.projectiles.position, base + 1));
    h = mix(h, num(world.projectiles.position, base + 2));
    h = mix(h, num(world.projectiles.velocity, base));
    h = mix(h, num(world.projectiles.velocity, base + 1));
    h = mix(h, num(world.projectiles.velocity, base + 2));
    h = mix(h, num(world.projectiles.ownerId, id));
  }
  return h;
}

function mixFlags(hash: number, world: World): number {
  let h = hash;
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const base = id * 3;
    h = mix(h, id);
    h = mix(h, num(world.flags.team, id));
    h = mix(h, num(world.flags.state, id));
    h = mix(h, num(world.flags.carrierId, id));
    h = mix(h, num(world.flags.position, base));
    h = mix(h, num(world.flags.position, base + 1));
    h = mix(h, num(world.flags.position, base + 2));
  }
  return h;
}

export function hashWorld(world: World): number {
  let hash = 0x811c9dc5;
  hash = mix(hash, world.tick);
  hash = mix(hash, world.gameOver ? 1 : 0);
  hash = mix(hash, world.winnerTeam);
  hash = mix(hash, world.gameOverReason);
  hash = mix(hash, num(world.teamScores, 1));
  hash = mix(hash, num(world.teamScores, 2));
  const p = world.players;
  for (let id = 0; id < p.count; id += 1) {
    if (!p.active[id]) continue;
    hash = mixPlayer(hash, p, id);
  }
  hash = mixProjectiles(hash, world);
  hash = mixFlags(hash, world);
  return hash >>> 0;
}
