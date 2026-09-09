import { armorFor } from './armor.js';
import { BaseObjectKind, teamHasPower, type BaseObjectStore } from './baseObjects.js';
import { applyDamage } from './damage.js';
import { raycastInteriors, resolveSphereAgainstInteriors } from './interiors.js';
import { GRAVITY } from './movement.js';
import { nextRandom } from './random.js';
import { groundHeightAt } from './ground.js';
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
  spawnTime: Float64Array; // seconds until fabrication and automatic boarding complete
  reservedPilotId: Int16Array;
  weaponTimer: Float64Array; // Shrike blaster cooldown; unused by Wildcat
  onGround: Uint8Array;
  // Codex review round 1 (this PR), finding 8: the Wildcat's own jump was level-triggered
  // on `input.jump` with no edge detection, so holding the key applied a fresh impulse every
  // tick the hover spring's own contact range kept `onGround` at 1 (not a rare single-frame
  // window -- easily several ticks). Mirrors PlayerStore.wasJumpHeld/movement.ts's own
  // jumpEdge pattern, one tick simpler (no wasGrounded-based bunny-hop chaining needed for a
  // vehicle jump).
  wasJumpHeld: Uint8Array;
}

export const MOUNT_RANGE = 4; // real, both kinds; see VEHICLE_DATA.minMountDist per-kind above
export const VEHICLE_PAD_USE_RADIUS = 4; // ours — see the plan's numbers table
const TIMER_EPSILON = 1e-9;

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
    spawnTime: new Float64Array(capacity),
    reservedPilotId: new Int16Array(capacity).fill(-1),
    weaponTimer: new Float64Array(capacity),
    onGround: new Uint8Array(capacity),
    wasJumpHeld: new Uint8Array(capacity),
  };
}

function allocate(store: VehicleStore): number | null {
  const id = store.freeIds.pop() ?? store.count;
  if (id >= store.active.length) return null;
  if (id === store.count) store.count += 1;
  return id;
}

// Mirrors ProjectileStore's own PROJECTILE_ID_REUSE_DELAY_TICKS/pendingFreeIds pattern (M3),
// for the same reason: without it, VehicleStore's capacity (8) would be exhausted for the
// rest of the match after only 8 total spawns across the whole game, cumulative -- every pad
// respawn or combat destruction would otherwise burn an id forever (destroyExistingAtPad and
// applyVehicleDamage only ever set `destroyed`, never actually free the slot), and every
// later spawn attempt at either team's pad would silently fail once `count` hit capacity.
// Freeing after a short delay rather than immediately keeps failure matrix row 18 true: a
// destroyed vehicle's id must still read back as destroyed=1 for at least one further
// stepVehicles call, not vanish or get reused within the same tick a client's next snapshot
// needed to observe it destroyed.
const VEHICLE_ID_REUSE_DELAY_TICKS = 3;

function queueVehicleIdFree(vehicles: VehicleStore, id: number): void {
  vehicles.pendingFreeIds.push({ id, ticksRemaining: VEHICLE_ID_REUSE_DELAY_TICKS });
}

function flushPendingVehicleFreeIds(vehicles: VehicleStore): void {
  const stillPending: PendingFreeId[] = [];
  for (const entry of vehicles.pendingFreeIds) {
    entry.ticksRemaining -= 1;
    if (entry.ticksRemaining <= 0) vehicles.freeIds.push(entry.id);
    else stillPending.push(entry);
  }
  vehicles.pendingFreeIds = stillPending;
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
      queueVehicleIdFree(vehicles, id);
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
  // kind ultimately traces back to a wire byte (protocol/handshake.ts's decodeVehicleSpawn
  // reads a raw u8 with no range check of its own) via server/net.ts's handleVehicleSpawn,
  // so an out-of-range value must be rejected here, before anything below allocates a slot
  // or reads VEHICLE_DATA[kind] -- both `if (kind !== VehicleKind.Shrike && kind !==
  // VehicleKind.Wildcat)` would work, but this checks the actual backing table so a future
  // third kind that forgets to also touch this guard fails closed, not open.
  if (!(kind in VEHICLE_DATA)) return null;
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
  vehicles.spawnTime[id] = 0;
  vehicles.reservedPilotId[id] = -1;
  vehicles.weaponTimer[id] = 0;
  vehicles.onGround[id] = 0;
  vehicles.wasJumpHeld[id] = 0;
  return id;
}

// Original serverVehicleHud.cs: reveal at 4.8 s, mountable at 6.5 s.
export const VEHICLE_BUILD_TIME = 6.5;
export const VEHICLE_REVEAL_TIME = 4.8;

function padIsBuilding(v: VehicleStore, padId: number): boolean {
  for (let id = 0; id < v.count; id++) {
    if (v.active[id] && !v.destroyed[id] && v.padId[id] === padId && v.spawnTime[id]! > 0)
      return true;
  }
  return false;
}

export function requestVehicleAtPad(
  world: World,
  playerId: number,
  padId: number,
  kind: VehicleKind,
): number | null {
  const p = world.players;
  if (
    !p.active[playerId] ||
    !p.alive[playerId] ||
    p.mountedVehicleId[playerId] !== -1 ||
    vehiclePadAt(world, playerId) !== padId
  )
    return null;
  if (padIsBuilding(world.vehicles, padId)) return null;
  const id = spawnVehicleAtPad(world, padId, kind);
  if (id === null) return null;
  const v = world.vehicles;
  v.spawnTime[id] = VEHICLE_BUILD_TIME;
  v.reservedPilotId[id] = playerId;
  // Orient toward the purchaser's view, avoiding a steering target jump at boarding.
  v.yaw[id] = p.yaw[playerId] ?? 0;
  resolveVehicleCollision(world, id, seatPosition(v, id), 1);
  return id;
}

function stepVehicleBuild(world: World, id: number, dt: number): boolean {
  const v = world.vehicles;
  if (v.spawnTime[id]! <= 0) return false;
  v.spawnTime[id] = Math.max(0, v.spawnTime[id]! - dt);
  const pilot = v.reservedPilotId[id]!;
  if (pilot !== -1 && (world.players.active[pilot] === 0 || world.players.alive[pilot] === 0))
    v.reservedPilotId[id] = -1;
  if (v.spawnTime[id] === 0 && v.reservedPilotId[id] !== -1) {
    if (world.players.mountedVehicleId[pilot] === -1) {
      v.driverId[id] = pilot;
      world.players.mountedVehicleId[pilot] = id;
      seatDriver(world, id, pilot);
    }
    v.reservedPilotId[id] = -1;
  }
  return true;
}

/** The id of a powered `StationVehiclePad` belonging to the player's own team within
 *  `VEHICLE_PAD_USE_RADIUS`, or `null` -- the vehicle-pad sibling of baseObjects.ts's
 *  `stationAt`, same shape (never an enemy pad, never an unpowered one). Ours: this helper
 *  is not itself one of Task 1's own listed exports, but the client's pad menu (Task 13)
 *  needs exactly this "am I standing at a usable pad" check and it belongs in sim, not
 *  duplicated in client code, for the same reason stationAt does. */
export function vehiclePadAt(world: World, playerId: number): number | null {
  const baseObjects = world.baseObjects;
  const players = world.players;
  const pBase = playerId * 3;
  const playerPos: Vec3 = {
    x: at(players.position, pBase),
    y: at(players.position, pBase + 1),
    z: at(players.position, pBase + 2),
  };
  const team = players.team[playerId] ?? 0;
  for (let id = 0; id < baseObjects.count; id += 1) {
    if (baseObjects.kind[id] !== BaseObjectKind.StationVehiclePad) continue;
    if (baseObjects.team[id] !== team || !baseObjects.powered[id]) continue;
    const base = id * 3;
    const padPos: Vec3 = {
      x: at(baseObjects.usePosition, base),
      y: at(baseObjects.usePosition, base + 1),
      z: at(baseObjects.usePosition, base + 2),
    };
    const dist = Math.hypot(playerPos.x - padPos.x, playerPos.y - padPos.y, playerPos.z - padPos.z);
    if (dist <= VEHICLE_PAD_USE_RADIUS) return id;
  }
  return null;
}

// --- Shrike flight physics (Task 2) -----------------------------------------------------
// Real T2 numbers cite vehicles/vehicle_shrike.cs; every field not in the spec's Vehicle
// numbers table is collected in the plan's "ours" numbers table alongside its citation.
const SHRIKE_MIN_DRAG = 30;
const SHRIKE_MANEUVERING_FORCE = 3000; // vehicles/vehicle_shrike.cs:140
const SHRIKE_VERT_THRUST_MULTIPLE = 3; // vehicles/vehicle_shrike.cs:152
const SHRIKE_MAX_AUTO_SPEED = 15; // vehicles/vehicle_shrike.cs:131
const SHRIKE_AUTO_LINEAR_FORCE = 300; // vehicles/vehicle_shrike.cs:132 — ours table
const SHRIKE_STEERING_FORCE = 1200; // vehicles/vehicle_shrike.cs:141 — ours table
const SHRIKE_JET_FORCE = 2000;
const SHRIKE_MIN_JET_ENERGY = 28;
const SHRIKE_JET_ENERGY_DRAIN = 2.8;
const SHRIKE_MAX_FORWARD_SPEED = 100; // vehicles/vehicle_shrike.cs:145 — real thrust cutoff,
// not the spec's Chaingun-style projectile speed cap (see the plan's numbers table).

function headingOf(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

/** `arr[i] ?? 0` as a call instead of an inline operator -- every physics function below
 *  reads a typed array many times per tick, and each inline `?? 0` counts as its own branch
 *  toward that function's own ESLint `complexity` budget. Moving the fallback in here keeps
 *  the reading code flat without inflating every caller. */
function at(arr: Float64Array | Uint8Array | Int16Array, i: number): number {
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

/** Low-speed linear braking. Angular stabilization belongs to the heading controller. */
function applyShrikeAutoStabilize(
  vehicles: VehicleStore,
  id: number,
  speed: number,
  dt: number,
): void {
  const mass = VEHICLE_DATA[VehicleKind.Shrike].mass;
  const base = id * 3;
  for (let axis = 0; axis < 3; axis += 1) {
    // Vertical stabilization remains engaged during flight: holding forward or
    // boost must not preserve a dive after the pilot levels the nose.
    if (axis !== 1 && speed >= SHRIKE_MAX_AUTO_SPEED) continue;
    const v = vehicles.velocity[base + axis] ?? 0;
    vehicles.velocity[base + axis] =
      v - Math.sign(v) * Math.min(Math.abs(v), (SHRIKE_AUTO_LINEAR_FORCE / mass) * dt);
  }
}

/** Critically damped heading controller. The script supplies steering force, not
 * Torque's inertia tensor; these explicit demo rates avoid an underdamped orbit. */
function applyShrikeSteering(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const base = id * 3;
  const stiffness = SHRIKE_STEERING_FORCE / VEHICLE_DATA[VehicleKind.Shrike].mass;
  const damping = 2 * Math.sqrt(stiffness);
  const targetPitch = Math.max(-1.35, Math.min(1.35, input.pitch));
  const errors = [
    normalizeAngle(input.yaw - at(vehicles.yaw, id)),
    targetPitch - at(vehicles.pitch, id),
  ];
  for (let axis = 0; axis < 2; axis++) {
    const velocity = at(vehicles.angVel, base + axis);
    vehicles.angVel[base + axis] = Math.max(
      -1.8,
      Math.min(1.8, velocity + (errors[axis]! * stiffness - damping * velocity) * dt),
    );
  }
  vehicles.yaw[id] = normalizeAngle(at(vehicles.yaw, id) + at(vehicles.angVel, base) * dt);
  vehicles.pitch[id] = Math.max(
    -1.35,
    Math.min(1.35, at(vehicles.pitch, id) + at(vehicles.angVel, base + 1) * dt),
  );
  const bank = Math.max(-0.45, Math.min(0.45, -at(vehicles.angVel, base) * 0.3));
  const rollRate = at(vehicles.angVel, base + 2);
  vehicles.angVel[base + 2] = rollRate + ((bank - at(vehicles.roll, id)) * 16 - 8 * rollRate) * dt;
  vehicles.roll[id] = at(vehicles.roll, id) + at(vehicles.angVel, base + 2) * dt;
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
  const yaw = at(vehicles.yaw, id);
  vehicles.velocity[base] = at(vehicles.velocity, base) - Math.cos(yaw) * input.moveX * thrust * dt;
  vehicles.velocity[base + 2] =
    at(vehicles.velocity, base + 2) + Math.sin(yaw) * input.moveX * thrust * dt;
  vehicles.velocity[base] = (vehicles.velocity[base] ?? 0) + heading.x * input.moveZ * thrust * dt;
  vehicles.velocity[base + 1] =
    (vehicles.velocity[base + 1] ?? 0) +
    heading.y * input.moveZ * thrust * dt * SHRIKE_VERT_THRUST_MULTIPLE;
  vehicles.velocity[base + 2] =
    (vehicles.velocity[base + 2] ?? 0) + heading.z * input.moveZ * thrust * dt;
}

function applyShrikeJetThrust(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
): void {
  const data = VEHICLE_DATA[VehicleKind.Shrike];
  const base = id * 3;
  const jet = SHRIKE_JET_FORCE / data.mass;
  if (input.moveX === 0 && input.moveZ === 0) {
    vehicles.velocity[base + 1] =
      at(vehicles.velocity, base + 1) + jet * SHRIKE_VERT_THRUST_MULTIPLE * dt;
  } else {
    const heading = headingOf(at(vehicles.yaw, id), at(vehicles.pitch, id));
    vehicles.velocity[base] = at(vehicles.velocity, base) + heading.x * jet * dt;
    vehicles.velocity[base + 1] = at(vehicles.velocity, base + 1) + heading.y * jet * dt;
    vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) + heading.z * jet * dt;
  }
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
  applyShrikeJetThrust(vehicles, id, input, dt);
}

/** Shrikes are self-supporting flyers: retain horizontal drag without passive gravity or lift. */
function applyShrikeDrag(vehicles: VehicleStore, id: number, dt: number): void {
  const data = VEHICLE_DATA[VehicleKind.Shrike];
  const base = id * 3;
  const dragScale = 1 - Math.min(1, (SHRIKE_MIN_DRAG / data.mass) * dt);
  vehicles.velocity[base] = (vehicles.velocity[base] ?? 0) * dragScale;
  vehicles.velocity[base + 2] = (vehicles.velocity[base + 2] ?? 0) * dragScale;
}

/** Real thrust cutoff (vehicles/vehicle_shrike.cs:145), not the projectile speed cap the
 *  spec's Chaingun-style table uses elsewhere -- caps the whole velocity vector, matching
 *  Torque's own "thrust stops adding once you're already this fast" rule rather than a
 *  per-axis clamp that would distort the heading. Split out of stepShrike to keep that
 *  function's own complexity under budget. */
function clampShrikeSpeed(vehicles: VehicleStore, id: number, speed: number): void {
  if (speed <= SHRIKE_MAX_FORWARD_SPEED) return;
  const base = id * 3;
  const scale = SHRIKE_MAX_FORWARD_SPEED / speed;
  vehicles.velocity[base] = at(vehicles.velocity, base) * scale;
  vehicles.velocity[base + 1] = at(vehicles.velocity, base + 1) * scale;
  vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) * scale;
}

export function stepShrike(world: World, id: number, input: PlayerInput, dt: number): void {
  const vehicles = world.vehicles;
  const base = id * 3;

  applyShrikeSteering(vehicles, id, input, dt);
  applyShrikeThrust(vehicles, id, input, dt);
  applyShrikeAfterburner(vehicles, id, input, dt);
  applyShrikeDrag(vehicles, id, dt);

  const speed = Math.hypot(
    vehicles.velocity[base] ?? 0,
    vehicles.velocity[base + 1] ?? 0,
    vehicles.velocity[base + 2] ?? 0,
  );
  applyShrikeAutoStabilize(vehicles, id, speed, dt);
  clampShrikeSpeed(vehicles, id, speed);

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
// Ours: the spec's own Vehicle numbers table cites a real `dragForce 25/45` this file does
// not otherwise model (no continuous drag term exists for the Wildcat the way the Shrike's
// own minDrag/SHRIKE_MAX_FORWARD_SPEED bound its top speed) -- reverse-engineering the exact
// Torque units behind those two numbers without the engine source produced either a
// negligible or a crippling drag depending on which convention was assumed, so this is a
// flat speed cap instead: an unbounded Wildcat under this file's accel-direct thrust
// convention reaches 50+ m/s within two seconds and destroys itself on the very first terrain
// bump (collDamageThresholdVel 23 m/s, groundImpactMinSpeed 29 m/s). Sized comfortably under
// both thresholds unboosted, with boost allowed to approach (not exceed) collDamageThresholdVel
// -- fast, but a flat-out boosted collision still carries real risk, matching the spec's own
// "collision damage" row actually mattering during normal play.
const WILDCAT_MAX_SPEED = 15;
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
  const ground = groundHeightAt(world, { x, y: at(vehicles.position, base + 1), z });
  if (ground === null) {
    vehicles.velocity[base + 1] = at(vehicles.velocity, base + 1) - GRAVITY * dt;
    vehicles.onGround[id] = 0;
    return;
  }
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

  const cap = boosting ? WILDCAT_MAX_SPEED * WILDCAT_TURBO_FACTOR : WILDCAT_MAX_SPEED;
  const horizSpeed = Math.hypot(at(vehicles.velocity, base), at(vehicles.velocity, base + 2));
  if (horizSpeed > cap) {
    const scale = cap / horizSpeed;
    vehicles.velocity[base] = at(vehicles.velocity, base) * scale;
    vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) * scale;
  }
}

function applyWildcatJump(vehicles: VehicleStore, id: number, input: PlayerInput): void {
  // Edge-triggered on the press, not the hold: `onGround` stays 1 for as long as the hover
  // spring keeps the Wildcat within its own contact range (applyHoverSpring, below), which is
  // easily several ticks in a row while parked or hovering low, not a single-frame window.
  // Without wasJumpHeld, holding jump applied a fresh impulse every one of those ticks.
  const jumpEdge = input.jump && !vehicles.wasJumpHeld[id];
  vehicles.wasJumpHeld[id] = input.jump ? 1 : 0;
  if (!jumpEdge || !vehicles.onGround[id]) return;
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

/** Real, real, real impulse magnitudes (vehicles/vehicle.cs:237-260), converted to a
 *  velocity change by dividing by the ejected pilot's own mass -- Torque's own applyImpulse
 *  convention, since this sim has no rigid-body integrator to reproduce instead. See the
 *  plan's numbers table for why this is an adaptation, not a direct port. */
function ejectPilot(world: World, vehicleId: number): void {
  const driverId = world.vehicles.driverId[vehicleId] ?? -1;
  if (driverId === -1 || !world.players.active[driverId]) return;
  const armor = armorFor(world, driverId);
  const rand = (): number => nextRandom(world.random);
  const impulse: Vec3 = {
    x: 250 - rand() * 500,
    y: rand() * 100 + 50,
    z: 250 - rand() * 500,
  };
  const base = driverId * 3;
  world.players.velocity[base] = at(world.players.velocity, base) + impulse.x / armor.mass;
  world.players.velocity[base + 1] = at(world.players.velocity, base + 1) + impulse.y / armor.mass;
  world.players.velocity[base + 2] = at(world.players.velocity, base + 2) + impulse.z / armor.mass;
  world.players.mountedVehicleId[driverId] = -1;
  world.vehicles.driverId[vehicleId] = -1;
  applyDamage(world, driverId, 0.4, -1, armor); // vehicles/vehicle.cs:260
}

/** Same shielded-damage rule the spec states for players and M4 already established for base
 *  objects/turrets: spends `min(energy / energyPerDamagePoint, amount)` worth of a hit
 *  against `energy` first, the remainder against `damage`, clamped at `maxDamage` and
 *  destroying exactly once (failure matrix row 16) -- never a repeat `pendingVehicleDestroyed`
 *  push or a repeat ejection for an already-destroyed vehicle (failure matrix row 17).
 *  `attackerId` is accepted for signature symmetry with applyDamage/applyBaseObjectDamage and
 *  a future kill-feed line; this milestone does not score a vehicle kill off it (Spec gaps). */
export function applyVehicleDamage(
  world: World,
  id: number,
  amount: number,
  _attackerId: number,
): void {
  const vehicles = world.vehicles;
  if (amount <= 0 || !vehicles.active[id] || vehicles.destroyed[id]) return;
  const data = VEHICLE_DATA[vehicles.kind[id] as VehicleKind];
  const energy = at(vehicles.energy, id);
  const perPoint = data.energyPerDamagePoint;
  const spentFromShield = perPoint > 0 ? Math.min(energy / perPoint, amount) : 0;
  vehicles.energy[id] = energy - spentFromShield * perPoint;
  const remaining = amount - spentFromShield;
  vehicles.damage[id] = Math.min(at(vehicles.damage, id) + remaining, data.maxDamage);
  if (at(vehicles.damage, id) < data.maxDamage) return;

  vehicles.destroyed[id] = 1;
  queueVehicleIdFree(vehicles, id);
  const base = id * 3;
  world.pendingVehicleDestroyed.push({
    id,
    position: {
      x: at(vehicles.position, base),
      y: at(vehicles.position, base + 1),
      z: at(vehicles.position, base + 2),
    },
    team: at(vehicles.team, id),
  });
  ejectPilot(world, id);
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

/** Remove only velocity into the contact, retaining motion along the surface. */
function slideVehicle(world: World, id: number, normal: Vec3): void {
  const v = world.vehicles.velocity;
  const base = id * 3;
  const inward = Math.min(
    0,
    at(v, base) * normal.x + at(v, base + 1) * normal.y + at(v, base + 2) * normal.z,
  );
  v[base] = at(v, base) - inward * normal.x;
  v[base + 1] = at(v, base + 1) - inward * normal.y;
  v[base + 2] = at(v, base + 2) - inward * normal.z;
}

function closingSpeed(motion: Vec3, normal: Vec3): number {
  return Math.max(0, -(motion.x * normal.x + motion.y * normal.y + motion.z * normal.z));
}

function resolveVehicleGround(world: World, id: number, current: Vec3, motion: Vec3): number {
  const vehicles = world.vehicles;
  const data = VEHICLE_DATA[vehicles.kind[id] as VehicleKind];
  const ground = groundHeightAt(world, current);
  if (ground === null || current.y - data.checkRadius >= ground) return 0;
  const terrain = sampleTerrain(world.terrain, current.x, current.z);
  const normal = terrain.empty ? { x: 0, y: 1, z: 0 } : terrain.normal;
  vehicles.position[id * 3 + 1] = ground + data.checkRadius;
  slideVehicle(world, id, normal);
  const speed = closingSpeed(motion, normal);
  if (speed > data.groundImpactMinSpeed) {
    applyVehicleDamage(
      world,
      id,
      (speed - data.groundImpactMinSpeed) * data.groundImpactSpeedDamageScale,
      -1,
    );
  }
  return speed;
}

/** Sweep prevents tunnelling; sphere overlap handles resting and glancing contact. */
function resolveVehicleInteriors(
  world: World,
  id: number,
  previous: Vec3,
  current: Vec3,
  motion: Vec3,
): number {
  const vehicles = world.vehicles;
  const data = VEHICLE_DATA[vehicles.kind[id] as VehicleKind];
  const base = id * 3;
  const dx = current.x - previous.x,
    dy = current.y - previous.y,
    dz = current.z - previous.z;
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
  let impact = 0;
  if (swept) {
    // Mesh triangles are double-sided. Orient the normal toward the incoming vehicle.
    const sign =
      motion.x * swept.normal.x + motion.y * swept.normal.y + motion.z * swept.normal.z > 0
        ? -1
        : 1;
    const normal = { x: swept.normal.x * sign, y: swept.normal.y * sign, z: swept.normal.z * sign };
    vehicles.position.set(
      [
        swept.point.x + normal.x * data.checkRadius,
        swept.point.y + normal.y * data.checkRadius,
        swept.point.z + normal.z * data.checkRadius,
      ],
      base,
    );
    impact = closingSpeed(motion, normal);
    slideVehicle(world, id, normal);
  }
  const resolved = seatPosition(vehicles, id);
  const push = resolveSphereAgainstInteriors(world.interiors, resolved, data.checkRadius);
  if (push) {
    vehicles.position.set([resolved.x + push.x, resolved.y + push.y, resolved.z + push.z], base);
    const length = Math.hypot(push.x, push.y, push.z);
    const normal = { x: push.x / length, y: push.y / length, z: push.z / length };
    impact = Math.max(impact, closingSpeed(motion, normal));
    slideVehicle(world, id, normal);
  }
  return impact;
}

export function resolveVehicleCollision(
  world: World,
  id: number,
  previousPosition: Vec3,
  dt: number,
): void {
  const current = seatPosition(world.vehicles, id);
  const motion = {
    x: (current.x - previousPosition.x) / dt,
    y: (current.y - previousPosition.y) / dt,
    z: (current.z - previousPosition.z) / dt,
  };
  const groundImpact = resolveVehicleGround(world, id, current, motion);
  const interiorImpact = resolveVehicleInteriors(world, id, previousPosition, current, motion);
  applyCollisionDamage(world, id, Math.max(groundImpact, interiorImpact));
}

// --- Mount/dismount, seat position, weapon takeover (Task 5) ----------------------------

function seatPosition(vehicles: VehicleStore, id: number): Vec3 {
  const base = id * 3;
  return {
    x: at(vehicles.position, base),
    y: at(vehicles.position, base + 1),
    z: at(vehicles.position, base + 2),
  };
}

function idleVehicleInput(): PlayerInput {
  return {
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    jump: false,
    jet: false,
    fire: false,
    altFire: false,
    slot: 0,
    packActive: false,
    use: false,
  };
}

/** The id of the nearest active, non-destroyed, unoccupied vehicle within its own
 *  minMountDist of the player, or null. Shared by mountNearestVehicle (the actual mount,
 *  server/sim-side) and the client-facing nearbyUnoccupiedVehicle export below (so app.ts
 *  can decide whether pressing E is even mount-relevant before sending the `use` wire bit --
 *  M5 plan, Global Constraints: "a held E near an unoccupied vehicle... additionally sends
 *  use: true"). */
function findUnoccupiedVehicleInRange(world: World, playerId: number): number | null {
  const vehicles = world.vehicles;
  const pBase = playerId * 3;
  const playerPos: Vec3 = {
    x: at(world.players.position, pBase),
    y: at(world.players.position, pBase + 1),
    z: at(world.players.position, pBase + 2),
  };
  for (let vId = 0; vId < vehicles.count; vId += 1) {
    if (
      !vehicles.active[vId] ||
      vehicles.destroyed[vId] ||
      vehicles.spawnTime[vId]! > 0 ||
      vehicles.driverId[vId] !== -1
    )
      continue;
    const data = VEHICLE_DATA[vehicles.kind[vId] as VehicleKind];
    const vPos = seatPosition(vehicles, vId);
    const dist = Math.hypot(playerPos.x - vPos.x, playerPos.y - vPos.y, playerPos.z - vPos.z);
    if (dist <= data.minMountDist) return vId;
  }
  return null;
}

/** Nearest-in-range-and-unoccupied wins; the caller (stepVehicles) resolves failure-matrix
 *  row 13 (two players racing for the same vehicle the same tick) just by iterating player
 *  ids in ascending order and mounting one at a time -- once this claims a vehicle, a later
 *  id in that same pass already sees `driverId` set and skips it. */
function mountNearestVehicle(world: World, playerId: number): void {
  const vId = findUnoccupiedVehicleInRange(world, playerId);
  if (vId === null) return;
  world.vehicles.driverId[vId] = playerId;
  world.players.mountedVehicleId[playerId] = vId;
}

/** Client-facing: is there any reason for a fresh `E` press to be sent as the wire-level
 *  `use` bit rather than staying a purely local menu toggle? True while already mounted
 *  (so a press can dismount) or while an unoccupied vehicle sits within mount range. Ours --
 *  not itself one of Task 1's exports, but app.ts (Task 14) needs exactly this decision and
 *  it belongs in sim, matching vehiclePadAt's own precedent (Task 13). */
export function canSendVehicleUse(world: World, playerId: number): boolean {
  if ((world.players.mountedVehicleId[playerId] ?? -1) !== -1) return true;
  return findUnoccupiedVehicleInRange(world, playerId) !== null;
}

function tryMountOrDismount(world: World, playerId: number, input: PlayerInput): void {
  const players = world.players;
  const wasHeld = (players.wasUseHeld[playerId]! & 1) !== 0;
  const blocked = (players.wasUseHeld[playerId]! & 2) !== 0;
  const edge = input.use && !wasHeld;
  players.wasUseHeld[playerId] = input.use ? 1 : 0;
  const currentVehicle = players.mountedVehicleId[playerId] ?? -1;
  if (currentVehicle !== -1) {
    if (!edge) return;
    players.wasUseHeld[playerId] = 3; // Block automatic reboarding until leaving contact.
    world.vehicles.driverId[currentVehicle] = -1;
    players.mountedVehicleId[playerId] = -1;
    // While mounted, movement.ts's own guard skips stepPlayer entirely for this id, so
    // onGround/wasGrounded/ski never got refreshed the whole time it was driving -- they're
    // still whatever they were the instant before mounting. A dismount can land the player
    // anywhere, so starting movement's own ground-tracking from a clean slate (rather than
    // carrying over state from wherever they stood before mounting, possibly seconds and
    // meters away) is the same defensive reset addPlayer/resetPlayerToSpawn already apply
    // for a fresh spawn -- cheap, and avoids a stale wasGrounded/ski flag ever influencing
    // classify/integrate's ground-snap logic (movement.ts) for a frame it shouldn't.
    players.onGround[playerId] = 0;
    players.wasGrounded[playerId] = 0;
    players.ski[playerId] = 0;
    players.wasJumpHeld[playerId] = 0;
    return;
  }
  if (blocked && findUnoccupiedVehicleInRange(world, playerId) !== null && !edge) {
    players.wasUseHeld[playerId] = input.use ? 3 : 2;
    return;
  }
  mountNearestVehicle(world, playerId);
}

/** Failure matrix row 5's dismount half: a pad-respawn (or Task 7's own destruction path)
 *  marks `destroyed` first and leaves the actual unmount/no-damage handling to this, called
 *  from stepVehicles's per-vehicle pass every tick a destroyed vehicle still has a driver. */
function dismountWithoutDamage(world: World, vId: number): void {
  const driverId = world.vehicles.driverId[vId] ?? -1;
  if (driverId === -1) return;
  world.players.mountedVehicleId[driverId] = -1;
  world.vehicles.driverId[vId] = -1;
}

function stepOneVehiclePhysics(world: World, vId: number, input: PlayerInput, dt: number): void {
  const vehicles = world.vehicles;
  const previous = seatPosition(vehicles, vId);
  if (vehicles.kind[vId] === VehicleKind.Shrike) stepShrike(world, vId, input, dt);
  else stepWildcat(world, vId, input, dt);
  resolveVehicleCollision(world, vId, previous, dt);
}

// --- Shrike blaster (Task 6) --------------------------------------------------------------

/** A pending Shrike-blaster shot, drained by projectiles.ts's spawnVehicleShot the same tick
 *  stepVehicles produces it -- exactly parallel to TurretFireEvent/spawnTurretShot (M4). */
export interface VehicleFireEvent {
  vehicleId: number;
  team: number;
  origin: Vec3;
  direction: Vec3;
  velocity: Vec3;
}

export const SHRIKE_BLASTER_DATA = {
  directDamage: 0.125, // weapons/chaingun.cs:503
  speed: 425, // weapons/chaingun.cs:512
  lifetime: 1, // weapons/chaingun.cs:516 (lifetimeMS 1000)
  // T2's fireTimeout is 125 ms. Playtest tuning requests 200 ms between shots; this
  // remains one authoritative shot stream because barrel alternation is presentation-only.
  fireInterval: 0.2,
  minEnergy: 5, // vehicles/vehicle_shrike.cs:255-256
};

/** Only the Shrike has a weapon (the Wildcat defines none, matching vehicle_wildcat.cs and
 *  the spec's own Vehicle numbers table) -- reads the driver's own `fire` input directly,
 *  since a mounted player's own weapon system is inert (weapons.ts's stepOnePlayer guard). */
function tryFireShrikeBlaster(world: World, vId: number, input: PlayerInput, dt: number): void {
  const vehicles = world.vehicles;
  let remaining = at(vehicles.weaponTimer, vId) - dt;
  if (!input.fire) {
    vehicles.weaponTimer[vId] = Math.max(0, remaining);
    return;
  }
  while (remaining <= TIMER_EPSILON && at(vehicles.energy, vId) >= SHRIKE_BLASTER_DATA.minEnergy) {
    remaining += SHRIKE_BLASTER_DATA.fireInterval;
    vehicles.energy[vId] = at(vehicles.energy, vId) - SHRIKE_BLASTER_DATA.minEnergy;
    const direction = headingOf(at(vehicles.yaw, vId), at(vehicles.pitch, vId));
    const base = vId * 3;
    const origin: Vec3 = {
      x: at(vehicles.position, base),
      y: at(vehicles.position, base + 1),
      z: at(vehicles.position, base + 2),
    };
    const velocity: Vec3 = {
      x: at(vehicles.velocity, base),
      y: at(vehicles.velocity, base + 1),
      z: at(vehicles.velocity, base + 2),
    };
    world.pendingVehicleFireEvents.push({
      vehicleId: vId,
      team: at(vehicles.team, vId),
      origin,
      direction,
      velocity,
    });
  }
  vehicles.weaponTimer[vId] = Math.max(0, remaining);
}

function seatDriver(world: World, vId: number, driverId: number): void {
  if (driverId === -1 || !world.players.active[driverId]) return;
  const seat = seatPosition(world.vehicles, vId);
  const base = driverId * 3;
  world.players.position.set([seat.x, seat.y, seat.z], base);
  world.players.velocity.set([0, 0, 0], base);
}

/** The system `stepWorld` calls (Task 9) between stepWeapons and stepTurrets. Resolves this
 *  tick's mount/dismount requests, then steps every active vehicle's physics -- piloted or
 *  not, matching a real T2 vehicle idling at its pad -- and seat-locks its driver's position
 *  to the vehicle's own transform. */
/** One active, non-destroyed vehicle's whole tick: physics, the Shrike blaster (piloted
 *  only), and seat-locking its driver -- split out of stepVehicles to keep that function's
 *  own complexity under budget. */
/** True if `vId`'s current driver should keep driving this tick -- false only when the
 *  driver's own PlayerStore row explicitly says dead (`active === 1 && alive === 0`).
 *  Codex review round 2 (this PR), finding 2 (P2/P1 hardening): under this milestone's own
 *  rules a mounted player can only die via ejectPilot (which clears both sides of the
 *  mount relationship atomically -- direct hits and splash both exclude mounted players,
 *  and movement.ts's own stepPlayer skips a mounted player entirely, so there is no
 *  fall-damage path either), so this should never fire on the authoritative server today.
 *  It exists as the same defense-in-depth damage.ts's respawnPlayer already documents for
 *  the player side of this relationship.
 *
 *  Deliberately does NOT treat `active === 0` as evidence of death: a networked CLIENT's
 *  own local world only ever populates PlayerStore for its own remapped LOCAL_SLOT index
 *  (netclient.ts never calls deserializePlayer for any other id), so every OTHER player's
 *  own driverId reads active === 0 there -- not because that player is gone, but because
 *  this client was never told anything about them. Treating that as "dead" would have
 *  self-un-mounted the LOCAL player's own driven vehicle every single tick (its driverId is
 *  the real server-assigned id, per finding 1's own fix, which the client's local world
 *  never has a PlayerStore row for either). A truly removed player already has their
 *  driverId cleared at removal time (world.ts's removePlayer), so `active === 0` here is
 *  never a case this function needs to catch in the first place. */
function driverIsLive(world: World, driverId: number): boolean {
  if (driverId === -1) return false;
  if (world.players.active[driverId] !== 1) return true; // no data here isn't evidence of death
  return world.players.alive[driverId] === 1;
}

function stepOneVehicle(
  world: World,
  vId: number,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  const vehicles = world.vehicles;
  if (stepVehicleBuild(world, vId, dt)) return;
  let driverId = vehicles.driverId[vId] ?? -1;
  if (driverId !== -1 && !driverIsLive(world, driverId)) {
    // Self-heals a mount relationship a dead/removed driver left dangling on the vehicle's
    // own side (world.players.mountedVehicleId may already be clear -- see driverIsLive's
    // own comment -- but this makes the fix correct even if some future path kills a
    // mounted player without going through ejectPilot).
    world.players.mountedVehicleId[driverId] = -1;
    vehicles.driverId[vId] = -1;
    driverId = -1;
  }
  const input =
    driverId !== -1
      ? (inputs.get(driverId) ?? idleVehicleInput())
      : { ...idleVehicleInput(), yaw: at(vehicles.yaw, vId), pitch: at(vehicles.pitch, vId) };
  stepOneVehiclePhysics(world, vId, input, dt);
  // stepOneVehiclePhysics can destroy this vehicle via collision damage (resolveVehicleCollision
  // -> applyVehicleDamage), which ejects the pilot and clears vehicles.driverId[vId] to -1. Using
  // the driverId captured BEFORE physics for either of the two calls below would fire the weapon
  // from an already-destroyed vehicle, or -- worse -- re-seat the just-ejected pilot straight back
  // onto the wreck and zero the ejection impulse seatDriver's own velocity reset just applied,
  // silently undoing "crash destruction ejects the pilot" the whole way ejectPilot exists to
  // guarantee. Re-reading the current driver after physics makes both calls agree with whatever
  // ejectPilot actually did this tick.
  const currentDriverId = vehicles.driverId[vId] ?? -1;
  if (vehicles.kind[vId] === VehicleKind.Shrike && currentDriverId !== -1) {
    tryFireShrikeBlaster(world, vId, input, dt);
  }
  seatDriver(world, vId, currentDriverId);
}

export function stepVehicles(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  const vehicles = world.vehicles;
  flushPendingVehicleFreeIds(vehicles);
  // One-tick transient signal, same convention pendingDeaths (movement.ts's stepPlayers) and
  // pendingFireEvents/pendingTurretFireEvents already follow (hash.ts's own POLICY comment):
  // cleared at the start of every call so a consumer only ever sees this tick's destructions,
  // not an unbounded history. Nothing in this milestone's client/server actually reads this
  // yet -- see the PR body's Open follow-ups -- but the array must not silently grow forever
  // in the meantime regardless of whether anything drains it.
  world.pendingVehicleDestroyed = [];

  const ids = [...inputs.keys()].sort((a, b) => a - b);
  for (const playerId of ids) {
    if (!world.players.active[playerId] || !world.players.alive[playerId]) continue;
    tryMountOrDismount(world, playerId, inputs.get(playerId) as PlayerInput);
  }

  for (let vId = 0; vId < vehicles.count; vId += 1) {
    if (!vehicles.active[vId]) continue;
    if (vehicles.destroyed[vId]) {
      dismountWithoutDamage(world, vId);
      continue;
    }
    stepOneVehicle(world, vId, inputs, dt);
  }
}
