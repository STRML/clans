import { LIGHT_ARMOR, type ArmorData } from './armor.js';
import type { Vec3, World } from './types.js';

export const RESPAWN_SECONDS = 5; // Ours: the spec asks for a pick, not a T2 number.
const FIXED_DT = 32 / 1000;
export const RESPAWN_TICKS = Math.round(RESPAWN_SECONDS / FIXED_DT);
// Ours: no true capsule-vs-ray test this milestone. A sphere at capsule center height,
// radius = the wider bounding-box axis / 2, is close enough for a demo's hit detection.
const HEAD_BAND = 0.15; // Top 15% of player height counts as a headshot for the Laser Rifle.

export interface PlayerHitbox {
  center: Vec3;
  radius: number;
  headY: number;
}

export function playerHitbox(world: World, id: number, armor: ArmorData): PlayerHitbox {
  const base = id * 3;
  const x = world.players.position[base] ?? 0;
  const y = world.players.position[base + 1] ?? 0;
  const z = world.players.position[base + 2] ?? 0;
  const [boxX, boxY, height] = armor.boundingBox;
  return {
    center: { x, y: y + height / 2, z },
    radius: Math.max(boxX, boxY) / 2,
    headY: y + height * (1 - HEAD_BAND),
  };
}

export function raySphereDistance(origin: Vec3, dir: Vec3, hitbox: PlayerHitbox): number | null {
  const ox = origin.x - hitbox.center.x;
  const oy = origin.y - hitbox.center.y;
  const oz = origin.z - hitbox.center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - hitbox.radius * hitbox.radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  // c <= 0 means the origin itself is at or inside the sphere (its distance from center is
  // <= radius) -- an immediate hit at distance 0, not a miss. The old `t < 0 -> null` here
  // conflated that case with the other way t can go negative: the sphere sits entirely
  // behind the ray's origin (c > 0), which is a genuine miss. Left unfixed, this cost both
  // an armed grenade that starts its sweep already inside a player (Codex review round 2,
  // finding 6) and a point-blank Chaingun/Laser hit, since both go through this one function
  // -- see projectiles.ts's findDirectHit and sphereContactDistance, its only two callers.
  if (c <= 0) return 0;
  const t = -b - Math.sqrt(discriminant);
  return t >= 0 ? t : null;
}

export function radiusFalloff(distance: number, radius: number): number {
  if (radius <= 0) return distance <= 0 ? 1 : 0;
  return Math.max(0, 1 - distance / radius);
}

export function applyKickback(
  world: World,
  id: number,
  direction: Vec3,
  magnitude: number,
  falloff: number,
  armor: ArmorData,
): void {
  if (falloff <= 0 || magnitude <= 0) return;
  const scale = (magnitude / armor.mass) * falloff;
  const base = id * 3;
  world.players.velocity[base] = (world.players.velocity[base] ?? 0) + direction.x * scale;
  world.players.velocity[base + 1] = (world.players.velocity[base + 1] ?? 0) + direction.y * scale;
  world.players.velocity[base + 2] = (world.players.velocity[base + 2] ?? 0) + direction.z * scale;
}

function scoreForDeath(world: World, victimId: number, attackerId: number): void {
  if (attackerId < 0) return; // Fall damage or another environmental cause: no score change.
  const players = world.players;
  if (attackerId === victimId) {
    players.score[victimId] = (players.score[victimId] ?? 0) - 10;
    return;
  }
  const sameTeam = players.team[attackerId] === players.team[victimId];
  players.score[attackerId] = (players.score[attackerId] ?? 0) + (sameTeam ? -10 : 10);
}

/** `attackerId` is -1 for fall damage or any other non-player cause. */
export function applyDamage(
  world: World,
  id: number,
  amount: number,
  attackerId: number,
  armor: ArmorData,
): void {
  const players = world.players;
  // God mode has to stop damage here, before anything downstream runs: stepWorld calls
  // stepPlayers -> stepWeapons -> stepProjectiles -> stepFlags in one synchronous pass (the
  // sim's Global Constraint -- stepWorld is the only public entry point), so a lethal hit
  // that reached this far would already have dropped a carried flag and recorded a
  // kill/score event before any reactive, post-hoc zeroing elsewhere could undo it. Codex
  // review round 3, finding 1.
  if (amount <= 0 || !players.active[id] || !players.alive[id] || players.godMode[id]) return;
  players.damage[id] = (players.damage[id] ?? 0) + amount;
  if ((players.damage[id] ?? 0) < armor.maxDamage) return;
  players.alive[id] = 0;
  players.respawnAt[id] = world.tick + RESPAWN_TICKS;
  world.pendingDeaths.push({ id, attackerId });
  scoreForDeath(world, id, attackerId);
}

export function applyFallDamage(
  world: World,
  id: number,
  landingSpeed: number,
  armor: ArmorData,
): void {
  if (landingSpeed <= armor.minJumpSpeed) return;
  applyDamage(world, id, (landingSpeed - armor.minJumpSpeed) * armor.speedDamageScale, -1, armor);
}

export function respawnPlayer(world: World, id: number, spawn: Vec3): void {
  const players = world.players;
  players.alive[id] = 1;
  players.damage[id] = 0;
  players.respawnAt[id] = -1;
  players.position.set([spawn.x, spawn.y, spawn.z], id * 3);
  // movement.ts's kill-plane fallback (resetToSpawn) reads players.spawn, not players.position,
  // when a player falls out of the world -- so this has to move too, or a player who respawns
  // somewhere new and later falls out lands all the way back at their original spawn instead
  // of the one they just respawned at (Codex review round 4, finding 7).
  players.spawn.set([spawn.x, spawn.y, spawn.z], id * 3);
  players.velocity.set([0, 0, 0], id * 3);
  // Codex review round 2, finding 4: this reset health/position/velocity but left energy,
  // ground contact, and jump-edge state exactly where death interrupted them, so a player
  // who died mid-jet came back alive with drained energy and had to recharge gradually
  // instead of spawning full. LIGHT_ARMOR (not a passed-in armor param) because this file's
  // respawnPlayer already has no armor parameter, and every armor-dependent value elsewhere
  // in the sim -- explode()'s hitbox, resetPlayerToSpawn's energy -- uses LIGHT_ARMOR
  // directly too: it's the only armor this milestone has.
  players.energy[id] = LIGHT_ARMOR.maxEnergy;
  players.onGround[id] = 0;
  players.wasGrounded[id] = 0;
  players.wasJumpHeld[id] = 0;
}

export function dueForRespawn(world: World): number[] {
  const ids: number[] = [];
  const players = world.players;
  for (let id = 0; id < players.count; id += 1) {
    const respawnAt = players.respawnAt[id] ?? -1;
    if (players.active[id] && !players.alive[id] && respawnAt >= 0 && world.tick >= respawnAt) {
      ids.push(id);
    }
  }
  return ids;
}
