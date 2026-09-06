import { LIGHT_ARMOR } from './armor.js';
import {
  applyDamage,
  applyKickback,
  playerHitbox,
  radiusFalloff,
  raySphereDistance,
  type PlayerHitbox,
} from './damage.js';
import { GRAVITY } from './movement.js';
import { sampleTerrain, type Heightfield, type TerrainSample } from './terrain.js';
import type { ProjectileStore, Vec3, World } from './types.js';
import {
  GRENADE_DATA,
  ProjectileType,
  WEAPON_DATA,
  WeaponId,
  type AmmoRefund,
  type FireEvent,
  type WeaponData,
} from './weapons.js';

export const PROJECTILE_CAPACITY = 256; // Ours: comfortably above what 32 players can sustain.
const FIXED_DT = 32 / 1000;
const TERRAIN_MARCH_STEP = 0.5; // meters: fine enough to not skip past a ridge in one tick.

/**
 * Marches from `origin` along unit `direction` for `length` meters at TERRAIN_MARCH_STEP
 * intervals, returning the first point that's inside solid ground (a non-empty square whose
 * height is at or above the point), or null if the ray never touches solid ground within that
 * distance. A single endpoint sample -- what this replaced -- treats an empty square (a real
 * hole in the terrain, see TerrainSample.empty) as ground, and can jump clean over a ridge or
 * a player-height gap crossed within one tick's travel (a 425 m/s Chaingun bullet covers
 * 13.6 m per 32 ms tick). Marching catches both: it skips empty squares entirely, and it
 * samples often enough that a ridge thinner than one step can't be stepped over unnoticed.
 * Shared by projectile terrain collision (previous->current swept segment) and the Laser
 * Rifle's line-of-sight check (origin->maxRange), which need the same "does this ray hit
 * terrain, and where" answer.
 */
function marchTerrain(
  terrain: Heightfield,
  origin: Vec3,
  direction: Vec3,
  length: number,
): { distance: number; point: Vec3; sample: TerrainSample } | null {
  if (length <= 0) return null;
  const steps = Math.max(1, Math.ceil(length / TERRAIN_MARCH_STEP));
  for (let i = 1; i <= steps; i += 1) {
    const distance = Math.min(length, (i / steps) * length);
    const point: Vec3 = {
      x: origin.x + direction.x * distance,
      y: origin.y + direction.y * distance,
      z: origin.z + direction.z * distance,
    };
    const sample = sampleTerrain(terrain, point.x, point.z);
    if (!sample.empty && point.y <= sample.height) return { distance, point, sample };
  }
  return null;
}

/** marchTerrain over a previous->current tick segment rather than an origin+direction+range
 *  ray -- the shape projectile terrain collision needs, vs. the hitscan occlusion check's. */
function terrainHitAlongSegment(
  terrain: Heightfield,
  previous: Vec3,
  current: Vec3,
): { distance: number; point: Vec3; sample: TerrainSample } | null {
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) {
    const sample = sampleTerrain(terrain, current.x, current.z);
    return !sample.empty && current.y <= sample.height
      ? { distance: 0, point: current, sample }
      : null;
  }
  const direction: Vec3 = { x: dx / length, y: dy / length, z: dz / length };
  return marchTerrain(terrain, previous, direction, length);
}

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

/** The actual point `distance` meters along the previous->current segment -- NOT the segment's
 *  raw endpoint, which is what a fast projectile's swept-hit distance used to be resolved
 *  against instead (Codex review round 3, finding 3). A zero-length segment (previous ===
 *  current) has no direction to interpolate along, so it just returns that shared point. */
function pointAlongSegment(previous: Vec3, current: Vec3, distance: number): Vec3 {
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return current;
  const t = distance / length;
  return { x: previous.x + dx * t, y: previous.y + dy * t, z: previous.z + dz * t };
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
    pendingFreeIds: [],
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

/** Deactivates `id` and defers it into `pendingFreeIds` rather than `freeIds` directly, so
 *  `allocate` can't hand it straight back out to another weapon fired later in this same
 *  `stepProjectiles` call. See ProjectileStore.pendingFreeIds and flushPendingFreeIds. */
function free(store: ProjectileStore, id: number): void {
  store.active[id] = 0;
  store.pendingFreeIds.push(id);
}

/** Drains last tick's freed ids into the real `freeIds` pool -- called at the very start of
 *  `stepProjectiles`, mirroring how weapons.ts's `applyPendingAmmoRefunds` drains
 *  `world.pendingAmmoRefunds` at the start of its own next `stepWeapons` call. By the time
 *  this runs, at least one full snapshot has already gone out with these ids inactive and
 *  unallocated (Codex review round 7, finding 5). */
function flushPendingFreeIds(store: ProjectileStore): void {
  for (const id of store.pendingFreeIds) store.freeIds.push(id);
  store.pendingFreeIds = [];
}

function velocityFor(direction: Vec3, speed: number, shooterVel: Vec3, velInherit: number): Vec3 {
  return {
    x: direction.x * speed + shooterVel.x * velInherit,
    y: direction.y * speed + shooterVel.y * velInherit,
    z: direction.z * speed + shooterVel.z * velInherit,
  };
}

/** Records a shot that already spent its ammo/grenade in stepWeapons but found the 256-slot
 *  projectile store full -- see AmmoRefund and stepWeapons's applyPendingAmmoRefunds, which
 *  credits it back one tick later. */
function refundAmmo(world: World, event: FireEvent): void {
  const refund: AmmoRefund = {
    playerId: event.playerId,
    weaponId: event.weaponId,
    isAltFire: event.isAltFire,
  };
  world.pendingAmmoRefunds.push(refund);
}

function spawnStored(
  world: World,
  event: FireEvent,
  type: ProjectileType,
  weaponId: WeaponId,
  speed: number,
  velInherit: number,
): number | null {
  const id = allocate(world.projectiles);
  if (id === null) {
    refundAmmo(world, event);
    return null;
  }
  const store = world.projectiles;
  store.type[id] = type;
  store.weaponId[id] = weaponId;
  store.ownerId[id] = event.playerId;
  store.position.set([event.origin.x, event.origin.y, event.origin.z], id * 3);
  const velocity = velocityFor(event.direction, speed, event.shooterVelocity, velInherit);
  store.velocity.set([velocity.x, velocity.y, velocity.z], id * 3);
  // Correlates this event back to the exact projectile it spawned -- see FireEvent.projectileId
  // for why server/net.ts's lag-comp correction needs this (Codex review round 5, finding 1).
  event.projectileId = id;
  return id;
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

/** Finds the *nearest* player hit along the previous->current swept segment, not the first
 *  one encountered by ascending id -- two candidates on the same ray used to return whichever
 *  had the lower id, regardless of which was actually closer to where the shot started.
 *  Returns the distance alongside the id so stepLinearOrTracer can compare it against a
 *  terrain hit on the same segment (Codex review round 2, finding 1): resolving this before
 *  checking terrain let a shot that crossed a ridge first still detonate on a player standing
 *  on the far side, instead of stopping at the ridge it should have hit first.
 *
 *  Takes `ownerId` directly rather than a live projectile's id so `hitTestTracer`'s
 *  side-effect-free recheck can run this exact same search against a hypothetical
 *  (event-described, not-yet-spawned) segment, with no projectile store entry to read an
 *  ownerId back out of; `findDirectHit` below is the live-projectile wrapper over this. */
function findDirectHitFrom(
  world: World,
  ownerId: number,
  previous: Vec3,
  current: Vec3,
): { playerId: number; distance: number } | null {
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  let nearest: { playerId: number; distance: number } | null = null;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!isValidTarget(world, playerId, ownerId)) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(previous, direction, hitbox);
    if (distance === null || distance > length || (nearest && distance >= nearest.distance))
      continue;
    nearest = { playerId, distance };
  }
  return nearest;
}

function findDirectHit(
  world: World,
  id: number,
  previous: Vec3,
  current: Vec3,
): { playerId: number; distance: number } | null {
  return findDirectHitFrom(world, world.projectiles.ownerId[id] ?? -1, previous, current);
}

/** Distance to hitbox contact this tick: 0 if `current` already overlaps it, else the swept
 *  previous->current entry distance if the path crosses it, else null for no contact at all.
 *  Split out of grenadeHitPlayer to keep that function's branch count under the complexity
 *  budget -- see grenadeHitPlayer's own comment for why both checks are needed. */
function sphereContactDistance(
  previous: Vec3,
  current: Vec3,
  direction: Vec3 | null,
  length: number,
  hitbox: PlayerHitbox,
): number | null {
  const px = current.x - hitbox.center.x,
    py = current.y - hitbox.center.y,
    pz = current.z - hitbox.center.z;
  if (Math.hypot(px, py, pz) <= hitbox.radius) return 0;
  if (!direction) return null;
  const sweepDistance = raySphereDistance(previous, direction, hitbox);
  return sweepDistance !== null && sweepDistance <= length ? sweepDistance : null;
}

/** The armed grenade's per-tick contact check: nearest player either already overlapping the
 *  current position, or swept over by the previous->current path this tick. A point-only
 *  check at the post-integration position alone (what this used to be) misses a player who
 *  sat entirely between the previous and current sample points -- a 63.7 m/s mortar covers
 *  about 2 m per 32 ms tick, well past a player's ~1.2 m hitbox diameter, so it can tunnel
 *  straight through someone without either endpoint ever landing inside their hitbox.
 *  raySphereDistance alone can't cover the "already inside" case: a zero-length direction
 *  (previous === current, or the point already overlaps at the segment's very start) makes
 *  it resolve to "no hit" for every point strictly inside the sphere, since its t comes out
 *  negative -- so sphereContactDistance's direct overlap check stays alongside the sweep. */
function grenadeHitPlayer(
  world: World,
  id: number,
  previous: Vec3,
  current: Vec3,
): { playerId: number; distance: number } | null {
  const store = world.projectiles;
  const ownerId = store.ownerId[id] ?? -1;
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz);
  const direction = length > 0 ? { x: dx / length, y: dy / length, z: dz / length } : null;
  let nearest: { playerId: number; distance: number } | null = null;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!isValidTarget(world, playerId, ownerId)) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = sphereContactDistance(previous, current, direction, length, hitbox);
    if (distance === null || (nearest && distance >= nearest.distance)) continue;
    nearest = { playerId, distance };
  }
  return nearest;
}

/** Picks whichever of a terrain hit or a player hit is nearer along the previous->current
 *  segment, and resolves to that hit's OWN point -- not always the terrain point, which is
 *  what an armed grenade used to resolve at unconditionally whenever a terrain hit existed
 *  on the segment at all, regardless of whether a player was actually contacted first. This
 *  mirrors the terrain-vs-player distance comparison stepLinearOrTracer's own hit-test
 *  already makes (Codex review round 2, finding 1); grenades never got the same treatment
 *  until now (Codex review round 3, finding 3). Returns null when the segment hit neither. */
function nearerGrenadeContact(
  previous: Vec3,
  current: Vec3,
  terrainHit: { distance: number; point: Vec3 } | null,
  hitPlayer: { playerId: number; distance: number } | null,
): { point: Vec3; playerId: number | null } | null {
  if (terrainHit && (!hitPlayer || terrainHit.distance <= hitPlayer.distance)) {
    return { point: terrainHit.point, playerId: null };
  }
  if (hitPlayer) {
    return {
      point: pointAlongSegment(previous, current, hitPlayer.distance),
      playerId: hitPlayer.playerId,
    };
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

/** The authoritative hit-test's own result for one tick of a synchronously-resolving
 *  projectile -- see FireEvent's hitPlayerId/hitPoint for why this exists and what the
 *  no-hit defaults mean. Exported so `hitTestFireEvent`'s callers (server/net.ts's narrow
 *  lag-compensation recheck) can type its result without reaching into this file's internals. */
export interface HitResult {
  hitPlayerId: number;
  hitPoint: Vec3 | null;
}
const NO_HIT: HitResult = { hitPlayerId: -1, hitPoint: null };

/** Steps one non-grenade projectile (Linear or Tracer) a tick and resolves whichever it hits
 *  first along the previous->current segment: terrain or a player. Both checks run every
 *  tick and the closer of the two wins -- checking player-hit alone and only falling back to
 *  terrain on a miss (this used to) let a shot that crossed a ridge first still detonate on
 *  a player standing behind it, since the player-hit check never knew the ridge was in the
 *  way (Codex review round 2, finding 1). Returns this tick's HitResult so spawnFromEvent's
 *  same-tick Tracer resolution can record it onto the FireEvent that spawned it; the normal
 *  per-tick loop in stepProjectiles ignores the return value. */
function stepLinearOrTracer(world: World, id: number, dt: number): HitResult {
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
  const directHit = findDirectHit(world, id, previous, current);
  const terrainHit = terrainHitAlongSegment(world.terrain, previous, current);
  if (terrainHit && (!directHit || terrainHit.distance <= directHit.distance)) {
    resolveImpact(world, id, data, terrainHit.point, null);
    return NO_HIT;
  }
  if (directHit) {
    // The actual point of contact along the segment, NOT the segment's raw endpoint -- a
    // fast projectile (a 90+ m/s Spinfusor disc, say) can travel several meters past the
    // hit distance in a single 32 ms tick, so resolving at `current` instead put radius
    // falloff and kickback several meters from where the collision geometrically happened
    // (Codex review round 3, finding 3).
    const hitPoint = pointAlongSegment(previous, current, directHit.distance);
    resolveImpact(world, id, data, hitPoint, directHit.playerId);
    return { hitPlayerId: directHit.playerId, hitPoint };
  }
  if (expireOneTick(store, id, data.lifetime)) free(store, id);
  return NO_HIT;
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
  const previous = readVec3(store.position, id * 3);
  const current = integrateGrenade(store, id, dt);
  const isMortar = store.weaponId[id] === WeaponId.Mortar;
  const elapsed = (store.expiresAtTick[id] ?? 0) + 1;
  store.expiresAtTick[id] = elapsed;
  armGrenadeIfDue(store, id, elapsed, isMortar);

  const terrainHit = terrainHitAlongSegment(world.terrain, previous, current);
  const armed = store.armed[id] === 1;
  const hitPlayer = armed ? grenadeHitPlayer(world, id, previous, current) : null;
  const data: ImpactData = isMortar ? WEAPON_DATA[WeaponId.Mortar] : GRENADE_DATA;
  const contact = armed ? nearerGrenadeContact(previous, current, terrainHit, hitPlayer) : null;
  if (contact) {
    resolveImpact(world, id, data, contact.point, contact.playerId);
    return;
  }
  if (terrainHit) {
    writeVec3(store.position, id * 3, terrainHit.point);
    bounce(world, id, terrainHit.sample.normal);
  }
  if (elapsed >= grenadeLifetimeTicks(isMortar))
    finalizeGrenadeLifetime(world, id, data, current, armed);
}

/** Nearest player hit within maxRange, but not through terrain: a target behind a ridge or
 *  hill has always had a clear ray-sphere intersection here, since this search never checked
 *  terrain at all -- only the line-of-sight distance a solid wall of terrain would cut the
 *  ray off at (marchTerrain's first hit, or maxRange if the ray stays clear) limits how far a
 *  hit can be credited. */
function nearestHitscanTarget(
  world: World,
  event: FireEvent,
  maxRange: number,
): { playerId: number; distance: number } | null {
  const terrainHit = marchTerrain(world.terrain, event.origin, event.direction, maxRange);
  const visibleRange = terrainHit ? terrainHit.distance : maxRange;
  let nearest: { playerId: number; distance: number } | null = null;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!isValidTarget(world, playerId, event.playerId)) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(event.origin, event.direction, hitbox);
    if (distance === null || distance > visibleRange) continue;
    if (!nearest || distance < nearest.distance) nearest = { playerId, distance };
  }
  return nearest;
}

function resolveHitscan(world: World, event: FireEvent, data: WeaponData): void {
  // The hit-test runs right here, whether or not it finds a target -- so `resolved` is set
  // unconditionally, before the miss branch can return early. See FireEvent.resolved (Codex
  // review round 4, finding 3).
  event.resolved = true;
  const nearest = nearestHitscanTarget(world, event, data.maxRange ?? 0);
  if (!nearest) return;
  const hitbox = playerHitbox(world, nearest.playerId, LIGHT_ARMOR);
  const hitPoint: Vec3 = {
    x: event.origin.x + event.direction.x * nearest.distance,
    y: event.origin.y + event.direction.y * nearest.distance,
    z: event.origin.z + event.direction.z * nearest.distance,
  };
  const multiplier = hitPoint.y >= hitbox.headY ? (data.headMultiplier ?? 1) : 1;
  applyDamage(
    world,
    nearest.playerId,
    data.directDamage * event.energyScale * multiplier,
    event.playerId,
    LIGHT_ARMOR,
  );
  // Same-tick resolution: this weapon (the Laser Rifle) is one of the two hitscan/tracer
  // cases FireEvent's hitPlayerId/hitPoint comment calls out, so world.lastFireEvents can
  // carry the sim's own authoritative hit straight through to server/net.ts's laser-beam
  // broadcast (Codex review round 3, finding 4).
  event.hitPlayerId = nearest.playerId;
  event.hitPoint = hitPoint;
}

/** `hitTestFireEvent`'s Laser Rifle case: identical search to `resolveHitscan`'s own, minus
 *  applying damage or mutating `event` -- this is the whole point of the split, see
 *  `hitTestFireEvent`'s own doc comment. */
function hitTestHitscan(world: World, event: FireEvent, data: WeaponData): HitResult {
  const nearest = nearestHitscanTarget(world, event, data.maxRange ?? 0);
  if (!nearest) return NO_HIT;
  return {
    hitPlayerId: nearest.playerId,
    hitPoint: {
      x: event.origin.x + event.direction.x * nearest.distance,
      y: event.origin.y + event.direction.y * nearest.distance,
      z: event.origin.z + event.direction.z * nearest.distance,
    },
  };
}

/** `hitTestFireEvent`'s Chaingun case: rebuilds the exact one-tick travel segment
 *  `spawnFromEvent`'s immediate `stepLinearOrTracer` call resolves a live Tracer against
 *  (same `velocityFor` inputs, same `dt`), then redoes just that segment's terrain-vs-player
 *  hit-test -- terrain wins ties, matching `stepLinearOrTracer` -- without ever spawning a
 *  projectile or applying damage. */
function hitTestTracer(world: World, event: FireEvent, data: WeaponData, dt: number): HitResult {
  const velocity = velocityFor(event.direction, data.speed, event.shooterVelocity, data.velInherit);
  const current: Vec3 = {
    x: event.origin.x + velocity.x * dt,
    y: event.origin.y + velocity.y * dt,
    z: event.origin.z + velocity.z * dt,
  };
  const terrainHit = terrainHitAlongSegment(world.terrain, event.origin, current);
  const directHit = findDirectHitFrom(world, event.playerId, event.origin, current);
  if (!directHit || (terrainHit && terrainHit.distance <= directHit.distance)) return NO_HIT;
  return {
    hitPlayerId: directHit.playerId,
    hitPoint: pointAlongSegment(event.origin, current, directHit.distance),
  };
}

/**
 * Non-mutating hit-test for a same-tick-resolving fire event (the Laser Rifle's hitscan, or
 * the Chaingun's Tracer), re-run against whatever positions currently sit in
 * `world.players.position`. Applies no damage, spawns no projectile, and never mutates
 * `event`. Exists so a caller -- server/net.ts's narrow lag-compensation recheck -- can
 * temporarily substitute a target's rewound position into `world.players.position`, call
 * this, and restore the true position right after, without re-running any part of
 * `stepWorld`. This is the design `stepWorld` itself replaced: rewinding positions and
 * running the FULL simulation against them corrupted everything else that tick's simulation
 * touched for the rewound player -- energy, ammo, velocity, even fall damage -- because only
 * position ever got restored afterward (Codex PR #9 round 3, P1 finding 1). This function is
 * the narrow alternative: it touches nothing but the hit-test itself.
 *
 * Any other weapon (a Spinfusor disc, a Mortar shell, a thrown grenade, or an alt-fire) never
 * resolves within the tick it fires -- see FireEvent's hitPlayerId/hitPoint comment -- so
 * this always reports no hit for one; there is nothing yet to recheck a lag-compensated
 * position against.
 */
export function hitTestFireEvent(world: World, event: FireEvent, dt: number): HitResult {
  if (event.isAltFire) return NO_HIT;
  const data = WEAPON_DATA[event.weaponId];
  if (data.projectile === null) return hitTestHitscan(world, event, data);
  if (data.projectile === ProjectileType.Tracer) return hitTestTracer(world, event, data, dt);
  return NO_HIT;
}

/**
 * Frees a specific still-flying projectile by id -- exported for server/net.ts's
 * applyLagCompensatedHits, which calls this once a rewound recheck (hitTestFireEvent above)
 * determines a live-missed Chaingun/Tracer shot would have hit under lag compensation. That
 * correction applies damage directly via applyDamage, entirely outside this file's normal
 * resolveImpact path, so without an explicit deactivation the tracer stays active and keeps
 * traveling: a miss only advances a projectile's lifetime, it never despawns one. Left alone,
 * that live projectile can go on to score a second, independent hit on a later tick's
 * stepProjectiles pass -- one non-penetrating shot damaging two players (Codex review round
 * 5, finding 1).
 *
 * A no-op for an id that's out of range or already inactive (already resolved its own live
 * hit or terrain contact, expired, or simply never spawned -- FireEvent.projectileId defaults
 * to -1), so a caller never needs to check that first.
 */
export function deactivateProjectile(world: World, id: number): void {
  if (id < 0 || id >= world.projectiles.active.length || !world.projectiles.active[id]) return;
  free(world.projectiles, id);
}

function spawnFromEvent(world: World, event: FireEvent, dt: number): void {
  if (event.isAltFire) {
    spawnStored(world, event, ProjectileType.Grenade, event.weaponId, GRENADE_DATA.speed, 1);
    return;
  }
  const data = WEAPON_DATA[event.weaponId];
  if (data.projectile === null) {
    resolveHitscan(world, event, data);
    return;
  }
  const id = spawnStored(
    world,
    event,
    data.projectile,
    event.weaponId,
    data.speed,
    data.velInherit,
  );
  // Tracer weapons (the Chaingun) are marked for lag-comp rewind in server/net.ts just like
  // the genuinely hitscan Laser Rifle: net.ts rewinds every non-shooter's position before
  // calling stepWorld and restores it right after stepWorld returns. A Tracer projectile
  // that waited for its *next* stepProjectiles call to be integrated and hit-tested -- this
  // file's normal one-tick spawn latency, see stepProjectiles's own comment -- would run
  // that test only after positions were already restored, missing the rewind window
  // entirely and defeating the whole point of marking it for lag comp. Stepping it once,
  // immediately, in the same tick it spawns resolves it while the rewind is still active,
  // exactly like the Laser Rifle's resolveHitscan call above already does. The Chaingun is
  // FireEvent's other same-tick case: record whatever this resolved onto the event so
  // world.lastFireEvents carries it too (Codex review round 3, finding 4).
  if (id !== null && data.projectile === ProjectileType.Tracer) {
    const result = stepLinearOrTracer(world, id, dt);
    event.hitPlayerId = result.hitPlayerId;
    event.hitPoint = result.hitPoint;
    // Only reached when spawnStored actually allocated a slot above -- a full store returns
    // id === null and refunds the ammo instead, leaving `resolved` at its false default so a
    // caller can tell "never fired into the world" apart from "fired and missed". See
    // FireEvent.resolved (Codex review round 4, finding 3).
    event.resolved = true;
  }
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
 * Exception: a Tracer (Chaingun) shot resolves immediately in spawnFromEvent instead of
 * waiting out this latency -- see that function's comment for why lag comp requires it.
 */
export function stepProjectiles(world: World, dt: number): void {
  flushPendingFreeIds(world.projectiles);
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    if (world.projectiles.type[id] === ProjectileType.Grenade) stepGrenade(world, id, dt);
    else stepLinearOrTracer(world, id, dt);
  }
  // Recorded before draining, into a field this function doesn't itself clear (unlike
  // pendingFireEvents just below), so server/net.ts can still read this tick's fire events
  // -- to build a LaserFired broadcast -- after stepWorld has already returned. See
  // World.lastFireEvents.
  world.lastFireEvents = world.pendingFireEvents;
  for (const event of world.pendingFireEvents) spawnFromEvent(world, event, dt);
  world.pendingFireEvents = [];
}
