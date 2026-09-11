import { armorFor } from './armor.js';
import { BaseObjectKind, teamHasPower, type BaseObjectStore } from './baseObjects.js';
import { applyDamage, applyKickback, applyVehicleKillScore, playerHitbox } from './damage.js';
import { raycastInteriors, resolveSphereAgainstInteriors } from './interiors.js';
import { GRAVITY } from './movement.js';
import { nextRandom } from './random.js';
import { groundHeightAt } from './ground.js';
import { sampleTerrain } from './terrain.js';
import type { PendingFreeId, PlayerInput, Vec3, World } from './types.js';

/** Every kind is a real T2 base-game vehicle script (GameData/base/scripts/vehicles/):
 *  Shrike vehicle_shrike.cs, Wildcat vehicle_wildcat.cs, Bomber vehicle_bomber.cs, Havoc
 *  vehicle_havoc.cs, Tank vehicle_tank.cs, MobilePointBase vehicle_mpb.cs. The value is a
 *  raw wire byte (protocol/handshake.ts's decodeVehicleSpawn, snapshot.ts's writeVehicle),
 *  so these ids are append-only: adding kinds never needs a protocol version bump, and the
 *  u8 ceilings are 255 kinds (protocol) and 255 concurrent vehicles (writeU8Counted) --
 *  VehicleStore's own capacity of 8 is the binding limit long before either. */
export enum VehicleKind {
  Shrike = 0,
  Wildcat = 1,
  Bomber = 2,
  Havoc = 3,
  Tank = 4,
  MobilePointBase = 5,
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
  /** The model-origin height above the support surface this kind's own ground collision
   *  resolves to: the hard floor that catches the hull, and (for the wheeled MPB) the ride
   *  height the wheels rest at. For the Shrike/Wildcat it is exactly their `checkRadius`,
   *  which is what this file's single sphere-based ground resolver always used; the two new
   *  classes need their own number because a sphere radius is not a ride height -- the
   *  Tank's `checkRadius` (5.5535) sits ABOVE its hover band and would fight the spring
   *  every tick, and the MPB has to rest on its wheels. See each entry's own comment. */
  groundContactHeight: number;
}

// Tank hover band (vehicles/vehicle_tank.cs:274-277). Declared before VEHICLE_DATA because
// its ground contact height is derived from them; the hover physics below reuses the same
// constants through HOVER_PARAMS.
const TANK_STAB_LEN_MIN = 3.25; // vehicles/vehicle_tank.cs:274
const TANK_STAB_LEN_MAX = 4; // vehicles/vehicle_tank.cs:275
const TANK_STAB_SPRING = 50; // vehicles/vehicle_tank.cs:276
const TANK_HOVER_REST_HEIGHT = (TANK_STAB_LEN_MIN + TANK_STAB_LEN_MAX) / 2;
// Ours: the Tank's ground floor is the spring's own sagged equilibrium under GRAVITY
// (rest height - GRAVITY / stabSpringConstant = 3.625 - 0.4), i.e. exactly the height the
// spring holds the craft at when nothing else acts on it, so the hard floor and the spring
// agree instead of fighting (the Wildcat's floor is below its own equilibrium, so both
// hover kinds float on the spring and only a hard dive reaches the floor).
const TANK_GROUND_CONTACT_HEIGHT = TANK_HOVER_REST_HEIGHT - GRAVITY / TANK_STAB_SPRING;
// Ours, measured from the published model: the MPB's wheels reach 2.83 m below its origin
// in root space (assets/out/katabatic/shapes/vehicle_land_mpbase.glb, y[-2.83, 2.72]), so
// the origin has to ride at that height for the wheels to sit on the surface rather than
// half a hull deep in it. Unlike the hover kinds this is a ride height, not a hover band.
const MPB_GROUND_REST_HEIGHT = 2.83;

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
    // Unchanged from this file's original sphere-based ground rule (checkRadius as the
    // resting height): the flyer is self-supporting, so this only ever matters in a crash.
    groundContactHeight: 5.5, // = checkRadius, vehicles/vehicle_shrike.cs:225
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
    // Unchanged from this file's original sphere-based ground rule; sits below the hover
    // band's own sagged equilibrium (2.333 m), so the spring is what holds the craft.
    groundContactHeight: 1.7785, // = checkRadius, vehicles/vehicle_wildcat.cs:209
  },
  // Thundersword (FlyingVehicleData/BomberFlyer). Weapon turrets, the bomb bay and the
  // passenger seats are a follow-up slice -- nothing here models them.
  [VehicleKind.Bomber]: {
    mass: 350, // vehicles/vehicle_bomber.cs:260
    maxDamage: 2.8, // vehicles/vehicle_bomber.cs:212
    maxEnergy: 400, // vehicles/vehicle_bomber.cs:217
    energyPerDamagePoint: 150, // vehicles/vehicle_bomber.cs:216 (isShielded true, :215)
    rechargeRate: 0.8, // vehicles/vehicle_bomber.cs:220
    checkRadius: 7.1895, // vehicles/vehicle_bomber.cs:314
    minMountDist: 4, // vehicles/vehicle_bomber.cs:300
    collDamageThresholdVel: 25, // vehicles/vehicle_bomber.cs:272
    collDamageMultiplier: 0.02, // vehicles/vehicle_bomber.cs:273
    groundImpactMinSpeed: 20, // vehicles/vehicle_bomber.cs:268
    groundImpactSpeedDamageScale: 0.06, // vehicles/vehicle_bomber.cs:269
    cameraMaxDist: 22, // vehicles/vehicle_bomber.cs:205
    cameraOffset: 5, // vehicles/vehicle_bomber.cs:206
    cameraLag: 1.0, // vehicles/vehicle_bomber.cs:207
    groundContactHeight: 7.1895, // = checkRadius; the flyer only touches ground in a crash
  },
  // Havoc (FlyingVehicleData/HAPCFlyer). Its turret and the six passenger mount points are
  // a follow-up slice.
  [VehicleKind.Havoc]: {
    mass: 550, // vehicles/vehicle_havoc.cs:122
    maxDamage: 3.5, // vehicles/vehicle_havoc.cs:73
    maxEnergy: 550, // vehicles/vehicle_havoc.cs:79
    energyPerDamagePoint: 200, // vehicles/vehicle_havoc.cs:78 (isShielded true, :76)
    rechargeRate: 0.8, // vehicles/vehicle_havoc.cs:77
    checkRadius: 7.8115, // vehicles/vehicle_havoc.cs:176
    minMountDist: 4, // vehicles/vehicle_havoc.cs:162
    collDamageThresholdVel: 28, // vehicles/vehicle_havoc.cs:134
    collDamageMultiplier: 0.02, // vehicles/vehicle_havoc.cs:135
    groundImpactMinSpeed: 25, // vehicles/vehicle_havoc.cs:130
    groundImpactSpeedDamageScale: 0.06, // vehicles/vehicle_havoc.cs:131
    cameraMaxDist: 17, // vehicles/vehicle_havoc.cs:66
    cameraOffset: 2, // vehicles/vehicle_havoc.cs:67
    cameraLag: 8.5, // vehicles/vehicle_havoc.cs:68
    groundContactHeight: 7.8115, // = checkRadius; the flyer only touches ground in a crash
  },
  // Beowulf (HoverVehicleData/AssaultVehicle). Its turret/weapons are a follow-up slice.
  [VehicleKind.Tank]: {
    mass: 1500, // vehicles/vehicle_tank.cs:243
    maxDamage: 3.15, // vehicles/vehicle_tank.cs:232
    maxEnergy: 400, // vehicles/vehicle_tank.cs:238
    energyPerDamagePoint: 135, // vehicles/vehicle_tank.cs:237 (isShielded true, :235)
    rechargeRate: 1.0, // vehicles/vehicle_tank.cs:236
    checkRadius: 5.5535, // vehicles/vehicle_tank.cs:337
    minMountDist: 4, // vehicles/vehicle_tank.cs:315
    collDamageThresholdVel: 18, // vehicles/vehicle_tank.cs:259
    collDamageMultiplier: 0.045, // vehicles/vehicle_tank.cs:260
    groundImpactMinSpeed: 17, // vehicles/vehicle_tank.cs:255
    groundImpactSpeedDamageScale: 0.06, // vehicles/vehicle_tank.cs:256
    cameraMaxDist: 20, // vehicles/vehicle_tank.cs:223
    cameraOffset: 3, // vehicles/vehicle_tank.cs:224
    cameraLag: 1.5, // vehicles/vehicle_tank.cs:225
    groundContactHeight: TANK_GROUND_CONTACT_HEIGHT, // see that constant's own comment
  },
  // Jericho (WheeledVehicleData/MobileBaseVehicle). Its deployable turret/station, the
  // wheeled suspension and the canAbandon/cantTeamSwitch rules are follow-up slices.
  [VehicleKind.MobilePointBase]: {
    mass: 2000, // vehicles/vehicle_mpb.cs:150
    maxDamage: 3.85, // vehicles/vehicle_mpb.cs:193
    maxEnergy: 600, // vehicles/vehicle_mpb.cs:198
    energyPerDamagePoint: 125, // vehicles/vehicle_mpb.cs:197 (isShielded true, :196)
    rechargeRate: 1.0, // vehicles/vehicle_mpb.cs:202
    checkRadius: 7.5225, // vehicles/vehicle_mpb.cs:246
    minMountDist: 3, // vehicles/vehicle_mpb.cs:223
    collDamageThresholdVel: 18, // vehicles/vehicle_mpb.cs:166
    collDamageMultiplier: 0.07, // vehicles/vehicle_mpb.cs:167
    groundImpactMinSpeed: 12, // vehicles/vehicle_mpb.cs:162
    groundImpactSpeedDamageScale: 0.06, // vehicles/vehicle_mpb.cs:163
    cameraMaxDist: 20, // vehicles/vehicle_mpb.cs:132
    cameraOffset: 6, // vehicles/vehicle_mpb.cs:133
    cameraLag: 1.5, // vehicles/vehicle_mpb.cs:134
    groundContactHeight: MPB_GROUND_REST_HEIGHT, // see that constant's own comment
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
  /** The last player to land player-attributed damage on this vehicle (issue #57). Recorded
   *  by applyVehicleDamage and credited as a vehicle kill on destruction via damage.ts's
   *  applyVehicleKillScore; -1 when nothing player-sourced ever hurt it. Last-damager rather
   *  than killing-blow, because a vehicle's fatal blow is very often its own crash
   *  (applyCollisionDamage's attackerId -1) or an unattributed turret shot -- either would
   *  erase the credited attacker entirely under a strict killing-blow rule, while a
   *  player-sourced hit is the only way this field is ever set. Reset to -1 on every
   *  spawnVehicleAtPad: a reused id must not inherit the previous occupant's attacker, the
   *  same reused-id hygiene addPlayer applies to score/godMode. */
  lastAttackerId: Int16Array;
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
    lastAttackerId: new Int16Array(capacity).fill(-1),
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
    if (entry.ticksRemaining > 0) {
      stillPending.push(entry);
      continue;
    }
    // Issue #26: the tick the id actually frees is also the tick the slot must stop being
    // a live snapshot entry -- serializeActiveVehicles ships every slot with active === 1,
    // so without this the wreck's entry kept going out on every snapshot for the rest of
    // the match even after its id was back in freeIds. Deactivating exactly here, not at
    // destruction time, is what keeps the row-18 visibility window whole (see the
    // VEHICLE_ID_REUSE_DELAY_TICKS comment above): the slot stays active+destroyed for all
    // three retained ticks, so every snapshot inside the window still reads destroyed=1,
    // and spawnVehicleAtPad reactivates the slot itself when the freed id is reused.
    vehicles.active[entry.id] = 0;
    vehicles.freeIds.push(entry.id);
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

/** The surface a pad spawn should sit above: the pad's deck when one covers it (probed
 *  down from just above the pad origin -- on real Katabatic the svpad deck top sits 2.3 m
 *  ABOVE the pad object's y), else whatever the terrain answers, else the pad origin.
 *  Split out of spawnVehicleAtPad to keep that function's own complexity under budget. */
function padSpawnSupport(world: World, padPos: Vec3): number {
  const deck = raycastInteriors(
    world.interiors,
    { x: padPos.x, y: padPos.y + 6, z: padPos.z },
    { x: 0, y: -1, z: 0 },
    16,
  );
  return deck?.point.y ?? groundHeightAt(world, padPos) ?? padPos.y;
}

/** How high above the pad's walkable surface each kind's model origin starts. A hover craft
 *  starts at its own spring's rest height so the spring begins in equilibrium instead of
 *  popping the craft out of the deck; a flyer only needs clearance, and the two new ones
 *  use their script's createHoverHeight (the field named for exactly this); the wheeled MPB
 *  starts on its wheels. The Shrike's flat 2 m is this file's own original value and stays
 *  pinned, even though vehicle_shrike.cs:144 also authors a createHoverHeight (3). */
function spawnLiftFor(kind: VehicleKind): number {
  if (kind === VehicleKind.Shrike) return 2;
  if (isFlyerKind(kind)) return FLYER_PARAMS[kind].createHoverHeight;
  if (kind === VehicleKind.Tank) return TANK_HOVER_REST_HEIGHT;
  if (kind === VehicleKind.MobilePointBase) return MPB_GROUND_REST_HEIGHT;
  return WILDCAT_HOVER_REST_HEIGHT;
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
  // Spawn at rest height above the pad's actual WALKABLE surface, not a flat offset from
  // the pad object's own origin: on real Katabatic the svpad deck top sits 2.3 m above the
  // pad object's y (measured issue trace: pad y 77.80, deck 80.10), so the old
  // padPos.y + 2 placed the Wildcat 0.3 m INSIDE the deck mesh, which then shoved the
  // craft sideways off the pad while the hover spring dragged it down through the deck
  // (y 78.3 -> 77.4 over 60 ticks). Probe the deck from just above the pad origin; with
  // no deck overhead-ish, fall back to what the terrain sees, then to the pad origin.
  const support = padSpawnSupport(world, padPos);
  const lift = spawnLiftFor(kind);
  vehicles.position.set([padPos.x, support + lift, padPos.z], id * 3);
  vehicles.velocity.set([0, 0, 0], id * 3);
  vehicles.yaw[id] = 0;
  vehicles.pitch[id] = 0;
  vehicles.roll[id] = 0;
  vehicles.angVel.set([0, 0, 0], id * 3);
  vehicles.energy[id] = VEHICLE_DATA[kind].maxEnergy;
  vehicles.damage[id] = 0;
  vehicles.destroyed[id] = 0;
  vehicles.lastAttackerId[id] = -1;
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

// --- Vehicle physics classes -------------------------------------------------------------
// Each kind runs the model its own real datablock class declares:
//   FlyingVehicleData (Shrike, Bomber, Havoc) -- thrust along the heading, no passive gravity
//     (the jets are what hold a flyer up), linear drag, a critically damped heading
//     controller, the auto-stabilizer below maxAutoSpeed, and the energy afterburner.
//   HoverVehicleData (Wildcat, Tank) -- a spring-damper holds the craft inside its own
//     stabLenMin..stabLenMax band above the surface; planar thrust, wheel-free steering, and
//     a one-shot jump (the Wildcat's jump is this file's own addition -- the real
//     HoverVehicleData defines no jump at all; the Tank has none).
//   WheeledVehicleData (MobilePointBase) -- wheels on the surface: torque-limited drive up to
//     maxWheelSpeed, braking on release, lateral tire grip, and steering whose rate comes
//     from the script's own maxSteeringAngle at the speed being driven (no turning at rest).
// Every script field with no counterpart in this simulation is named in the report rather
// than given an invented meaning here (flyer maxSteeringAngle/autoAngularForce/
// horizontalSurfaceForce/verticalSurfaceForce/rotationalDrag; hover floatingGravMag/
// maxSteeringAngle/gyroForce/gyroDamping/normalForce/restorativeForce; the MPB's
// wheel-by-wheel springs, tire forces and deployables).

/** The flying class's own script forces (FlyingVehicleData in every flyer script). Applied
 *  as accelerations (force / mass), the same convention armor.ts's runForce/jetForce/
 *  jumpForce use -- so a flyer's mass changes how much force it takes to reach its own
 *  thrust cutoff, not how the script numbers were authored. */
interface FlyerParams {
  minDrag: number;
  maneuveringForce: number;
  vertThrustMultiple: number;
  maxAutoSpeed: number;
  autoLinearForce: number;
  steeringForce: number;
  jetForce: number;
  minJetEnergy: number;
  jetEnergyDrain: number;
  maxForwardSpeed: number;
  createHoverHeight: number;
}

type FlyerKind = VehicleKind.Shrike | VehicleKind.Bomber | VehicleKind.Havoc;

const FLYER_PARAMS: Record<FlyerKind, FlyerParams> = {
  [VehicleKind.Shrike]: {
    minDrag: 30, // vehicles/vehicle_shrike.cs:127
    maneuveringForce: 3000, // vehicles/vehicle_shrike.cs:139
    vertThrustMultiple: 3, // vehicles/vehicle_shrike.cs:151
    maxAutoSpeed: 15, // vehicles/vehicle_shrike.cs:130
    autoLinearForce: 300, // vehicles/vehicle_shrike.cs:132
    steeringForce: 1200, // vehicles/vehicle_shrike.cs:140
    jetForce: 2000, // vehicles/vehicle_shrike.cs:148
    minJetEnergy: 28, // vehicles/vehicle_shrike.cs:149
    jetEnergyDrain: 2.8, // vehicles/vehicle_shrike.cs:150
    maxForwardSpeed: 100, // vehicles/vehicle_shrike.cs:145 -- real thrust cutoff
    createHoverHeight: 3, // vehicles/vehicle_shrike.cs:144 -- NOT used at spawn (see spawnLiftFor)
  },
  [VehicleKind.Bomber]: {
    minDrag: 60, // vehicles/vehicle_bomber.cs:218
    maneuveringForce: 4700, // vehicles/vehicle_bomber.cs:232
    vertThrustMultiple: 3, // vehicles/vehicle_bomber.cs:244
    maxAutoSpeed: 15, // vehicles/vehicle_bomber.cs:223
    autoLinearForce: 300, // vehicles/vehicle_bomber.cs:225
    steeringForce: 1100, // vehicles/vehicle_bomber.cs:233
    jetForce: 3000, // vehicles/vehicle_bomber.cs:241
    minJetEnergy: 40, // vehicles/vehicle_bomber.cs:242
    jetEnergyDrain: 3.0, // vehicles/vehicle_bomber.cs:243
    maxForwardSpeed: 85, // vehicles/vehicle_bomber.cs:238 -- real thrust cutoff
    createHoverHeight: 3, // vehicles/vehicle_bomber.cs:237
  },
  [VehicleKind.Havoc]: {
    minDrag: 100, // vehicles/vehicle_havoc.cs:80
    maneuveringForce: 6000, // vehicles/vehicle_havoc.cs:93
    vertThrustMultiple: 3, // vehicles/vehicle_havoc.cs:105
    maxAutoSpeed: 10, // vehicles/vehicle_havoc.cs:84
    autoLinearForce: 450, // vehicles/vehicle_havoc.cs:86
    steeringForce: 1000, // vehicles/vehicle_havoc.cs:94
    jetForce: 5000, // vehicles/vehicle_havoc.cs:102
    minJetEnergy: 55, // vehicles/vehicle_havoc.cs:103
    jetEnergyDrain: 3.6, // vehicles/vehicle_havoc.cs:104
    maxForwardSpeed: 71, // vehicles/vehicle_havoc.cs:99 -- real thrust cutoff
    createHoverHeight: 6, // vehicles/vehicle_havoc.cs:98
  },
};

function isFlyerKind(kind: VehicleKind): kind is FlyerKind {
  return kind === VehicleKind.Shrike || kind === VehicleKind.Bomber || kind === VehicleKind.Havoc;
}

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
function applyFlyerAutoStabilize(
  vehicles: VehicleStore,
  id: number,
  speed: number,
  dt: number,
  data: VehicleData,
  params: FlyerParams,
): void {
  const base = id * 3;
  for (let axis = 0; axis < 3; axis += 1) {
    // Vertical stabilization remains engaged during flight: holding forward or
    // boost must not preserve a dive after the pilot levels the nose.
    if (axis !== 1 && speed >= params.maxAutoSpeed) continue;
    const v = vehicles.velocity[base + axis] ?? 0;
    vehicles.velocity[base + axis] =
      v - Math.sign(v) * Math.min(Math.abs(v), (params.autoLinearForce / data.mass) * dt);
  }
}

/** Critically damped heading controller. The script supplies steering force, not
 *  Torque's inertia tensor; these explicit demo rates avoid an underdamped orbit. */
function applyFlyerSteering(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: FlyerParams,
): void {
  const base = id * 3;
  const stiffness = params.steeringForce / data.mass;
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

function applyFlyerThrust(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: FlyerParams,
): void {
  const base = id * 3;
  const heading = headingOf(vehicles.yaw[id] ?? 0, vehicles.pitch[id] ?? 0);
  const thrust = params.maneuveringForce / data.mass;
  const yaw = at(vehicles.yaw, id);
  vehicles.velocity[base] = at(vehicles.velocity, base) - Math.cos(yaw) * input.moveX * thrust * dt;
  vehicles.velocity[base + 2] =
    at(vehicles.velocity, base + 2) + Math.sin(yaw) * input.moveX * thrust * dt;
  vehicles.velocity[base] = (vehicles.velocity[base] ?? 0) + heading.x * input.moveZ * thrust * dt;
  vehicles.velocity[base + 1] =
    (vehicles.velocity[base + 1] ?? 0) +
    heading.y * input.moveZ * thrust * dt * params.vertThrustMultiple;
  vehicles.velocity[base + 2] =
    (vehicles.velocity[base + 2] ?? 0) + heading.z * input.moveZ * thrust * dt;
}

function applyFlyerJetThrust(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: FlyerParams,
): void {
  const base = id * 3;
  const jet = params.jetForce / data.mass;
  if (input.moveX === 0 && input.moveZ === 0) {
    vehicles.velocity[base + 1] =
      at(vehicles.velocity, base + 1) + jet * params.vertThrustMultiple * dt;
  } else {
    const heading = headingOf(at(vehicles.yaw, id), at(vehicles.pitch, id));
    vehicles.velocity[base] = at(vehicles.velocity, base) + heading.x * jet * dt;
    vehicles.velocity[base + 1] = at(vehicles.velocity, base + 1) + heading.y * jet * dt;
    vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) + heading.z * jet * dt;
  }
  vehicles.energy[id] = at(vehicles.energy, id) - params.jetEnergyDrain;
}

/** A held jet input that can't afford minJetEnergy is a flat refusal -- no thrust, no drain,
 *  and (unlike letting go of jet) no recharge either, since the player is still holding the
 *  afterburner down; recharge only resumes once jet is released. */
function applyFlyerAfterburner(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: FlyerParams,
): void {
  if (!input.jet) {
    vehicles.energy[id] = Math.min(data.maxEnergy, at(vehicles.energy, id) + data.rechargeRate);
    return;
  }
  if (at(vehicles.energy, id) < params.minJetEnergy) return;
  applyFlyerJetThrust(vehicles, id, input, dt, data, params);
}

/** Flyers are self-supporting: retain horizontal drag without passive gravity or lift. */
function applyFlyerDrag(
  vehicles: VehicleStore,
  id: number,
  dt: number,
  data: VehicleData,
  params: FlyerParams,
): void {
  const base = id * 3;
  const dragScale = 1 - Math.min(1, (params.minDrag / data.mass) * dt);
  vehicles.velocity[base] = (vehicles.velocity[base] ?? 0) * dragScale;
  vehicles.velocity[base + 2] = (vehicles.velocity[base + 2] ?? 0) * dragScale;
}

/** Real thrust cutoff (vehicle_shrike.cs:145 and its two siblings), not a projectile speed
 *  cap -- caps the whole velocity vector, matching Torque's own "thrust stops adding once
 *  you're already this fast" rule rather than a per-axis clamp that would distort the
 *  heading. Split out of stepFlyer to keep that function's own complexity under budget. */
function clampFlyerSpeed(
  vehicles: VehicleStore,
  id: number,
  speed: number,
  params: FlyerParams,
): void {
  if (speed <= params.maxForwardSpeed) return;
  const base = id * 3;
  const scale = params.maxForwardSpeed / speed;
  vehicles.velocity[base] = at(vehicles.velocity, base) * scale;
  vehicles.velocity[base + 1] = at(vehicles.velocity, base + 1) * scale;
  vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) * scale;
}

export function stepFlyer(
  world: World,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: FlyerParams,
): void {
  const vehicles = world.vehicles;
  const base = id * 3;

  applyFlyerSteering(vehicles, id, input, dt, data, params);
  applyFlyerThrust(vehicles, id, input, dt, data, params);
  applyFlyerAfterburner(vehicles, id, input, dt, data, params);
  applyFlyerDrag(vehicles, id, dt, data, params);

  const speed = Math.hypot(
    vehicles.velocity[base] ?? 0,
    vehicles.velocity[base + 1] ?? 0,
    vehicles.velocity[base + 2] ?? 0,
  );
  applyFlyerAutoStabilize(vehicles, id, speed, dt, data, params);
  clampFlyerSpeed(vehicles, id, speed, params);

  vehicles.position[base] = (vehicles.position[base] ?? 0) + (vehicles.velocity[base] ?? 0) * dt;
  vehicles.position[base + 1] =
    (vehicles.position[base + 1] ?? 0) + (vehicles.velocity[base + 1] ?? 0) * dt;
  vehicles.position[base + 2] =
    (vehicles.position[base + 2] ?? 0) + (vehicles.velocity[base + 2] ?? 0) * dt;
}

export function stepShrike(world: World, id: number, input: PlayerInput, dt: number): void {
  stepFlyer(
    world,
    id,
    input,
    dt,
    VEHICLE_DATA[VehicleKind.Shrike],
    FLYER_PARAMS[VehicleKind.Shrike],
  );
}

// --- Hover class (Wildcat, Tank) ---------------------------------------------------------

/** The hover class's own script fields (HoverVehicleData in both hover scripts). */
interface HoverParams {
  stabLenMin: number;
  stabLenMax: number;
  stabSpring: number;
  stabDamping: number;
  mainThrust: number;
  reverseThrust: number;
  strafeThrust: number;
  turboFactor: number;
  brakingForce: number;
  brakingActivationSpeed: number;
  steeringForce: number;
  rollForce: number;
  gyroDrag: number;
  /** Ours: the script defines no top speed for either hover craft, and this file's
   *  accel-direct thrust convention reaches 50+ m/s in two seconds, well past the kind's own
   *  collDamageThresholdVel/groundImpactMinSpeed -- an uncapped hover craft destroys itself
   *  on its first terrain bump. Sized under both thresholds unboosted, with boost (turbo
   *  factor) allowed to approach, not exceed, the collision threshold. */
  maxSpeed: number;
  minJetEnergy: number;
  jetEnergyDrain: number;
  /** Ours, m/s: no jump exists in either script. The Wildcat's jet-energy-gated hop is the
   *  shape the player's own jumpForce = 8.3 * mass uses; the Tank has no jump at all. */
  jumpImpulsePerMass?: number;
}

type HoverKind = VehicleKind.Wildcat | VehicleKind.Tank;

const WILDCAT_STAB_LEN_MIN = 2.25; // vehicles/vehicle_wildcat.cs:146
const WILDCAT_STAB_LEN_MAX = 3.75; // vehicles/vehicle_wildcat.cs:147
// Ours: (stabLenMin + stabLenMax) / 2 -- applyHoverSpring's equilibrium height, shared
// with spawnVehicleAtPad so a pad spawn starts in spring equilibrium (issue trace).
const WILDCAT_HOVER_REST_HEIGHT = (WILDCAT_STAB_LEN_MIN + WILDCAT_STAB_LEN_MAX) / 2;

const HOVER_PARAMS: Record<HoverKind, HoverParams> = {
  [VehicleKind.Wildcat]: {
    stabLenMin: WILDCAT_STAB_LEN_MIN,
    stabLenMax: WILDCAT_STAB_LEN_MAX,
    stabSpring: 30, // vehicles/vehicle_wildcat.cs:148
    stabDamping: 16, // vehicles/vehicle_wildcat.cs:149
    mainThrust: 30, // vehicles/vehicle_wildcat.cs:138
    reverseThrust: 10, // vehicles/vehicle_wildcat.cs:139
    strafeThrust: 8, // vehicles/vehicle_wildcat.cs:140
    turboFactor: 1.5, // vehicles/vehicle_wildcat.cs:141
    brakingForce: 25, // vehicles/vehicle_wildcat.cs:143
    brakingActivationSpeed: 4, // vehicles/vehicle_wildcat.cs:144
    // The plan's sketch value (vehicle_wildcat.cs:154's steeringForce, treated as an
    // acceleration like the rest of this model -- see the class comment above). The earlier
    // 2.5 retune existed only because the OLD controller damped angVel by GYRO_DRAG/100
    // (zeta ~ 0.05), where 30 span a 90-degree held turn into a +/-70-degree limit cycle;
    // under critical damping 30 turns a held 90-degree input around in about a second with
    // no measurable overshoot (issue trace).
    steeringForce: 30,
    rollForce: 15, // vehicles/vehicle_wildcat.cs:155
    gyroDrag: 16, // spec's Vehicle numbers table
    maxSpeed: 15, // ours -- see HoverParams.maxSpeed
    minJetEnergy: 15, // vehicles/vehicle_wildcat.cs:116
    jetEnergyDrain: 1.3, // vehicles/vehicle_wildcat.cs:117
    jumpImpulsePerMass: 8.3, // ours -- see HoverParams.jumpImpulsePerMass
  },
  [VehicleKind.Tank]: {
    stabLenMin: TANK_STAB_LEN_MIN,
    stabLenMax: TANK_STAB_LEN_MAX,
    stabSpring: TANK_STAB_SPRING,
    stabDamping: 20, // vehicles/vehicle_tank.cs:277
    mainThrust: 50, // vehicles/vehicle_tank.cs:266
    reverseThrust: 40, // vehicles/vehicle_tank.cs:267
    strafeThrust: 40, // vehicles/vehicle_tank.cs:268
    turboFactor: 1.7, // vehicles/vehicle_tank.cs:269
    brakingForce: 25, // vehicles/vehicle_tank.cs:271
    brakingActivationSpeed: 4, // vehicles/vehicle_tank.cs:272
    steeringForce: 15, // vehicles/vehicle_tank.cs:282
    rollForce: 5, // vehicles/vehicle_tank.cs:283
    gyroDrag: 20, // vehicles/vehicle_tank.cs:279
    maxSpeed: 13, // ours -- see HoverParams.maxSpeed; under its own 17 m/s impact floor
    minJetEnergy: 15, // vehicles/vehicle_tank.cs:239
    jetEnergyDrain: 2.0, // vehicles/vehicle_tank.cs:240
  },
};

function isHoverKind(kind: VehicleKind): kind is HoverKind {
  return kind === VehicleKind.Wildcat || kind === VehicleKind.Tank;
}

// Ours, metres: only a deck within this window below the craft can be hover support, so
// high flight never grips a distant floor the way an unbounded deck ray would.
const HOVER_DECK_WINDOW = 8;

/** Highest surface below the craft: terrain, or an interior deck standing on top of it.
 *  groundHeightAt answers terrain-FIRST and never sees a deck standing on non-empty
 *  terrain -- the real Katabatic pads sit on solid ground with their walkable deck 5 m up
 *  (measured: terrain 75.07, deck 80.10), which pinned the hover spring 5 m under the
 *  deck and dragged every pad spawn down through it. The ray starts at the craft's own
 *  center, so it reports exactly the surface the spring should hold the craft over. */
function hoverSupport(world: World, position: Vec3): number | null {
  const terrain = sampleTerrain(world.terrain, position.x, position.z);
  let support = terrain.empty ? null : terrain.height;
  const deck = raycastInteriors(
    world.interiors,
    position,
    { x: 0, y: -1, z: 0 },
    HOVER_DECK_WINDOW,
  );
  if (deck) support = support === null ? deck.point.y : Math.max(support, deck.point.y);
  return support;
}

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
function applyHoverSpring(
  world: World,
  vehicles: VehicleStore,
  id: number,
  dt: number,
  params: HoverParams,
): void {
  const base = id * 3;
  const x = at(vehicles.position, base);
  const z = at(vehicles.position, base + 2);
  const ground = hoverSupport(world, { x, y: at(vehicles.position, base + 1), z });
  if (ground === null) {
    vehicles.velocity[base + 1] = at(vehicles.velocity, base + 1) - GRAVITY * dt;
    vehicles.onGround[id] = 0;
    return;
  }
  const height = at(vehicles.position, base + 1) - ground;
  const restHeight = (params.stabLenMin + params.stabLenMax) / 2;
  const compression = restHeight - height;
  const springAccel = compression * params.stabSpring;
  const dampingAccel = -at(vehicles.velocity, base + 1) * params.stabDamping;
  vehicles.velocity[base + 1] =
    at(vehicles.velocity, base + 1) + (springAccel + dampingAccel) * dt - GRAVITY * dt;
  vehicles.onGround[id] = height <= params.stabLenMax ? 1 : 0;
}

function applyHoverSteering(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  params: HoverParams,
): void {
  const base = id * 3;
  const yawError = normalizeAngle(input.yaw - at(vehicles.yaw, id));
  // Ours: critical damping (c = 2*sqrt(K), zeta = 1) for the yawError -> angVel -> yaw double
  // integrator. The previous form damped angVel by GYRO_DRAG/100 = 0.16/s (zeta ~ 0.05), so a
  // held 90-degree turn overshot the held heading by 77 degrees and then limit-cycled 65
  // degrees UNDER it for the whole measurement window (issue trace) -- the craft would never
  // hold a heading. gyroDrag stays on roll, the cosmetic lean it was being scaled for here.
  const damping = 2 * Math.sqrt(params.steeringForce);
  vehicles.angVel[base + 1] =
    (at(vehicles.angVel, base + 1) + yawError * params.steeringForce * dt) *
    (1 - Math.min(1, damping * dt));
  vehicles.yaw[id] = at(vehicles.yaw, id) + at(vehicles.angVel, base + 1) * dt;
  // Lean into the turn: roll follows yaw rate, restoring toward level via gyroDrag.
  const dragScale = 1 - Math.min(1, (params.gyroDrag / 100) * dt);
  vehicles.roll[id] =
    (at(vehicles.roll, id) + at(vehicles.angVel, base + 1) * dt * (params.rollForce / 100)) *
    dragScale;
  vehicles.angVel[base + 1] = at(vehicles.angVel, base + 1) * dragScale;
}

function hoverForwardForce(input: PlayerInput, boosting: boolean, params: HoverParams): number {
  const base = input.moveZ >= 0 ? params.mainThrust : params.reverseThrust;
  return boosting ? base * params.turboFactor : base;
}

/** Comes to rest via a flat braking force once the driver lets go of both move axes above
 *  brakingActivationSpeed -- split out of applyHoverThrust to keep that function's own
 *  complexity under budget. */
function applyHoverBraking(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  params: HoverParams,
): void {
  if (input.moveX !== 0 || input.moveZ !== 0) return;
  const base = id * 3;
  const horizSpeed = Math.hypot(at(vehicles.velocity, base), at(vehicles.velocity, base + 2));
  if (horizSpeed <= params.brakingActivationSpeed) return;
  // Bounded decel toward (not past) zero -- a scale-based reduction can't overshoot into
  // reverse the way subtracting a flat delta from each axis independently could.
  const decel = Math.min(horizSpeed, params.brakingForce * dt);
  const scale = (horizSpeed - decel) / horizSpeed;
  vehicles.velocity[base] = at(vehicles.velocity, base) * scale;
  vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) * scale;
}

function applyHoverThrust(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: HoverParams,
): void {
  const base = id * 3;
  const heading = headingOf(at(vehicles.yaw, id), 0);
  const right: Vec3 = { x: heading.z, y: 0, z: -heading.x };
  const boosting = input.jet && at(vehicles.energy, id) >= params.minJetEnergy;
  const forwardAccel = hoverForwardForce(input, boosting, params);
  vehicles.velocity[base] =
    at(vehicles.velocity, base) + heading.x * input.moveZ * forwardAccel * dt;
  vehicles.velocity[base + 2] =
    at(vehicles.velocity, base + 2) + heading.z * input.moveZ * forwardAccel * dt;
  vehicles.velocity[base] =
    at(vehicles.velocity, base) + right.x * input.moveX * params.strafeThrust * dt;
  vehicles.velocity[base + 2] =
    at(vehicles.velocity, base + 2) + right.z * input.moveX * params.strafeThrust * dt;
  if (boosting) vehicles.energy[id] = at(vehicles.energy, id) - params.jetEnergyDrain;
  else {
    vehicles.energy[id] = Math.min(data.maxEnergy, at(vehicles.energy, id) + data.rechargeRate);
  }
  applyHoverBraking(vehicles, id, input, dt, params);

  const cap = boosting ? params.maxSpeed * params.turboFactor : params.maxSpeed;
  const horizSpeed = Math.hypot(at(vehicles.velocity, base), at(vehicles.velocity, base + 2));
  if (horizSpeed > cap) {
    const scale = cap / horizSpeed;
    vehicles.velocity[base] = at(vehicles.velocity, base) * scale;
    vehicles.velocity[base + 2] = at(vehicles.velocity, base + 2) * scale;
  }
}

function applyHoverJump(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  params: HoverParams,
): void {
  if (params.jumpImpulsePerMass === undefined) return;
  // Edge-triggered on the press, not the hold: `onGround` stays 1 for as long as the hover
  // spring keeps the craft within its own contact range (applyHoverSpring, below), which is
  // easily several ticks in a row while parked or hovering low, not a single-frame window.
  // Without wasJumpHeld, holding jump applied a fresh impulse every one of those ticks.
  const jumpEdge = input.jump && !vehicles.wasJumpHeld[id];
  vehicles.wasJumpHeld[id] = input.jump ? 1 : 0;
  if (!jumpEdge || !vehicles.onGround[id]) return;
  if (at(vehicles.energy, id) < params.minJetEnergy) return;
  vehicles.velocity[id * 3 + 1] = at(vehicles.velocity, id * 3 + 1) + params.jumpImpulsePerMass;
  vehicles.energy[id] = at(vehicles.energy, id) - params.jetEnergyDrain;
}

export function stepHover(
  world: World,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: HoverParams,
): void {
  const vehicles = world.vehicles;
  applyHoverSteering(vehicles, id, input, dt, params);
  applyHoverThrust(vehicles, id, input, dt, data, params);
  applyHoverJump(vehicles, id, input, params);
  applyHoverSpring(world, vehicles, id, dt, params);
  const base = id * 3;
  vehicles.position[base] = at(vehicles.position, base) + at(vehicles.velocity, base) * dt;
  vehicles.position[base + 1] =
    at(vehicles.position, base + 1) + at(vehicles.velocity, base + 1) * dt;
  vehicles.position[base + 2] =
    at(vehicles.position, base + 2) + at(vehicles.velocity, base + 2) * dt;
}

export function stepWildcat(world: World, id: number, input: PlayerInput, dt: number): void {
  stepHover(
    world,
    id,
    input,
    dt,
    VEHICLE_DATA[VehicleKind.Wildcat],
    HOVER_PARAMS[VehicleKind.Wildcat],
  );
}

// --- Wheeled class (MobilePointBase) -----------------------------------------------------
// The source's wheeled simulation is Torque's WheeledVehicle: one rigid body plus per-wheel
// suspension springs (springForce 8000 N/m, springDamping 1300 N.s/m, antiSwayForce), tire
// contact forces (tireLongitudinalForce 12000, tireLateralForce 3000, tireRadius 1.6) and a
// staticLoadScale. This file has no rigid-body integrator, so the minimum honest version is
// a kinematic one: the torque at the wheels becomes a drive acceleration
// (engineTorque / tireRadius / mass), the script's own maxWheelSpeed is the speed cap, the
// brake torque becomes the release deceleration, maxSteeringAngle gives the turn rate at the
// speed being driven, and the hull rests on the ground contact height (the wheels' own
// measured reach) instead of hanging on six springs. What that deliberately does NOT model:
// per-wheel spring compression/rebound and load transfer, tire slip curves, and the body's
// pitch/roll under acceleration -- a wheeled vehicle here is flat, planted and torque-limited.
interface WheeledParams {
  engineTorque: number;
  breakTorque: number;
  maxWheelSpeed: number;
  tireRadius: number;
  maxSteeringAngle: number;
  tireFriction: number;
}

const MPB_WHEELED: WheeledParams = {
  engineTorque: 7.0 * 745, // vehicles/vehicle_mpb.cs:170 -- 5215 N.m
  breakTorque: 7.0 * 745, // vehicles/vehicle_mpb.cs:171
  maxWheelSpeed: 20, // vehicles/vehicle_mpb.cs:172
  tireRadius: 1.6, // vehicles/vehicle_mpb.cs:181
  maxSteeringAngle: 0.3, // vehicles/vehicle_mpb.cs:139
  tireFriction: 10.0, // vehicles/vehicle_mpb.cs:182 -- used as a lateral grip rate, see below
};

/** Ours: the source steers the wheels and lets tire forces turn the body. A kinematic
 *  bicycle model instead turns at `speed * tan(maxSteeringAngle) / wheelbase`, and the
 *  wheelbase is the one number this sim has to supply -- twice the script's own tireRadius
 *  is the wheelbase of the two-axle chassis that radius describes. */
const MPB_WHEELBASE = MPB_WHEELED.tireRadius * 2;

/** The contact-damage rule both ground paths share: resolveVehicleGround's terrain sphere
 *  contact below, and the wheeled class's own wheel contact. Same expression it was inline,
 *  one rule for the two ways a hull can reach the ground. */
function applyGroundImpactDamage(world: World, id: number, speed: number): void {
  const data = VEHICLE_DATA[world.vehicles.kind[id] as VehicleKind];
  if (speed <= data.groundImpactMinSpeed) return;
  applyVehicleDamage(
    world,
    id,
    (speed - data.groundImpactMinSpeed) * data.groundImpactSpeedDamageScale,
    -1,
  );
}

/** Drive and braking: throttle along the wheel heading, brake torque toward zero on release,
 *  both capped by maxWheelSpeed. */
function applyWheeledDrive(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: WheeledParams,
): void {
  const base = id * 3;
  const heading = headingOf(at(vehicles.yaw, id), 0);
  const throttle = Math.max(-1, Math.min(1, input.moveZ));
  const driveAccel = params.engineTorque / params.tireRadius / data.mass;
  const brakeAccel = params.breakTorque / params.tireRadius / data.mass;
  let vx = at(vehicles.velocity, base);
  let vz = at(vehicles.velocity, base + 2);
  if (throttle !== 0) {
    vx += heading.x * throttle * driveAccel * dt;
    vz += heading.z * throttle * driveAccel * dt;
  } else {
    const speed = Math.hypot(vx, vz);
    const scale = speed > 0 ? Math.max(0, speed - brakeAccel * dt) / speed : 0;
    vx *= scale;
    vz *= scale;
  }
  // Tires grip: the component of motion across the wheel heading decays at tireFriction
  // (a rate, ours -- the script's tire forces are per-wheel, which this model has no wheels
  // to hang them on), so a collision impulse does not leave the base sliding sideways.
  const forward = vx * heading.x + vz * heading.z;
  const lateralScale = Math.max(0, 1 - params.tireFriction * dt);
  const lateralX = (vx - heading.x * forward) * lateralScale;
  const lateralZ = (vz - heading.z * forward) * lateralScale;
  const capped = Math.max(-params.maxWheelSpeed, Math.min(params.maxWheelSpeed, forward));
  vehicles.velocity[base] = heading.x * capped + lateralX;
  vehicles.velocity[base + 2] = heading.z * capped + lateralZ;
}

/** Steering: the driver's own look yaw is a target heading, and the wheels can close only
 *  `speed * tan(maxSteeringAngle) / wheelbase` radians of it per second -- so a stationary
 *  MPB cannot turn on the spot the way the hover class can, and a fast one turns wide. */
function applyWheeledSteering(
  vehicles: VehicleStore,
  id: number,
  input: PlayerInput,
  dt: number,
  params: WheeledParams,
): void {
  const base = id * 3;
  const heading = headingOf(at(vehicles.yaw, id), 0);
  const forwardSpeed =
    at(vehicles.velocity, base) * heading.x + at(vehicles.velocity, base + 2) * heading.z;
  const maxYawRate = (Math.abs(forwardSpeed) * Math.tan(params.maxSteeringAngle)) / MPB_WHEELBASE;
  const yawError = normalizeAngle(input.yaw - at(vehicles.yaw, id));
  const limit = maxYawRate * dt;
  vehicles.yaw[id] = at(vehicles.yaw, id) + Math.max(-limit, Math.min(limit, yawError));
}

/** Wheel contact: the hull rides at its own ground contact height above the support surface
 *  (terrain or a pad deck, the same support the hover spring reads), falls under gravity
 *  when there is none, and hands the impact speed it absorbed to the shared ground-damage
 *  rule. onGround reports whether the wheels are within the vehicle's own reach of the
 *  surface. The whole vertical step lives here -- position and velocity together -- so the
 *  contact correction is never integrated a second time by the caller. */
function applyWheeledSuspension(
  world: World,
  vehicles: VehicleStore,
  id: number,
  dt: number,
  data: VehicleData,
): void {
  const base = id * 3;
  const position = {
    x: at(vehicles.position, base),
    y: at(vehicles.position, base + 1),
    z: at(vehicles.position, base + 2),
  };
  const support = hoverSupport(world, position);
  if (support === null) {
    const fall = at(vehicles.velocity, base + 1) - GRAVITY * dt;
    vehicles.velocity[base + 1] = fall;
    vehicles.position[base + 1] = position.y + fall * dt;
    vehicles.onGround[id] = 0;
    return;
  }
  const height = position.y - support;
  if (height <= data.groundContactHeight) {
    const impact = Math.max(0, -at(vehicles.velocity, base + 1));
    vehicles.position[base + 1] = support + data.groundContactHeight;
    vehicles.velocity[base + 1] = 0;
    vehicles.onGround[id] = 1;
    applyGroundImpactDamage(world, id, impact);
    return;
  }
  const fall = at(vehicles.velocity, base + 1) - GRAVITY * dt;
  vehicles.velocity[base + 1] = fall;
  vehicles.position[base + 1] = position.y + fall * dt;
  vehicles.onGround[id] = height <= data.groundContactHeight + data.checkRadius ? 1 : 0;
}

export function stepWheeled(
  world: World,
  id: number,
  input: PlayerInput,
  dt: number,
  data: VehicleData,
  params: WheeledParams,
): void {
  const vehicles = world.vehicles;
  const base = id * 3;
  applyWheeledSteering(vehicles, id, input, dt, params);
  applyWheeledDrive(vehicles, id, input, dt, data, params);
  vehicles.position[base] = at(vehicles.position, base) + at(vehicles.velocity, base) * dt;
  vehicles.position[base + 2] =
    at(vehicles.position, base + 2) + at(vehicles.velocity, base + 2) * dt;
  applyWheeledSuspension(world, vehicles, id, dt, data);
}

/** One tick of a vehicle's own class physics, dispatched on its kind. Anything not in
 *  VEHICLE_DATA cannot reach here: spawnVehicleAtPad and deserializeVehicle both reject
 *  unknown kinds before a slot is ever activated. */
export function stepVehiclePhysics(world: World, id: number, input: PlayerInput, dt: number): void {
  const kind = world.vehicles.kind[id] as VehicleKind;
  if (isFlyerKind(kind)) {
    stepFlyer(world, id, input, dt, VEHICLE_DATA[kind], FLYER_PARAMS[kind]);
    return;
  }
  if (isHoverKind(kind)) {
    stepHover(world, id, input, dt, VEHICLE_DATA[kind], HOVER_PARAMS[kind]);
    return;
  }
  if (kind === VehicleKind.MobilePointBase) {
    stepWheeled(world, id, input, dt, VEHICLE_DATA[kind], MPB_WHEELED);
  }
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
 *  `attackerId` credits the kill: the last player to hurt the vehicle is recorded on
 *  `lastAttackerId` and destruction scores it via damage.ts's applyVehicleKillScore
 *  (issue #57; the M5 plan's Spec gaps left the number to the implementer). */
export function applyVehicleDamage(
  world: World,
  id: number,
  amount: number,
  attackerId: number,
): void {
  const vehicles = world.vehicles;
  if (amount <= 0 || !vehicles.active[id] || vehicles.destroyed[id]) return;
  // Issue #57 kill attribution: remember the last player who hurt this vehicle (see
  // lastAttackerId's own comment for the last-damager rule); -1 sources -- the vehicle's
  // own crash damage and turret shots -- leave any earlier credit intact.
  if (attackerId >= 0) vehicles.lastAttackerId[id] = attackerId;
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
  applyVehicleKillScore(world, vehicles.lastAttackerId[id] ?? -1, at(vehicles.team, id));
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

/** Terrain-sphere contact. `groundContactHeight` is the resting height this kind resolves
 *  to: equal to `checkRadius` for the four flyers/hoverers it always was, and a real ride
 *  height for the Tank and MPB (see VehicleData.groundContactHeight). */
function resolveVehicleGround(world: World, id: number, current: Vec3, motion: Vec3): number {
  const vehicles = world.vehicles;
  const data = VEHICLE_DATA[vehicles.kind[id] as VehicleKind];
  const ground = groundHeightAt(world, current);
  if (ground === null || current.y - data.groundContactHeight >= ground) return 0;
  const terrain = sampleTerrain(world.terrain, current.x, current.z);
  const normal = terrain.empty ? { x: 0, y: 1, z: 0 } : terrain.normal;
  vehicles.position[id * 3 + 1] = ground + data.groundContactHeight;
  slideVehicle(world, id, normal);
  const speed = closingSpeed(motion, normal);
  applyGroundImpactDamage(world, id, speed);
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
  const playerImpact = resolveVehiclePlayerContacts(world, id, current, motion);
  applyCollisionDamage(world, id, Math.max(groundImpact, interiorImpact, playerImpact));
}

// --- Vehicle-versus-player collision (issue #57) ------------------------------------------

/** The contact normal and closing speeds of one vehicle/player overlap: `closing` is the
 *  vehicle-MINUS-player relative velocity along the normal (what the impulse and damage
 *  consume); the vehicle's own motion into the contact is checked inline. */
interface PlayerContact {
  normal: Vec3;
  closing: number;
}

/** Ours: below half a metre per second of the vehicle's own motion into the contact there
 *  is no collision event at all -- the overlap is parking/resting contact. Without this
 *  gate a dismounted driver standing where seatDriver left them (the vehicle's own center)
 *  re-fires the strike every tick they fall back into the sphere: shoved out, pulled down
 *  by gravity, their velocity opposes the normal again, and the relative-closing rule
 *  reads that as a fresh collision -- a perpetual micro-bounce that never settles (caught
 *  by e2e/vehicles.spec.ts's three-identical-position poll). A pad-idle vehicle in Torque
 *  likewise produces no collision response against an overlapping player; only the
 *  vehicle's own motion generates one. The threshold is LOAD-BEARING, not cosmetic: a
 *  vehicle at rest never has exactly zero per-tick motion (applyWildcatBraking early-returns
 *  below 4 m/s so residual coast speed persists, and applyHoverSpring converges
 *  asymptotically), so a `> 0` gate would keep micro-shoving forever and the exact-equality
 *  settle poll would never pass. Do not "simplify" this to zero. */
const VEHICLE_STRIKE_MIN_CLOSING = 0.5;

/** Overlap test plus closing speed for one pedestrian player against `vId`'s hit sphere, or
 *  null when there is no contact. The two spheres are the ones the rest of the sim already
 *  uses for exactly this pair: the vehicle's own `checkRadius` (what resolveVehicleInteriors
 *  resolves against and what projectiles.ts's vehicle hit-test sweeps) and the player's
 *  bounding-sphere (`playerHitbox`, projectiles.ts's direct-hit test). Null for a dead,
 *  inactive, or MOUNTED player -- a mounted player rides inside their own vehicle's hit
 *  sphere (seatDriver locks them to seatPosition, the exact point resolveVehicleInteriors
 *  resolves against), so without the mounted skip every piloted vehicle would roadkill its
 *  own driver every tick, and contact with the vehicle a player is riding is vehicle-vs-
 *  vehicle territory (an explicit M5 Spec-gap non-goal, not added here). The normal points
 *  from the vehicle toward the player; `closing` is the vehicle-minus-player relative
 *  velocity along it, floored at 0 -- a contact only fires while the two still move INTO
 *  each other, so a player already riding along at the vehicle's speed is not re-shoved.
 *  Null as well unless the VEHICLE itself is moving into the contact faster than
 *  VEHICLE_STRIKE_MIN_CLOSING: the collision event belongs to the vehicle, and an idle
 *  or parked vehicle overlapping a pedestrian (dismount leftovers, someone standing under
 *  a pad hover) must stay inert rather than shoving them around. */
function vehiclePlayerContact(
  world: World,
  vId: number,
  center: Vec3,
  motion: Vec3,
  playerId: number,
): PlayerContact | null {
  const players = world.players;
  if (!players.active[playerId] || !players.alive[playerId]) return null;
  if ((players.mountedVehicleId[playerId] ?? -1) !== -1) return null;
  const data = VEHICLE_DATA[world.vehicles.kind[vId] as VehicleKind];
  const armor = armorFor(world, playerId);
  const box = playerHitbox(world, playerId, armor);
  const dx = box.center.x - center.x;
  const dy = box.center.y - center.y;
  const dz = box.center.z - center.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist >= data.checkRadius + box.radius) return null;
  const normal = dist > 0 ? { x: dx / dist, y: dy / dist, z: dz / dist } : { x: 0, y: 1, z: 0 };
  const base = playerId * 3;
  const closing = Math.max(
    0,
    (motion.x - at(players.velocity, base)) * normal.x +
      (motion.y - at(players.velocity, base + 1)) * normal.y +
      (motion.z - at(players.velocity, base + 2)) * normal.z,
  );
  const vehicleClosing = motion.x * normal.x + motion.y * normal.y + motion.z * normal.z;
  if (vehicleClosing <= VEHICLE_STRIKE_MIN_CLOSING) return null;
  return { normal, closing };
}

/** One contact's effects, in Torque's order (the engine resolves contact response, then
 *  runs VehicleData's damage rules on whatever it collided with):
 *  - Impulse: no script constant exists for an engine-side collision impulse (the M5
 *    numbers table's ejection entry is the one place a script writes one by hand), so this
 *    is the standard two-body elastic contact impulse, 2 * mV * mP / (mV + mP) *
 *    closingSpeed kg·m/s along the contact normal, applied through applyKickback -- whose
 *    divide-by-the-receiver's-mass scale IS Torque's applyImpulse convention per the same
 *    numbers table. Its mass weighting reproduces the familiar asymmetry: a 150 kg Shrike
 *    launches a 90 kg Light hard, a 400 kg Wildcat harder.
 *  - Damage: (closingSpeed - collDamageThresholdVel) * collDamageMultiplier, the same
 *    per-kind rule applyCollisionDamage already applies to the VEHICLE for its terrain and
 *    interior impacts -- Torque's collision pass does not special-case Player contacts when
 *    it decides impact damage, and resolveVehicleCollision feeds the same closing speed
 *    into the vehicle's own damage below.
 *  Attribution: the vehicle's current driver is the attacker, so a roadkill scores like any
 *  other kill through applyDamage -> scoreForDeath; an unpiloted vehicle rolling into
 *  somebody attributes to -1, matching fall damage's environmental convention. */
function applyVehicleStrike(
  world: World,
  vId: number,
  playerId: number,
  contact: PlayerContact,
): void {
  const data = VEHICLE_DATA[world.vehicles.kind[vId] as VehicleKind];
  const armor = armorFor(world, playerId);
  const impulse = ((2 * data.mass * armor.mass) / (data.mass + armor.mass)) * contact.closing;
  applyKickback(world, playerId, contact.normal, impulse, 1, armor);
  if (contact.closing <= data.collDamageThresholdVel) return;
  applyDamage(
    world,
    playerId,
    (contact.closing - data.collDamageThresholdVel) * data.collDamageMultiplier,
    world.vehicles.driverId[vId] ?? -1,
    armor,
  );
}

/** Struck-player half of issue #57's "a Shrike currently does not collide with or damage a
 *  player it flies through" (the M5 plan deferred it because movement.ts's player collision
 *  pass was already a full task; this is the vehicle-side form of the same fix and needs
 *  nothing from movement.ts -- the shove lands on the player's velocity, which
 *  stepPlayers integrates on the NEXT tick, after stepVehicles has run in stepWorld's
 *  order). Returns the largest closing speed among struck players so the caller can feed
 *  it into the vehicle's own applyCollisionDamage. */
function resolveVehiclePlayerContacts(
  world: World,
  vId: number,
  current: Vec3,
  motion: Vec3,
): number {
  const players = world.players;
  let impact = 0;
  for (let playerId = 0; playerId < players.count; playerId += 1) {
    const contact = vehiclePlayerContact(world, vId, current, motion, playerId);
    if (!contact) continue;
    applyVehicleStrike(world, vId, playerId, contact);
    impact = Math.max(impact, contact.closing);
  }
  return impact;
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
  stepVehiclePhysics(world, vId, input, dt);
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
  /** The driving player credited when this shot destroys something (issue #57 kill
   *  attribution): tryFireShrikeBlaster always sets it, since it only fires piloted.
   *  Optional so partial/older event shapes stay valid -- projectiles.ts's
   *  spawnVehicleShot materializes a missing ownerId as -1, the same unattributed
   *  convention turret shots already use, and destruction scoring (applyVehicleKillScore)
   *  credits nobody for -1. */
  ownerId?: number;
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
      // StepOneVehicle only calls this for a seated, live driver, so driverId is the
      // roadkill/kill-credit attacker for anything this shot destroys (issue #57).
      ownerId: at(vehicles.driverId, vId),
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
