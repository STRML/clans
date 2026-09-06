import { LIGHT_ARMOR } from './armor.js';
import {
  applyDamage,
  applyKickback,
  playerHitbox,
  radiusFalloff,
  raySphereDistance,
} from './damage.js';
import { GRAVITY } from './movement.js';
import { sampleTerrain } from './terrain.js';
import type { ProjectileStore, Vec3, World } from './types.js';
import {
  GRENADE_DATA,
  ProjectileType,
  WEAPON_DATA,
  WeaponId,
  type FireEvent,
  type WeaponData,
} from './weapons.js';

export const PROJECTILE_CAPACITY = 256; // Ours: comfortably above what 32 players can sustain.
const FIXED_DT = 32 / 1000;

/** Shape resolveImpact needs from a weapon's or the hand grenade's data: enough to explode
 *  (radiusDamage > 0) or apply a single direct hit (directDamage), nothing else. */
interface ImpactData {
  radiusDamage: number;
  radius: number;
  kickback: number;
  directDamage?: number;
}

function readVec3(arr: Float64Array, base: number): Vec3 {
  return { x: arr[base] ?? 0, y: arr[base + 1] ?? 0, z: arr[base + 2] ?? 0 };
}

function writeVec3(arr: Float64Array, base: number, v: Vec3): void {
  arr[base] = v.x;
  arr[base + 1] = v.y;
  arr[base + 2] = v.z;
}

/** A player counts as a valid hit target when it's alive and isn't the one who fired the
 *  shot -- shared by the direct-hit, grenade-contact, and hitscan target searches so the
 *  "skip inactive/dead/self" rule lives in exactly one place. */
function isValidTarget(world: World, playerId: number, ownerId: number): boolean {
  return (
    world.players.active[playerId] === 1 &&
    world.players.alive[playerId] === 1 &&
    playerId !== ownerId
  );
}

export function createProjectileStore(capacity = PROJECTILE_CAPACITY): ProjectileStore {
  return {
    count: 0,
    freeIds: [],
    active: new Uint8Array(capacity),
    type: new Uint8Array(capacity),
    weaponId: new Uint8Array(capacity),
    ownerId: new Int16Array(capacity),
    position: new Float64Array(capacity * 3),
    velocity: new Float64Array(capacity * 3),
    expiresAtTick: new Float64Array(capacity),
    armed: new Uint8Array(capacity),
  };
}

function allocate(store: ProjectileStore): number | null {
  const id = store.freeIds.pop() ?? store.count;
  if (id >= store.active.length) return null; // Capacity exceeded: drop the shot silently.
  if (id === store.count) store.count += 1;
  store.active[id] = 1;
  store.expiresAtTick[id] = 0;
  store.armed[id] = 0;
  return id;
}

function free(store: ProjectileStore, id: number): void {
  store.active[id] = 0;
  store.freeIds.push(id);
}

function velocityFor(direction: Vec3, speed: number, shooterVel: Vec3, velInherit: number): Vec3 {
  return {
    x: direction.x * speed + shooterVel.x * velInherit,
    y: direction.y * speed + shooterVel.y * velInherit,
    z: direction.z * speed + shooterVel.z * velInherit,
  };
}

function spawnStored(
  world: World,
  event: FireEvent,
  type: ProjectileType,
  weaponId: WeaponId,
  speed: number,
  velInherit: number,
): void {
  const id = allocate(world.projectiles);
  if (id === null) return;
  const store = world.projectiles;
  store.type[id] = type;
  store.weaponId[id] = weaponId;
  store.ownerId[id] = event.playerId;
  store.position.set([event.origin.x, event.origin.y, event.origin.z], id * 3);
  const velocity = velocityFor(event.direction, speed, event.shooterVelocity, velInherit);
  store.velocity.set([velocity.x, velocity.y, velocity.z], id * 3);
}

function explode(
  world: World,
  point: Vec3,
  radiusDamage: number,
  radius: number,
  kickback: number,
  ownerId: number,
): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    const dx = hitbox.center.x - point.x,
      dy = hitbox.center.y - point.y,
      dz = hitbox.center.z - point.z;
    const distance = Math.hypot(dx, dy, dz);
    const falloff = radiusFalloff(distance, radius);
    if (falloff <= 0) continue;
    applyDamage(world, id, radiusDamage * falloff, ownerId, LIGHT_ARMOR);
    const length = distance || 1;
    applyKickback(
      world,
      id,
      { x: dx / length, y: dy / length, z: dz / length },
      kickback,
      falloff,
      LIGHT_ARMOR,
    );
  }
}

function findDirectHit(world: World, id: number, previous: Vec3, current: Vec3): number | null {
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  const ownerId = world.projectiles.ownerId[id] ?? -1;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!isValidTarget(world, playerId, ownerId)) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(previous, direction, hitbox);
    if (distance !== null && distance <= length) return playerId;
  }
  return null;
}

/** Point-in-sphere overlap, for the armed grenade's per-tick contact check. Reusing
 *  findDirectHit's swept-ray test with previous === current would degenerate to a
 *  zero-length direction vector, which raySphereDistance resolves to "no hit" for every
 *  point strictly inside the sphere (its t comes out negative) -- so a dedicated distance
 *  check is used here instead of pretending a stationary point is a ray. */
function grenadeHitPlayer(world: World, id: number): number | null {
  const store = world.projectiles;
  const point = readVec3(store.position, id * 3);
  const ownerId = store.ownerId[id] ?? -1;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!isValidTarget(world, playerId, ownerId)) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const dx = point.x - hitbox.center.x,
      dy = point.y - hitbox.center.y,
      dz = point.z - hitbox.center.z;
    if (Math.hypot(dx, dy, dz) <= hitbox.radius) return playerId;
  }
  return null;
}

function resolveImpact(
  world: World,
  id: number,
  data: ImpactData,
  point: Vec3,
  hitPlayerId: number | null,
): void {
  const owner = world.projectiles.ownerId[id] ?? -1;
  if (data.radiusDamage > 0) {
    explode(world, point, data.radiusDamage, data.radius, data.kickback, owner);
  } else if (hitPlayerId !== null) {
    applyDamage(world, hitPlayerId, data.directDamage ?? 0, owner, LIGHT_ARMOR);
  }
  free(world.projectiles, id);
}

function bounce(world: World, id: number, terrainNormal: Vec3): void {
  const store = world.projectiles;
  const base = id * 3;
  const velocity = readVec3(store.velocity, base);
  const along =
    velocity.x * terrainNormal.x + velocity.y * terrainNormal.y + velocity.z * terrainNormal.z;
  const elasticity = GRENADE_DATA.elasticity;
  writeVec3(store.velocity, base, {
    x: (velocity.x - 2 * along * terrainNormal.x) * elasticity,
    y: (velocity.y - 2 * along * terrainNormal.y) * elasticity,
    z: (velocity.z - 2 * along * terrainNormal.z) * elasticity,
  });
}

/** Advances one projectile's lifetime-elapsed counter by a tick and reports whether it has
 *  now outlived its weapon's lifetime. */
function expireOneTick(store: ProjectileStore, id: number, lifetimeSeconds: number): boolean {
  const elapsed = (store.expiresAtTick[id] ?? 0) + 1;
  store.expiresAtTick[id] = elapsed;
  return elapsed >= Math.round(lifetimeSeconds / FIXED_DT);
}

function stepLinearOrTracer(world: World, id: number, dt: number): void {
  const store = world.projectiles;
  const base = id * 3;
  const previous = readVec3(store.position, base);
  const velocity = readVec3(store.velocity, base);
  const current: Vec3 = {
    x: previous.x + velocity.x * dt,
    y: previous.y + velocity.y * dt,
    z: previous.z + velocity.z * dt,
  };
  writeVec3(store.position, base, current);
  const data = WEAPON_DATA[store.weaponId[id] as WeaponId];
  const hitPlayer = findDirectHit(world, id, previous, current);
  if (hitPlayer !== null) {
    resolveImpact(world, id, data, current, hitPlayer);
    return;
  }
  const terrain = sampleTerrain(world.terrain, current.x, current.z);
  if (current.y <= terrain.height) {
    resolveImpact(world, id, data, current, null);
    return;
  }
  if (expireOneTick(store, id, data.lifetime)) free(store, id);
}

function grenadeArmTicks(isMortar: boolean): number {
  return Math.round(
    (isMortar ? (WEAPON_DATA[WeaponId.Mortar].armTime ?? 0) : GRENADE_DATA.armTime) / FIXED_DT,
  );
}
function grenadeLifetimeTicks(isMortar: boolean): number {
  return Math.round(
    (isMortar ? WEAPON_DATA[WeaponId.Mortar].lifetime : GRENADE_DATA.lifetime) / FIXED_DT,
  );
}

function integrateGrenade(store: ProjectileStore, id: number, dt: number): Vec3 {
  const base = id * 3;
  const velocity = readVec3(store.velocity, base);
  const drag = Math.max(0, 1 - GRENADE_DATA.drag * dt);
  const nextVelocity: Vec3 = {
    x: velocity.x * drag,
    y: velocity.y - GRAVITY * dt,
    z: velocity.z * drag,
  };
  writeVec3(store.velocity, base, nextVelocity);
  const position = readVec3(store.position, base);
  const nextPosition: Vec3 = {
    x: position.x + nextVelocity.x * dt,
    y: position.y + nextVelocity.y * dt,
    z: position.z + nextVelocity.z * dt,
  };
  writeVec3(store.position, base, nextPosition);
  return nextPosition;
}

/** Sets the armed flag once the grenade has been flying for its arm delay. Split out of
 *  stepGrenade purely to keep that function's branch count under the complexity budget. */
function armGrenadeIfDue(
  store: ProjectileStore,
  id: number,
  elapsed: number,
  isMortar: boolean,
): void {
  if (!store.armed[id] && elapsed >= grenadeArmTicks(isMortar)) store.armed[id] = 1;
}

/** Detonates an armed grenade whose lifetime just ran out with nothing else triggering it,
 *  or simply frees an unarmed one -- the tail of stepGrenade's lifetime-expiry branch. */
function finalizeGrenadeLifetime(
  world: World,
  id: number,
  data: ImpactData,
  current: Vec3,
  armed: boolean,
): void {
  if (armed) resolveImpact(world, id, data, current, null);
  else free(world.projectiles, id);
}

function stepGrenade(world: World, id: number, dt: number): void {
  const store = world.projectiles;
  const current = integrateGrenade(store, id, dt);
  const isMortar = store.weaponId[id] === WeaponId.Mortar;
  const elapsed = (store.expiresAtTick[id] ?? 0) + 1;
  store.expiresAtTick[id] = elapsed;
  armGrenadeIfDue(store, id, elapsed, isMortar);

  const terrain = sampleTerrain(world.terrain, current.x, current.z);
  const grounded = current.y <= terrain.height;
  const armed = store.armed[id] === 1;
  const hitPlayer = armed ? grenadeHitPlayer(world, id) : null;
  const data: ImpactData = isMortar ? WEAPON_DATA[WeaponId.Mortar] : GRENADE_DATA;
  if (armed && (grounded || hitPlayer !== null)) {
    resolveImpact(world, id, data, current, hitPlayer);
    return;
  }
  if (grounded) {
    store.position[id * 3 + 1] = terrain.height;
    bounce(world, id, terrain.normal);
  }
  if (elapsed >= grenadeLifetimeTicks(isMortar))
    finalizeGrenadeLifetime(world, id, data, current, armed);
}

function nearestHitscanTarget(
  world: World,
  event: FireEvent,
  maxRange: number,
): { playerId: number; distance: number } | null {
  let nearest: { playerId: number; distance: number } | null = null;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!isValidTarget(world, playerId, event.playerId)) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(event.origin, event.direction, hitbox);
    if (distance === null || distance > maxRange) continue;
    if (!nearest || distance < nearest.distance) nearest = { playerId, distance };
  }
  return nearest;
}

function resolveHitscan(world: World, event: FireEvent, data: WeaponData): void {
  const nearest = nearestHitscanTarget(world, event, data.maxRange ?? 0);
  if (!nearest) return;
  const hitbox = playerHitbox(world, nearest.playerId, LIGHT_ARMOR);
  const hitY = event.origin.y + event.direction.y * nearest.distance;
  const multiplier = hitY >= hitbox.headY ? (data.headMultiplier ?? 1) : 1;
  applyDamage(
    world,
    nearest.playerId,
    data.directDamage * event.energyScale * multiplier,
    event.playerId,
    LIGHT_ARMOR,
  );
}

function spawnFromEvent(world: World, event: FireEvent): void {
  if (event.isAltFire) {
    spawnStored(world, event, ProjectileType.Grenade, event.weaponId, GRENADE_DATA.speed, 1);
    return;
  }
  const data = WEAPON_DATA[event.weaponId];
  if (data.projectile === null) {
    resolveHitscan(world, event, data);
    return;
  }
  spawnStored(world, event, data.projectile, event.weaponId, data.speed, data.velInherit);
}

/**
 * Steps every already-flying projectile before materializing this tick's new shots, so a
 * projectile spawned this tick starts moving on the *next* call rather than integrating
 * and colliding within the same tick it was created (a disc fired one meter above a slope
 * would otherwise tunnel through the ground before anything could ever observe it as
 * active). This is a one-tick spawn latency, imperceptible at a 32 ms tick rate.
 * `pendingFireEvents` is drained here (not just reset by stepWeapons at the top of the
 * next real tick) so direct, repeated calls to stepProjectiles -- as this file's own tests
 * make, without an intervening stepWeapons call -- don't re-fire the same event forever.
 */
export function stepProjectiles(world: World, dt: number): void {
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    if (world.projectiles.type[id] === ProjectileType.Grenade) stepGrenade(world, id, dt);
    else stepLinearOrTracer(world, id, dt);
  }
  for (const event of world.pendingFireEvents) spawnFromEvent(world, event);
  world.pendingFireEvents = [];
}
