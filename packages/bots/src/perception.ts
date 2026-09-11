import {
  armorFor,
  BaseObjectKind,
  hasLineOfSight,
  playerHitbox,
  TurretBarrelId,
  turretHitbox,
  type BaseObjectStore,
  type Vec3,
  type World,
} from '@clans/sim';

export const VISION_RANGE = 150; // Ours.
export const LOW_HEALTH_FRACTION = 0.4; // Ours.
export const LOW_ENERGY_FRACTION = 0.3; // Ours.
/** Issue #32 carrier survival: how far a bot will reach to shoot an enemy BASE TURRET
 *  that is not currently shooting a player target. The plasma barrel's real envelope is
 *  the sensor radius (80 m) inside its 120 m attack radius (turrets.ts's engagementRange),
 *  so engaging from ~110 m keeps the shooter outside every turret's own reach while
 *  covering the approach to the enemy flag deck. Beyond ~110 m the disc's flight time
 *  (90 m/s) and 4-degree aim tolerance waste ammo. */
export const TURRET_ATTACK_RANGE_M = 110; // Ours, meters.
const MUZZLE_HEIGHT = 1.6; // weapons.ts's own constant, restated here to avoid a circular
// re-export dependency on weapons.ts internals -- the value is cited, not picked; see
// weapons.ts:53.

function botEye(world: World, botId: number): { x: number; y: number; z: number } {
  const base = botId * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: (world.players.position[base + 1] ?? 0) + MUZZLE_HEIGHT,
    z: world.players.position[base + 2] ?? 0,
  };
}

/** Failure matrix row 18, real M5 behavior (projectiles.ts's isValidTarget,
 *  weapons.ts:420): a mounted player has no separate hitbox while riding a vehicle --
 *  only the vehicle can be shot. A bot with no vehicle-combat logic this milestone
 *  treats a mounted enemy as simply not there, rather than "visible" and then wasting
 *  every shot against it. */
function isEngageableEnemy(world: World, botId: number, team: number, id: number): boolean {
  if (id === botId || !world.players.active[id] || !world.players.alive[id]) return false;
  if (world.players.team[id] === team) return false;
  if (world.players.mountedVehicleId[id] !== -1) return false;
  return true;
}

/** The one definition of "this enemy is a target for this observer": engageable (see
 *  isEngageableEnemy) AND inside VISION_RANGE of the observer's own eye AND in line of
 *  sight from it. Returns the 3D eye-to-hitbox distance when it is a target, `null` when
 *  it is not -- distance is never a sentinel. Both nearest-enemy scans route through here
 *  (findNearestVisibleEnemy from the bot's own eye, findCarrierThreat from the carrier's),
 *  so "visible" cannot drift into two different rules one caller at a time. */
export function visibleEnemyDistanceM(
  world: World,
  observerId: number,
  targetId: number,
): number | null {
  if (targetId < 0 || targetId >= world.players.count) return null;
  const team = world.players.team[observerId] ?? 0;
  if (!isEngageableEnemy(world, observerId, team, targetId)) return null;
  const eye = botEye(world, observerId);
  const hitbox = playerHitbox(world, targetId, armorFor(world, targetId));
  const d = Math.hypot(eye.x - hitbox.center.x, eye.y - hitbox.center.y, eye.z - hitbox.center.z);
  if (d > VISION_RANGE) return null;
  if (!hasLineOfSight(world, eye, hitbox.center)) return null;
  return d;
}

export function findNearestVisibleEnemy(world: World, botId: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < world.players.count; id += 1) {
    const d = visibleEnemyDistanceM(world, botId, id);
    if (d === null || d >= bestDistance) continue;
    best = id;
    bestDistance = d;
  }
  return best;
}

export function needsHealing(world: World, botId: number): boolean {
  const armor = armorFor(world, botId);
  const health = 1 - (world.players.damage[botId] ?? 0) / armor.maxDamage;
  const energy = (world.players.energy[botId] ?? 0) / armor.maxEnergy;
  return health < LOW_HEALTH_FRACTION || energy < LOW_ENERGY_FRACTION;
}

function isUsableFriendlyStation(store: BaseObjectStore, team: number, id: number): boolean {
  if (store.kind[id] !== BaseObjectKind.StationInventory) return false;
  if (store.team[id] !== team) return false;
  if (!store.powered[id]) return false;
  if (store.destroyed[id]) return false;
  return true;
}

// Codex review round 2, finding (P2): this and maybeHeal's own in-range check (brain.ts)
// both used X/Z-only distance, while the real gate a heal request is checked against --
// baseObjects.ts's stationAt, which applyLoadoutSelection calls internally -- uses full 3D
// distance. A bot could walk to the right horizontal spot on a raised or sunken platform,
// read itself as "in range" here, and have applyLoadoutSelection silently reject every
// request forever (stationAt's own real check fails), stuck at a heal goal that could
// never resolve.
function vec3At(arr: Float64Array, base: number): { x: number; y: number; z: number } {
  return { x: arr[base] ?? 0, y: arr[base + 1] ?? 0, z: arr[base + 2] ?? 0 };
}

export function findNearestFriendlyStation(world: World, botId: number): number | null {
  const store = world.baseObjects;
  const team = world.players.team[botId] ?? 0;
  const botPos = vec3At(world.players.position, botId * 3);
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < store.count; id += 1) {
    if (!isUsableFriendlyStation(store, team, id)) continue;
    const stationPos = vec3At(store.position, id * 3);
    const d = Math.hypot(botPos.x - stationPos.x, botPos.y - stationPos.y, botPos.z - stationPos.z);
    if (d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  return best;
}

export function findEscortedCarrier(world: World, team: number, selfId: number): number | null {
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    if (world.flags.team[flagId] === team) continue; // only the ENEMY flag has a carrier worth escorting
    const carrierId = world.flags.carrierId[flagId];
    if (
      carrierId === undefined ||
      carrierId < 0 ||
      carrierId === selfId ||
      !world.players.active[carrierId] ||
      !world.players.alive[carrierId] ||
      world.players.team[carrierId] !== team
    ) {
      continue;
    }
    return carrierId;
  }
  return null;
}

/** Issue #32: the enemy player currently carrying OUR flag, if any. The mirror of
 *  findEscortedCarrier: an escort wants the friendly carrier of the ENEMY flag, an
 *  interceptor wants the hostile carrier of the OWN flag. Same liveness rules -- a dead,
 *  inactive, or same-team carrier id is not a target (flags.ts clears carrierId on drop
 *  and on death, but the store is only as fresh as the last stepFlags). */
export function findEnemyFlagCarrier(world: World, team: number): number | null {
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    if (world.flags.team[flagId] !== team) continue; // only the OWN flag has an enemy carrier to hunt
    const carrierId = world.flags.carrierId[flagId];
    if (
      carrierId === undefined ||
      carrierId < 0 ||
      !world.players.active[carrierId] ||
      !world.players.alive[carrierId] ||
      world.players.team[carrierId] === team
    ) {
      continue;
    }
    return carrierId;
  }
  return null;
}

/** Issue #32 escort threat priority: how far from the CARRIER an enemy still counts as
 *  the carrier's fight. 120 m is the plasma turret's own attack radius (turrets.ts's
 *  engagementRange) -- the envelope that measured ~70% of all carrier chip damage, see
 *  TURRET_ATTACK_RANGE_M's comment above -- so it covers every hostile that can put
 *  damage on a carrier before it reaches home, and nothing farther out that the escort
 *  would only reach by leaving the carrier behind. It also sits inside VISION_RANGE
 *  (150): a cap past the vision range could only ever be a lie, since this query can
 *  return nothing the carrier itself cannot see. */
export const CARRIER_THREAT_RADIUS_M = 120; // Ours, meters.

/** Issue #32 escort threat priority: the closest enemy the CARRIER can see inside
 *  `radiusM` -- the enemy that threatens the principal, not the enemy that happens to be
 *  nearest the escort. Visibility is the same shared rule as findNearestVisibleEnemy's
 *  (engageable, inside VISION_RANGE, line of sight), measured from the carrier's own eye:
 *  "an enemy the carrier is looking at" is the only defensible reading of a threat the
 *  bodyguard is asked to fight *instead of* its own nearest. A `radiusM` above
 *  VISION_RANGE is clamped by the visibility rule itself, not by a second comparison.
 *  Returns null for a dead, inactive, or out-of-range carrier -- flags.ts's carrierId is
 *  only as fresh as the last stepFlags, and this query must never aim a bodyguard at
 *  whatever a stale id now refers to. */
export function findCarrierThreat(world: World, carrierId: number, radiusM: number): number | null {
  if (carrierId < 0 || carrierId >= world.players.count) return null;
  if (!world.players.active[carrierId] || !world.players.alive[carrierId]) return null;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < world.players.count; id += 1) {
    const d = visibleEnemyDistanceM(world, carrierId, id);
    if (d === null || d > radiusM || d >= bestDistance) continue;
    best = id;
    bestDistance = d;
  }
  return best;
}

/** Issue #32 carrier fire discipline: true while this bot is the one carrying the ENEMY
 *  flag home -- the player whose life is the score. brain.ts has its own private copy
 *  taking the runtime; this is the same rule (the enemy flag's carrierId, own flag
 *  excluded) stated as a world query, because combat.ts's fire gate needs it and
 *  brain.ts already imports combat.ts -- importing that helper back would be a cycle.
 *  No liveness check, deliberately: this asks whether the bot holds the flag, and
 *  stepBots never asks anything about a dead bot (flags.ts clears the carrier on death
 *  anyway, one stepFlags earlier). */
export function isCarryingEnemyFlag(world: World, botId: number): boolean {
  const team = world.players.team[botId] ?? 0;
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    if (world.flags.team[flagId] === team) continue; // only the ENEMY flag is carried home
    if (world.flags.carrierId[flagId] === botId) return true;
  }
  return false;
}

/** True when this turret's barrel ever engages PLAYERS: the plasma barrel (120 m attack
 *  radius, 0.8 s reload -- the single biggest chip-damage source on a carrier's exit from
 *  the enemy base, measured in the #32 production-seed probes: ~70% of all carrier chip
 *  damage landed inside an enemy plasma turret's 120 m envelope) and the sentry barrel
 *  (60 m, 0.4 s reload, guarding each midfield tower). The AA barrel is deliberately NOT
 *  attackable: vehiclesOnly targeting (turrets.ts's own field) means it can never shoot a
 *  bot, and every disc spent on it is ammo a carrier's bodyguard will not have later. */
function threatensPlayers(world: World, turretId: number): boolean {
  const barrel = world.turrets.barrel[turretId] as TurretBarrelId;
  return (
    barrel === TurretBarrelId.PlasmaBarrelLarge || barrel === TurretBarrelId.SentryTurretBarrel
  );
}

export interface AttackableTurret {
  id: number;
  position: Vec3;
}

/** Issue #32 carrier survival: the nearest enemy base turret that (a) threatens players,
 *  (b) is standing and powered (an unpowered or wrecked turret shoots nobody, and ammo
 *  spent re-killing it is wasted), (c) sits within TURRET_ATTACK_RANGE_M of the bot, and
 *  (d) has line of sight -- a shot at a blocked structure is a wasted disc. Fired when no
 *  player target is visible, so it never competes with a real engagement for the bot's
 *  aim. Both bases' plasma turrets guard the flag approach, which every attacker walks on
 *  the way to a take, so a handful of passing attackers strip the shield (3 damage at 50
 *  energy per point) and health (2.25) over a few runs and the carrier's exit window
 *  stops costing 40-95% health. */
export function findAttackableTurret(world: World, botId: number): AttackableTurret | null {
  const team = world.players.team[botId] ?? 0;
  const eye = botEye(world, botId);
  let best: AttackableTurret | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < world.turrets.count; id += 1) {
    if (world.turrets.team[id] === team || world.turrets.destroyed[id]) continue;
    if (!world.turrets.powered[id]) continue;
    if (!threatensPlayers(world, id)) continue;
    const hitbox = turretHitbox(world, id);
    const d = Math.hypot(eye.x - hitbox.center.x, eye.y - hitbox.center.y, eye.z - hitbox.center.z);
    if (d > TURRET_ATTACK_RANGE_M || d >= bestDistance) continue;
    if (!hasLineOfSight(world, eye, hitbox.center)) continue;
    best = { id, position: hitbox.center };
    bestDistance = d;
  }
  return best;
}

/** Issue #32 carrier survival: the friendly station worth a detour on the way home,
 *  judged by MARGINAL distance -- how many metres `bot -> station -> home` adds over the
 *  straight `bot -> home` walk. The old test (nearest station within a flat 60 m radius)
 *  never fired on real Katabatic: the bases' own stations sit 450-580 m from the route
 *  and the midfield-tower stations are ~300 m off the direct diagonal, so a wounded
 *  carrier (measured: 59% at the take, 5% thirty seconds later, dead to turret attrition
 *  at 29% progress) had no heal option at all. Judged by marginal distance the towers are
 *  cheap: measured 179-189 m extra along the first half of the return, a ~20 s detour for
 *  a full health+energy reset. Scans every usable friendly station and returns the one
 *  with the smallest marginal at or under `maxMarginalM` -- not merely the nearest one,
 *  whose marginal can be far worse than a slightly-farther tower's. */
export function findCarrierHealStation(
  world: World,
  botId: number,
  homeStand: Vec3,
  maxMarginalM: number,
): number | null {
  const store = world.baseObjects;
  const me = vec3At(world.players.position, botId * 3);
  const direct = Math.hypot(me.x - homeStand.x, me.y - homeStand.y, me.z - homeStand.z);
  let best: number | null = null;
  let bestMarginal = maxMarginalM;
  for (let id = 0; id < store.count; id += 1) {
    if (!isUsableFriendlyStation(store, world.players.team[botId] ?? 0, id)) continue;
    const station = vec3At(store.position, id * 3);
    const toStation = Math.hypot(me.x - station.x, me.y - station.y, me.z - station.z);
    const toHome = Math.hypot(
      station.x - homeStand.x,
      station.y - homeStand.y,
      station.z - homeStand.z,
    );
    const marginal = toStation + toHome - direct;
    if (marginal < bestMarginal) {
      bestMarginal = marginal;
      best = id;
    }
  }
  return best;
}
