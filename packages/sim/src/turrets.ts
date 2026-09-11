import { teamHasPower } from './baseObjects.js';
import type { PlayerHitbox } from './damage.js';
import { segmentBlockedByInteriors } from './occlusion.js';
import { sampleTerrain } from './terrain.js';
import { ProjectileType } from './weapons.js';
import type { Vec3, World } from './types.js';

const LOS_MARCH_STEP = 0.5; // Ours — matches projectiles.ts's own TERRAIN_MARCH_STEP.
const TURRET_EYE_HEIGHT = 2; // Ours — see this plan's "ours" numbers table.

/** Marches the segment from `from` to `to` at a fixed step and blocks line of sight the
 *  instant a sampled point's terrain height is at or above the segment's own interpolated
 *  height there. Matches the real T2 sensor's `detectsUsingLOS = true`
 *  (`turret.cs:142`, `turrets/sentryTurret.cs:129`). Duplicated from the same technique
 *  `projectiles.ts` uses for terrain marching, not imported from it, because this task runs
 *  before Task 5 exports anything reusable — see this plan's Global Constraints. */
export function hasLineOfSight(world: World, from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x,
    dy = to.y - from.y,
    dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal === 0) return true;
  const steps = Math.max(1, Math.ceil(horizontal / LOS_MARCH_STEP));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const sample = sampleTerrain(world.terrain, from.x + dx * t, from.z + dz * t);
    if (!sample.empty && sample.height >= from.y + dy * t) return false;
  }
  return true;
}

/** Issue #49: the full sight test every turret LOS decision shares -- acquisition
 *  (`nearestPlayerTarget`/`nearestVehicleTarget`) and retention (`targetStillValid`)
 *  alike. `hasLineOfSight` keeps its original terrain-only semantics (packages/bots
 *  perception/waypoints and sim/repair.ts depend on exactly those), so the interior/
 *  enemy-force-field half comes from occlusion.ts and the two answers AND together. The
 *  field test runs against the turret's OWN team, so only an opposing field can blind
 *  it, and the turret's own assembly (turretHitShape) is deliberately not part of the
 *  test at all: a sightline grazing the turret's own envelope must still resolve, or no
 *  turret could ever see past its own barrel. */
function turretCanSee(world: World, eye: Vec3, target: Vec3, team: number): boolean {
  return hasLineOfSight(world, eye, target) && !segmentBlockedByInteriors(world, eye, target, team);
}

export enum TurretBarrelId {
  PlasmaBarrelLarge = 0,
  AABarrelLarge = 1,
  SentryTurretBarrel = 2,
}
export enum TurretBaseId {
  Large = 0,
  Sentry = 1,
}
export enum TurretState {
  Ready = 0,
  Firing = 1,
  Reload = 2,
}

export interface TurretBarrelData {
  projectile: ProjectileType;
  speed: number;
  velInherit: number;
  directDamage: number;
  radiusDamage: number;
  radius: number;
  kickback: number;
  fireTime: number;
  reloadTime: number;
  lifetime: number;
  attackRadius: number;
  /** AABarrelLarge only: the real T2 barrel is a vehicle-seeking weapon
   *  (`isSeeker = true`, `aaBarrelLarge.cs:176-183`). No vehicle exists until milestone 5,
   *  so this barrel never acquires a target this milestone — see this plan's "ours" table. */
  vehiclesOnly?: boolean;
}
export interface TurretBaseData {
  maxHealth: number;
  /** Damage must fall below this T2 `disabledLevel` before a repaired turret operates again. */
  disabledDamage: number;
  maxEnergy: number;
  energyPerDamagePoint: number;
  rechargeRate: number;
  thetaMin: number;
  thetaMax: number;
  /** Target-acquisition sensor radius — tighter than the barrel's own `attackRadius` for
   *  TurretBaseLarge (80 m sensor vs 120 m Plasma attack range), so engagement range is the
   *  smaller of the two; see `engagementRange`. */
  sensorRadius: number;
}

export const TURRET_BARREL_DATA: Record<TurretBarrelId, TurretBarrelData> = {
  // turrets/plasmaBarrelLarge.cs:195-306. Spec: 0.5 radius damage at 10 m, 50 m/s, kickback
  // 500, 0.3 s fire, 0.8 s reload. attackRadius (120) and lifetime (6 s, lifetimeMS = 6000)
  // are not in the spec table; both come straight from the script.
  [TurretBarrelId.PlasmaBarrelLarge]: {
    projectile: ProjectileType.Linear,
    speed: 50,
    velInherit: 1.0,
    directDamage: 0,
    radiusDamage: 0.5,
    radius: 10,
    kickback: 500,
    fireTime: 0.3,
    reloadTime: 0.8,
    lifetime: 6,
    attackRadius: 120,
  },
  // turrets/aaBarrelLarge.cs:125-193. Spec: "targets vehicles, numbers from
  // aaBarrelLarge.cs at implementation time" — this is that citation.
  [TurretBarrelId.AABarrelLarge]: {
    projectile: ProjectileType.Tracer,
    speed: 150,
    velInherit: 1.0,
    directDamage: 0.25,
    radiusDamage: 0,
    radius: 0,
    kickback: 0,
    fireTime: 0.15,
    reloadTime: 0.2,
    lifetime: 3,
    attackRadius: 200,
    vehiclesOnly: true,
  },
  // turrets/sentryTurret.cs:92-227. Spec: 0.1 direct at 200 m/s, 0.13 s fire, 0.40 s reload.
  [TurretBarrelId.SentryTurretBarrel]: {
    projectile: ProjectileType.Linear,
    speed: 200,
    velInherit: 0.5,
    directDamage: 0.1,
    radiusDamage: 0,
    radius: 0,
    kickback: 0,
    fireTime: 0.13,
    reloadTime: 0.4,
    lifetime: 3,
    attackRadius: 60,
  },
};

export const TURRET_BASE_DATA: Record<TurretBaseId, TurretBaseData> = {
  // turret.cs:150-192 (TurretData) + turret.cs:139-146 (TurretBaseSensorObj). Spec: maxDamage
  // 2.25, energyPerDamagePoint 50, elevation 15 to 140. maxEnergy/rechargeRate/sensor radius
  // are not in the spec table; all three come straight from the script.
  [TurretBaseId.Large]: {
    maxHealth: 2.25,
    disabledDamage: 1.35,
    maxEnergy: 150,
    energyPerDamagePoint: 50,
    rechargeRate: 0.31,
    thetaMin: 15,
    thetaMax: 140,
    sensorRadius: 80,
  },
  // sentryTurret.cs:92-227 (TurretData + SentryMotionSensor). Spec: maxDamage 1.2 only;
  // every other field here is read from the script.
  [TurretBaseId.Sentry]: {
    maxHealth: 1.2,
    disabledDamage: 0.84,
    maxEnergy: 150,
    energyPerDamagePoint: 100,
    rechargeRate: 0.4,
    thetaMin: 89,
    thetaMax: 175,
    sensorRadius: 60,
  },
};

const BASE_FOR_BARREL: Record<TurretBarrelId, TurretBaseId> = {
  [TurretBarrelId.PlasmaBarrelLarge]: TurretBaseId.Large,
  [TurretBarrelId.AABarrelLarge]: TurretBaseId.Large,
  [TurretBarrelId.SentryTurretBarrel]: TurretBaseId.Sentry,
};

export function baseFor(barrel: TurretBarrelId): TurretBaseData {
  return TURRET_BASE_DATA[BASE_FOR_BARREL[barrel]];
}

/** Ours: the smaller of the base's sensor radius and the barrel's own attackRadius — see
 *  `TurretBaseData.sensorRadius`'s comment for why these differ for TurretBaseLarge. */
export function engagementRange(barrel: TurretBarrelId): number {
  return Math.min(baseFor(barrel).sensorRadius, TURRET_BARREL_DATA[barrel].attackRadius);
}

export interface TurretStore {
  count: number;
  barrel: Uint8Array;
  team: Uint8Array;
  position: Float64Array;
  damage: Float64Array;
  destroyed: Uint8Array;
  energy: Float64Array;
  powered: Uint8Array;
  targetId: Int16Array;
  /** 0 = targetId refers to world.players, 1 = world.vehicles. Only ever nonzero for a
   *  vehiclesOnly barrel (AABarrelLarge, M5 Task 8) -- disambiguates targetId's own referent
   *  for acquireTarget/targetStillValid/fireAt, since TurretFireEvent itself carries no
   *  target id at all (direction is already resolved by the time fireAt queues it, so a
   *  player-vs-vehicle discriminator can't live there). New simulation-relevant state that
   *  decides which store a later tick's fireAt reads from, so hashWorld must mix it in too
   *  (Task 9) -- the exact class of gap issue #13 already found in mixTurrets omitting
   *  `timer`, not to be repeated for a field this task itself introduces. */
  targetKind: Uint8Array;
  state: Uint8Array;
  timer: Float64Array;
}
const TURRET_CAPACITY = 16; // Ours: Katabatic's real count is 6; headroom for other maps.

export function createEmptyTurrets(): TurretStore {
  return {
    count: 0,
    barrel: new Uint8Array(TURRET_CAPACITY),
    team: new Uint8Array(TURRET_CAPACITY),
    position: new Float64Array(TURRET_CAPACITY * 3),
    damage: new Float64Array(TURRET_CAPACITY),
    destroyed: new Uint8Array(TURRET_CAPACITY),
    energy: new Float64Array(TURRET_CAPACITY),
    powered: new Uint8Array(TURRET_CAPACITY),
    targetId: new Int16Array(TURRET_CAPACITY).fill(-1),
    targetKind: new Uint8Array(TURRET_CAPACITY),
    state: new Uint8Array(TURRET_CAPACITY),
    timer: new Float64Array(TURRET_CAPACITY),
  };
}

export function createTurrets(
  world: World,
  placements: Array<{ barrel: TurretBarrelId; team: number; position: Vec3 }>,
): void {
  const store = world.turrets;
  placements.forEach(({ barrel, team, position }, id) => {
    if (id >= TURRET_CAPACITY) throw new RangeError('Turret capacity exceeded');
    store.barrel[id] = barrel;
    store.team[id] = team;
    store.position.set([position.x, position.y, position.z], id * 3);
    store.damage[id] = 0;
    store.destroyed[id] = 0;
    store.energy[id] = baseFor(barrel).maxEnergy;
    store.powered[id] = 0;
    store.targetId[id] = -1;
    store.targetKind[id] = 0;
    store.state[id] = TurretState.Ready;
    store.timer[id] = 0;
    store.count = Math.max(store.count, id + 1);
  });
}

export function applyTurretDamage(world: World, id: number, amount: number): void {
  const store = world.turrets;
  const data = baseFor(store.barrel[id] as TurretBarrelId);
  if (amount <= 0 || store.destroyed[id]) return;
  const energy = store.energy[id] ?? 0;
  const shieldCapacity = data.energyPerDamagePoint > 0 ? energy / data.energyPerDamagePoint : 0;
  const shieldAbsorbed = Math.min(shieldCapacity, amount);
  store.energy[id] = energy - shieldAbsorbed * data.energyPerDamagePoint;
  const throughShield = amount - shieldAbsorbed;
  if (throughShield <= 0) return;
  // Keep a destroyed turret at its real max damage. Besides keeping snapshots bounded, this
  // makes a wreck repairable in the same finite time regardless of the overkill amount.
  store.damage[id] = Math.min((store.damage[id] ?? 0) + throughShield, data.maxHealth);
  if ((store.damage[id] ?? 0) >= data.maxHealth) {
    store.destroyed[id] = 1;
    store.targetId[id] = -1;
  }
}

/**
 * Codex round 1, finding 1: writes a decoded snapshot's DYNAMIC turret fields (damage/
 * destroyed/powered/targetId/state, plus the optional protocol-9 energy/targetKind) onto
 * the store by id, growing `store.count` to fit an id that's never been locally placed yet
 * -- the turret-store sibling of baseObjects.ts's `applyBaseObjectSnapshot`; see that
 * function's own comment for why static placement (barrel/team/position) never needs to be
 * on the wire at all. The two optional fields are skipped entirely when absent, so
 * pre-protocol-9 snapshots and hand-built test literals leave the store defaults alone.
 */
export function applyTurretSnapshot(
  world: World,
  data: {
    id: number;
    damage: number;
    destroyed: 0 | 1;
    powered: 0 | 1;
    targetId: number;
    state: number;
    energy?: number;
    targetKind?: number;
  },
): void {
  const store = world.turrets;
  if (data.id >= TURRET_CAPACITY) return;
  if (data.id >= store.count) store.count = data.id + 1;
  store.damage[data.id] = data.damage;
  store.destroyed[data.id] = data.destroyed;
  store.powered[data.id] = data.powered;
  store.targetId[data.id] = data.targetId;
  store.state[data.id] = data.state;
  // Optional protocol-9 fields: absent on every pre-9 snapshot and on hand-built test
  // literals, and assigning undefined into a typed array would silently store NaN -- so
  // only write what actually arrived.
  if (data.energy !== undefined) store.energy[data.id] = data.energy;
  if (data.targetKind !== undefined) store.targetKind[data.id] = data.targetKind;
}

/** Mirrors `baseObjects.ts`'s `stepPower`, but turrets are always `needsPower: true` (a
 *  turret has no power-independent counterpart the way a generator does), so this is a
 *  straight team-power lookup with no branch. */
export function stepTurretPower(world: World): void {
  const store = world.turrets;
  const teamPower = new Map<number, boolean>();
  for (let id = 0; id < store.count; id += 1) {
    const team = store.team[id] ?? 0;
    if (!teamPower.has(team)) teamPower.set(team, teamHasPower(world, team));
    store.powered[id] = teamPower.get(team) ? 1 : 0;
  }
}

function distance(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

function turretPosition(store: TurretStore, id: number): Vec3 {
  const base = id * 3;
  return {
    x: store.position[base] ?? 0,
    y: store.position[base + 1] ?? 0,
    z: store.position[base + 2] ?? 0,
  };
}

function playerPoint(world: World, playerId: number): Vec3 {
  const base = playerId * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: world.players.position[base + 1] ?? 0,
    z: world.players.position[base + 2] ?? 0,
  };
}

function vehiclePoint(world: World, vehicleId: number): Vec3 {
  const base = vehicleId * 3;
  return {
    x: world.vehicles.position[base] ?? 0,
    y: world.vehicles.position[base + 1] ?? 0,
    z: world.vehicles.position[base + 2] ?? 0,
  };
}

function turretEye(pos: Vec3): Vec3 {
  return { x: pos.x, y: pos.y + TURRET_EYE_HEIGHT, z: pos.z };
}

/** Nearest living enemy player within the barrel's engagement range and with a clear line of
 *  sight from the turret's eye position to the player — terrain (`hasLineOfSight`) AND
 *  interiors/enemy force fields (`turretCanSee`; issue #49: the sensor must not track a
 *  target its own barrel could not reach). Matches the real T2 sensor's
 *  `detectsUsingLOS = true` (`turret.cs:142`, `turrets/sentryTurret.cs:129`) — failure matrix
 *  row 16. */
function nearestPlayerTarget(
  world: World,
  pos: Vec3,
  eye: Vec3,
  team: number,
  range: number,
): number {
  let nearest = -1;
  let nearestDistance = Infinity;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!world.players.active[playerId] || !world.players.alive[playerId]) continue;
    if (world.players.team[playerId] === team) continue;
    const target = playerPoint(world, playerId);
    const d = distance(pos.x, pos.y, pos.z, target.x, target.y, target.z);
    if (d > range || d >= nearestDistance) continue;
    if (!turretCanSee(world, eye, target, team)) continue;
    nearest = playerId;
    nearestDistance = d;
  }
  return nearest;
}

/** `vehiclesOnly` barrels' own version of `nearestPlayerTarget` (M5, Task 8) — dormant since
 *  M4, this is the one deliberate gap the plan closes: an AA barrel with line of sight to an
 *  enemy vehicle in range now acquires and fires on it, same rules as a ground turret firing
 *  on a player (failure matrix row 15) — including `turretCanSee`'s interior/force-field
 *  half, so a vehicle parked behind a wall is just as invisible as a player (issue #49). */
function nearestVehicleTarget(
  world: World,
  pos: Vec3,
  eye: Vec3,
  team: number,
  range: number,
): number {
  const vehicles = world.vehicles;
  let nearest = -1;
  let nearestDistance = Infinity;
  for (let vehicleId = 0; vehicleId < vehicles.count; vehicleId += 1) {
    if (!vehicles.active[vehicleId] || vehicles.destroyed[vehicleId]) continue;
    if (vehicles.team[vehicleId] === team) continue;
    const target = vehiclePoint(world, vehicleId);
    const d = distance(pos.x, pos.y, pos.z, target.x, target.y, target.z);
    if (d > range || d >= nearestDistance) continue;
    if (!turretCanSee(world, eye, target, team)) continue;
    nearest = vehicleId;
    nearestDistance = d;
  }
  return nearest;
}

/** Dispatches to `nearestPlayerTarget` or (for a `vehiclesOnly` barrel, M5) `nearestVehicleTarget`
 *  and records which store the result refers to in `store.targetKind[id]` — see that field's
 *  own doc comment for why the discriminator has to live here rather than on the fire event. */
function acquireTarget(world: World, id: number): number {
  const store = world.turrets;
  const barrelId = store.barrel[id] as TurretBarrelId;
  const range = engagementRange(barrelId);
  const pos = turretPosition(store, id);
  const eye = turretEye(pos);
  const team = store.team[id] ?? 0;
  if (TURRET_BARREL_DATA[barrelId].vehiclesOnly) {
    store.targetKind[id] = 1;
    return nearestVehicleTarget(world, pos, eye, team, range);
  }
  store.targetKind[id] = 0;
  return nearestPlayerTarget(world, pos, eye, team, range);
}

/** True when the current target is still a valid one to keep engaging — alive/active (or, for
 *  a vehicle target, active and not destroyed), an enemy, still in range, and still visible.
 *  Reacquisition (`acquireTarget`) always runs when this is false, covering "target died"
 *  (failure matrix row 12), "target walked out of range", "target walked behind terrain"
 *  (failure matrix row 16), and now "target stepped behind an interior wall or an enemy
 *  force field" (issue #49, via `turretCanSee`) alike — there is no separate code path for
 *  any of these causes. Branches on `targetKind` to read the right store for a vehicle
 *  target (M5). */
function targetStillValid(world: World, id: number): boolean {
  const store = world.turrets;
  const targetId = store.targetId[id] ?? -1;
  if (targetId < 0) return false;
  const isVehicle = store.targetKind[id] === 1;
  const stillExists = isVehicle
    ? world.vehicles.active[targetId] === 1 && !world.vehicles.destroyed[targetId]
    : world.players.active[targetId] === 1 && world.players.alive[targetId] === 1;
  if (!stillExists) return false;
  const barrelId = store.barrel[id] as TurretBarrelId;
  const pos = turretPosition(store, id);
  const target = isVehicle ? vehiclePoint(world, targetId) : playerPoint(world, targetId);
  const d = distance(pos.x, pos.y, pos.z, target.x, target.y, target.z);
  return (
    d <= engagementRange(barrelId) &&
    turretCanSee(world, turretEye(pos), target, store.team[id] ?? 0)
  );
}

export interface TurretFireEvent {
  turretId: number;
  barrel: TurretBarrelId;
  team: number;
  origin: Vec3;
  direction: Vec3;
}

/** Ready -> Firing -> Reload -> Ready, the same shape as `weapons.ts`'s player state
 *  machine but with no ammo: a powered turret with a target always cycles. */
function advanceFireCycle(world: World, id: number, dt: number): void {
  const store = world.turrets;
  const barrel = TURRET_BARREL_DATA[store.barrel[id] as TurretBarrelId];
  const timer = (store.timer[id] ?? 0) - dt;
  if (timer > 0) {
    store.timer[id] = timer;
    return;
  }
  if (store.state[id] === TurretState.Firing) {
    store.state[id] = TurretState.Reload;
    store.timer[id] = barrel.reloadTime;
    return;
  }
  store.state[id] = TurretState.Ready;
  store.timer[id] = 0;
}

function fireAt(world: World, id: number): void {
  const store = world.turrets;
  const barrelId = store.barrel[id] as TurretBarrelId;
  const barrel = TURRET_BARREL_DATA[barrelId];
  const pos = turretPosition(store, id);
  const targetId = store.targetId[id] ?? -1;
  const target =
    store.targetKind[id] === 1 ? vehiclePoint(world, targetId) : playerPoint(world, targetId);
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dz = target.z - pos.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  world.pendingTurretFireEvents.push({
    turretId: id,
    barrel: barrelId,
    team: store.team[id] ?? 0,
    origin: pos,
    direction: { x: dx / len, y: dy / len, z: dz / len },
  });
  store.state[id] = TurretState.Firing;
  store.timer[id] = barrel.fireTime;
}

function stepOneTurret(world: World, id: number, dt: number): void {
  const store = world.turrets;
  if (!store.powered[id] || store.destroyed[id]) {
    store.targetId[id] = -1;
    return;
  }
  if (!targetStillValid(world, id)) store.targetId[id] = acquireTarget(world, id);
  if ((store.targetId[id] ?? -1) < 0) return;
  if (store.state[id] === TurretState.Ready) fireAt(world, id);
  else advanceFireCycle(world, id, dt);
}

// --- AA seeker guidance (issue #57) ---------------------------------------------------------

const SEEKER_FIXED_DT = 32 / 1000; // matches damage.ts/projectiles.ts's own tick constant
/** Real (turrets/aaBarrelLarge.cs:181-184): `isSeeker = true` with `seekTime = 1.0` -- a
 *  launched missile flies straight this long while the seeker locks on, then homes. */
const AA_SEEK_TIME = 1.0;
const AA_SEEK_TICKS = Math.round(AA_SEEK_TIME / SEEKER_FIXED_DT);
/** Ours, rad/s: the homing turn rate. The script's remaining seeker fields are
 *  acquisition-side and already satisfied by this sim's shape -- seekRadius 200 is the
 *  barrel's own attackRadius (the gate nearestVehicleTarget applies), maxSeekAngle
 *  6 degrees holds at launch by construction (fireAt aims the shot exactly at the locked
 *  target), and minSeekHeat 0.6 stands in as the barrel's vehiclesOnly targeting (vehicles
 *  are the only hot targets it ever acquires). The engine's homing turn rate itself is not
 *  in the script; 4.5 rad/s turns a 150 m/s shot inside a ~33 m radius -- tight enough to
 *  run down a crossing Shrike at the Large base's 80 m sensor range, loose enough that a
 *  point-blank crossing target still draws a visible pursuit arc instead of snapping onto
 *  it (the WILDCAT_STEERING_FORCE precedent: an untuned value is either flaccid or twitchy). */
const AA_SEEK_TURN_RATE = 4.5;

/** True while this projectile is one of this turret store's own AA missiles: any live shot
 *  whose sourceTurretId still names an AABarrelLarge. Matching on the firing turret's own
 *  barrel (instead of projectiles.ts's weaponId offset arithmetic) keeps seeker
 *  identification inside the turret data that defines the barrel. */
function isAASeeker(world: World, id: number): boolean {
  const store = world.projectiles;
  if (!store.active[id]) return false;
  const turretId = store.sourceTurretId[id] ?? -1;
  return turretId >= 0 && world.turrets.barrel[turretId] === TurretBarrelId.AABarrelLarge;
}

/** The locked vehicle target this seeker's own turret currently holds, or null once that
 *  lock is gone (killed / out of range / occluded / turret destroyed or unpowered --
 *  stepOneTurret clears targetId the same tick it invalidates, and runs before
 *  stepAASeekers on every call). A seeker whose lock is gone flies straight, like a real
 *  heat-seeker that lost the signature; the missile does NOT re-scan for a new target on
 *  its own -- the barrel's acquisition IS the lock, which is what targetStillValid already
 *  re-checks every tick. */
function seekerTargetPoint(world: World, turretId: number): Vec3 | null {
  const store = world.turrets;
  if ((store.targetId[turretId] ?? -1) < 0 || store.targetKind[turretId] !== 1) return null;
  return vehiclePoint(world, store.targetId[turretId]!);
}

/** Rotates `velocity` toward `target` by at most AA_SEEK_TURN_RATE * dt, preserving speed --
 *  a seeker re-aims, it does not accelerate. Returns the steered velocity rather than
 *  writing the store, so stepOneSeeker owns the write. */
function steerToward(velocity: Vec3, position: Vec3, target: Vec3, dt: number): Vec3 {
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const dist = Math.hypot(dx, dy, dz);
  if (speed <= 0 || dist <= 0) return velocity;
  const desired = { x: dx / dist, y: dy / dist, z: dz / dist };
  const current = { x: velocity.x / speed, y: velocity.y / speed, z: velocity.z / speed };
  const axis = {
    x: current.y * desired.z - current.z * desired.y,
    y: current.z * desired.x - current.x * desired.z,
    z: current.x * desired.y - current.y * desired.x,
  };
  const sin = Math.hypot(axis.x, axis.y, axis.z);
  const cos = current.x * desired.x + current.y * desired.y + current.z * desired.z;
  if (sin <= 0) return velocity; // aligned (done), or exactly anti-parallel with no axis
  const turn = Math.min(Math.atan2(sin, cos), AA_SEEK_TURN_RATE * dt);
  const k = { x: axis.x / sin, y: axis.y / sin, z: axis.z / sin };
  // Rodrigues rotation of the unit heading around `k` by `turn`, scaled back to `speed`.
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const cross = {
    x: k.y * current.z - k.z * current.y,
    y: k.z * current.x - k.x * current.z,
    z: k.x * current.y - k.y * current.x,
  };
  const dot = k.x * current.x + k.y * current.y + k.z * current.z;
  return {
    x: (current.x * c + cross.x * s + k.x * dot * (1 - c)) * speed,
    y: (current.y * c + cross.y * s + k.y * dot * (1 - c)) * speed,
    z: (current.z * c + cross.z * s + k.z * dot * (1 - c)) * speed,
  };
}

/** Steers one AA missile toward its turret's lock, once its seekTime straight fly-out has
 *  elapsed. Reads stepProjectiles's own per-projectile ticks-alive counter (see
 *  ProjectileStore.expiresAtTick's field comment -- the name is historical) rather than
 *  world.tick, so guidance behaves identically whether the caller is stepWorld or a test
/** `arr[base + i] ?? 0` as one call instead of six inline operators -- the same reason
 *  vehicles.ts's own `at()` exists: each inline `?? 0` is a separate branch against this
 *  file's ESLint complexity budget, and a seeker step reads two full Vec3s per tick. */
function vecAt(arr: Float64Array, base: number): Vec3 {
  return { x: arr[base] ?? 0, y: arr[base + 1] ?? 0, z: arr[base + 2] ?? 0 };
}

/** Steers one AA missile toward its turret's lock, once its seekTime straight fly-out has
 *  elapsed. Reads stepProjectiles's own per-projectile ticks-alive counter (see
 *  ProjectileStore.expiresAtTick's field comment -- the name is historical) rather than
 *  world.tick, so guidance behaves identically whether the caller is stepWorld or a test
 *  stepping stepProjectiles directly. */
function stepOneSeeker(world: World, id: number, dt: number): void {
  const store = world.projectiles;
  if ((store.expiresAtTick[id] ?? 0) < AA_SEEK_TICKS) return;
  const target = seekerTargetPoint(world, store.sourceTurretId[id] ?? -1);
  if (!target) return;
  const base = id * 3;
  const steered = steerToward(vecAt(store.velocity, base), vecAt(store.position, base), target, dt);
  store.velocity[base] = steered.x;
  store.velocity[base + 1] = steered.y;
  store.velocity[base + 2] = steered.z;
}

/** Runs after this tick's own acquisition/firing pass (stepOneTurret per turret) and
 *  before stepProjectiles -- stepWorld calls stepTurrets there, so the steered velocity is
 *  what this same tick's tracer integration actually flies, with no guidance latency. */
function stepAASeekers(world: World, dt: number): void {
  const store = world.projectiles;
  for (let id = 0; id < store.count; id += 1) {
    if (!isAASeeker(world, id)) continue;
    stepOneSeeker(world, id, dt);
  }
}

export function stepTurrets(world: World, dt: number): void {
  stepTurretPower(world);
  world.pendingTurretFireEvents = [];
  for (let id = 0; id < world.turrets.count; id += 1) stepOneTurret(world, id, dt);
  stepAASeekers(world, dt);
}

// --- Collision shape (issue #54) -------------------------------------------------------------

/** A vertical cylinder on the placement's own axis, in the placement's frame: the pedestal
 *  and the head column are both solids of revolution, so neither needs a turret yaw the sim
 *  does not carry. */
interface TurretHitCylinder {
  y0: number;
  y1: number;
  radius: number;
}

/** The barrel's own capsule, bored from the mount socket (a) out along the barrel axis to the
 *  GLB's muzzle marker (b). The one volume that is not a solid of revolution: a barrel is long
 *  and thin, and a sphere that covered it would have to be as long as the barrel. */
interface TurretHitCapsule {
  a: Vec3;
  b: Vec3;
  radius: number;
}

/** Measured shape data for one barrel, shared and frozen: every number below is read from the
 *  source GLBs (see TURRET_HIT_SHAPE_DATA), never tuned. */
export interface TurretHitShapeData {
  pedestal: TurretHitCylinder;
  /** Head column: the base mesh's arms/sleeve (and the drawn barrel inside them). Null only
   *  for the pedestal-less sentry, whose whole head fits the pedestal cylinder. */
  head: TurretHitCylinder | null;
  /** Null when the barrel's own mesh and muzzle marker already stay inside the head column
   *  (the AA barrel and the sentry). */
  barrel: TurretHitCapsule | null;
  /** The union's circumscribed sphere, for the one consumer that still ray-tests a sphere:
   *  repair.ts's repair-beam candidate search (see turretHitbox). */
  bound: { centerY: number; radius: number };
}

/**
 * Issue #54: the turret's collision volumes, measured from the source GLBs rather than
 * approximated. Every volume is a solid of revolution about the placement's own vertical axis
 * except the barrel capsule, so the shape needs no turret yaw -- and `createTurrets` carries
 * none: both call sites pass only `{ barrel, team, position }`, and the scene's placement
 * rotation never reaches the sim (packages/server/src/world.ts and packages/client/src/app.ts
 * both drop it; the client's call site is out of this task's scope). The residuals that leaves
 * are measured and listed below rather than papered over with a bigger sphere.
 *
 * Measured by reading the JSON chunks of `packages/assets/cache/shapes.vl2/shapes/*.glb`: each
 * mesh-bearing node's POSITION accessor min/max baked through the node's static transform (the
 * same JSON-chunk read `packages/assets/src/interiors.ts`'s `extractTriangles` performs,
 * without decoding the Draco buffers), keeping the intact nodes and dropping the `HULK_*`
 * wreck variants (`vis_keyframes_visibility` is 0 while intact, 1 once destroyed). All numbers
 * are metres in the placement's own frame; the bracketed point is the box corner that sets a
 * radius.
 *
 * `turret_base_large.glb` (the pedestal every large barrel mounts on):
 *   BaseMain     x ±1.1194  y 0.0011..1.2833  z -0.4110..2.0712  -> r 2.3543 [1.1194, 2.0712]
 *   PostBaseL/R  x ±0.8632  y -0.0004..0.5079  z -1.0651..-0.4019
 *   PostCapL/R   y 1.2780..1.3260 (the tallest node that does not turn with the head)
 *   Arms         x ±0.5310  y 0.3544..2.0508  z -0.3740..1.2007  -> r 1.3130 [0.5310, 1.2007]
 *   Sleeve       x ±0.3819  y 1.4375..2.2179  z -1.0417..0.2566  (intact top 2.2179)
 *   BaseWingL/R  x 0.4492..1.3162  y -0.0001..1.1802  z 0.5510..2.4015 -> r 2.7385
 *   Mount0 (the barrel socket) sits at (0, 1.8265, -0.4001); the head's yaw joint (DumTurn)
 *   sits at (0, 0.7608, 0.6989), so the socket swings on a 1.0990 m radius about it, i.e.
 *   0.4001 to 1.7979 m from the placement axis as the head turns.
 * `turret_fusion_large.glb`, mounted on that socket (its Mountpoint is at (0, 0.3499, 0)):
 *   its Muzzlepoint lands at (0, 1.8427, 1.3571), 1.7573 m out along the barrel axis, while the
 *   intact barrel nodes span -0.5029..0.8937 along that axis with a 0.4363 m maximum
 *   perpendicular radius (the breech block, Body_ 0.5098 x 0.6951). The remaining 0.86 m to the
 *   muzzle marker is the source's barrel-extension animation (DumActBarrelExtend) -- i.e. the
 *   barrel a firing mount draws.
 * `turret_aa_large.glb` on the same socket: its muzzle marker is only 0.8382 m out, at
 *   (0, 2.0012, 0.4196), and its whole intact mesh (max radius 0.9353, top 2.1751) is inside
 *   the head column, so it gets no barrel volume of its own.
 * `turret_sentry.glb` (barrel 2 draws this GLB whole): Base x -0.3566..0.4550,
 *   z -0.4329..0.4212 -> r 0.6280, intact y -0.2597..0.3898. Its head turns about a post axis
 *   0.0386 m off the placement axis and its widest head part (Body, r 0.4975) stays inside that
 *   radius in every yaw, so one cylinder is its exact shape.
 *
 * Measured volume and coverage against the intact node boxes (600k-sample Monte Carlo over the
 * union AABB; "phantom" is the shape's own volume lying outside every box, "covers" is the
 * boxes' volume inside the shape):
 *   large, the replaced sphere (r 2.0 at +1.3):    33.510 m3, 73.1% phantom, covers 80.6%
 *   large, this shape:                             34.653 m3, 44.4% phantom, covers 95.7%
 *   sentry, the replaced sphere (r 0.65 at -0.07):   1.150 m3, 86.6% phantom, covers 100%
 *   sentry, this cylinder:                           0.808 m3, 64.3% phantom, covers 100%
 * The old sphere reached y 3.30, 1.08 m of phantom above the intact 2.2179 top; this shape's
 * highest volume is the barrel capsule's muzzle cap at y 2.279. The old sphere stopped at
 * r 2.0, and so missed the 2.3543 base-body corners and the 2.7385 wing tips entirely.
 *
 * Known residuals, both needing scene rotation on the sim store -- a `createTurrets` field no
 * call site passes today, so they are reported rather than guessed at:
 *  - The base wings reach r 2.7385, 0.384 m past the pedestal cylinder. The sphere this
 *    replaces missed them by 0.739 m, so this is still the tighter of the two.
 *  - The barrel capsule sits in the placement's own frame, so a head yawed away from it (the
 *    socket swings 0.4001..1.7979 m from the placement axis about the joint above) or a barrel
 *    pitched anywhere in the base's own 15..140 deg theta band can leave it: measured over that
 *    whole band about the elevation joint (DumElevate, at y 1.8246), the drawn barrel mesh
 *    reaches y 2.6402, its Muzzlepoint -- the fired extension's tip -- 3.0010, and the
 *    horizontal radius grows to 1.3572. Covering every yaw instead measures r 2.4939 about the
 *    placement axis: a cylinder over the head's own 0.354..2.218 m band alone is 36.4 m3, more
 *    than this entire shape's 34.653 m3, and it would block shots that visibly pass beside the
 *    barrel. The authored frame is the pose the client relaxes to (turret-mount.ts's
 *    `relaxTowardRest`) and the frame every other turret constant in this file already uses.
 */
export const TURRET_HIT_SHAPE_DATA: Record<TurretBarrelId, TurretHitShapeData> = {
  // The pedestal cylinder is BaseMain's circumscribed radius (its widest intact part), rounded
  // outward a hair to the nearest millimetre; the head column is the Arms/Sleeve span above it.
  [TurretBarrelId.PlasmaBarrelLarge]: {
    pedestal: { y0: -0.001, y1: 1.327, radius: 2.355 },
    head: { y0: 0.354, y1: 2.219, radius: 1.314 },
    barrel: {
      a: { x: 0, y: 1.8265, z: -0.4001 },
      b: { x: 0, y: 1.8427, z: 1.3571 },
      radius: 0.4363,
    },
    bound: { centerY: 0.663, radius: 2.4468 },
  },
  [TurretBarrelId.AABarrelLarge]: {
    pedestal: { y0: -0.001, y1: 1.327, radius: 2.355 },
    head: { y0: 0.354, y1: 2.219, radius: 1.314 },
    barrel: null,
    bound: { centerY: 0.663, radius: 2.4468 },
  },
  [TurretBarrelId.SentryTurretBarrel]: {
    pedestal: { y0: -0.26, y1: 0.39, radius: 0.629 },
    head: null,
    barrel: null,
    bound: { centerY: 0.065, radius: 0.7079 },
  },
};

/** A turret's collision shape in world space: the placement origin every local volume in
 *  `data` is offset by. `data` is the shared frozen table above, so a lookup costs one small
 *  object per turret per hit test rather than one per volume. */
export interface TurretHitShape {
  x: number;
  y: number;
  z: number;
  data: TurretHitShapeData;
}

export function turretHitShape(world: World, id: number): TurretHitShape {
  const base = id * 3;
  return {
    x: world.turrets.position[base] ?? 0,
    y: world.turrets.position[base + 1] ?? 0,
    z: world.turrets.position[base + 2] ?? 0,
    data: TURRET_HIT_SHAPE_DATA[world.turrets.barrel[id] as TurretBarrelId],
  };
}

/** Entry distance of the unit-direction ray `origin + t * dir` into one vertical cylinder, or
 *  null when it misses or only meets it behind the origin. Standard slab/interval test: the
 *  entry is the later of the two axes' entries and must not be past the earlier of the exits,
 *  which also makes an origin already inside it resolve to 0 rather than a negative root. */
function rayCylinderDistance(
  lx: number,
  ly: number,
  lz: number,
  dir: Vec3,
  cylinder: TurretHitCylinder,
): number | null {
  let enter = -Infinity;
  let exit = Infinity;
  if (dir.y === 0) {
    if (ly < cylinder.y0 || ly > cylinder.y1) return null;
  } else {
    const a = (cylinder.y0 - ly) / dir.y;
    const b = (cylinder.y1 - ly) / dir.y;
    enter = Math.min(a, b);
    exit = Math.max(a, b);
  }
  const a2 = dir.x * dir.x + dir.z * dir.z;
  const b2 = lx * dir.x + lz * dir.z;
  const c2 = lx * lx + lz * lz - cylinder.radius * cylinder.radius;
  const discriminant = b2 * b2 - a2 * c2;
  if (discriminant < 0) return null;
  if (a2 === 0) {
    if (c2 > 0) return null;
  } else {
    const root = Math.sqrt(discriminant);
    enter = Math.max(enter, (-b2 - root) / a2);
    exit = Math.min(exit, (-b2 + root) / a2);
  }
  return enter > exit ? null : Math.max(0, enter);
}

/** Closest distance from (px, py, pz) to the segment a..b -- shared by the capsule's own
 *  containment test and its point distance, so the two can never disagree. */
function distanceToSegment(px: number, py: number, pz: number, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const length2 = abx * abx + aby * aby + abz * abz;
  const axial = (px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, axial / length2));
  return Math.hypot(px - a.x - abx * t, py - a.y - aby * t, pz - a.z - abz * t);
}

/** The scalar twin of damage.ts's `raySphereDistance`: the same "an origin inside counts as a
 *  hit at 0, a sphere entirely behind the origin does not" contract, without allocating a
 *  PlayerHitbox for every end cap of every barrel on every projectile tick. */
function raySphereEntry(
  lx: number,
  ly: number,
  lz: number,
  dir: Vec3,
  center: Vec3,
  radius: number,
): number | null {
  const px = lx - center.x;
  const py = ly - center.y;
  const pz = lz - center.z;
  const b = px * dir.x + py * dir.y + pz * dir.z;
  const c = px * px + py * py + pz * pz - radius * radius;
  const discriminant = b * b - c; // `dir` is unit length, so the quadratic's a term is 1.
  if (discriminant < 0) return null;
  if (c <= 0) return 0;
  const t = -b - Math.sqrt(discriminant);
  return t >= 0 ? t : null;
}

/** Entry distance of the ray into the capsule's straight side: the infinite cylinder about
 *  the segment's axis, clamped to the segment's own span `0..length`. Split out of
 *  `rayCapsuleDistance` to keep both under this file's complexity budget. */
function capsuleSideEntry(
  lx: number,
  ly: number,
  lz: number,
  dir: Vec3,
  capsule: TurretHitCapsule,
  length: number,
): number | null {
  const ox = lx - capsule.a.x;
  const oy = ly - capsule.a.y;
  const oz = lz - capsule.a.z;
  const ux = (capsule.b.x - capsule.a.x) / length;
  const uy = (capsule.b.y - capsule.a.y) / length;
  const uz = (capsule.b.z - capsule.a.z) / length;
  const axial = ox * ux + oy * uy + oz * uz;
  const px = ox - axial * ux;
  const py = oy - axial * uy;
  const pz = oz - axial * uz;
  const along = dir.x * ux + dir.y * uy + dir.z * uz;
  const qx = dir.x - along * ux;
  const qy = dir.y - along * uy;
  const qz = dir.z - along * uz;
  const a2 = qx * qx + qy * qy + qz * qz;
  if (a2 === 0) return null;
  const b2 = px * qx + py * qy + pz * qz;
  const c2 = px * px + py * py + pz * pz - capsule.radius * capsule.radius;
  const discriminant = b2 * b2 - a2 * c2;
  if (discriminant < 0) return null;
  const t = (-b2 - Math.sqrt(discriminant)) / a2;
  const hitAxial = axial + t * along;
  if (t < 0 || hitAxial < 0 || hitAxial > length) return null;
  return t;
}

/** Entry distance of the ray into the barrel capsule, or null. The side comes from the
 *  segment's own cylinder and each cap from the sphere at its end; the earliest non-negative
 *  of the three is the entry. */
function rayCapsuleDistance(
  lx: number,
  ly: number,
  lz: number,
  dir: Vec3,
  capsule: TurretHitCapsule,
): number | null {
  if (distanceToSegment(lx, ly, lz, capsule.a, capsule.b) <= capsule.radius) return 0;
  const entryA = raySphereEntry(lx, ly, lz, dir, capsule.a, capsule.radius);
  const entryB = raySphereEntry(lx, ly, lz, dir, capsule.b, capsule.radius);
  const nearest = minEntry(entryA, entryB);
  const length = Math.hypot(
    capsule.b.x - capsule.a.x,
    capsule.b.y - capsule.a.y,
    capsule.b.z - capsule.a.z,
  );
  if (length === 0) return nearest;
  return minEntry(nearest, capsuleSideEntry(lx, ly, lz, dir, capsule, length));
}

function minEntry(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Nearest entry distance of a unit-direction ray into a turret's shape, or null when it
 *  misses every volume. Shared by the live shot test and the lag-comp recheck (both go through
 *  projectiles.ts's `nearestStructureHitFrom`), so a hit that resolves live resolves the same
 *  way when it is re-run against a rewound segment. */
export function rayTurretHitShapeDistance(
  origin: Vec3,
  dir: Vec3,
  shape: TurretHitShape,
): number | null {
  const lx = origin.x - shape.x;
  const ly = origin.y - shape.y;
  const lz = origin.z - shape.z;
  let nearest = rayCylinderDistance(lx, ly, lz, dir, shape.data.pedestal);
  const head = shape.data.head;
  const barrel = shape.data.barrel;
  if (head) nearest = minEntry(nearest, rayCylinderDistance(lx, ly, lz, dir, head));
  if (barrel) nearest = minEntry(nearest, rayCapsuleDistance(lx, ly, lz, dir, barrel));
  return nearest;
}

function distanceToCylinder(
  lx: number,
  ly: number,
  lz: number,
  cylinder: TurretHitCylinder,
): number {
  const radial = Math.max(0, Math.hypot(lx, lz) - cylinder.radius);
  const vertical = Math.max(0, cylinder.y0 - ly, ly - cylinder.y1);
  return Math.hypot(radial, vertical);
}

/** Distance from `point` to the shape's nearest surface, 0 when inside: what splash damage
 *  measures its falloff against, so a blast landing on the barrel is as close to the turret as
 *  it looks. */
export function distanceToTurretHitShape(shape: TurretHitShape, point: Vec3): number {
  const lx = point.x - shape.x;
  const ly = point.y - shape.y;
  const lz = point.z - shape.z;
  let nearest = distanceToCylinder(lx, ly, lz, shape.data.pedestal);
  const head = shape.data.head;
  const barrel = shape.data.barrel;
  if (head) nearest = Math.min(nearest, distanceToCylinder(lx, ly, lz, head));
  if (barrel)
    nearest = Math.min(nearest, distanceToSegment(lx, ly, lz, barrel.a, barrel.b) - barrel.radius);
  return Math.max(0, nearest);
}

/** Shared collision/repair target around the visible turret: the circumscribed sphere of
 *  `turretHitShape`'s own volumes, so repair targeting reads the same measured geometry the
 *  projectile and splash tests do. A sphere rather than the cylinders because repair.ts tests
 *  candidates with `raySphereDistance`; converting its turret search to the shape's own ray
 *  test is a change inside that file, which this task froze. The sphere bounds exactly the
 *  same volumes, so it can never select a turret the shape does not cover, and the terrain/
 *  interior gate above it (`hasRepairLineOfSight`) is unchanged. */
export function turretHitbox(world: World, id: number): PlayerHitbox {
  const shape = turretHitShape(world, id);
  return {
    center: { x: shape.x, y: shape.y + shape.data.bound.centerY, z: shape.z },
    radius: shape.data.bound.radius,
    headY: Infinity,
  };
}
