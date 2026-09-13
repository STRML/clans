import { MOUNT_RANGE, type Vec3, type VehicleStore, type World } from '@clans/sim';
import type { BotRuntimeState } from './types.js';

/** Real M5 mount is permissive about team (vehicles.ts's own findUnoccupiedVehicleInRange
 *  has no team check at all -- any player can mount any unoccupied vehicle). Bots
 *  deliberately narrow this to the bot's own team: the same "don't exploit unintended
 *  permissiveness" policy Global Constraints already states for spawnVehicleAtPad, applied
 *  here to mounting instead of spawning. This is a bot policy choice, not a sim rule. */
function isUsableByTeam(store: VehicleStore, vehicleId: number, team: number): boolean {
  return (
    store.active[vehicleId] === 1 &&
    store.destroyed[vehicleId] === 0 &&
    store.driverId[vehicleId] === -1 &&
    store.team[vehicleId] === team
  );
}

/** Codex review round 1, finding: real mounting (sim/vehicles.ts's own
 *  findUnoccupiedVehicleInRange) checks full 3D distance
 *  (`Math.hypot(dx, dy, dz)` against `minMountDist`), not a horizontal-only one -- a
 *  same-team vehicle directly above or below a bot (a cliff edge, a ledge) previously read
 *  as "in range" here on X/Z alone while the real mount check in stepVehicles kept
 *  rejecting it, leaving the bot stuck holding `use: true` at a vehicle goal that could
 *  never actually resolve. */
function distance3D(world: World, botId: number, vehicleId: number): number {
  const base = botId * 3;
  const vBase = vehicleId * 3;
  const dx = (world.players.position[base] ?? 0) - (world.vehicles.position[vBase] ?? 0);
  const dy = (world.players.position[base + 1] ?? 0) - (world.vehicles.position[vBase + 1] ?? 0);
  const dz = (world.players.position[base + 2] ?? 0) - (world.vehicles.position[vBase + 2] ?? 0);
  return Math.hypot(dx, dy, dz);
}

export function findMountableVehicle(world: World, botId: number): number | null {
  const store = world.vehicles;
  const team = world.players.team[botId] ?? 0;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < store.count; id += 1) {
    if (!isUsableByTeam(store, id, team)) continue;
    const d = distance3D(world, botId, id);
    if (d <= MOUNT_RANGE && d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  return best;
}

/** Only ever offered as a fallback goal, checked by brain.ts AFTER every CTF priority
 *  (carry home, chase enemy flag, recover own flag, escort a carrier) comes up empty --
 *  a bot never abandons an active CTF task to go joyride a vehicle. See Task 6's
 *  decideGoal and this task's own note in Global Constraints about bots never spawning
 *  a vehicle themselves, only mounting one that already exists. */
export function decideVehicleGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } | null {
  const vehicleId = findMountableVehicle(world, runtime.playerId);
  if (vehicleId === null) return null;
  const base = vehicleId * 3;
  return {
    position: {
      x: world.vehicles.position[base] ?? 0,
      y: world.vehicles.position[base + 1] ?? 0,
      z: world.vehicles.position[base + 2] ?? 0,
    },
    key: `vehicle:${String(vehicleId)}`,
  };
}

/** Feeds Task 6's composeInput: true only once the bot's CURRENT goal is a vehicle goal
 *  (never sent opportunistically just because a vehicle happens to be nearby -- a bot
 *  only presses "E" on the vehicle it actually walked toward) and it is still within
 *  MOUNT_RANGE and still unoccupied by the time the bot arrives -- re-checked fresh every
 *  call, not cached from when the goal was set, so a vehicle taken by a teammate (or
 *  destroyed) in the interim is simply not mounted. Real stepVehicles (vehicles.ts) does
 *  the actual mounting off this bit exactly as it does for a human holding E; this
 *  function only decides whether to send it. */
function vehicleGoalId(goalKey: string | null, vehicleCount: number): number | null {
  if (goalKey === null || !goalKey.startsWith('vehicle:')) return null;
  const vehicleId = Number(goalKey.slice('vehicle:'.length));
  if (Number.isNaN(vehicleId) || vehicleId < 0 || vehicleId >= vehicleCount) return null;
  return vehicleId;
}

export function shouldUseVehicle(world: World, runtime: BotRuntimeState, botId: number): boolean {
  const store = world.vehicles;
  const vehicleId = vehicleGoalId(runtime.goalKey, store.count);
  if (vehicleId === null) return false;
  const team = world.players.team[botId] ?? 0;
  if (!isUsableByTeam(store, vehicleId, team)) return false;
  return distance3D(world, botId, vehicleId) <= MOUNT_RANGE;
}

// --- Issue #32: bots drive the map's vehicles, and take one when the leg is long ---------
//
// Until this, `decideVehicleGoal` was a last-resort goal checked after every CTF priority, so
// with a full roster it never fired at all: measured 0 mounts in 12,000 ticks with two
// vehicles parked at the teams' own pads. Vehicles were also unusable when they did happen,
// because nothing in the brain knew a bot was mounted -- a riding bot kept emitting walking
// input, which a vehicle reads as throttle and steer. Both halves are here.

/** A vehicle is worth the detour only when the leg is long: on Katabatic the two flag stands
 *  are 1,060 m apart, and the point of a vehicle is to cross that at 25-100 m/s instead of
 *  walking it at 15. Under this the walk is fine and the detour is pure loss. */
export const VEHICLE_MIN_LEG_M = 300;

/** How far off the line a bot will walk to reach a parked vehicle. Sized from the map: the
 *  pads sit at each base alongside the spawns, so a radius of 90 m caught almost nothing (one
 *  rider per match, measured), while 200 m lets a bot leaving its own base pick up the craft
 *  parked there -- which is the whole point, since the leg it then rides is about 1,000 m. */

export const VEHICLE_DETOUR_M = 200;

/** Where a driving bot stops driving and dismounts. Deliberately tight: a capture is taken
 *  inside a 2 m radius of the stand (`flags.ts`'s `PICKUP_RADIUS`, and its check reads the
 *  CARRIER's position, which for a mounted player is the vehicle's), so a mounted carrier
 *  that can reach the stand captures without ever getting out. At 40 m the rider arrived,
 *  dismounted, and then had to walk the last stretch -- the stretch the whole feature exists
 *  to skip. The dismount is now only for a craft that cannot get closer. */

export const VEHICLE_DISMOUNT_M = 4;

/** Straight-line distance from a bot to a point: the leg a detour has to be worth. */
function legLengthTo(world: World, botId: number, target: Vec3): number {
  const base = botId * 3;
  return Math.hypot(
    target.x - (world.players.position[base] ?? 0),
    target.y - (world.players.position[base + 1] ?? 0),
    target.z - (world.players.position[base + 2] ?? 0),
  );
}

/** The nearest unoccupied same-team vehicle within `range`, or null. */
export function findUsableVehicleNear(world: World, botId: number, range: number): number | null {
  const store = world.vehicles;
  const team = world.players.team[botId] ?? 0;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < store.count; id += 1) {
    if (!isUsableByTeam(store, id, team)) continue;
    const d = distance3D(world, botId, id);
    if (d > range || d >= bestDistance) continue;
    bestDistance = d;
    best = id;
  }
  return best;
}

/** A detour to a parked vehicle when the bot's own leg is long, or null to walk it. Null
 *  whenever the bot is already riding: once mounted, its goal must be the real target, not
 *  the vehicle it is sitting in -- which is also what keeps the ride from reading as
 *  "arrived" and dismounting on the spot. */
export function vehicleDetourGoal(
  world: World,
  botId: number,
  target: Vec3,
  detourRange: number = VEHICLE_DETOUR_M,
): { position: Vec3; key: string } | null {
  if ((world.players.mountedVehicleId[botId] ?? -1) !== -1) return null;
  if (legLengthTo(world, botId, target) < VEHICLE_MIN_LEG_M) return null;
  const vehicleId = findUsableVehicleNear(world, botId, detourRange);
  if (vehicleId === null) return null;
  const vBase = vehicleId * 3;
  return {
    position: {
      x: world.vehicles.position[vBase] ?? 0,
      y: world.vehicles.position[vBase + 1] ?? 0,
      z: world.vehicles.position[vBase + 2] ?? 0,
    },
    key: `vehicle:${String(vehicleId)}`,
  };
}

/** The driving input for a mounted bot: the craft steers toward an absolute heading
 *  (`applyHoverSteering` and the flyer's own controller both read `input.yaw` as the heading
 *  to hold), so pointing it at the goal is the whole controller, and throttle is full until
 *  the dismount range. `use` is the dismount: the sim edge-detects it, and holding it across
 *  ticks does not re-mount (its own test pins that). */
export function driveInputFor(
  world: World,
  runtime: BotRuntimeState,
  goal: Vec3,
): { yaw: number; moveZ: number; jet: boolean; use: boolean } {
  const botId = runtime.playerId;
  const base = botId * 3;
  const dx = goal.x - (world.players.position[base] ?? 0);
  const dz = goal.z - (world.players.position[base + 2] ?? 0);
  const dy = goal.y - (world.players.position[base + 1] ?? 0);
  const distance = Math.hypot(dx, dz);
  // Stall escape. Without it a craft that cannot reach the goal -- a wall, the base deck the
  // stand sits on, a slope it cannot climb -- holds throttle against the obstacle for the rest
  // of the match, with the bot still inside it, which is what the 7, 30 and 86 m closest
  // approaches were. Progress is measured on the best distance this ride has seen, so a
  // detour around an obstacle still counts as progress and a craft stuck against one does
  // not.
  if (distance < runtime.rideBestDistance - RIDE_PROGRESS_M) {
    runtime.rideBestDistance = distance;
    runtime.rideStallTicks = 0;
  } else {
    runtime.rideStallTicks += 1;
  }
  const stalled = runtime.rideStallTicks >= RIDE_STALL_TICKS;
  return {
    yaw: Math.atan2(dx, dz),
    moveZ: distance > VEHICLE_DISMOUNT_M && !stalled ? 1 : 0,
    // Jets when the goal is ABOVE the craft, which is what makes a flag run reachable at
    // all: Katabatic's stands sit about 21 m up on the bases' decks, so a level-flying craft
    // that never climbs can only ever get under them. A flyer climbs on its jets; a hover
    // craft gets its hop. Nothing else about altitude is modelled yet -- no terrain
    // following, no dive -- so this is the one vertical rule the controller has.
    jet: dy > VEHICLE_CLIMB_M && !stalled,
    use: stalled || distance <= VEHICLE_DISMOUNT_M,
  };
}

/** Progress a ride has to make to count as moving, in metres, and how many ticks without it
 *  before the driver gives up and walks. 1 m over 3 s is a craft that is not going anywhere:
 *  a Wildcat crosses 1,000 m in under a minute, so anything that holds a metre for three
 *  seconds is against something. */
const RIDE_PROGRESS_M = 1;
const RIDE_STALL_TICKS = 90;

export const VEHICLE_CLIMB_M = 4;

/** How far a FLAG CARRIER will walk to reach a craft, which is deliberately much further than
 *  an attacker will (VEHICLE_DETOUR_M). The asymmetry is the round trip: the craft is parked
 *  at the enemy base by whoever drove it there, and the carrier that takes the flag off that
 *  stand has a 1,060 m walk home ahead of it, so a detour of several hundred metres still
 *  wins. Measured: with the attacker's 200 m the first capture appeared but only in one seed
 *  of four, with carriers reaching 0, 7, 30 and 86 m of their own stand. */
export const VEHICLE_CARRIER_DETOUR_M = 400;
