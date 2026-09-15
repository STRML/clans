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

// Scratch for the nearest-target scans (findNearestVisibleEnemy, findCarrierThreat,
// findAttackableTurret). P2 ledger (docs/ISSUES.md, "48-bot tick bursts"): at 24v24 the
// bot half of a tick measured 5.6x the sim half (1.41 ms vs 0.25 ms mean, p99 13.6 ms,
// worst tick 31.7 of the 32 ms budget) because each scan marched line of sight for EVERY
// candidate before choosing. The scans now collect cheap distances first and march
// candidates in ascending (distance, id) order, stopping at the first visible one --
// firstVisibleCollected below carries the exactness argument. One module-level
// grow-on-demand set of arrays keeps the hot path allocation-free; the scans are
// synchronous, never re-entrant (no scan calls another), and the world does not change
// while one runs (perception queries run between simulation steps) -- the same purity the
// old per-candidate fold already relied on. Distances are finite: positions come from the
// float64 integrator and spawn points, and a NaN position would already have poisoned
// every physics step and match hash, so ordering by distance is a total order.
const SCAN_SCRATCH_MIN = 64; // Covers the 48-bot roster and the test worlds; grows on demand.
let scanIds = new Int32Array(SCAN_SCRATCH_MIN);
let scanDist = new Float64Array(SCAN_SCRATCH_MIN);
let scanX = new Float64Array(SCAN_SCRATCH_MIN); // Sight-target center per candidate, kept so
let scanY = new Float64Array(SCAN_SCRATCH_MIN); // a finalist's LOS march reads the exact
let scanZ = new Float64Array(SCAN_SCRATCH_MIN); // floats its distance was computed from.
const scanTarget: Vec3 = { x: 0, y: 0, z: 0 };

function growScanScratch(count: number): void {
  if (count <= scanIds.length) return;
  const cap = Math.max(count, scanIds.length * 2);
  scanIds = new Int32Array(cap);
  scanDist = new Float64Array(cap);
  scanX = new Float64Array(cap);
  scanY = new Float64Array(cap);
  scanZ = new Float64Array(cap);
}

/** The cheap half of the shared visibility rule below -- engageable AND inside `rangeM`
 *  of the observer's eye -- WITHOUT the line-of-sight march, which is the expensive half
 *  (a 0.5 m terrain walk over the whole sightline, ~300 samples at VISION_RANGE; P2
 *  ledger). Leaves the target's distance and center in the scan scratch at [targetId] so
 *  the scan's later march reads the same floats; returns the distance, null when the id
 *  is not a candidate. */
function engageableDistanceM(
  world: World,
  observerId: number,
  team: number,
  eye: { x: number; y: number; z: number },
  targetId: number,
  rangeM: number,
): number | null {
  growScanScratch(world.players.count);
  if (!isEngageableEnemy(world, observerId, team, targetId)) return null;
  const hitbox = playerHitbox(world, targetId, armorFor(world, targetId));
  const d = Math.hypot(eye.x - hitbox.center.x, eye.y - hitbox.center.y, eye.z - hitbox.center.z);
  if (d > rangeM) return null;
  scanDist[targetId] = d;
  scanX[targetId] = hitbox.center.x;
  scanY[targetId] = hitbox.center.y;
  scanZ[targetId] = hitbox.center.z;
  return d;
}

/** Collects every engageable enemy within `rangeM` of the observer's eye into the scan
 *  scratch -- ids packed into scanIds[0..n), distances and centers indexed by entity id --
 *  and returns n. No line-of-sight marching happens here; that is the point. */
function collectVisibleEnemies(world: World, observerId: number, rangeM: number): number {
  const team = world.players.team[observerId] ?? 0;
  const eye = botEye(world, observerId);
  let n = 0;
  for (let id = 0; id < world.players.count; id += 1) {
    if (engageableDistanceM(world, observerId, team, eye, id, rangeM) === null) continue;
    scanIds[n] = id;
    n += 1;
  }
  return n;
}

/** The scans' (distance, id) preference order, named because it IS the exactness
 *  contract: the old folds walked ids ascending and kept the minimum distance with a
 *  strict `<` update, so equal distances went to the LOWEST id, and this predicate ranks
 *  candidates in exactly that order. */
function candidateOutranks(a: number, b: number): boolean {
  const da = scanDist[a] ?? 0;
  const db = scanDist[b] ?? 0;
  return da < db || (da === db && a < b);
}

/** Points the shared scanTarget at candidate `id`'s stored center, so a finalist's
 *  hasLineOfSight march reads the exact floats its distance came from, with no fresh
 *  allocation. */
function aimScanTargetAt(id: number): void {
  scanTarget.x = scanX[id] ?? 0;
  scanTarget.y = scanY[id] ?? 0;
  scanTarget.z = scanZ[id] ?? 0;
}

/** Marches line of sight over the collected candidates in ascending (distance, id) order
 *  and returns the first VISIBLE one -- the same target the old full fold returned,
 *  because a line-of-sight answer never depends on iteration order (the same eye and
 *  center floats march the same terrain): the first visible candidate in preference order
 *  IS the old minimum, and every march the old code ran past the winner (typically nearly
 *  all of them in a 24v24 melee, where the nearest enemy is usually visible) is simply
 *  not marched. Selection is swap-pop over scanIds, O(n) per finalist, so the common case
 *  (the nearest candidate is visible) costs one pass of cheap compares and one march. */
function firstVisibleCollected(
  world: World,
  eye: { x: number; y: number; z: number },
  count: number,
): number | null {
  let remaining = count;
  while (remaining > 0) {
    let bestAt = 0;
    for (let i = 1; i < remaining; i += 1) {
      const id = scanIds[i] ?? -1;
      const bestId = scanIds[bestAt] ?? -1;
      if (candidateOutranks(id, bestId)) bestAt = i;
    }
    const id = scanIds[bestAt] ?? -1;
    aimScanTargetAt(id);
    if (hasLineOfSight(world, eye, scanTarget)) return id;
    remaining -= 1;
    scanIds[bestAt] = scanIds[remaining] ?? -1;
  }
  return null;
}

/** The one definition of "this enemy is a target for this observer": engageable (see
 *  isEngageableEnemy) AND inside VISION_RANGE of the observer's own eye AND in line of
 *  sight from it. Returns the 3D eye-to-hitbox distance when it is a target, `null` when
 *  it is not -- distance is never a sentinel. Both nearest-enemy scans are built from the
 *  same two halves this function composes -- engageableDistanceM (the cheap filter, via
 *  collectVisibleEnemies) and hasLineOfSight (the march, via firstVisibleCollected) -- so
 *  "visible" cannot drift into two different rules one caller at a time. */
export function visibleEnemyDistanceM(
  world: World,
  observerId: number,
  targetId: number,
): number | null {
  if (targetId < 0 || targetId >= world.players.count) return null;
  const team = world.players.team[observerId] ?? 0;
  const eye = botEye(world, observerId);
  const d = engageableDistanceM(world, observerId, team, eye, targetId, VISION_RANGE);
  if (d === null) return null;
  aimScanTargetAt(targetId);
  if (!hasLineOfSight(world, eye, scanTarget)) return null;
  return d;
}

export function findNearestVisibleEnemy(world: World, botId: number): number | null {
  const candidates = collectVisibleEnemies(world, botId, VISION_RANGE);
  return firstVisibleCollected(world, botEye(world, botId), candidates);
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
  // The threat cap folds into the cheap collect as min(VISION_RANGE, radiusM): a candidate
  // beyond radiusM could never win the old fold (it was skipped -- but only AFTER its line
  // of sight had been marched, which the P2 ledger flags as the wasted work), so skipping
  // its march too returns the same answer. The min is the visibility rule's own clamp, not
  // a second radius check.
  const candidates = collectVisibleEnemies(world, carrierId, Math.min(VISION_RANGE, radiusM));
  return firstVisibleCollected(world, botEye(world, carrierId), candidates);
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

/** Turret-side twin of collectVisibleEnemies: gathers every enemy turret that threatens
 *  players, is standing and powered, and sits within TURRET_ATTACK_RANGE_M of the bot's
 *  eye (its cheapest-out half of the old fold; the old code checked range before its
 *  march too, so the eligible set is unchanged). Returns how many it collected. */
function collectAttackableTurrets(world: World, botId: number): number {
  const team = world.players.team[botId] ?? 0;
  growScanScratch(world.turrets.count);
  const eye = botEye(world, botId);
  let n = 0;
  for (let id = 0; id < world.turrets.count; id += 1) {
    if (world.turrets.team[id] === team || world.turrets.destroyed[id]) continue;
    if (!world.turrets.powered[id]) continue;
    if (!threatensPlayers(world, id)) continue;
    const hitbox = turretHitbox(world, id);
    const d = Math.hypot(eye.x - hitbox.center.x, eye.y - hitbox.center.y, eye.z - hitbox.center.z);
    if (d > TURRET_ATTACK_RANGE_M) continue;
    scanDist[id] = d;
    scanX[id] = hitbox.center.x;
    scanY[id] = hitbox.center.y;
    scanZ[id] = hitbox.center.z;
    scanIds[n] = id;
    n += 1;
  }
  return n;
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
  // Same (distance, id) order, same first-visible-wins march as the player scans: the old
  // fold walked ids ascending with a strict `<` update and a range check before its march,
  // so its winner was the nearest in-range visible turret, lowest id on ties -- which is
  // exactly what firstVisibleCollected returns, minus the marches it ran past the winner.
  const id = firstVisibleCollected(
    world,
    botEye(world, botId),
    collectAttackableTurrets(world, botId),
  );
  if (id === null) return null;
  // The same center floats the fold judged. turretHitbox builds a fresh object per call,
  // so no caller can be holding the old object's identity -- only its values, unchanged.
  return { id, position: { x: scanX[id] ?? 0, y: scanY[id] ?? 0, z: scanZ[id] ?? 0 } };
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
