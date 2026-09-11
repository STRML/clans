import { armorFor } from './armor.js';
import { applyBaseObjectDamage, BaseObjectKind } from './baseObjects.js';
import {
  applyDamage,
  applyKickback,
  playerHitbox,
  radiusFalloff,
  raySphereDistance,
  type PlayerHitbox,
} from './damage.js';
import { raycastInteriors } from './interiors.js';
import { interiorFieldColliders } from './occlusion.js';
import { GRAVITY } from './movement.js';
import { sampleTerrain, type Heightfield, type TerrainSample } from './terrain.js';
import {
  ProjectileImpactReason,
  type PendingFreeId,
  type ProjectileStore,
  type Vec3,
  type World,
} from './types.js';
import {
  applyTurretDamage,
  distanceToTurretHitShape,
  rayTurretHitShapeDistance,
  TURRET_BARREL_DATA,
  turretHitShape,
  type TurretBarrelData,
  type TurretBarrelId,
  type TurretFireEvent,
  type TurretHitShape,
} from './turrets.js';
import {
  applyVehicleDamage,
  isProtectedSeat,
  VEHICLE_DATA,
  VEHICLE_WEAPON_DATA,
  VehicleKind,
  VehicleWeaponId,
  type VehicleFireEvent,
} from './vehicles.js';
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
// Ours, but not arbitrary: must stay >= the server's real snapshot cadence,
// SNAPSHOT_EVERY_N_TICKS in packages/protocol/src/messages.ts (= 2 as of Codex review round
// 8), or a freed projectile id can be reallocated before any snapshot ever shows it absent --
// see ProjectileStore.pendingFreeIds. packages/sim can't import that constant directly (its
// Global Constraint keeps it standalone, with no dependency on packages/protocol), so this is
// a literal picked with margin above the known cadence: verify it's still >= that constant's
// current value if this ever needs revisiting.
const PROJECTILE_ID_REUSE_DELAY_TICKS = 3;

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

/** The nearer of a terrain hit and an interior/force-field hit along the same
 *  previous->current segment — failure matrix rows 14 and 17. An empty collider list (the
 *  common case for every M1-M3 test, and for any map without buildings or force fields)
 *  costs one array length check, not a wasted triangle scan. */
function worldHitAlongSegment(
  world: World,
  previous: Vec3,
  current: Vec3,
  shooterTeam: number,
): { distance: number; point: Vec3; sample?: TerrainSample; normal?: Vec3 } | null {
  const terrainHit = terrainHitAlongSegment(world.terrain, previous, current);
  const colliders = interiorFieldColliders(world, shooterTeam);
  if (colliders.length === 0) return terrainHit;
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return terrainHit;
  const direction: Vec3 = { x: dx / length, y: dy / length, z: dz / length };
  const interiorHit = raycastInteriors(colliders, previous, direction, length);
  if (!terrainHit) return interiorHit;
  if (!interiorHit) return terrainHit;
  return interiorHit.distance <= terrainHit.distance ? interiorHit : terrainHit;
}

/** The `marchTerrain`-shaped sibling of `worldHitAlongSegment`, for an origin+direction+range
 *  ray rather than a previous->current tick segment — the shape `nearestHitscanTarget`'s
 *  occlusion check needs. */
function worldMarch(
  world: World,
  origin: Vec3,
  direction: Vec3,
  length: number,
  shooterTeam: number,
): { distance: number } | null {
  const terrainHit = marchTerrain(world.terrain, origin, direction, length);
  const colliders = interiorFieldColliders(world, shooterTeam);
  if (colliders.length === 0) return terrainHit;
  const interiorHit = raycastInteriors(colliders, origin, direction, length);
  if (!terrainHit) return interiorHit;
  if (!interiorHit) return terrainHit;
  return interiorHit.distance <= terrainHit.distance ? interiorHit : terrainHit;
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
 *  "skip inactive/dead/self" rule lives in exactly one place.
 *
 *  A mounted player in a PROTECTED seat is never a valid target (issue #57 follow-up): their
 *  position is seat-locked to their vehicle's own transform (vehicles.ts's stepVehicles), so
 *  without this exclusion a shot would test both the vehicle's own hit-sphere
 *  (nearestStructureHitFrom, now vehicle-aware) AND the tiny player hitbox sitting at that
 *  exact same point -- and since a player hitbox is far smaller than a vehicle's
 *  checkRadius, findDirectHitFrom would almost always win the nearestOfThree race with a
 *  shorter distance, landing every hit on the PILOT directly and bypassing the vehicle's
 *  shield/health pool entirely. Real T2 has no separate pilot hitbox while mounted; only the
 *  vehicle can be shot.
 *
 *  That exclusion is exactly the script's own `isProtectedMountPoint` rule
 *  (player.cs:2681-2732: damage to a crewman in a protected node is redirected onto the
 *  vehicle), so it is applied per seat now instead of to every mounted player: a seat its own
 *  kind does NOT mark protected is hittable normally. Every seat of every kind is protected in
 *  the scripts, so nothing observable changes for the vehicles that exist -- but the rule is
 *  the data's, not a blanket. */
function isValidTarget(world: World, playerId: number, ownerId: number): boolean {
  return (
    world.players.active[playerId] === 1 &&
    world.players.alive[playerId] === 1 &&
    playerId !== ownerId &&
    !isProtectedSeat(world, playerId)
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
    team: new Uint8Array(capacity),
    sourceTurretId: new Int16Array(capacity).fill(-1),
    sourceVehicleId: new Int16Array(capacity).fill(-1),
    position: new Float64Array(capacity * 3),
    velocity: new Float64Array(capacity * 3),
    expiresAtTick: new Float64Array(capacity),
    armed: new Uint8Array(capacity),
    impactSequence: 0,
    lastImpacts: [],
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
 *  `stepProjectiles` call -- or any call within PROJECTILE_ID_REUSE_DELAY_TICKS of this one.
 *  See ProjectileStore.pendingFreeIds and flushPendingFreeIds. */
function free(store: ProjectileStore, id: number): void {
  store.active[id] = 0;
  store.pendingFreeIds.push({ id, ticksRemaining: PROJECTILE_ID_REUSE_DELAY_TICKS });
}

/** Emits one authoritative ProjectileImpact (#52) into the store's per-tick record list:
 *  contact position, weapon, projectile type, reason, and the next monotonic sequence number.
 *  Every stopping or reflecting path in this file funnels through here -- resolveImpact for
 *  detonations and direct hits, the lifetime-expiry branches, the two bounce branches, and
 *  deactivateProjectile's lag-comp correction -- so a client never has to infer an impact from
 *  a projectile's disappearance from a snapshot again, which mis-fired for shots born and
 *  freed between snapshots, reported stale positions, and read lifetime removals as impacts. */
function recordImpact(world: World, id: number, point: Vec3, reason: ProjectileImpactReason): void {
  const store = world.projectiles;
  store.impactSequence += 1;
  store.lastImpacts.push({
    x: point.x,
    y: point.y,
    z: point.z,
    weaponId: store.weaponId[id] ?? 0,
    type: store.type[id] ?? 0,
    reason,
    seq: store.impactSequence,
  });
}

/** Counts down every pending id's remaining delay by one call, moving any that have now
 *  waited out PROJECTILE_ID_REUSE_DELAY_TICKS into the real `freeIds` pool -- called at the
 *  very start of `stepProjectiles`, mirroring how weapons.ts's `applyPendingAmmoRefunds`
 *  drains `world.pendingAmmoRefunds` at the start of its own next `stepWeapons` call. By the
 *  time an id reaches `freeIds`, at least PROJECTILE_ID_REUSE_DELAY_TICKS calls have passed
 *  since it was freed -- comfortably more than the server's real snapshot cadence, so at
 *  least one full snapshot has gone out with the id inactive and unallocated (Codex review
 *  round 7, finding 5; round 8, finding 1, for why one tick alone wasn't enough). */
function flushPendingFreeIds(store: ProjectileStore): void {
  const stillPending: PendingFreeId[] = [];
  for (const pending of store.pendingFreeIds) {
    const ticksRemaining = pending.ticksRemaining - 1;
    if (ticksRemaining <= 0) store.freeIds.push(pending.id);
    else stillPending.push({ id: pending.id, ticksRemaining });
  }
  store.pendingFreeIds = stillPending;
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
  store.team[id] = world.players.team[event.playerId] ?? 0;
  store.sourceTurretId[id] = -1; // Reset on every (re)allocation -- see this field's own comment.
  store.sourceVehicleId[id] = -1; // Same reset, for the M5 sibling field.
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
    // Same protected-seat rule as isValidTarget's own comment explains for direct hits: a
    // crewman in a protected mount node is not individually hittable -- splash that reaches
    // the vehicle (explodeVehicles, below) damages it instead, and real T2 has no separate
    // pilot hitbox while mounted at all. A crewman in an unprotected node takes the splash
    // like anyone else (no kind in the scripts has one; the rule is the data's).
    if (isProtectedSeat(world, id)) continue;
    const armor = armorFor(world, id);
    const hitbox = playerHitbox(world, id, armor);
    const dx = hitbox.center.x - point.x,
      dy = hitbox.center.y - point.y,
      dz = hitbox.center.z - point.z;
    const distance = Math.hypot(dx, dy, dz);
    const falloff = radiusFalloff(distance, radius);
    if (falloff <= 0) continue;
    applyDamage(world, id, radiusDamage * falloff, ownerId, armor);
    const length = distance || 1;
    applyKickback(
      world,
      id,
      { x: dx / length, y: dy / length, z: dz / length },
      kickback,
      falloff,
      armor,
    );
  }
}

function distanceToPoint(positions: Float64Array, base: number, point: Vec3): number {
  return Math.hypot(
    (positions[base] ?? 0) - point.x,
    (positions[base + 1] ?? 0) - point.y,
    (positions[base + 2] ?? 0) - point.z,
  );
}

function explodeBaseObjects(world: World, point: Vec3, radiusDamage: number, radius: number): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.destroyed[id]) continue;
    const falloff = radiusFalloff(distanceToPoint(bases.position, id * 3, point), radius);
    if (falloff > 0) applyBaseObjectDamage(world, id, radiusDamage * falloff);
  }
}

/** Issue #54: the blast measures to the turret's own collision shape, not to its ground
 *  anchor. A Spinfusor that lands on the barrel used to read as 1.83 m further away than it
 *  visually was (the anchor sits at the placement's feet, the barrel at 1.83 m), so the
 *  falloff it took was not the falloff it earned; `distanceToTurretHitShape` is the same
 *  helper the direct-hit search resolves against. */
function explodeTurrets(world: World, point: Vec3, radiusDamage: number, radius: number): void {
  const turrets = world.turrets;
  for (let id = 0; id < turrets.count; id += 1) {
    if (turrets.destroyed[id]) continue;
    const distance = distanceToTurretHitShape(turretHitShape(world, id), point);
    const falloff = radiusFalloff(distance, radius);
    if (falloff > 0) applyTurretDamage(world, id, radiusDamage * falloff);
  }
}

/** M5: splash also reaches a vehicle standing in the blast, same falloff math against its
 *  own position. Not in the plan's own Task 6 text (which only extended the direct-hit/
 *  tracer search), but the file structure's own summary calls vehicles a "hittable/blocking
 *  category" alongside players/base objects/turrets with no splash-shaped carve-out, and a
 *  Spinfusor or Mortar that can blow up a generator but never scratch a parked Wildcat next
 *  to it would be a real, player-visible gap -- not worth leaving in given how cheap the fix
 *  is (see the PR body for this judgment call). */
function explodeVehicles(
  world: World,
  point: Vec3,
  radiusDamage: number,
  radius: number,
  attackerId: number,
): void {
  const vehicles = world.vehicles;
  for (let id = 0; id < vehicles.count; id += 1) {
    if (!vehicles.active[id] || vehicles.destroyed[id]) continue;
    const falloff = radiusFalloff(distanceToPoint(vehicles.position, id * 3, point), radius);
    if (falloff > 0) applyVehicleDamage(world, id, radiusDamage * falloff, attackerId);
  }
}

/** Splash also reaches a base object, turret, or vehicle standing in the blast: same falloff
 *  math, reusing radiusFalloff against the structure's own hit-sphere center -- except the
 *  turret, which measures to its measured collision shape (see explodeTurrets). */
function explodeStructures(
  world: World,
  point: Vec3,
  radiusDamage: number,
  radius: number,
  attackerId: number,
): void {
  explodeBaseObjects(world, point, radiusDamage, radius);
  explodeTurrets(world, point, radiusDamage, radius);
  explodeVehicles(world, point, radiusDamage, radius, attackerId);
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
    const hitbox = playerHitbox(world, playerId, armorFor(world, playerId));
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

export const BASE_OBJECT_HIT_RADIUS = 1.5; // Ours — see this plan's "ours" numbers table.

interface StructureHit {
  kind: 'baseObject' | 'turret' | 'vehicle';
  id: number;
  distance: number;
}

/** Same "nearest along the swept segment" search `findDirectHitFrom` runs for players, over
 *  base objects, turrets, and (M5) vehicles instead — a projectile can hit whichever of the
 *  four (player, base object, turret, vehicle) is nearest; `stepLinearOrTracer` compares
 *  every result. No team filter on the hit-test itself (matches M3's existing player-vs-
 *  player model, where any weapon can damage a teammate) — only turret target *acquisition*
 *  excludes a turret's own team, not a hit-test against one. */
interface StructureArray {
  count: number;
  position: Float64Array;
  destroyed: Uint8Array;
  /** Uniform hit radius; unused when `shapeFor` supplies the turret's measured volumes. */
  radius: number;
  /** Per-id override for a store whose hit-sphere radius isn't uniform (vehicles: Shrike
   *  5.5 m vs. Wildcat 1.7785 m) -- falls back to `radius` above when absent. */
  radiusFor?: (id: number) => number;
  /** Issue #54: stores whose hit volume is not a sphere at all (turrets) return their shared
   *  measured shape here, and the ray resolves against its cylinders/capsule instead of a
   *  hit-sphere. */
  shapeFor?: (id: number) => TurretHitShape;
  kind: StructureHit['kind'];
  skip?: (id: number) => boolean;
}

/** Nearest hit along a segment against one structure array (base objects, turrets, or
 *  vehicles) -- shared by every half of `nearestStructureHitFrom` so each stays under the
 *  complexity budget instead of duplicating the same scan-and-compare loop three times. */
function positionAt(positions: Float64Array, base: number): Vec3 {
  return { x: positions[base] ?? 0, y: positions[base + 1] ?? 0, z: positions[base + 2] ?? 0 };
}

function structureCandidateDistance(
  previous: Vec3,
  direction: Vec3,
  array: StructureArray,
  id: number,
): number | null {
  const shape = array.shapeFor?.(id);
  if (shape) return rayTurretHitShapeDistance(previous, direction, shape);
  const hitbox: PlayerHitbox = {
    center: positionAt(array.position, id * 3),
    radius: array.radiusFor?.(id) ?? array.radius,
    headY: Infinity,
  };
  return raySphereDistance(previous, direction, hitbox);
}

function nearestFromArray(
  previous: Vec3,
  direction: Vec3,
  length: number,
  array: StructureArray,
): StructureHit | null {
  let nearest: StructureHit | null = null;
  for (let id = 0; id < array.count; id += 1) {
    if (array.destroyed[id] || array.skip?.(id)) continue;
    const distance = structureCandidateDistance(previous, direction, array, id);
    if (distance === null || distance > length || (nearest && distance >= nearest.distance))
      continue;
    nearest = { kind: array.kind, id, distance };
  }
  return nearest;
}

function nearestStructureHitFrom(
  world: World,
  previous: Vec3,
  current: Vec3,
  excludeTurretId: number,
  excludeVehicleId = -1,
): StructureHit | null {
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  const direction: Vec3 = { x: dx / length, y: dy / length, z: dz / length };
  const bases = world.baseObjects;
  const baseHit = nearestFromArray(previous, direction, length, {
    count: bases.count,
    position: bases.position,
    destroyed: bases.destroyed,
    radius: BASE_OBJECT_HIT_RADIUS,
    kind: 'baseObject',
    // Force fields are hittable only as the plane geometry activeForceFieldBlockers/
    // worldHitAlongSegment already resolve, never as a generic point sphere — the plan's own
    // "ours" table scopes this 1.5 m hit-sphere to Generator/Sensor/StationInventory/
    // StationVehiclePad only. Without this skip, a shot that legitimately passes a friendly
    // (non-blocking) or already-bypassed force field would still "hit" the field's own
    // BaseObjectStore entry at its exact position and detonate there instead of continuing
    // on to whatever lies beyond it.
    skip: (id) => bases.kind[id] === BaseObjectKind.ForceField,
  });
  const turrets = world.turrets;
  const turretHit = nearestFromArray(previous, direction, length, {
    count: turrets.count,
    position: turrets.position,
    destroyed: turrets.destroyed,
    // Unused: `shapeFor` below supplies the turret's measured volumes (issue #54).
    radius: 0,
    shapeFor: (id) => turretHitShape(world, id),
    kind: 'turret',
    // Excludes the turret that fired this exact shot -- see ProjectileStore.sourceTurretId.
    skip: (id) => id === excludeTurretId,
  });
  const vehicles = world.vehicles;
  const vehicleHit = nearestFromArray(previous, direction, length, {
    count: vehicles.count,
    position: vehicles.position,
    destroyed: vehicles.destroyed,
    radius: 0,
    radiusFor: (id) => VEHICLE_DATA[vehicles.kind[id] as VehicleKind].checkRadius,
    kind: 'vehicle',
    // Excludes the firing vehicle from its own shot -- see ProjectileStore.sourceVehicleId.
    skip: (id) => id === excludeVehicleId,
  });
  return nearestOfStructures(baseHit, turretHit, vehicleHit);
}

/** Whichever of up to three structure candidates has the smallest `distance`, or null if all
 *  three missed -- split out of `nearestStructureHitFrom` to keep that function's own
 *  complexity under budget. */
function nearestOfStructures(
  baseHit: StructureHit | null,
  turretHit: StructureHit | null,
  vehicleHit: StructureHit | null,
): StructureHit | null {
  let nearest = baseHit;
  if (turretHit && (!nearest || turretHit.distance < nearest.distance)) nearest = turretHit;
  if (vehicleHit && (!nearest || vehicleHit.distance < nearest.distance)) nearest = vehicleHit;
  return nearest;
}

function applyStructureDamage(
  structure: StructureHit,
  amount: number,
  world: World,
  attackerId: number,
): void {
  if (structure.kind === 'baseObject') applyBaseObjectDamage(world, structure.id, amount);
  else if (structure.kind === 'turret') applyTurretDamage(world, structure.id, amount);
  else applyVehicleDamage(world, structure.id, amount, attackerId);
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
    const hitbox = playerHitbox(world, playerId, armorFor(world, playerId));
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
  reason: ProjectileImpactReason,
  hitStructure: StructureHit | null = null,
): void {
  const owner = world.projectiles.ownerId[id] ?? -1;
  if (data.radiusDamage > 0) {
    explode(world, point, data.radiusDamage, data.radius, data.kickback, owner);
    explodeStructures(world, point, data.radiusDamage, data.radius, owner);
  } else if (hitStructure) {
    applyStructureDamage(hitStructure, data.directDamage ?? 0, world, owner);
  } else if (hitPlayerId !== null) {
    applyDamage(world, hitPlayerId, data.directDamage ?? 0, owner, armorFor(world, hitPlayerId));
  }
  // The record is emitted before the slot is freed, from the exact contact point the damage
  // was resolved against (#52) -- never the segment endpoint the shot happened to reach this
  // tick, which is the stale position the old disappearance-diff FX reported.
  recordImpact(world, id, point, reason);
  free(world.projectiles, id);
}

function bounce(world: World, id: number, terrainNormal: Vec3, elasticity: number): void {
  const store = world.projectiles;
  const base = id * 3;
  const velocity = readVec3(store.velocity, base);
  const along =
    velocity.x * terrainNormal.x + velocity.y * terrainNormal.y + velocity.z * terrainNormal.z;
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

/** `ProjectileStore.weaponId` is a `Uint8Array` shared by both player weapons (`WeaponId`,
 *  0-4) and turret barrels (`TurretBarrelId`, 0-2); this offset keeps the two ranges from
 *  colliding on the wire. */
export const TURRET_WEAPON_ID_OFFSET = 100;
/** Same collision-avoidance offset, one range over, for the vehicle weapons: stored id 150 +
 *  VehicleWeaponId. `dataForStoredWeapon` and `ordnanceFor` both resolve the range by
 *  subtraction, so adding a weapon kind extends it without touching either lookup. Exported
 *  for the client's own weapon-id-range checks (audio.ts's impact cues), exactly like
 *  TURRET_WEAPON_ID_OFFSET above. */
export const VEHICLE_WEAPON_ID_OFFSET = 150;

function dataForStoredWeapon(weaponId: number): WeaponData | TurretBarrelData {
  if (weaponId >= VEHICLE_WEAPON_ID_OFFSET) {
    // Structurally a TurretBarrelData plus the ordnance fields -- see VehicleWeaponData.
    return VEHICLE_WEAPON_DATA[(weaponId - VEHICLE_WEAPON_ID_OFFSET) as VehicleWeaponId];
  }
  return weaponId >= TURRET_WEAPON_ID_OFFSET
    ? TURRET_BARREL_DATA[(weaponId - TURRET_WEAPON_ID_OFFSET) as TurretBarrelId]
    : WEAPON_DATA[weaponId as WeaponId];
}

/** `a`/`b`/`c` are each either null or an object carrying a `distance` — returns whichever is
 *  nearest, or null if all three are. Used by `stepLinearOrTracer` to pick among a terrain/
 *  interior/force-field hit, a structure hit, and a player hit on the same segment. */
function nearestOfThree<
  A extends { distance: number } | null,
  B extends { distance: number } | null,
  C extends { distance: number } | null,
>(a: A, b: B, c: C): A | B | C {
  let best: A | B | C = a;
  if (b && (!best || b.distance < best.distance)) best = b;
  if (c && (!best || c.distance < best.distance)) best = c;
  return best;
}

/** Steps one non-grenade projectile (Linear or Tracer) a tick and resolves whichever it hits
 *  first along the previous->current segment: terrain/interior/force-field, a base object or
 *  turret, or a player. All three checks run every tick and the closest wins -- checking
 *  player-hit alone and only falling back to terrain on a miss (this used to) let a shot that
 *  crossed a ridge first still detonate on a player standing behind it, since the player-hit
 *  check never knew the ridge was in the way (Codex review round 2, finding 1). Returns this
 *  tick's HitResult so spawnFromEvent's same-tick Tracer resolution can record it onto the
 *  FireEvent that spawned it; the normal per-tick loop in stepProjectiles ignores the return
 *  value. */
/** The three-way hit resolution `stepLinearOrTracer` needs, split out to keep that function's
 *  own complexity under budget: resolves whichever of a terrain/interior/force-field hit, a
 *  base-object/turret hit, or a player hit is nearest along the segment, or returns null when
 *  the segment hit nothing at all (the caller then only has expiry left to check). */
function resolveLinearHit(
  world: World,
  id: number,
  data: WeaponData | TurretBarrelData,
  previous: Vec3,
  current: Vec3,
  worldHit: ReturnType<typeof worldHitAlongSegment>,
  structureHit: StructureHit | null,
  directHit: { playerId: number; distance: number } | null,
): HitResult | null {
  const nearest = nearestOfThree(worldHit, directHit, structureHit);
  if (nearest === worldHit && worldHit) {
    resolveImpact(world, id, data, worldHit.point, null, ProjectileImpactReason.World);
    return NO_HIT;
  }
  if (nearest === structureHit && structureHit) {
    const hitPoint = pointAlongSegment(previous, current, structureHit.distance);
    resolveImpact(world, id, data, hitPoint, null, ProjectileImpactReason.World, structureHit);
    return NO_HIT;
  }
  if (nearest === directHit && directHit) {
    // The actual point of contact along the segment, NOT the segment's raw endpoint -- a
    // fast projectile (a 90+ m/s Spinfusor disc, say) can travel several meters past the
    // hit distance in a single 32 ms tick, so resolving at `current` instead put radius
    // falloff and kickback several meters from where the collision geometrically happened
    // (Codex review round 3, finding 3).
    const hitPoint = pointAlongSegment(previous, current, directHit.distance);
    resolveImpact(world, id, data, hitPoint, directHit.playerId, ProjectileImpactReason.Direct);
    return { hitPlayerId: directHit.playerId, hitPoint };
  }
  return null;
}

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
  const data = dataForStoredWeapon(store.weaponId[id] ?? 0);
  const directHit = findDirectHit(world, id, previous, current);
  const structureHit = nearestStructureHitFrom(
    world,
    previous,
    current,
    store.sourceTurretId[id] ?? -1,
    store.sourceVehicleId[id] ?? -1,
  );
  const worldHit = worldHitAlongSegment(world, previous, current, store.team[id] ?? 0);
  const resolved = resolveLinearHit(
    world,
    id,
    data,
    previous,
    current,
    worldHit,
    structureHit,
    directHit,
  );
  if (resolved) return resolved;
  if (expireOneTick(store, id, data.lifetime)) {
    // #52: a lifetime expiry is a REMOVAL, not an impact. Recording it as a Timeout lets the
    // client skip detonation FX for it -- previously a Tracer or disc silently expiring mid-air
    // fired the same disappearance flash a real terrain strike did, at whatever position the
    // last snapshot happened to report.
    recordImpact(world, id, current, ProjectileImpactReason.Timeout);
    free(store, id);
  }
  return NO_HIT;
}

/** The ordnance numbers a stored grenade-type projectile flies on. `resolveImpact` only
 *  needs ImpactData's own four fields, and the flight needs the four optional ones --
 *  every source object (the hand grenade's GRENADE_DATA, the player mortar's WEAPON_DATA
 *  row, and each vehicle weapon's VEHICLE_WEAPON_DATA row) supplies all of them. Returning
 *  the shared table object itself, never a copy, keeps this allocation-free per tick. */
type OrdnanceData = ImpactData & {
  armTime?: number;
  lifetime?: number;
  drag?: number;
  elasticity?: number;
};

/** Which ordnance datablock a stored Grenade-type projectile belongs to, by its own weapon
 *  id: the vehicle range by offset (the Tank's mortar, the Bomber's bombs), the player
 *  Mortar's own row, else the hand grenade's. The hand grenade is what a thrown `altFire`
 *  produces (weapons.ts pushes it with the Spinfusor's weaponId, the value
 *  `spawnFromEvent`'s isAltFire branch never reads), which is why this is keyed on the
 *  Stored id and not on the fire event. */
function ordnanceFor(weaponId: number): OrdnanceData {
  if (weaponId >= VEHICLE_WEAPON_ID_OFFSET) {
    return VEHICLE_WEAPON_DATA[(weaponId - VEHICLE_WEAPON_ID_OFFSET) as VehicleWeaponId];
  }
  return weaponId === WeaponId.Mortar ? WEAPON_DATA[WeaponId.Mortar] : GRENADE_DATA;
}

function grenadeArmTicks(data: OrdnanceData): number {
  return Math.round((data.armTime ?? 0) / FIXED_DT);
}

function grenadeLifetimeTicks(data: OrdnanceData): number {
  return Math.round((data.lifetime ?? 0) / FIXED_DT);
}

function integrateGrenade(
  store: ProjectileStore,
  id: number,
  dt: number,
  data: OrdnanceData,
): Vec3 {
  const base = id * 3;
  const velocity = readVec3(store.velocity, base);
  const drag = Math.max(0, 1 - (data.drag ?? 0) * dt);
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
  data: OrdnanceData,
): void {
  if (!store.armed[id] && elapsed >= grenadeArmTicks(data)) store.armed[id] = 1;
}

/** Detonates an armed grenade whose lifetime just ran out with nothing else triggering it,
 *  or simply frees an unarmed one -- the tail of stepGrenade's lifetime-expiry branch. Both
 *  outcomes are authoritative Timeout records (#52): the armed case is a real detonation the
 *  client must render as one, the unarmed case (unreachable with the current GRENADE_DATA
 *  armTime < lifetime, kept for safety) is a silent removal the detonation-FX rule must not
 *  fire for -- it is a Grenade-type Timeout only in the armed branch's spirit; the record's
 *  type field says Grenade either way, so the client's timeout rule treats a Grenade-type
 *  Timeout as a detonation, which the unreachable unarmed case slightly over-renders. */
function finalizeGrenadeLifetime(
  world: World,
  id: number,
  data: ImpactData,
  current: Vec3,
  armed: boolean,
): void {
  if (armed) resolveImpact(world, id, data, current, null, ProjectileImpactReason.Timeout);
  else {
    recordImpact(world, id, current, ProjectileImpactReason.Timeout);
    free(world.projectiles, id);
  }
}

/** A terrain hit carries its normal on `sample`; an interior/force-field hit (from
 *  `worldHitAlongSegment`'s `raycastInteriors` branch) carries it directly on `normal`. Split
 *  out of `stepGrenade` to keep the `??`/`?.` chain from counting against that function's own
 *  complexity budget. */
function bounceNormalFor(hit: ReturnType<typeof worldHitAlongSegment>): Vec3 {
  return hit?.sample?.normal ?? hit?.normal ?? { x: 0, y: 1, z: 0 };
}

/** The armed-grenade contact check for this tick, or null while unarmed or on a miss. Split
 *  out of `stepGrenade` to keep that function's own complexity budget clear. */
function grenadeContactThisTick(
  world: World,
  id: number,
  previous: Vec3,
  current: Vec3,
  armed: boolean,
  terrainHit: ReturnType<typeof worldHitAlongSegment>,
): { point: Vec3; playerId: number | null } | null {
  if (!armed) return null;
  const hitPlayer = grenadeHitPlayer(world, id, previous, current);
  return nearerGrenadeContact(previous, current, terrainHit, hitPlayer);
}

function stepGrenade(world: World, id: number, dt: number): void {
  const store = world.projectiles;
  const previous = readVec3(store.position, id * 3);
  // The stored weapon decides every flight number: the hand grenade and the player Mortar as
  // before, and now the Tank's AssaultMortar / the Bomber's bombs through the vehicle range
  // (vehicles.ts's VEHICLE_WEAPON_DATA, each field cited to its own script line).
  const data = ordnanceFor(store.weaponId[id] ?? 0);
  const current = integrateGrenade(store, id, dt, data);
  const elapsed = (store.expiresAtTick[id] ?? 0) + 1;
  store.expiresAtTick[id] = elapsed;
  armGrenadeIfDue(store, id, elapsed, data);

  const terrainHit = worldHitAlongSegment(world, previous, current, store.team[id] ?? 0);
  const armed = store.armed[id] === 1;
  const contact = grenadeContactThisTick(world, id, previous, current, armed, terrainHit);
  if (contact) {
    // An armed grenade's contact resolution: Direct when the nearer contact was a player,
    // World when terrain/interior won the same segment -- the same two-way reason split
    // resolveLinearHit's own branches make (issue #52).
    const reason =
      contact.playerId === null ? ProjectileImpactReason.World : ProjectileImpactReason.Direct;
    resolveImpact(world, id, data, contact.point, contact.playerId, reason);
    return;
  }
  if (terrainHit) {
    // A bounce is a reflection, not a removal: the record (#52) tells the client to render a
    // puff at the contact point while the projectile keeps flying under its new velocity.
    recordImpact(world, id, terrainHit.point, ProjectileImpactReason.Bounce);
    writeVec3(store.position, id * 3, terrainHit.point);
    bounce(world, id, bounceNormalFor(terrainHit), data.elasticity ?? 0);
  }
  if (elapsed >= grenadeLifetimeTicks(data))
    finalizeGrenadeLifetime(world, id, data, current, armed);
}

/** T2's EnergyBolt has zero gravity, 0.05 drag, and 0.998 grenade elasticity
 * (weapons/blaster.cs:217-271). It damages actors/structures, but reflects from terrain and
 * interiors so the renderer can show the characteristic bouncing bolt and trail. */
function stepEnergy(world: World, id: number, dt: number): void {
  const store = world.projectiles;
  const base = id * 3;
  const previous = readVec3(store.position, base);
  const data = WEAPON_DATA[WeaponId.Blaster];
  const velocity = readVec3(store.velocity, base);
  const drag = Math.max(0, 1 - data.drag! * dt);
  const current = {
    x: previous.x + velocity.x * drag * dt,
    y: previous.y + velocity.y * drag * dt,
    z: previous.z + velocity.z * drag * dt,
  };
  writeVec3(store.velocity, base, {
    x: velocity.x * drag,
    y: velocity.y * drag,
    z: velocity.z * drag,
  });
  writeVec3(store.position, base, current);
  const worldHit = worldHitAlongSegment(world, previous, current, store.team[id] ?? 0);
  const directHit = findDirectHit(world, id, previous, current);
  const structureHit = nearestStructureHitFrom(
    world,
    previous,
    current,
    store.sourceTurretId[id] ?? -1,
    store.sourceVehicleId[id] ?? -1,
  );
  const nearest = nearestOfThree(worldHit, directHit, structureHit);
  if (nearest === worldHit && worldHit) {
    // Same bounce record as stepGrenade's (#52): reflection puff, projectile keeps flying.
    recordImpact(world, id, worldHit.point, ProjectileImpactReason.Bounce);
    writeVec3(store.position, base, worldHit.point);
    bounce(world, id, bounceNormalFor(worldHit), data.elasticity!);
  } else if (nearest) {
    resolveLinearHit(world, id, data, previous, current, null, structureHit, directHit);
  }
  // The active check matters: a bolt that just detonated above was already freed (and its
  // impact recorded) inside resolveLinearHit, and must not also gain a Timeout record.
  if (store.active[id] && expireOneTick(store, id, data.lifetime)) {
    recordImpact(world, id, current, ProjectileImpactReason.Timeout);
    free(store, id);
  }
}

/** The farthest distance along a Laser Rifle ray that anything solid still lets the beam
 *  travel: the nearest of a terrain/interior/force-field hit (`worldMarch`) and an intact
 *  base-object/turret/vehicle hit. Issue #21: `resolveHitscan`/`hitTestHitscan` used to
 *  consult only the former -- unlike the Chaingun/Spinfusor path's
 *  `nearestStructureHitFrom` -- so a player standing directly behind an intact generator,
 *  station, or turret took laser damage straight through it, live and in server/net.ts's
 *  lag-comp recheck alike (both paths run through `nearestHitscanTarget`). The structure
 *  half reuses that exact hit-sphere model by synthesizing a segment out to maxRange,
 *  with -1 for both source ids: a player's own FireEvent is never turret- or
 *  vehicle-sourced. maxRange when the ray is completely clear. */
function hitscanVisibleRange(world: World, event: FireEvent, maxRange: number): number {
  const worldHit = worldMarch(
    world,
    event.origin,
    event.direction,
    maxRange,
    world.players.team[event.playerId] ?? 0,
  );
  const structureHit = nearestStructureHitFrom(
    world,
    event.origin,
    {
      x: event.origin.x + event.direction.x * maxRange,
      y: event.origin.y + event.direction.y * maxRange,
      z: event.origin.z + event.direction.z * maxRange,
    },
    -1,
  );
  return Math.min(worldHit?.distance ?? maxRange, structureHit?.distance ?? maxRange);
}

/** Nearest player hit within the ray's visible span, but not through terrain,
 *  interiors/force fields, or an intact structure: a target behind any of them has always
 *  had a clear ray-sphere intersection here, since this search itself never checks any of
 *  them -- only the distance the nearest obstruction cuts the ray off at
 *  (`hitscanVisibleRange`) limits how far a hit can be credited, so whichever obstruction
 *  is closest always wins. */
function nearestHitscanTarget(
  world: World,
  event: FireEvent,
  visibleRange: number,
): { playerId: number; distance: number } | null {
  let nearest: { playerId: number; distance: number } | null = null;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!isValidTarget(world, playerId, event.playerId)) continue;
    const hitbox = playerHitbox(world, playerId, armorFor(world, playerId));
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
  const maxRange = data.maxRange ?? 0;
  // The beam ends at the nearest obstruction -- terrain, interior/force field, or (issue
  // #21) an intact base object/turret/vehicle -- not at maxRange, and not past a nearer
  // obstruction just because a farther one also stands in the way.
  const endpointDistance = hitscanVisibleRange(world, event, maxRange);
  event.beamEnd = {
    x: event.origin.x + event.direction.x * endpointDistance,
    y: event.origin.y + event.direction.y * endpointDistance,
    z: event.origin.z + event.direction.z * endpointDistance,
  };
  const nearest = nearestHitscanTarget(world, event, endpointDistance);
  if (!nearest) return;
  const hitbox = playerHitbox(world, nearest.playerId, armorFor(world, nearest.playerId));
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
    armorFor(world, nearest.playerId),
  );
  // Same-tick resolution: this weapon (the Laser Rifle) is one of the two hitscan/tracer
  // cases FireEvent's hitPlayerId/hitPoint comment calls out, so world.lastFireEvents can
  // carry the sim's own authoritative hit straight through to server/net.ts's laser-beam
  // broadcast (Codex review round 3, finding 4).
  event.hitPlayerId = nearest.playerId;
  event.hitPoint = hitPoint;
  event.beamEnd = hitPoint;
}

/** `hitTestFireEvent`'s Laser Rifle case: identical search to `resolveHitscan`'s own, minus
 *  applying damage or mutating `event` -- this is the whole point of the split, see
 *  `hitTestFireEvent`'s own doc comment. Same visible span, too: server/net.ts's lag-comp
 *  recheck inherits the structure occlusion from `hitscanVisibleRange` for free, so a
 *  rewound target standing behind an intact generator is not "corrected" into a hit
 *  through it (issue #21). */
function hitTestHitscan(world: World, event: FireEvent, data: WeaponData): HitResult {
  const visibleRange = hitscanVisibleRange(world, event, data.maxRange ?? 0);
  const nearest = nearestHitscanTarget(world, event, visibleRange);
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
 *  (same `velocityFor` inputs, same `dt`), then redoes that segment's three-way hit-test
 *  (terrain/interior/force-field, base object/turret, player) the exact same way
 *  `stepLinearOrTracer`/`resolveLinearHit` does for a live shot -- `nearestOfThree` ties break
 *  identically (terrain beats a tied player hit; a tied player hit beats a structure hit) --
 *  without ever spawning a projectile or applying damage.
 *
 *  Codex round 3 review of PR #11: this used to check only terrain/interiors/force-fields
 *  (`worldHitAlongSegment`) and the player, omitting the live path's base-object/turret check
 *  (`nearestStructureHitFrom`) entirely. server/net.ts's applyLagCompensatedHits calls this to
 *  substitute a rewound position and redo the hit-test for a shot the live sim missed; with no
 *  structure check here, a high-ping shooter could score -- and have real damage applied for --
 *  a "hit" through an intact generator, station, or turret standing directly between them and
 *  the target, something the live simulation would have stopped dead. -1 for excludeTurretId:
 *  a player's own FireEvent is never turret-sourced (only a real turret shot has one). */
function hitTestTracer(world: World, event: FireEvent, data: WeaponData, dt: number): HitResult {
  const velocity = velocityFor(event.direction, data.speed, event.shooterVelocity, data.velInherit);
  const current: Vec3 = {
    x: event.origin.x + velocity.x * dt,
    y: event.origin.y + velocity.y * dt,
    z: event.origin.z + velocity.z * dt,
  };
  const terrainHit = worldHitAlongSegment(
    world,
    event.origin,
    current,
    world.players.team[event.playerId] ?? 0,
  );
  const directHit = findDirectHitFrom(world, event.playerId, event.origin, current);
  const structureHit = nearestStructureHitFrom(world, event.origin, current, -1);
  const nearest = nearestOfThree(terrainHit, directHit, structureHit);
  if (!directHit || nearest !== directHit) return NO_HIT;
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
export function deactivateProjectile(world: World, id: number, impactPoint?: Vec3 | null): void {
  if (id < 0 || id >= world.projectiles.active.length || !world.projectiles.active[id]) return;
  // #52: a lag-compensated correction consumed a shot that really did hit a player -- record
  // the Direct impact at the rewound contact point so the corrected hit renders exactly like a
  // live one. Without this, the deactivation deleted the shot with no record at all and the
  // corrected hit produced no client-side effect (round 5, finding 1's deactivation path).
  if (impactPoint) recordImpact(world, id, impactPoint, ProjectileImpactReason.Direct);
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

/** Materializes one turret shot (Task 4's `stepTurrets`) as a real, damaging projectile —
 *  the turret-fired sibling of `spawnFromEvent`, with no `FireEvent`/ammo/player identity to
 *  read: `ownerId` is -1 (matches fall damage's own no-attribution convention) and `team`
 *  comes straight from the event instead of a player lookup. A Tracer barrel (AABarrelLarge)
 *  resolves same-tick just like a player's Chaingun shot does, for the same reason. */
function spawnTurretShot(world: World, event: TurretFireEvent, dt: number): void {
  const data = TURRET_BARREL_DATA[event.barrel];
  const id = allocate(world.projectiles);
  if (id === null) return; // Turrets have no ammo to refund — a full store just drops the shot.
  const store = world.projectiles;
  store.type[id] = data.projectile;
  store.weaponId[id] = event.barrel + TURRET_WEAPON_ID_OFFSET;
  store.ownerId[id] = -1; // No player identity; see this plan's "ours" table.
  store.team[id] = event.team;
  // Excludes the firing turret from its own shot's structure hit-test — see
  // ProjectileStore.sourceTurretId's own comment for why this is needed.
  store.sourceTurretId[id] = event.turretId;
  store.sourceVehicleId[id] = -1; // A turret shot is never vehicle-sourced.
  store.position.set([event.origin.x, event.origin.y, event.origin.z], id * 3);
  const velocity = {
    x: event.direction.x * data.speed,
    y: event.direction.y * data.speed,
    z: event.direction.z * data.speed,
  };
  store.velocity.set([velocity.x, velocity.y, velocity.z], id * 3);
  if (data.projectile === ProjectileType.Tracer) stepLinearOrTracer(world, id, dt);
}

/** Drains `world.pendingTurretFireEvents` (Task 4's `stepTurrets` already ran this same tick,
 *  before `stepProjectiles` — see this plan's Global Constraints for the required call
 *  order) into real projectiles, the same one-tick-latency shape `spawnFromEvent` gives
 *  player shots. */
function spawnPendingTurretShots(world: World, dt: number): void {
  for (const event of world.pendingTurretFireEvents) spawnTurretShot(world, event, dt);
}

/** Materializes one vehicle weapon's shot (vehicles.ts's stepOneVehicleWeapon) as a real
 *  projectile -- the vehicle-fired sibling of `spawnTurretShot`, same no-ammo shape (a full
 *  store just drops the shot; there is no ammo to refund). The event's own `weapon` selects
 *  every number from VEHICLE_WEAPON_DATA, exactly as a TurretFireEvent's barrel selectts
 *  TURRET_BARREL_DATA, so the Shrike blaster, the Tank's chaingun and mortar and the Bomber's
 *  turret gun and bombs all flow through this one function.
 *
 *  `ownerId` comes straight from the event -- the crew member who pulled the trigger, so a
 *  vehicle-destroying shot credits its killer through applyVehicleKillScore (issue #57);
 *  older/partial event shapes without one materialize as -1, matching spawnTurretShot's own
 *  unattributed convention. `team` also comes from the event, not a player lookup. Velocity
 *  inherits the firing vehicle's own velocity by the weapon's own `velInherit` (the Shrike
 *  blaster's 1.0, the mortar's 1.0, the bomb's 1.0 -- its real velInheritFactor). A Tracer
 *  shot resolves same-tick, exactly like spawnTurretShot's own AA-barrel case; a Grenade
 *  ordnance round (the mortar, the bombs) waits out the normal one-tick spawn latency and
 *  arms on its own script's arming delay. */
function spawnVehicleShot(world: World, event: VehicleFireEvent, dt: number): void {
  const id = allocate(world.projectiles);
  if (id === null) return;
  const store = world.projectiles;
  const weaponId = event.weapon ?? VehicleWeaponId.ShrikeBlaster;
  const data = VEHICLE_WEAPON_DATA[weaponId];
  // The firing driver/gunner, for kill attribution -- see VehicleFireEvent.ownerId.
  store.ownerId[id] = event.ownerId ?? -1;
  store.type[id] = data.projectile;
  store.weaponId[id] = VEHICLE_WEAPON_ID_OFFSET + weaponId;
  store.team[id] = event.team;
  store.sourceTurretId[id] = -1;
  // Excludes the firing vehicle from its own shot's structure hit-test — same reason
  // sourceTurretId excludes a turret from its own shot; see that field's own comment.
  store.sourceVehicleId[id] = event.vehicleId;
  store.position.set([event.origin.x, event.origin.y, event.origin.z], id * 3);
  const velocity = velocityFor(event.direction, data.speed, event.velocity, data.velInherit);
  store.velocity.set([velocity.x, velocity.y, velocity.z], id * 3);
  // Both same-tick-resolving vehicle weapon types: the Shrike's VehicleLaser bolt (the type
  // it has carried since M5, which the client draws distinctly from a player Blaster bolt) and
  // an ordinary Tracer. A Grenade round (the mortar, the bombs) waits out the normal one-tick
  // spawn latency, exactly like spawnStored's own mortar.
  if (data.projectile === ProjectileType.Tracer || data.projectile === ProjectileType.VehicleLaser) {
    stepLinearOrTracer(world, id, dt);
  }
}

/** Drains `world.pendingVehicleFireEvents` (Task 5's `stepVehicles` already ran this same
 *  tick, before `stepProjectiles`) into real projectiles, exactly parallel to
 *  `spawnPendingTurretShots`. */
function spawnPendingVehicleShots(world: World, dt: number): void {
  world.lastVehicleFireEvents = world.pendingVehicleFireEvents;
  for (const event of world.pendingVehicleFireEvents) spawnVehicleShot(world, event, dt);
  world.pendingVehicleFireEvents = [];
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
  // The per-tick impact record list is OVERWRITTEN every call, exactly like lastFireEvents is
  // reassigned: a consumer reading it after this call sees exactly this call's impacts (#52),
  // and nothing from an earlier call can ever be delivered twice.
  world.projectiles.lastImpacts = [];
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    if (world.projectiles.type[id] === ProjectileType.Grenade) stepGrenade(world, id, dt);
    else if (world.projectiles.type[id] === ProjectileType.Energy) stepEnergy(world, id, dt);
    else stepLinearOrTracer(world, id, dt);
  }
  // Recorded before draining, into a field this function doesn't itself clear (unlike
  // pendingFireEvents just below), so server/net.ts can still read this tick's fire events
  // -- to build a LaserFired broadcast -- after stepWorld has already returned. See
  // World.lastFireEvents.
  world.lastFireEvents = world.pendingFireEvents;
  for (const event of world.pendingFireEvents) spawnFromEvent(world, event, dt);
  world.pendingFireEvents = [];
  spawnPendingTurretShots(world, dt);
  world.pendingTurretFireEvents = [];
  spawnPendingVehicleShots(world, dt);
}
