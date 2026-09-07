import { BaseObjectKind, teamHasPower, type BaseObjectStore } from './baseObjects.js';
import { GRAVITY } from './movement.js';
import type { PendingFreeId, PlayerInput, Vec3, World } from './types.js';

export enum VehicleKind {
  Shrike = 0,
  Wildcat = 1,
}

export interface VehicleData {
  mass: number;
  maxDamage: number;
  maxEnergy: number;
  energyPerDamagePoint: number;
  rechargeRate: number;
  checkRadius: number;
  minMountDist: number;
  collDamageThresholdVel: number;
  collDamageMultiplier: number;
  groundImpactMinSpeed: number;
  groundImpactSpeedDamageScale: number;
  cameraMaxDist: number;
  cameraOffset: number;
  cameraLag: number;
}

// Spec's Vehicle numbers table, used exactly for every field it gives; every other field
// cites the real T2 script inline (see the plan's numbers table for line ranges).
export const VEHICLE_DATA: Record<VehicleKind, VehicleData> = {
  [VehicleKind.Shrike]: {
    mass: 150,
    maxDamage: 1.4,
    maxEnergy: 280,
    energyPerDamagePoint: 160,
    rechargeRate: 0.8,
    checkRadius: 5.5, // vehicles/vehicle_shrike.cs:225
    minMountDist: 4, // vehicles/vehicle_shrike.cs:209
    collDamageThresholdVel: 23,
    collDamageMultiplier: 0.02,
    groundImpactMinSpeed: 10, // vehicles/vehicle_shrike.cs:162
    groundImpactSpeedDamageScale: 0.06, // vehicles/vehicle_shrike.cs:163
    cameraMaxDist: 15, // vehicles/vehicle_shrike.cs:112
    cameraOffset: 2.5, // vehicles/vehicle_shrike.cs:113
    cameraLag: 0.9, // vehicles/vehicle_shrike.cs:114
  },
  [VehicleKind.Wildcat]: {
    mass: 400,
    maxDamage: 0.6,
    maxEnergy: 150,
    energyPerDamagePoint: 75,
    rechargeRate: 0.7,
    checkRadius: 1.7785, // vehicles/vehicle_wildcat.cs:209
    minMountDist: 4, // vehicles/vehicle_wildcat.cs:185
    collDamageThresholdVel: 23,
    collDamageMultiplier: 0.03,
    groundImpactMinSpeed: 29, // vehicles/vehicle_wildcat.cs:127
    groundImpactSpeedDamageScale: 0.01, // vehicles/vehicle_wildcat.cs:128
    cameraMaxDist: 5.0, // vehicles/vehicle_wildcat.cs:98
    cameraOffset: 0.7, // vehicles/vehicle_wildcat.cs:99
    cameraLag: 0.5, // vehicles/vehicle_wildcat.cs:100
  },
};

export interface VehicleStore {
  count: number;
  freeIds: number[];
  pendingFreeIds: PendingFreeId[]; // mirrors ProjectileStore's own field, same reason (M3)
  active: Uint8Array;
  kind: Uint8Array;
  team: Uint8Array;
  position: Float64Array;
  velocity: Float64Array;
  yaw: Float64Array;
  pitch: Float64Array;
  roll: Float64Array;
  angVel: Float64Array; // yaw/pitch/roll rates, 3 per id
  energy: Float64Array;
  damage: Float64Array;
  destroyed: Uint8Array;
  driverId: Int16Array; // -1 = unpiloted
  padId: Int16Array; // originating BaseObjectStore id, -1 if none
  weaponTimer: Float64Array; // Shrike blaster cooldown; unused by Wildcat
  onGround: Uint8Array;
}

export const MOUNT_RANGE = 4; // real, both kinds; see VEHICLE_DATA.minMountDist per-kind above
export const VEHICLE_PAD_USE_RADIUS = 4; // ours — see the plan's numbers table

const VEHICLE_CAPACITY = 8; // ours: Katabatic needs at most 2 concurrently; headroom for id retention.

export function createVehicleStore(capacity = VEHICLE_CAPACITY): VehicleStore {
  return {
    count: 0,
    freeIds: [],
    pendingFreeIds: [],
    active: new Uint8Array(capacity),
    kind: new Uint8Array(capacity),
    team: new Uint8Array(capacity),
    position: new Float64Array(capacity * 3),
    velocity: new Float64Array(capacity * 3),
    yaw: new Float64Array(capacity),
    pitch: new Float64Array(capacity),
    roll: new Float64Array(capacity),
    angVel: new Float64Array(capacity * 3),
    energy: new Float64Array(capacity),
    damage: new Float64Array(capacity),
    destroyed: new Uint8Array(capacity),
    driverId: new Int16Array(capacity).fill(-1),
    padId: new Int16Array(capacity).fill(-1),
    weaponTimer: new Float64Array(capacity),
    onGround: new Uint8Array(capacity),
  };
}

function allocate(store: VehicleStore): number | null {
  const id = store.freeIds.pop() ?? store.count;
  if (id >= store.active.length) return null;
  if (id === store.count) store.count += 1;
  return id;
}

function poweredPadsForTeam(baseObjects: BaseObjectStore, world: World, team: number): number[] {
  const ids: number[] = [];
  // BaseObjectStore has no `active` field on main -- a base object is never removed once
  // placed, so "exists" is exactly `id < baseObjects.count` (see baseObjects.ts's own
  // teamHasPower doc comment), which this loop's bound already guarantees.
  for (let id = 0; id < baseObjects.count; id += 1) {
    if (baseObjects.kind[id] !== BaseObjectKind.StationVehiclePad) continue;
    if (baseObjects.team[id] !== team) continue;
    if (!teamHasPower(world, team)) continue;
    ids.push(id);
  }
  return ids;
}

export function vehicleCapForTeam(world: World, team: number): number {
  return poweredPadsForTeam(world.baseObjects, world, team).length;
}

export function activeVehicleCountForTeam(world: World, team: number): number {
  const vehicles = world.vehicles;
  let count = 0;
  for (let id = 0; id < vehicles.count; id += 1) {
    if (vehicles.active[id] && !vehicles.destroyed[id] && vehicles.team[id] === team) count += 1;
  }
  return count;
}

function destroyExistingAtPad(world: World, padId: number): void {
  const vehicles = world.vehicles;
  for (let id = 0; id < vehicles.count; id += 1) {
    if (vehicles.active[id] && !vehicles.destroyed[id] && vehicles.padId[id] === padId) {
      // Task 7 owns the real destruction/ejection path; Task 1 only needs the flag set so
      // the new spawn below is never blocked by "old vehicle still counts against the cap."
      vehicles.destroyed[id] = 1;
    }
  }
}

/** `null` when `padId` cannot host a spawn at all: missing, not a StationVehiclePad, or
 *  unpowered. Split out of `spawnVehicleAtPad` to keep that function's own complexity under
 *  budget. */
function padSpawnTeam(world: World, padId: number): number | null {
  const baseObjects = world.baseObjects;
  // Existence check only -- `id < count` is the real store's whole existence contract. A
  // destroyed check would be a no-op in practice: BaseObjectKind.StationVehiclePad is
  // `invincible: true` in baseObjects.ts, so applyBaseObjectDamage never destroys a pad.
  if (padId < 0 || padId >= baseObjects.count) return null;
  if (baseObjects.kind[padId] !== BaseObjectKind.StationVehiclePad) return null;
  const team = baseObjects.team[padId] ?? 0;
  if (!teamHasPower(world, team)) return null;
  return team;
}

export function spawnVehicleAtPad(world: World, padId: number, kind: VehicleKind): number | null {
  const team = padSpawnTeam(world, padId);
  if (team === null) return null;

  // Destroy whatever this pad already hosts before the cap check, unconditionally (failure
  // matrix row 5): replacing your own pad's vehicle must never be blocked by the very cap
  // that vehicle itself counts against.
  destroyExistingAtPad(world, padId);
  if (activeVehicleCountForTeam(world, team) >= vehicleCapForTeam(world, team)) return null;

  const id = allocate(world.vehicles);
  if (id === null) return null;
  const vehicles = world.vehicles;
  const baseObjects = world.baseObjects;
  const base = padId * 3;
  const padPos: Vec3 = {
    x: baseObjects.position[base] ?? 0,
    y: baseObjects.position[base + 1] ?? 0,
    z: baseObjects.position[base + 2] ?? 0,
  };
  vehicles.active[id] = 1;
  vehicles.kind[id] = kind;
  vehicles.team[id] = team;
  vehicles.position.set([padPos.x, padPos.y + 2, padPos.z], id * 3);
  vehicles.velocity.set([0, 0, 0], id * 3);
  vehicles.yaw[id] = 0;
  vehicles.pitch[id] = 0;
  vehicles.roll[id] = 0;
  vehicles.angVel.set([0, 0, 0], id * 3);
  vehicles.energy[id] = VEHICLE_DATA[kind].maxEnergy;
  vehicles.damage[id] = 0;
  vehicles.destroyed[id] = 0;
  vehicles.driverId[id] = -1;
  vehicles.padId[id] = padId;
  vehicles.weaponTimer[id] = 0;
  vehicles.onGround[id] = 0;
  return id;
}

// --- Shrike flight physics (Task 2) -----------------------------------------------------
// Real T2 numbers cite vehicles/vehicle_shrike.cs; every field not in the spec's Vehicle
// numbers table is collected in the plan's "ours" numbers table alongside its citation.
const SHRIKE_MIN_DRAG = 30;
const SHRIKE_MANEUVERING_FORCE = 3000; // vehicles/vehicle_shrike.cs:140
const SHRIKE_ROLL_FORCE = 4; // vehicles/vehicle_shrike.cs:143
const SHRIKE_HORIZONTAL_SURFACE_FORCE = 6; // vehicles/vehicle_shrike.cs:138
const SHRIKE_VERT_THRUST_MULTIPLE = 3; // vehicles/vehicle_shrike.cs:152
const SHRIKE_MAX_AUTO_SPEED = 15; // vehicles/vehicle_shrike.cs:131
const SHRIKE_AUTO_ANGULAR_FORCE = 400; // vehicles/vehicle_shrike.cs:131-133 — ours table
const SHRIKE_AUTO_LINEAR_FORCE = 300; // vehicles/vehicle_shrike.cs:132 — ours table
const SHRIKE_ROTATIONAL_DRAG = 900; // vehicles/vehicle_shrike.cs:128 — ours table
const SHRIKE_STEERING_FORCE = 1200; // vehicles/vehicle_shrike.cs:141 — ours table
const SHRIKE_JET_FORCE = 2000;
const SHRIKE_MIN_JET_ENERGY = 28;
const SHRIKE_JET_ENERGY_DRAIN = 2.8;

function headingOf(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

/** `arr[i] ?? 0` as a call instead of an inline operator -- every physics function below
 *  reads a typed array many times per tick, and each inline `?? 0` counts as its own branch
 *  toward that function's own ESLint `complexity` budget. Moving the fallback in here keeps
 *  the reading code flat without inflating every caller. */
function at(arr: Float64Array, i: number): number {
  return arr[i] ?? 0;
}

/** Auto-stabilizer: below maxAutoSpeed, angular velocity relaxes toward zero and linear
 *  velocity toward zero, at autoAngularForce/autoLinearForce -- Torque's own "when you let
 *  go of the stick it levels out" behavior. */
function applyShrikeAutoStabilize(
  vehicles: VehicleStore,
  id: number,
  speed: number,
  dt: number,
): void {
  if (speed >= SHRIKE_MAX_AUTO_SPEED) return;
  const mass = VEHICLE_DATA[VehicleKind.Shrike].mass;
  const base = id * 3;
  for (let axis = 0; axis < 3; axis += 1) {
    const av = vehicles.angVel[base + axis] ?? 0;
    vehicles.angVel[base + axis] =
      av - Math.sign(av) * Math.min(Math.abs(av), (SHRIKE_AUTO_ANGULAR_FORCE / 1000) * dt);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const v = vehicles.velocity[base + axis] ?? 0;
    vehicles.velocity[base + axis] =
      v - Math.sign(v) * Math.min(Math.abs(v), (SHRIKE_AUTO_LINEAR_FORCE / mass) * dt);
  }
}

/** The mouse-steering half of applyShrikeSteering (yaw/pitch/roll angular acceleration) --
 *  split out so the drag-and-integrate half below stays under the complexity budget on its
 *  own rather than one long function paying for both. */
function applyShrikeSteeringInput(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const mass = VEHICLE_DATA[VehicleKind.Shrike].mass;
  const base = id * 3;
  const rate = (SHRIKE_STEERING_FORCE / mass) * dt;
  vehicles.angVel[base + 1] = at(vehicles.angVel, base + 1) + input.yaw * rate;
  vehicles.angVel[base] = at(vehicles.angVel, base) + input.pitch * rate;
  vehicles.angVel[base + 2] =
    at(vehicles.angVel, base + 2) - SHRIKE_ROLL_FORCE * dt * Math.sign(at(vehicles.roll, id));
}

function applyShrikeSteering(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const base = id * 3;
  // Mouse yaw/pitch accelerate angular velocity via steeringForce, not snap the angle --
  // integrated below like everything else, so a held mouse input ramps, matching the real
  // steering-jet model rather than a direct-set rotation.
  applyShrikeSteeringInput(vehicles, id, input, dt);
  vehicles.yaw[id] = at(vehicles.yaw, id) + at(vehicles.angVel, base + 1) * dt;
  vehicles.pitch[id] = at(vehicles.pitch, id) + at(vehicles.angVel, base) * dt;
  vehicles.roll[id] = at(vehicles.roll, id) + at(vehicles.angVel, base + 2) * dt;
  const dragScale = 1 - Math.min(1, (SHRIKE_ROTATIONAL_DRAG / 1000) * dt);
  vehicles.angVel[base] = at(vehicles.angVel, base) * dragScale;
  vehicles.angVel[base + 1] = at(vehicles.angVel, base + 1) * dragScale;
}

function applyShrikeThrust(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const data = VEHICLE_DATA[VehicleKind.Shrike];
  const base = id * 3;
  const heading = headingOf(vehicles.yaw[id] ?? 0, vehicles.pitch[id] ?? 0);
  const thrust = SHRIKE_MANEUVERING_FORCE / data.mass;
  vehicles.velocity[base] = (vehicles.velocity[base] ?? 0) + heading.x * input.moveZ * thrust * dt;
  vehicles.velocity[base + 1] =
    (vehicles.velocity[base + 1] ?? 0) +
    heading.y * input.moveZ * thrust * dt * SHRIKE_VERT_THRUST_MULTIPLE;
  vehicles.velocity[base + 2] =
    (vehicles.velocity[base + 2] ?? 0) + heading.z * input.moveZ * thrust * dt;
}

function applyShrikeJetThrust(vehicles: VehicleStore, id: number, dt: number): void {
  const data = VEHICLE_DATA[VehicleKind.Shrike];
  const base = id * 3;
  const heading = headingOf(at(vehicles.yaw, id), at(vehicles.pitch, id));
  const jet = SHRIKE_JET_FORCE / data.mass;
  vehicles.velocity[base] = at(vehicles.velocity, base) + heading.x * jet * dt;
  vehicles.velocity[base + 1] = at(vehicles.velocity, base + 1) + heading.y * jet * dt;
  vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) + heading.z * jet * dt;
  vehicles.energy[id] = at(vehicles.energy, id) - SHRIKE_JET_ENERGY_DRAIN;
}

/** A held jet input that can't afford minJetEnergy is a flat refusal -- no thrust, no drain,
 *  and (unlike letting go of jet) no recharge either, since the player is still holding the
 *  afterburner down; recharge only resumes once jet is released. */
function applyShrikeAfterburner(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const data = VEHICLE_DATA[VehicleKind.Shrike];
  if (!input.jet) {
    vehicles.energy[id] = Math.min(data.maxEnergy, at(vehicles.energy, id) + data.rechargeRate);
    return;
  }
  if (at(vehicles.energy, id) < SHRIKE_MIN_JET_ENERGY) return;
  applyShrikeJetThrust(vehicles, id, dt);
}

/** Lift ("bite") opposing gravity while moving forward, plus gravity and the Shrike's own
 *  minDrag -- split out of stepShrike to keep its complexity under budget. */
function applyShrikeLiftAndGravity(vehicles: VehicleStore, id: number, dt: number): void {
  const data = VEHICLE_DATA[VehicleKind.Shrike];
  const base = id * 3;
  const heading = headingOf(vehicles.yaw[id] ?? 0, vehicles.pitch[id] ?? 0);
  const forwardSpeed =
    (vehicles.velocity[base] ?? 0) * heading.x + (vehicles.velocity[base + 2] ?? 0) * heading.z;
  vehicles.velocity[base + 1] =
    (vehicles.velocity[base + 1] ?? 0) +
    Math.max(0, forwardSpeed) * (SHRIKE_HORIZONTAL_SURFACE_FORCE / data.mass) * dt -
    GRAVITY * dt;
  const dragScale = 1 - Math.min(1, (SHRIKE_MIN_DRAG / data.mass) * dt);
  vehicles.velocity[base] = (vehicles.velocity[base] ?? 0) * dragScale;
  vehicles.velocity[base + 2] = (vehicles.velocity[base + 2] ?? 0) * dragScale;
}

export function stepShrike(world: World, id: number, input: PlayerInput, dt: number): void {
  const vehicles = world.vehicles;
  const base = id * 3;

  applyShrikeSteering(vehicles, id, input, dt);
  applyShrikeThrust(vehicles, id, input, dt);
  applyShrikeAfterburner(vehicles, id, input, dt);
  applyShrikeLiftAndGravity(vehicles, id, dt);

  const speed = Math.hypot(
    vehicles.velocity[base] ?? 0,
    vehicles.velocity[base + 1] ?? 0,
    vehicles.velocity[base + 2] ?? 0,
  );
  applyShrikeAutoStabilize(vehicles, id, speed, dt);

  vehicles.position[base] = (vehicles.position[base] ?? 0) + (vehicles.velocity[base] ?? 0) * dt;
  vehicles.position[base + 1] =
    (vehicles.position[base + 1] ?? 0) + (vehicles.velocity[base + 1] ?? 0) * dt;
  vehicles.position[base + 2] =
    (vehicles.position[base + 2] ?? 0) + (vehicles.velocity[base + 2] ?? 0) * dt;
}
