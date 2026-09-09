import { teamHasPower } from './baseObjects.js';
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
 * destroyed/powered/targetId/state) onto the store by id, growing `store.count` to fit an id
 * that's never been locally placed yet -- the turret-store sibling of baseObjects.ts's
 * `applyBaseObjectSnapshot`; see that function's own comment for why static placement
 * (barrel/team/position) never needs to be on the wire at all.
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
 *  sight from the turret's eye position to the player. Matches the real T2 sensor's
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
    if (!hasLineOfSight(world, eye, target)) continue;
    nearest = playerId;
    nearestDistance = d;
  }
  return nearest;
}

/** `vehiclesOnly` barrels' own version of `nearestPlayerTarget` (M5, Task 8) — dormant since
 *  M4, this is the one deliberate gap the plan closes: an AA barrel with line of sight to an
 *  enemy vehicle in range now acquires and fires on it, same rules as a ground turret firing
 *  on a player (failure matrix row 15). */
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
    if (!hasLineOfSight(world, eye, target)) continue;
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
 *  (failure matrix row 12), "target walked out of range", and "target walked behind terrain"
 *  (failure matrix row 16) alike — there is no separate code path for any of the three
 *  causes. Branches on `targetKind` to read the right store for a vehicle target (M5). */
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
  return d <= engagementRange(barrelId) && hasLineOfSight(world, turretEye(pos), target);
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

export function stepTurrets(world: World, dt: number): void {
  stepTurretPower(world);
  world.pendingTurretFireEvents = [];
  for (let id = 0; id < world.turrets.count; id += 1) stepOneTurret(world, id, dt);
}

/** Shared collision/repair target around the visible turret, above its placement origin.
 * Large base geometry reaches 2.26 m high; its barrel socket is at 1.83 m.
 * Conservative sphere envelopes approximate the original mounted GLB geometry. */
export function turretHitbox(world: World, id: number) {
  const base = id * 3;
  const sentry = world.turrets.barrel[id] === TurretBarrelId.SentryTurretBarrel;
  return {
    center: {
      x: world.turrets.position[base] ?? 0,
      y: (world.turrets.position[base + 1] ?? 0) + (sentry ? -0.07 : 1.3),
      z: world.turrets.position[base + 2] ?? 0,
    },
    radius: sentry ? 0.65 : 2,
    headY: Infinity,
  };
}
