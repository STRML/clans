import { BaseObjectKind, teamHasPower, type BaseObjectStore } from './baseObjects.js';
import { raycastInteriors, resolveSphereAgainstInteriors } from './interiors.js';
import { GRAVITY } from './movement.js';
import { sampleTerrain } from './terrain.js';
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

/** Wraps an angle to (-pi, pi]. `PlayerInput.yaw`/`pitch` are the driver's own absolute,
 *  unbounded look angle (client/src/input.ts accumulates `this.yaw -= movementX * sensitivity`
 *  with no wraparound and no clamp on yaw), not a per-tick steering delta -- reusing it as a
 *  vehicle steering INPUT (this file's steeringForce model, and Task 2's own test title,
 *  "steers ... via steeringForce, not a snap") means computing the shortest angular distance
 *  from the vehicle's current heading to where the driver is looking, then accelerating
 *  toward closing that gap -- not multiplying the raw (potentially many-radians) input value
 *  directly, which the plan's own sketch did and which produces an unbounded, un-physical
 *  angular acceleration spike once a player has looked around a few full turns. */
function normalizeAngle(angle: number): number {
  return angle - Math.round(angle / (2 * Math.PI)) * 2 * Math.PI;
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
  const yawError = normalizeAngle(input.yaw - at(vehicles.yaw, id));
  const pitchError = normalizeAngle(input.pitch - at(vehicles.pitch, id));
  vehicles.angVel[base + 1] = at(vehicles.angVel, base + 1) + yawError * rate;
  vehicles.angVel[base] = at(vehicles.angVel, base) + pitchError * rate;
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

// --- Wildcat hover physics (Task 3) -----------------------------------------------------
// Real T2 numbers cite vehicles/vehicle_wildcat.cs; every field not in the spec's Vehicle
// numbers table is collected in the plan's "ours" numbers table alongside its citation.
const WILDCAT_STAB_LEN_MIN = 2.25; // vehicles/vehicle_wildcat.cs:146
const WILDCAT_STAB_LEN_MAX = 3.75; // vehicles/vehicle_wildcat.cs:147
const WILDCAT_STAB_SPRING = 30; // vehicles/vehicle_wildcat.cs:148
const WILDCAT_STAB_DAMPING = 16; // vehicles/vehicle_wildcat.cs:149
const WILDCAT_MAIN_THRUST = 30; // vehicles/vehicle_wildcat.cs:138
const WILDCAT_REVERSE_THRUST = 10; // vehicles/vehicle_wildcat.cs:139 — ours table
const WILDCAT_STRAFE_THRUST = 8; // vehicles/vehicle_wildcat.cs:140 — ours table
const WILDCAT_TURBO_FACTOR = 1.5; // vehicles/vehicle_wildcat.cs:141
const WILDCAT_BRAKING_FORCE = 25; // vehicles/vehicle_wildcat.cs:143 — ours table
const WILDCAT_BRAKING_ACTIVATION_SPEED = 4; // vehicles/vehicle_wildcat.cs:144 — ours table
// Not in the plan's own numbers table despite appearing in its code sketch -- an
// undisclosed "ours" value (see the PR body). Tuned low: at the per-radian-error steering
// model this file uses (see normalizeAngle's own comment), the plan's original 30 produced
// an unplayably twitchy turn once divided against a realistic error range.
const WILDCAT_STEERING_FORCE = 2.5;
const WILDCAT_ROLL_FORCE = 15;
const WILDCAT_GYRO_DRAG = 16; // spec's Vehicle numbers table
const WILDCAT_MIN_JET_ENERGY = 15;
const WILDCAT_JET_ENERGY_DRAIN = 1.3;
// Ours: no jump exists in the real script -- see the plan's numbers table and Spec gaps.
const WILDCAT_JUMP_IMPULSE_PER_MASS = 8.3; // matches the player jumpForce = 8.3 * mass shape

// Applied as direct m/s^2 accelerations, not Newtons divided by mass. Player armor forces
// (armor.ts's runForce/jetForce/jumpForce) are all literally `coefficient * mass`, so
// dividing them back by mass recovers the coefficient as a mass-independent acceleration --
// the real convention these T2 script fields use. The Wildcat's own script constants
// (mainThrustForce 30, stabSpringConstant 30, ...) are NOT expressed that way (they're flat
// values, not `coefficient * 400`), so dividing them by the Wildcat's 400 kg mass the same
// way collapses them to near-zero (0.075 m/s^2 of thrust never overcomes 20 m/s^2 of
// gravity) -- a 400 kg craft that can never leave the ground. Treating them as already-an-
// acceleration instead reproduces the intended feel (a light, snappy scout craft) and is the
// same order of magnitude as the Shrike's own force-divided-by-mass accelerations (~20 m/s^2).
function applyHoverSpring(world: World, vehicles: VehicleStore, id: number, dt: number): void {
  const base = id * 3;
  const x = at(vehicles.position, base);
  const z = at(vehicles.position, base + 2);
  const ground = sampleTerrain(world.terrain, x, z).height;
  const height = at(vehicles.position, base + 1) - ground;
  const restHeight = (WILDCAT_STAB_LEN_MIN + WILDCAT_STAB_LEN_MAX) / 2;
  const compression = restHeight - height;
  const springAccel = compression * WILDCAT_STAB_SPRING;
  const dampingAccel = -at(vehicles.velocity, base + 1) * WILDCAT_STAB_DAMPING;
  vehicles.velocity[base + 1] =
    at(vehicles.velocity, base + 1) + (springAccel + dampingAccel) * dt - GRAVITY * dt;
  vehicles.onGround[id] = height <= WILDCAT_STAB_LEN_MAX ? 1 : 0;
}

function applyWildcatSteering(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const base = id * 3;
  const yawError = normalizeAngle(input.yaw - at(vehicles.yaw, id));
  vehicles.angVel[base + 1] =
    at(vehicles.angVel, base + 1) + yawError * WILDCAT_STEERING_FORCE * dt;
  vehicles.yaw[id] = at(vehicles.yaw, id) + at(vehicles.angVel, base + 1) * dt;
  // Lean into the turn: roll follows yaw rate, restoring toward level via gyroDrag.
  const dragScale = 1 - Math.min(1, (WILDCAT_GYRO_DRAG / 100) * dt);
  vehicles.roll[id] =
    (at(vehicles.roll, id) + at(vehicles.angVel, base + 1) * dt * (WILDCAT_ROLL_FORCE / 100)) *
    dragScale;
  vehicles.angVel[base + 1] = at(vehicles.angVel, base + 1) * dragScale;
}

function wildcatForwardForce(input: PlayerInput, boosting: boolean): number {
  const base = input.moveZ >= 0 ? WILDCAT_MAIN_THRUST : WILDCAT_REVERSE_THRUST;
  return boosting ? base * WILDCAT_TURBO_FACTOR : base;
}

/** Comes to rest via a flat braking force once the driver lets go of both move axes above
 *  brakingActivationSpeed -- split out of applyWildcatThrust to keep that function's own
 *  complexity under budget. */
function applyWildcatBraking(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  if (input.moveX !== 0 || input.moveZ !== 0) return;
  const base = id * 3;
  const horizSpeed = Math.hypot(at(vehicles.velocity, base), at(vehicles.velocity, base + 2));
  if (horizSpeed <= WILDCAT_BRAKING_ACTIVATION_SPEED) return;
  // Bounded decel toward (not past) zero -- a scale-based reduction can't overshoot into
  // reverse the way subtracting a flat delta from each axis independently could.
  const decel = Math.min(horizSpeed, WILDCAT_BRAKING_FORCE * dt);
  const scale = (horizSpeed - decel) / horizSpeed;
  vehicles.velocity[base] = at(vehicles.velocity, base) * scale;
  vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) * scale;
}

function applyWildcatThrust(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const base = id * 3;
  const heading = headingOf(at(vehicles.yaw, id), 0);
  const right: Vec3 = { x: heading.z, y: 0, z: -heading.x };
  const boosting = input.jet && at(vehicles.energy, id) >= WILDCAT_MIN_JET_ENERGY;
  const forwardAccel = wildcatForwardForce(input, boosting);
  vehicles.velocity[base] =
    at(vehicles.velocity, base) + heading.x * input.moveZ * forwardAccel * dt;
  vehicles.velocity[base + 2] =
    at(vehicles.velocity, base + 2) + heading.z * input.moveZ * forwardAccel * dt;
  vehicles.velocity[base] =
    at(vehicles.velocity, base) + right.x * input.moveX * WILDCAT_STRAFE_THRUST * dt;
  vehicles.velocity[base + 2] =
    at(vehicles.velocity, base + 2) + right.z * input.moveX * WILDCAT_STRAFE_THRUST * dt;
  if (boosting) vehicles.energy[id] = at(vehicles.energy, id) - WILDCAT_JET_ENERGY_DRAIN;
  else {
    const data = VEHICLE_DATA[VehicleKind.Wildcat];
    vehicles.energy[id] = Math.min(data.maxEnergy, at(vehicles.energy, id) + data.rechargeRate);
  }
  applyWildcatBraking(vehicles, id, input, dt);
}

function applyWildcatJump(vehicles: VehicleStore, id: number, input: PlayerInput): void {
  if (!input.jump || !vehicles.onGround[id]) return;
  if (at(vehicles.energy, id) < WILDCAT_MIN_JET_ENERGY) return;
  vehicles.velocity[id * 3 + 1] = at(vehicles.velocity, id * 3 + 1) + WILDCAT_JUMP_IMPULSE_PER_MASS;
  vehicles.energy[id] = at(vehicles.energy, id) - WILDCAT_JET_ENERGY_DRAIN;
}

export function stepWildcat(world: World, id: number, input: PlayerInput, dt: number): void {
  const vehicles = world.vehicles;
  applyWildcatSteering(vehicles, id, input, dt);
  applyWildcatThrust(vehicles, id, input, dt);
  applyWildcatJump(vehicles, id, input);
  applyHoverSpring(world, vehicles, id, dt);
  const base = id * 3;
  vehicles.position[base] = at(vehicles.position, base) + at(vehicles.velocity, base) * dt;
  vehicles.position[base + 1] =
    at(vehicles.position, base + 1) + at(vehicles.velocity, base + 1) * dt;
  vehicles.position[base + 2] =
    at(vehicles.position, base + 2) + at(vehicles.velocity, base + 2) * dt;
}

// --- Terrain/interior collision, crash and ground-impact damage (Task 4) ----------------

/** Stub, replaced by Task 7's real shield-aware version below (`applyVehicleDamage`'s final
 *  definition further down this file shadows this one is NOT how JS works -- see Task 7's
 *  own commit, which replaces this function body in place rather than adding a second
 *  declaration). Task 4's own tests only assert `damage` increases, which this satisfies. */
export function applyVehicleDamage(
  world: World,
  id: number,
  amount: number,
  attackerId: number,
): void {
  void attackerId;
  const vehicles = world.vehicles;
  if (amount <= 0 || !vehicles.active[id] || vehicles.destroyed[id]) return;
  vehicles.damage[id] = at(vehicles.damage, id) + amount;
}

function applyCollisionDamage(world: World, id: number, impactSpeed: number): void {
  const data = VEHICLE_DATA[world.vehicles.kind[id] as VehicleKind];
  if (impactSpeed <= data.collDamageThresholdVel) return;
  applyVehicleDamage(
    world,
    id,
    (impactSpeed - data.collDamageThresholdVel) * data.collDamageMultiplier,
    -1,
  );
}

/** Ground contact: clamps the vehicle to sit on the terrain surface and zeroes downward
 *  velocity, applying the ground-impact damage rule (a real, separately-cited T2 rule,
 *  distinct from the generic object-collision one below) when the impact speed passed
 *  groundImpactMinSpeed. */
function resolveVehicleGround(world: World, id: number, current: Vec3, speed: number): boolean {
  const vehicles = world.vehicles;
  const data = VEHICLE_DATA[vehicles.kind[id] as VehicleKind];
  const base = id * 3;
  const ground = sampleTerrain(world.terrain, current.x, current.z).height;
  if (current.y - data.checkRadius >= ground) return false;
  vehicles.position[base + 1] = ground + data.checkRadius;
  if (at(vehicles.velocity, base + 1) < 0) vehicles.velocity[base + 1] = 0;
  if (speed > data.groundImpactMinSpeed) {
    applyVehicleDamage(
      world,
      id,
      (speed - data.groundImpactMinSpeed) * data.groundImpactSpeedDamageScale,
      -1,
    );
  }
  return true;
}

/** Sweeps the previous->current segment against interiors (a fast vehicle crossing a thin
 *  wall within one 32 ms tick must still stop at it, not tunnel through -- failure matrix
 *  row 14) then resolves any remaining sphere overlap at the vehicle's own checkRadius.
 *  Mirrors movement.ts's own sweepChest pattern (M4's round-1 tunnelling fix): a normalized
 *  direction and a scalar distance, not two raw points. */
function resolveVehicleInteriors(world: World, id: number, previous: Vec3, current: Vec3): boolean {
  const vehicles = world.vehicles;
  const data = VEHICLE_DATA[vehicles.kind[id] as VehicleKind];
  const base = id * 3;
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  const dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz);
  const swept =
    length > 0
      ? raycastInteriors(
          world.interiors,
          previous,
          { x: dx / length, y: dy / length, z: dz / length },
          length,
        )
      : null;
  let hit = false;
  if (swept) {
    vehicles.position.set([swept.point.x, swept.point.y, swept.point.z], base);
    vehicles.velocity.set([0, 0, 0], base);
    hit = true;
  }
  const resolvedCurrent: Vec3 = {
    x: at(vehicles.position, base),
    y: at(vehicles.position, base + 1),
    z: at(vehicles.position, base + 2),
  };
  const push = resolveSphereAgainstInteriors(world.interiors, resolvedCurrent, data.checkRadius);
  if (push) {
    vehicles.position.set(
      [resolvedCurrent.x + push.x, resolvedCurrent.y + push.y, resolvedCurrent.z + push.z],
      base,
    );
    hit = true;
  }
  return hit;
}

export function resolveVehicleCollision(
  world: World,
  id: number,
  previousPosition: Vec3,
  dt: number,
): void {
  const vehicles = world.vehicles;
  const base = id * 3;
  const current: Vec3 = {
    x: at(vehicles.position, base),
    y: at(vehicles.position, base + 1),
    z: at(vehicles.position, base + 2),
  };
  const speed = Math.hypot(
    (current.x - previousPosition.x) / dt,
    (current.y - previousPosition.y) / dt,
    (current.z - previousPosition.z) / dt,
  );

  const hitGround = resolveVehicleGround(world, id, current, speed);
  const hitInterior = resolveVehicleInteriors(world, id, previousPosition, current);
  // Ground contact already applied the ground-impact rule (groundImpactMinSpeed/
  // groundImpactSpeedDamageScale) above, in resolveVehicleGround, when the impact was fast
  // enough to trip it. This is the separate, generic object-collision rule
  // (collDamageThresholdVel/collDamageMultiplier) the plan's own numbers table cites as
  // distinct from that one -- it applies whenever the vehicle hit *anything* solid this tick
  // (ground or interior) and stacks on top of the ground-impact figure for a genuinely hard
  // hit, matching a real crash doing more than one kind of damage at once.
  if (hitGround || hitInterior) applyCollisionDamage(world, id, speed);
}
