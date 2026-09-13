import {
  applyLoadoutSelection,
  armorFor,
  FlagState,
  groundHeightAt,
  PackId,
  STATION_USE_RADIUS,
  type ArmorId,
  type PlayerInput,
  type Vec3,
  type WeaponId,
  type World,
} from '@clans/sim';
import { OrderKind, type TeamOrder } from '@clans/protocol';
import { aimAndFire, aimAtPoint, carrierHoldsFireOnPoint, selectCombatTarget } from './combat.js';
import {
  CARRIER_THREAT_RADIUS_M,
  findAttackableTurret,
  findCarrierHealStation,
  findCarrierThreat,
  findEnemyFlagCarrier,
  findEscortedCarrier,
  findNearestFriendlyStation,
  findNearestVisibleEnemy,
  isCarryingEnemyFlag,
  LOW_HEALTH_FRACTION,
  needsHealing,
} from './perception.js';
import { steerToward } from './steering.js';
import { BotRole, BotState, type BotRuntimeState } from './types.js';
import {
  decideVehicleGoal,
  driveInputFor,
  shouldUseVehicle,
  vehicleDetourGoal,
  VEHICLE_CARRIER_DETOUR_M,
} from './vehicles.js';
import type { WaypointGraph } from './waypoints.js';

export const DEFEND_ENGAGE_RADIUS = 120; // Ours.

function playerPoint(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: world.players.position[base + 1] ?? 0,
    z: world.players.position[base + 2] ?? 0,
  };
}

function ownFlagId(world: World, team: number): number {
  for (let id = 0; id < world.flags.team.length; id += 1)
    if (world.flags.team[id] === team) return id;
  return 0;
}
function enemyFlagId(world: World, team: number): number {
  for (let id = 0; id < world.flags.team.length; id += 1)
    if (world.flags.team[id] !== team) return id;
  return 1;
}

function flagPosition(world: World, flagId: number): Vec3 {
  const base = flagId * 3;
  return {
    x: world.flags.position[base] ?? 0,
    y: world.flags.position[base + 1] ?? 0,
    z: world.flags.position[base + 2] ?? 0,
  };
}

function flagStandPosition(world: World, flagId: number): Vec3 {
  const base = flagId * 3;
  return {
    x: world.flags.standPosition[base] ?? 0,
    y: world.flags.standPosition[base + 1] ?? 0,
    z: world.flags.standPosition[base + 2] ?? 0,
  };
}
/** Issue #32 carrier survival, regroup: TRUE when the carrier should back off instead of
 *  pressing the return walk -- a visible enemy this close (they will exchange fire the
 *  whole way; duel completion needs every duel won and the measured carrier deaths were
 *  duels lost at 6-51% health with friendlies nowhere near) while NO teammate is within
 *  REGROUP_FRIENDLY_M. The point of backing off is not to outrun bullets -- nobody can --
 *  it is to stop closing on fresh threats while the team's own attack wave (which trails
 *  the carrier by 100-400 m, converging on the flag's current position) arrives and
 *  turns the 1 v 1 into a 5 v 1. */
export const REGROUP_ENEMY_M = 60; // Ours, meters.
export const REGROUP_FRIENDLY_M = 40; // Ours, meters.
/** How far toward home the hold point sits while regrouping -- close enough that the
 *  carrier is still making return progress (the goal drifts home as the carrier walks,
 *  exactly like the escort screen point drifts with its carrier), far enough that the
 *  retreat itself buys the teammates real closing time. */
export const REGROUP_HOLD_M = 80; // Ours, meters.

function carrierShouldRegroup(world: World, runtime: BotRuntimeState): boolean {
  const threatId = findNearestVisibleEnemy(world, runtime.playerId);
  if (threatId === null) return false;
  const me = playerPoint(world, runtime.playerId);
  const threat = playerPoint(world, threatId);
  if (Math.hypot(me.x - threat.x, me.y - threat.y, me.z - threat.z) > REGROUP_ENEMY_M) return false;
  const team = world.players.team[runtime.playerId] ?? 0;
  for (let id = 0; id < world.players.count; id += 1) {
    if (id === runtime.playerId) continue;
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    if (world.players.team[id] !== team) continue;
    const mate = playerPoint(world, id);
    if (Math.hypot(me.x - mate.x, me.y - mate.y, me.z - mate.z) <= REGROUP_FRIENDLY_M) return false;
  }
  return true;
}

/** Issue #32 home-leg economy: the flag stand's own capture gate, restated from flags.ts
 *  (ownFlagHome). A capture is refused while the capturer's own flag is anything but Home
 *  -- only the own flag's STATE matters, not who has it: a Dropped flag re-arms the capture
 *  only once somebody touches it back home, a carried one only when its carrier dies (or
 *  the 45 s return timer fires after it drops). This is the fact the whole home leg is
 *  built on: while it is true, the enemy flag a carrier holds converts to NOTHING. */
function ownFlagAway(world: World, team: number): boolean {
  return world.flags.state[ownFlagId(world, team)] !== FlagState.Home;
}

/** Issue #32 home-leg economy: how far off the stand the carrier holds while ownFlagAway
 *  is true. PICKUP_RADIUS (flags.ts, 2 m, 3D) is the entire capture gate, so the hold point
 *  has to stay comfortably inside it -- but exactly ON the stand point is the one place not
 *  to hold: it is where every teammate converging on the post ends up (defenders falling
 *  back to it, escorts, a second carrier), and players collide -- LIGHT_ARMOR's collision
 *  radius is 0.6 m (movement.ts's `Math.max(boxX, boxY) / 2`), so two bodies collide within
 *  1.2 m and a teammate parked on the stand point shoves the carrier off it (the same
 *  standoff reasoning as ESCORT_STANDOFF_M). 1.5 m clears that 1.2 m contact diameter and
 *  still leaves 0.5 m of the 2 m capture radius for the approach's own overshoot.
 *
 *  Measured (flat terrain, the real steering + movement stack, 2000 settled ticks of a
 *  carrier holding this point): distance to the stand ran mean 2.34 m, min 0.72 m, max
 *  10.32 m, and the carrier was inside the 2 m capture gate on 61% of ticks. It is a SWEEP,
 *  not a park: steering drives at the goal at full speed with no arrival damping (steering
 *  is not this slice's file) and the approach overshoots, then comes back -- the anti-stuck
 *  ladder is NOT what moves it (stuck streak peaked at 2 against its threshold of 3, zero
 *  skips, zero escape windows in the same run). A tighter point measured tighter (0.6 m ->
 *  80% of ticks inside), and costs the clearance from a teammate standing on the post: at
 *  0.6 m the carrier sits inside a 0.6 m-radius body's 1.2 m contact diameter, which is the
 *  shoving this standoff exists to avoid, so 1.5 m is the tightest defensible radius. That
 *  is enough for the gate it exists for: flags.ts's tryCapture runs for every player every
 *  tick, so each of those 61% of ticks is a live capture check -- the carrier sweeps the
 *  radius rather than parking in it, and a sweep still converts the moment the own flag
 *  comes back. */
export const CARRIER_HOLD_STANDOFF_M = 1.5; // Ours, meters.

/** Issue #32 home-leg economy -- the explicit preference call between the two things a
 *  carrier can do while its own flag is away: walk to its own stand and hold inside the
 *  capture radius, or turn and take the own flag back. While a thief that is carrying our
 *  flag is inside this radius the design prefers RECOVERY, on the brief's own premise: the
 *  enemy flag aboard is worth nothing until the own flag returns (ownFlagAway above), so the
 *  carrier must not park itself waiting on a flag an enemy is still walking away with when
 *  it is the closest body that can end that walk. Killing the thief drops our flag on the
 *  spot, and one touch returns it home (the 45 s return timer does it anyway), which
 *  re-arms every carrier we have. Beyond this radius the carrier HOLDS instead: a longer
 *  chase is the documented wandering failure this file already carries (carriers walking
 *  backwards off their return route), and the thief is the defenders' standing intercept
 *  duty (decideDefenderGoal) rather than something the carrier should abandon the capture
 *  window for. 60 m is REGROUP_ENEMY_M: the range at which this file already treats a
 *  visible enemy as an unavoidable encounter, so the diversion never leaves a fight the
 *  carrier was going to be in anyway. */
export const CARRIER_RECOVER_M = 60; // Ours, meters.

/** Where the carrier waits while ownFlagAway is true: CARRIER_HOLD_STANDOFF_M from the
 *  stand, along the ray from the stand to the carrier -- stop one body-width short on the
 *  side you are arriving from instead of walking onto the stand point itself. A moving
 *  hold point is fine (steering's drift repathing follows it exactly like the escort screen
 *  and the regroup point below), and it is what keeps the hold reachable: the approach side
 *  is by construction the side the carrier has already walked, so the point cannot land
 *  inside a base wall or off a deck lip the way a fixed offset axis could. Degenerate when
 *  the carrier is already ON the stand (the `|| 1` route guard, same idiom as the regroup
 *  point): the goal collapses to the stand point, which is still a legal capture position. */
function carrierHoldPoint(world: World, runtime: BotRuntimeState, ownId: number): Vec3 {
  const stand = flagStandPosition(world, ownId);
  const me = playerPoint(world, runtime.playerId);
  const dx = me.x - stand.x;
  const dz = me.z - stand.z;
  const route = Math.hypot(dx, dz) || 1;
  return {
    x: stand.x + (dx / route) * CARRIER_HOLD_STANDOFF_M,
    y: stand.y,
    z: stand.z + (dz / route) * CARRIER_HOLD_STANDOFF_M,
  };
}

/** The recovery half of CARRIER_RECOVER_M: the goal that takes the own flag back when the
 *  enemy carrying it is close enough to fight, or null when the carrier should hold
 *  instead. The key is the defender duty's own (`intercept:<id>`), so steering's drift
 *  repathing and the stuck ladder treat a carrier's recovery as the same task any defender
 *  runs. A flag already DROPPED is deliberately not a recovery case for the carrier: the
 *  defenders' own goal function already opens with exactly that errand
 *  (decideDefenderGoal's `recoverOwn` branch), one touch returns it, the 45 s timer
 *  returns it anyway, and the carrier's ready-inside-the-radius role is the one no
 *  teammate can cover -- only the player HOLDING the enemy flag can convert it. */
function carrierRecoverGoal(
  world: World,
  runtime: BotRuntimeState,
  team: number,
): { position: Vec3; key: string } | null {
  const thief = findEnemyFlagCarrier(world, team);
  if (thief === null) return null;
  const me = playerPoint(world, runtime.playerId);
  const thiefPos = playerPoint(world, thief);
  const gap = Math.hypot(me.x - thiefPos.x, me.y - thiefPos.y, me.z - thiefPos.z);
  if (gap > CARRIER_RECOVER_M) return null;
  return { position: thiefPos, key: `intercept:${String(thief)}` };
}

/** Issue #32 launch cohesion: how many teammates have to be within
 *  CARRIER_STAGE_RADIUS_M of the carrier before it starts the return leg. The HARNESS
 *  slice's four-seed telemetry is what this exists for: 21 carrier runs, 16 ended in death,
 *  15 of those 16 credited to an enemy PLAYER at a median 647 m from the carrier's own
 *  stand -- carriers are losing duels in midfield, alone, and never get near their own
 *  stand at all (best closest approach across all 21 runs: 272 m). The carrier is by
 *  definition the body that took the flag, so it also leaves the enemy base FIRST and the
 *  return leg starts with nobody around it. Two is the smallest group that makes the
 *  crossing a fight the enemy has to win 3v1 instead of a duel it wins 1v1, and this file
 *  already treats "no teammate within REGROUP_FRIENDLY_M" as alone (carrierShouldRegroup). */
export const CARRIER_STAGE_TEAMMATES = 2; // Ours.

/** How close a teammate has to be to count as the company above: DEFEND_ENGAGE_RADIUS
 *  (120 m), this file's existing answer to "how close is close enough to be fighting the
 *  same fight", and inside VISION_RANGE (150 m), so a body that counts is a body that can
 *  see and shoot whatever is shooting the carrier. */
export const CARRIER_STAGE_RADIUS_M = 120; // Ours, meters.

/** Issue #32 launch cohesion: how far out from the ENEMY stand, along the straight line to
 *  the carrier's own stand, the staging point sits -- the enemy side of midfield, and
 *  deliberately not the enemy flag deck. Both ends are ruled out by measurement rather than
 *  taste: the deck approach is where the #32 probes put ~70% of all carrier chip damage
 *  (inside an enemy plasma turret's 120 m envelope), so the wait has to sit outside that
 *  envelope; and the deaths this gate exists for land at a median 647 m from the carrier's
 *  OWN stand, i.e. around the middle of the ~1 km map, so the stage point has to stay well
 *  short of midfield. 200 m is 80 m clear of the plasma envelope and still ~300 m on the
 *  enemy side of the midpoint. */
export const CARRIER_STAGE_FROM_ENEMY_M = 200; // Ours, meters.

/** Issue #32 launch cohesion: how long the carrier stages for company before it launches
 *  alone (the give-up). 600 ticks (~19 s) was the original pick, sized from the trailing
 *  wave's own 100-400 m gap; the ablation study on this wave measured what it actually
 *  bought, and it was not arrivals: both flags sat carried for 38% of every match (18199 of
 *  48000 sampled ticks) with the 600-tick wait against 21.6% with the wait disabled, for 53
 *  fewer kills and eight fewer carrier deaths -- and zero extra arrivals either way. A short
 *  wait keeps the intent (pick up the bodies already close) without parking the flag in
 *  midfield: 100 ticks (~3 s) is about what a body inside CARRIER_STAGE_RADIUS_M needs to
 *  close the last few metres, and it is a twentieth of the 45 s the enemy flag's own return
 *  timer runs for, so it cannot throw away a live capture window. */
export const CARRIER_STAGE_WAIT_TICKS = 100; // Ours, ticks (~3 s at 32 ms/tick).

/** Issue #32 launch cohesion, escort side: below this horizontal speed the carrier counts
 *  as standing still, which for a carrier means it is staging for company (or wedged --
 *  either way its bodyguard's job is to close on it). 1 m/s, a tenth of the ~10 m/s run, so
 *  a carrier that is actually walking never reads as still, while a steering-stopped one
 *  (the stage goal collapses onto its own position, so movement.ts gets zero input) decays
 *  under it within a few ticks. */
export const CARRIER_STILL_SPEED_MPS = 1; // Ours, m/s.

/** Issue #32 launch cohesion: living teammates within CARRIER_STAGE_RADIUS_M of the
 *  carrier -- the company the launch gate counts. */
function teammatesNearCarrier(world: World, runtime: BotRuntimeState): number {
  const me = playerPoint(world, runtime.playerId);
  const team = world.players.team[runtime.playerId] ?? 0;
  let count = 0;
  for (let id = 0; id < world.players.count; id += 1) {
    if (id === runtime.playerId) continue;
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    if (world.players.team[id] !== team) continue;
    const mate = playerPoint(world, id);
    if (Math.hypot(me.x - mate.x, me.y - mate.y, me.z - mate.z) <= CARRIER_STAGE_RADIUS_M)
      count += 1;
  }
  return count;
}

/** The staging point: CARRIER_STAGE_FROM_ENEMY_M along the enemy stand -> own stand ray, at
 *  whatever ground height the map has there. Deliberately NOT the enemy stand's own y: that
 *  is a deck height, and a goal sitting a deck-height above a carrier 200 m out would have
 *  steering's climb-jet gate firing at nothing. */
function carrierStagePoint(world: World, team: number): Vec3 {
  const home = flagStandPosition(world, ownFlagId(world, team));
  const enemy = flagStandPosition(world, enemyFlagId(world, team));
  const dx = home.x - enemy.x;
  const dz = home.z - enemy.z;
  const route = Math.hypot(dx, dz) || 1;
  const x = enemy.x + (dx / route) * CARRIER_STAGE_FROM_ENEMY_M;
  const z = enemy.z + (dz / route) * CARRIER_STAGE_FROM_ENEMY_M;
  return { x, y: groundHeightAt(world, { x, y: 0, z }) ?? enemy.y, z };
}

/** Issue #32 launch cohesion: TRUE when the carrier is standing still (see
 *  CARRIER_STILL_SPEED_MPS). The escort reads this off the carrier's own velocity instead
 *  of sharing a flag with the carrier's decision layer, so the two duties stay independent
 *  -- and so the launch gate's company count can open the moment a bodyguard actually
 *  arrives. */
function carrierStandingStill(world: World, carrierId: number): boolean {
  const base = carrierId * 3;
  return (
    Math.hypot(world.players.velocity[base] ?? 0, world.players.velocity[base + 2] ?? 0) <
    CARRIER_STILL_SPEED_MPS
  );
}

/** Issue #32 launch cohesion: the bounded company wait, run for its side effect on the
 *  staging clock (`carrierStageSinceTick`). Returns the stage goal while the carrier is
 *  waiting for company, or null when it should be walking home -- company present, wait
 *  expired, or the carrier already out of the gate's scope.
 *
 *  Two scope guards, both about the leg rather than the flag. ENEMY HALF: the gate delays
 *  the long crossing, so it only applies while the carrier is still on the far side of
 *  midfield; a carrier that is already home-side has committed to the leg, and on a map
 *  whose stands are barely farther apart than the staging distance itself there is no long
 *  leg to launch (the gate never opens there). NO BACKTRACK: the stage point is only
 *  offered while the carrier has not reached it yet (`remaining` against `stageRemaining`),
 *  so a carrier that took the flag late, or got shoved past the line, walks home instead of
 *  turning around -- walking backwards off its own route is the documented carrier failure
 *  this file already carries.
 *
 *  The wait ends three ways, two of them early. Company: the gate opens the moment
 *  CARRIER_STAGE_TEAMMATES are inside CARRIER_STAGE_RADIUS_M, so the clock never has to
 *  expire. The give-up: CARRIER_STAGE_WAIT_TICKS after the carrier began staging, it
 *  launches alone. The reset: decideGoal clears the clock on any tick the bot is not
 *  carrying, so a fresh take can never inherit the previous run's elapsed wait. */
function carrierStageGoal(
  world: World,
  runtime: BotRuntimeState,
  team: number,
): { position: Vec3; key: string } | null {
  const ownId = ownFlagId(world, team);
  const home = flagStandPosition(world, ownId);
  const enemy = flagStandPosition(world, enemyFlagId(world, team));
  const stage = carrierStagePoint(world, team);
  const me = playerPoint(world, runtime.playerId);
  const remaining = Math.hypot(me.x - home.x, me.z - home.z);
  const route = Math.hypot(home.x - enemy.x, home.z - enemy.z);
  const stageRemaining = Math.hypot(stage.x - home.x, stage.z - home.z);
  // Issue #32: the launch is ONE WAY. Every branch below that ends the wait sets the
  // latch, and the latch is cleared only when the bot stops carrying (decideGoal) -- a
  // fresh take stages again. Without it the give-up branch below launched the carrier for
  // exactly one tick: the next call found `carrierStageSinceTick < 0` and re-armed the
  // clock against the same stage point, so the carrier was back at the stage goal one tick
  // later and the 100-tick wait could never actually fire. Measured on a production seed-1
  // match: carrier 11 flipped `home:1` <-> `stage:1` 115 times in 6527 ticks (58 up, 57
  // back) and spent 3020 ticks shuttling around one graph node 3.5-44 m away, closing 19 m
  // of a 995 m route while travelling 2886 m. A company count that crosses
  // CARRIER_STAGE_TEAMMATES and back is the other source of the same flip: the escort
  // formation hovers at a median 51 m, so the gate chattered around the threshold.
  if (runtime.carrierStageLaunched) return null;
  // Enemy half only, and never backwards. The first guard is the gate's own scope: the
  // crossing this delays is the long one, and a carrier that is already on its own half has
  // committed to it (on a map whose stands are barely farther apart than the staging
  // distance itself, there is no long leg to launch and the gate correctly never opens).
  // The second is the no-backtrack rule above.
  if (remaining <= route / 2 || remaining <= stageRemaining) {
    runtime.carrierStageSinceTick = -1;
    runtime.carrierStageLaunched = true;
    return null;
  }
  if (teammatesNearCarrier(world, runtime) >= CARRIER_STAGE_TEAMMATES) {
    runtime.carrierStageSinceTick = -1;
    runtime.carrierStageLaunched = true;
    return null;
  }
  if (
    runtime.carrierStageSinceTick >= 0 &&
    world.tick - runtime.carrierStageSinceTick >= CARRIER_STAGE_WAIT_TICKS
  ) {
    runtime.carrierStageSinceTick = -1;
    runtime.carrierStageLaunched = true;
    return null;
  }
  if (runtime.carrierStageSinceTick < 0) runtime.carrierStageSinceTick = world.tick;
  return { position: stage, key: `stage:${String(ownId)}` };
}

/** The carrier's home leg (issue #32 home-leg economy + launch cohesion), split out of
 *  decideGoal so the carry outranks the bot's ROLE: whichever role picked the enemy flag
 *  up, the only way it converts is this player standing inside the capture radius while
 *  ownFlagAway turns false. Four states, in order:
 *
 *  0. LAUNCH: still on the enemy side of the stage line and short of company -- hold at
 *     the staging point until CARRIER_STAGE_TEAMMATES arrive or CARRIER_STAGE_WAIT_TICKS
 *     runs out (carrierStageGoal). This is the leg the HARNESS telemetry says carriers
 *     die on: alone, in midfield, at a median 647 m from home, never once reaching the
 *     stand. Company first, then the walk.
 *  1. Own flag HOME -- the capture is live and the flag stand is the goal, exactly as
 *     before; the only detour left is the regroup retreat (carrierShouldRegroup), which
 *     still applies here because a healthy carrier in midfield with a deadline is a
 *     different animal from one standing in its own base.
 *  2. Own flag AWAY with the thief carrying it inside CARRIER_RECOVER_M -- recovery (see
 *     CARRIER_RECOVER_M): the carry is unconvertible until the own flag returns, and this
 *     is the only way the carrier can make that happen.
 *  3. Own flag AWAY otherwise -- HOLD inside the capture radius at the stand. This is the
 *     point of the state: carrierHoldPoint is a legal capture position, flags.ts's
 *     tryCapture runs for every player every tick, so the moment ownFlagAway turns false
 *     the capture lands even though the carrier never moved again. Nothing may pull the
 *     carrier off it: no regroup retreat (the regroup point is measured from the carrier's
 *     own position, so a carrier 30 m from home with a threat nearby gets a point 80 m
 *     along its own ray -- 50 m PAST the stand and 50 m out of the capture radius, i.e.
 *     the retreat actively fights the thing the carrier is waiting to do), and no station
 *     detour except the low-health valve (holdingCarrierSkipsHeal).
 *
 *  The goal key is `home:<ownId>` in every state except the stage, so steering sees one
 *  task (drift repathing handles the moving hold point) and any escort formation keyed to
 *  the carrier keeps following it; `stage:<ownId>` is its own key so the launch itself
 *  repaths from the staging point. */
function carrierHomeGoal(
  world: World,
  runtime: BotRuntimeState,
  team: number,
): { position: Vec3; key: string } {
  const ownId = ownFlagId(world, team);
  const key = `home:${String(ownId)}`;
  const recover = carrierRecoverGoal(world, runtime, team);
  if (recover !== null) return recover;
  const stage = carrierStageGoal(world, runtime, team);
  if (stage !== null) return stage;
  if (ownFlagAway(world, team)) {
    return { position: carrierHoldPoint(world, runtime, ownId), key };
  }
  const home = flagStandPosition(world, ownId);
  // Issue #32 vehicles: the same long-leg rule as the attacker's approach, and the reason the
  // round trip can close -- a craft left at the enemy base during the take is right there
  // when the flag comes off the stand.
  const ride = vehicleDetourGoal(world, runtime.playerId, home, VEHICLE_CARRIER_DETOUR_M);
  if (ride !== null) return ride;
  if (!carrierShouldRegroup(world, runtime)) return { position: home, key };
  // Regroup hold point: REGROUP_HOLD_M along the carrier -> home ray. Key stays
  // `home:<id>` so steering treats it as the same task (drift repathing handles the
  // moving point) and any escort formation keyed to the carrier keeps following.
  const me = playerPoint(world, runtime.playerId);
  const dx = home.x - me.x;
  const dz = home.z - me.z;
  const route = Math.hypot(dx, dz) || 1;
  return {
    position: {
      x: me.x + (dx / route) * REGROUP_HOLD_M,
      y: me.y,
      z: me.z + (dz / route) * REGROUP_HOLD_M,
    },
    key,
  };
}

/** Attacker not carrying the flag (the carry is handled by carrierHomeGoal above): head to
 *  the enemy flag wherever it currently is (home, dropped, or being carried by a teammate
 *  you're about to catch up to and pass, which is fine -- there's nothing wrong with two
 *  teammates converging on the same flag). */
function decideAttackerGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } {
  const enemyId = enemyFlagId(world, world.players.team[runtime.playerId] ?? 0);
  const target = flagPosition(world, enemyId);
  // Issue #32 vehicles: the approach to the enemy stand is the long leg (the stands are
  // 1,060 m apart), so an attacker takes a parked craft when one is on its way rather than
  // walking the whole way. The carrier's own return leg gets the same treatment in
  // carrierHomeGoal -- a craft parked at the enemy base is usually the one that attacker
  // arrived in, which is how the round trip closes.
  const ride = vehicleDetourGoal(world, runtime.playerId, target);
  if (ride !== null) return ride;
  return { position: target, key: `enemyFlag:${String(enemyId)}` };
}

/** Issue #32: how far an escort holds off its carrier. Exactly ON the carrier is worse
 *  than useless -- players collide, so a bodyguard pressed against the carrier's back
 *  shoves it off its own route (observed as carriers bouncing off their own escorts on
 *  the return walk). A standoff lets the escort walk the same route one body-width off,
 *  close enough that findNearestVisibleEnemy sees every threat the carrier sees. */
export const ESCORT_STANDOFF_M = 8; // Ours, meters.

/** The escort's hold point, issue #32 screen-ahead: ESCORT_STANDOFF_M from the carrier
 *  TOWARD THE CARRIER'S OWN TRAVEL DIRECTION (its horizontal velocity, falling back to
 *  the ray toward the escort when the carrier is slow) -- a bodyguard walks POINT, not
 *  trail. Threats met on the walk home come from ahead (the enemy attack wave funnels
 *  through the midfield between the carrier and home), and an escort ahead of the
 *  carrier engages them before the carrier ever does; a trailing escort arrives at each
 *  fight one duel too late (measured: carriers died to single interceptors while their
 *  escorts trailed 40+ m back). GOAL_DRIFT_REPATH_M already repaths as the carrier drags
 *  the screen point along. The screen point is also deliberately OFF the carrier by the
 *  standoff even at rest -- players collide, so a bodyguard pressed against the
 *  carrier's back shoves it off its own route. */
function escortPoint(world: World, runtime: BotRuntimeState, carrierId: number): Vec3 {
  const carrier = playerPoint(world, carrierId);
  const base = carrierId * 3;
  const vx = world.players.velocity[base] ?? 0;
  const vz = world.players.velocity[base + 2] ?? 0;
  let dx = vx;
  let dz = vz;
  const speed = Math.hypot(dx, dz);
  if (speed < 1) {
    const me = playerPoint(world, runtime.playerId);
    dx = me.x - carrier.x;
    dz = me.z - carrier.z;
  }
  const distance = Math.hypot(dx, dz) || 1;
  return {
    x: carrier.x + (dx / distance) * ESCORT_STANDOFF_M,
    y: carrier.y,
    z: carrier.z + (dz / distance) * ESCORT_STANDOFF_M,
  };
}

/** Issue #32: how far the escort may stand from the carrier and still use the close
 *  screen-ahead point. Measured on the production seeds: an escort with a live escort
 *  GOAL 500-1000 m from its carrier at every sample -- both walk at run speed, so a
 *  trailing escort chasing the carrier's heels never closes and arrives at each fight
 *  one duel too late (the exact failure the screen-ahead design already predicted for
 *  trailing escorts, one scale up). */
export const ESCORT_CATCHUP_M = 60; // Ours, meters.
/** How far ahead of the carrier, along its remaining route home, a distant escort aims:
 *  the escort walks the route the carrier is ABOUT to walk, meeting midfield threats
 *  first and falling into the close screen (ESCORT_CATCHUP_M) as the carrier catches up.
 *  As the point retreats toward home at the carrier's own pace, an escort that starts on
 *  the home side simply paces the return this far ahead of it -- a rolling picket, not a
 *  chase it can never win. 100, not more: a pacing escort is the carrier's ONLY body
 *  once the pursuer stream comes from BEHIND (the enemy attack wave chases the flag's
 *  current position, i.e. the carrier, from the enemy-base side) -- measured id12's run
 *  dying to a chaser with its escort parked 150 m ahead, out of the fight entirely. */
export const ESCORT_AHEAD_M = 100; // Ours, meters.
/** Carrier health below which the formation collapses onto the carrier: a wounded
 *  carrier cannot afford a screened escort -- the screen exists to engage threats
 *  before they reach a HEALTHY carrier, and a chaser trading shots with a wounded
 *  carrier wins that trade unless the bodyguard closes the gap now. 30 m puts the
 *  escort within one strafe of the duel, inside every weapon's useful envelope. 0.8,
 *  not lower: the measured near-miss carrier crossed midfield at 71-74% health with its
 *  escorts still pacing 96 m ahead -- a chaser trading shots with even that carrier
 *  wins, so the pull-in must cover "merely chipped" carriers too. */
export const CARRIER_CLOSE_HEALTH = 0.8; // Ours.
export const ESCORT_CLOSE_M = 30; // Ours, meters.

/** Issue #32 launch cohesion, return-leg arm: how far from the carrier, on the THREAT's
 *  side of it, the escort stations itself when the carrier has a live threat. The measured
 *  deaths in the four-seed telemetry have a median killer distance of 17 m -- point blank,
 *  one enemy, no pack -- while the escort paces ESCORT_AHEAD_M (100 m) up the route, so the
 *  bodyguard is a spectator at the only fight that matters. 25 m puts it inside every
 *  weapon's useful envelope (the same scale ESCORT_CLOSE_M's health-triggered pull-in uses)
 *  and, against a 17 m killer, within ~8 m of it: close enough that its own fire lands on
 *  the fight instead of on the carrier's corpse, far enough that it is not standing inside
 *  the carrier's own knife-range answer. */
export const ESCORT_ENGAGE_M = 25; // Ours, meters.

/** Issue #32: the escort's station when the carrier has a live threat -- ESCORT_ENGAGE_M
 *  from the carrier along the carrier -> threat ray, clamped to the threat itself when it
 *  is already that close, i.e. between the two with its guns facing the enemy. A threat that
 *  runs drags the point with it; a carrier with no threat keeps the picket (escortGoal). */
function escortEngagePoint(world: World, threatId: number, carrierId: number): Vec3 {
  const carrier = playerPoint(world, carrierId);
  const threat = playerPoint(world, threatId);
  const dx = threat.x - carrier.x;
  const dz = threat.z - carrier.z;
  const gap = Math.hypot(dx, dz) || 1;
  const reach = Math.min(ESCORT_ENGAGE_M, gap);
  return { x: carrier.x + (dx / gap) * reach, y: carrier.y, z: carrier.z + (dz / gap) * reach };
}

/** The escort's goal: the close screen-ahead hold point (escortPoint) once it is within
 *  ESCORT_CATCHUP_M of the carrier, or -- while it is still far away -- the point ahead
 *  of the carrier along the straight route to the home stand (clamped to the stand
 *  itself on the final approach). A carrier below CARRIER_CLOSE_HEALTH pulls the point
 *  in to ESCORT_CLOSE_M so the escort stops pacing and closes. Same `escort:<id>` goal
 *  key either way, so steering's drift repathing keeps following the moving point
 *  exactly as before.
 *
 *  Issue #32 launch cohesion, return-leg arm: a carrier with a LIVE THREAT outranks all of
 *  that. The picket is a bet that the next fight is 100 m up the route, and the telemetry
 *  says the bet loses -- the carrier dies to a single enemy at a median 17 m with no
 *  teammate within 100 m, i.e. while its bodyguard is pacing a point the fight is not at.
 *  When the carrier can see an enemy inside CARRIER_THREAT_RADIUS_M (the COMBAT slice's own
 *  envelope for "the carrier's fight is the escort's fight", so the goal and the fire
 *  discipline agree on where that fight is), the escort's goal becomes
 *  escortEngagePoint: the carrier's threat side, at engagement range. */
function escortGoal(world: World, runtime: BotRuntimeState, carrierId: number): Vec3 {
  const carrier = playerPoint(world, carrierId);
  const me = playerPoint(world, runtime.playerId);
  const gap = Math.hypot(me.x - carrier.x, me.z - carrier.z);
  const threat = findCarrierThreat(world, carrierId, CARRIER_THREAT_RADIUS_M);
  if (threat !== null) return escortEngagePoint(world, threat, carrierId);
  // Issue #32 launch cohesion, escort side: a carrier that is standing still is staging for
  // company (once it reaches the staging point its goal collapses onto its own position, so
  // it stops), and a distant escort's usual point is ESCORT_AHEAD_M along the route home --
  // a point a parked carrier is never going to walk to. Close on the body instead, the same
  // point the close screen uses, which is what actually satisfies the launch gate's company
  // count and lets the pair leave together.
  if (gap <= ESCORT_CATCHUP_M || carrierStandingStill(world, carrierId))
    return escortPoint(world, runtime, carrierId);
  const carrierArmor = armorFor(world, carrierId);
  const carrierHealth = 1 - (world.players.damage[carrierId] ?? 0) / carrierArmor.maxDamage;
  const aheadM = carrierHealth < CARRIER_CLOSE_HEALTH ? ESCORT_CLOSE_M : ESCORT_AHEAD_M;
  const team = world.players.team[runtime.playerId] ?? 0;
  const home = flagStandPosition(world, ownFlagId(world, team));
  const dx = home.x - carrier.x;
  const dz = home.z - carrier.z;
  const route = Math.hypot(dx, dz) || 1;
  const ahead = Math.min(aheadM, route);
  return {
    x: carrier.x + (dx / route) * ahead,
    y: carrier.y,
    z: carrier.z + (dz / route) * ahead,
  };
}
/** Issue #32 duty split: when the team has BOTH a thief to hunt and a carrier to
 *  bodyguard, all-defenders-intercept starves the carrier of protection (measured: a
 *  carrier died to the first enemy that met it in midfield while every defender was
 *  halfway across the map chasing a thief) and all-defenders-escort lets the thief walk
 *  our flag home unopposed. The squad splits by parity of the defender's join-order
 *  index within its own team (active same-team players with a lower id). Plain id parity
 *  was tried first and failed spectacularly: bots join alternating teams, so parity is
 *  just team membership in disguise -- one team's whole defender squad came out even
 *  (intercept-only), the other's odd (escort-only). The within-team index is immune to
 *  how ids interleave across teams. */
function squadIndex(world: World, runtime: BotRuntimeState): number {
  const team = world.players.team[runtime.playerId] ?? 0;
  let index = 0;
  for (let id = 0; id < runtime.playerId; id += 1) {
    if (world.players.active[id] && world.players.team[id] === team) index += 1;
  }
  return index;
}

function defenderTakesIntercept(world: World, runtime: BotRuntimeState): boolean {
  return squadIndex(world, runtime) % 2 === 0;
}

function decideDefenderGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } {
  const team = world.players.team[runtime.playerId] ?? 0;
  const ownId = ownFlagId(world, team);
  if (world.flags.state[ownId] === FlagState.Dropped) {
    return { position: flagPosition(world, ownId), key: `recoverOwn:${String(ownId)}` };
  }
  // Issue #32: an enemy carrying OUR flag is the highest-value target on the map -- a
  // capture is REFUSED while our own flag is away (flags.ts's ownFlagHome check), so
  // every second the thief lives is a second our own carrier's return leg is worth
  // nothing. Killing the thief drops the flag (then any touch returns it home, or the
  // 45 s timer does), which re-arms every one of our carriers at once. Sits between
  // "recover the dropped flag" (the flag is already down; picking it up is urgent and
  // one touch finishes it) and "escort" below.
  const thief = findEnemyFlagCarrier(world, team);
  const carrier = findEscortedCarrier(world, team, runtime.playerId);
  if (thief !== null && (carrier === null || defenderTakesIntercept(world, runtime))) {
    return { position: playerPoint(world, thief), key: `intercept:${String(thief)}` };
  }
  if (carrier !== null) {
    return { position: escortGoal(world, runtime, carrier), key: `escort:${String(carrier)}` };
  }

  // Fallback checked only when every CTF priority above comes up empty (Task 7): mount a
  // nearby own-team vehicle if one is reachable, otherwise hold at the flag stand as before.
  const vehicleGoal = decideVehicleGoal(world, runtime);
  if (vehicleGoal !== null) return vehicleGoal;
  return { position: flagStandPosition(world, ownId), key: `home:${String(ownId)}` };
}

/** Codex review round 1, finding (P1): `needsHealing` existed, but nothing ever routed a
 *  bot TOWARD a station -- `maybeHeal` (below) only ever healed a bot that happened to
 *  already be standing in range, so a bot at 80% damage 50 m from its own station kept
 *  chasing the enemy flag forever. The spec's own words ("backs off to a friendly
 *  inventory station when health or energy runs low") make this the bot's top priority,
 *  ahead of any CTF task -- checked here, before role branching, not folded into either
 *  role's own goal function.
 *
 *  Health only, not the full `needsHealing` (health OR energy): the milestone's own
 *  required proof (Task 11's bot-only match) is the check the plan itself names for
 *  exactly this tuning question ("a real signal to revisit brain.ts's goal priorities...
 *  before declaring this task done"), and gating this on energy too made every bot's
 *  routine uphill jetting over Katabatic (LOW_ENERGY_FRACTION's own 30% threshold drains
 *  fast against LIGHT_ARMOR's rechargeRate) trigger a full cross-map retreat, and the
 *  match produced zero kills across 5000 ticks -- verified directly, not assumed. Low
 *  energy alone is already handled gracefully without an explicit goal: slopeAssist stops
 *  offering `jet` once energy is low, so a low-energy bot just walks/skis instead, and
 *  `maybeHeal` below still tops off energy for free the moment any goal (CTF, escort, or
 *  this one) happens to walk it past a friendly station. */
/** The bot's full-health reset of the #32 heal-chase bookkeeping -- any state the chase
 *  clock built up is stale once healing is no longer needed. */
function resetHealChase(runtime: BotRuntimeState): void {
  runtime.healChaseKey = null;
  runtime.healChaseSinceTick = -1;
  runtime.healChaseCooldownUntilTick = 0;
}

function stationPosition(world: World, stationId: number): Vec3 {
  const base = stationId * 3;
  return {
    x: world.baseObjects.position[base] ?? 0,
    y: world.baseObjects.position[base + 1] ?? 0,
    z: world.baseObjects.position[base + 2] ?? 0,
  };
}

/** True when the bot's position is within HEAL_CHASE_NEAR_M of `station` -- "basically
 *  at the station", i.e. progress worth extending patience for. */
function nearStation(world: World, runtime: BotRuntimeState, station: Vec3): boolean {
  const base = runtime.playerId * 3;
  return (
    Math.hypot(
      (world.players.position[base] ?? 0) - station.x,
      (world.players.position[base + 1] ?? 0) - station.y,
      (world.players.position[base + 2] ?? 0) - station.z,
    ) <= HEAL_CHASE_NEAR_M
  );
}

/** Issue #32: the give-up state machine for a heal chase, run for its side effects on
 *  the runtime's chase clock. Returns false when the bot should stop chasing (cooldown
 *  window active, or the chase timed out and just armed the cooldown). Katabatic's
 *  stations sit inside structures, and a bot whose 2D route cannot actually enter the
 *  room wedges against the building forever -- verified in production-landmark matches,
 *  where the entire attack force evaporated into permanent, never-completing heal
 *  chases by tick ~1200 and no bot ever touched a flag again. After
 *  HEAL_CHASE_GIVEUP_TICKS of chasing (across nearest-station switches -- see the key
 *  comment in decideHealGoal) without getting within HEAL_CHASE_NEAR_M of a station,
 *  the bot commits to its CTF goal for HEAL_CHASE_COOLDOWN_TICKS -- and after that
 *  cooldown, the next allowed check opens a FRESH chase window. (The -1 "no chase in
 *  progress" sentinel must read as "start the clock now", never as an elapsed-time
 *  figure: the original `world.tick - (-1) > HEAL_CHASE_GIVEUP_TICKS` treated every
 *  post-give-up call as an already-expired chase, so one give-up re-armed the cooldown
 *  every call forever -- measured as carriers showing an active cooldown for 6000+
 *  straight ticks with no station attempt between re-arms.) */
function healChaseAllowed(world: World, runtime: BotRuntimeState, station: Vec3): boolean {
  if (world.tick < runtime.healChaseCooldownUntilTick) return false;
  if (runtime.healChaseSinceTick < 0) {
    // No chase in progress: this call starts one.
    runtime.healChaseSinceTick = world.tick;
    return true;
  }
  if (nearStation(world, runtime, station)) {
    // Genuine progress: the bot is basically at the station, so any remaining wedge is
    // worth more patience.
    runtime.healChaseSinceTick = world.tick;
    return true;
  }
  if (world.tick - runtime.healChaseSinceTick > HEAL_CHASE_GIVEUP_TICKS) {
    runtime.healChaseCooldownUntilTick = world.tick + HEAL_CHASE_COOLDOWN_TICKS;
    runtime.healChaseKey = null;
    runtime.healChaseSinceTick = -1;
    return false;
  }
  return true;
}

/** Issue #32: the cooldown's job is protecting the bot's CTF task from a wedging
 *  chase, but WITH THE FLAG ABOARD the CTF task IS the walk home, and a wounded
 *  carrier with no heal option is a dead carrier (measured: a carrier at 51% health
 *  with an active cooldown and 500 m of no-man's-land died to the first
 *  interceptor). Forgive the cooldown on pickup and start a fresh chase window: the
 *  marginal-detour gate and the give-up state machine (healChaseAllowed) still bound
 *  the chase. Split from decideHealGoal for the lint complexity cap. */
function forgiveHealCooldown(world: World, runtime: BotRuntimeState): void {
  if (world.tick >= runtime.healChaseCooldownUntilTick) return;
  runtime.healChaseCooldownUntilTick = 0;
  runtime.healChaseKey = null;
  runtime.healChaseSinceTick = -1;
}

/** Issue #32 home-leg economy: TRUE when the carrier's station detour must yield to the
 *  home leg -- carrying the enemy flag with the own flag away (ownFlagAway), and healthy
 *  enough that the detour costs more than it saves. While the own flag is away the carry
 *  cannot be converted at all, so the carrier's whole job is to be inside the capture
 *  radius the tick the flag returns: a 180-190 m marginal station detour (the measured cost
 *  of the midfield towers) walks it off that radius, and the regroup/hold design is exactly
 *  what keeps it there. The valve is the fraction. CARRIER_HEAL_HEALTH_FRACTION (0.6) is the
 *  carrier's top-up line while a live capture is still to protect, but that line is far too
 *  eager to be a "leave the hold" line: at 0.6 every chip a carrier takes in a firefight
 *  would send it off the stand, and the hold would never survive contact. Below
 *  LOW_HEALTH_FRACTION (0.4 -- the same line every non-carrier in the match backs off at)
 *  the carrier dies to the next exchange, and a dead carrier drops the flag and forfeits
 *  the carry entirely, so below that line it may still leave. Between the two lines the
 *  hold wins, and the carrier is not stranded without a heal: it is standing in its own
 *  base among its own defenders and turrets, and any station it is actually within range of
 *  still tops it up through maybeHeal's own request path, which needs no goal change at
 *  all. */
function holdingCarrierSkipsHeal(
  world: World,
  runtime: BotRuntimeState,
  carrying: boolean,
  health: number,
): boolean {
  if (!carrying || health < LOW_HEALTH_FRACTION) return false;
  return ownFlagAway(world, world.players.team[runtime.playerId] ?? 0);
}

/** The station a wounded bot walks to: the marginal-detour carrier scan while the enemy
 *  flag is aboard (findCarrierHealStation), the plain nearest one otherwise. Split out of
 *  decideHealGoal for the lint complexity cap. */
function healStationFor(world: World, runtime: BotRuntimeState, carrying: boolean): number | null {
  if (!carrying) return findNearestFriendlyStation(world, runtime.playerId);
  const team = world.players.team[runtime.playerId] ?? 0;
  return findCarrierHealStation(
    world,
    runtime.playerId,
    flagStandPosition(world, ownFlagId(world, team)),
    CARRIER_HEAL_MAX_MARGINAL_M,
  );
}

function decideHealGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } | null {
  const armor = armorFor(world, runtime.playerId);
  const health = 1 - (world.players.damage[runtime.playerId] ?? 0) / armor.maxDamage;
  const carrying = isCarryingEnemyFlag(world, runtime.playerId);
  if (health >= healGateFor(carrying)) {
    resetHealChase(runtime);
    return null;
  }
  if (holdingCarrierSkipsHeal(world, runtime, carrying, health)) {
    resetHealChase(runtime);
    return null;
  }
  if (carrying) forgiveHealCooldown(world, runtime);
  const stationId = healStationFor(world, runtime, carrying);
  if (stationId === null) return null;
  const station = stationPosition(world, stationId);
  if (!healChaseAllowed(world, runtime, station)) return null;
  const key = `heal:${String(stationId)}`;
  if (runtime.healChaseKey !== key) {
    // Track the station, but deliberately DO NOT restart the clock: on the walk home
    // the nearest friendly station flips between towers every few dozen meters, and a
    // per-station clock would reset on every flip and never expire.
    runtime.healChaseKey = key;
    if (runtime.healChaseSinceTick < 0) runtime.healChaseSinceTick = world.tick;
  }
  return { position: station, key };
}
/** Issue #32: a carrier detours to a station when the MARGINAL walking distance --
 *  `carrier -> station -> home stand` minus the straight walk home -- is at or under
 *  CARRIER_HEAL_MAX_MARGINAL_M. The old nearest-station flat-radius gate
 *  (CARRIER_HEAL_DETOUR_M = 60 m) never fired on real Katabatic at all: every own
 *  station sits 450-580 m off the direct return diagonal, while the midfield-tower
 *  stations cost only ~180-190 m of MARGINAL walking along the first half of the
 *  return -- a ~20 s detour for a full health+energy reset (applyLoadoutSelection zeroes
 *  damage). Scanning by marginal distance (perception.ts's findCarrierHealStation)
 *  picks that tower; the healChase give-up state machine below still bounds a chase
 *  that wedges. */
export const CARRIER_HEAL_MAX_MARGINAL_M = 250; // Ours, meters.
// A carrier's heal behavior is deliberately different from everyone else's: the carry is
// time-critical (the moment it dies the flag drops and a return timer starts), so full
// cross-map heal chases walked carriers backwards off their return route (observed
// carriers bouncing mid-map for 10k+ ticks between heal goals at under half the distance
// home they had already covered), while NO heal at all let attrition kill them 100 m from
// home. What survived is this bounded detour.
// Top up earlier than the bare LOW_HEALTH_FRACTION line: the carrier's job (survive to
// the stand) dies to attrition, so the refill must happen while there is health to save.
// Only while a capture is still live, though -- with the own flag away this line is
// suppressed down to LOW_HEALTH_FRACTION by holdingCarrierSkipsHeal (issue #32 home-leg
// economy), because the carry cannot convert until the flag returns and a detour then
// costs the capture window rather than protecting it.
const CARRIER_HEAL_HEALTH_FRACTION = 0.6; // Ours.

function healGateFor(carrying: boolean): number {
  return carrying ? CARRIER_HEAL_HEALTH_FRACTION : LOW_HEALTH_FRACTION;
}

// Issue #32 heal-chase bound -- see decideHealGoal. Long enough that a genuine
// cross-map retreat to the nearest friendly station comfortably completes (the map is
// ~1 km corner to corner at a ~10 m/s run); short enough that a wedged bot rejoins the
// fight within a couple of engagements.
export const HEAL_CHASE_GIVEUP_TICKS = 1800; // Ours.
export const HEAL_CHASE_NEAR_M = 10; // Ours, meters.
// How long a bot that gave up on a heal chase commits to its CTF goal before trying
// any station again. Health recovered (death/respawn or an opportunistic station pass)
// clears the chase state long before this can matter; a still-wounded bot uses the
// window to actually GET somewhere (home, with the flag).
export const HEAL_CHASE_COOLDOWN_TICKS = 3600; // Ours.

/** A commander's Attack/Defend/Repair order for the bot's own team, checked after
 *  decideHealGoal (self-preservation stays the bot's top priority, unchanged by an
 *  order -- see this task's own "judgment call" note) and before the normal role/CTF
 *  branch. Repair re-derives "have I got a Repair Pack yet" from
 *  `world.players.hasRepairPack` fresh every call, so a bot with no reachable powered
 *  station simply keeps trying to reach one -- no give-up state (failure matrix row 24). */
function orderGoal(
  world: World,
  runtime: BotRuntimeState,
  order: TeamOrder,
): { position: Vec3; key: string } {
  if (order.kind === OrderKind.Repair) {
    if (world.players.hasRepairPack[runtime.playerId] !== 1) {
      const stationId = findNearestFriendlyStation(world, runtime.playerId);
      if (stationId === null) {
        return { position: { x: order.x, y: 0, z: order.z }, key: 'order:repair-equip' };
      }
      const base = stationId * 3;
      return {
        position: {
          x: world.baseObjects.position[base] ?? 0,
          y: world.baseObjects.position[base + 1] ?? 0,
          z: world.baseObjects.position[base + 2] ?? 0,
        },
        key: 'order:repair-equip',
      };
    }
    return { position: { x: order.x, y: 0, z: order.z }, key: 'order:repair' };
  }
  const key = order.kind === OrderKind.Attack ? 'order:attack' : 'order:defend';
  return { position: { x: order.x, y: 0, z: order.z }, key };
}
/** Issue #32 gear-up, REJECTED design (kept documented so nobody re-derives it): a
 *  dedicated "walk to a station and grab an Energy Pack" goal deadlocked the whole bot
 *  population on production Katabatic -- most stations sit inside base structures the
 *  interior-blind 2D graph cannot actually enter, so bots orbited ~10 m from the
 *  station point forever (measured: 31 of 32 bots still on `gear:<station>` goals at
 *  tick 1800, zero kills and zero touches in the match), and an unbounded gear goal
 *  had no give-up to rescue them. What survives is the REQUEST side: maybeHeal below
 *  now treats "no pack at all" as a reason to request the loadout, so any bot that
 *  legitimately reaches a station (a real heal chase, a post at the stand, a passing
 *  2.5 m window) converts the visit into full bars plus the recharge pack. */
export function decideGoal(
  world: World,
  runtime: BotRuntimeState,
  order: TeamOrder | null,
): { position: Vec3; key: string } {
  const healGoal = decideHealGoal(world, runtime);
  if (healGoal !== null) return healGoal;
  const team = world.players.team[runtime.playerId] ?? 0;
  if (order && order.team === team) return orderGoal(world, runtime, order);
  // Issue #32 home-leg economy: the CARRY outranks the ROLE. A bot holding the enemy flag
  // converts it one way only -- by standing inside its own stand's capture radius while
  // its own flag is Home -- so whichever role actually picked the flag up (an Attacker on
  // the take, or a Defender that walked over the drop) its goal is carrierHomeGoal, not the
  // role's own duty. Before this, a Defender carrier had no carrier branch at all: it fell
  // through to escort/intercept/vehicle-mount and could walk its flag back out of the base.
  if (isCarryingEnemyFlag(world, runtime.playerId)) return carrierHomeGoal(world, runtime, team);
  // Issue #32 launch cohesion: the staging clock exists only while the carry does. Cleared
  // here, on every tick the bot is not carrying, so a fresh take can never inherit the
  // previous run's elapsed wait and launch on its first tick (carrierStageGoal). The launch
  // latch is cleared with it -- a later take stages on its own merits.
  runtime.carrierStageSinceTick = -1;
  runtime.carrierStageLaunched = false;
  return runtime.role === BotRole.Attacker
    ? decideAttackerGoal(world, runtime)
    : decideDefenderGoal(world, runtime);
}
/** Direct sim call, mirroring maybeHeal below -- a Repair order's "equip a Repair Pack"
 *  step is the same one-shot Loadout-request pattern maybeHeal already uses, just
 *  triggered by an order instead of low health/energy. */
export function maybeEquipRepairPack(world: World, botId: number): void {
  const stationId = findNearestFriendlyStation(world, botId);
  if (stationId === null) return;
  const base = botId * 3;
  const stationBase = stationId * 3;
  const dx = (world.players.position[base] ?? 0) - (world.baseObjects.position[stationBase] ?? 0);
  const dy =
    (world.players.position[base + 1] ?? 0) - (world.baseObjects.position[stationBase + 1] ?? 0);
  const dz =
    (world.players.position[base + 2] ?? 0) - (world.baseObjects.position[stationBase + 2] ?? 0);
  if (Math.hypot(dx, dy, dz) > STATION_USE_RADIUS) return;
  applyLoadoutSelection(world, botId, world.players.armor[botId] as ArmorId, PackId.Repair, 0);
}

export function decideState(runtime: BotRuntimeState, engagedTargetId: number | null): BotState {
  if (engagedTargetId === null) return BotState.Idle;
  return runtime.role === BotRole.Defender ? BotState.Defend : BotState.Attack;
}

/** True when the defender's post no longer exists and the leash must not apply: the own
 *  flag is away (nothing to hold -- the defender's job is now recovery/interception out
 *  in the field) or a teammate is running the enemy flag home (the defender's job is now
 *  bodyguard). Issue #32: the previous code leashed EVERY defender to DEFEND_ENGAGE_RADIUS
 *  around the home stand even while its doc comment claimed escorts were exempt, so an
 *  escort 200 m out trailed its carrier in total silence -- it would not fire on the very
 *  enemies it was walking beside -- and an interceptor never fired at all. A post you
 *  cannot defend from 150 m away with a flag gone is not a post. */
function defenderPostGone(world: World, runtime: BotRuntimeState): boolean {
  const team = world.players.team[runtime.playerId] ?? 0;
  if (ownFlagAway(world, team)) return true;
  return findEscortedCarrier(world, team, runtime.playerId) !== null;
}

function isOutsideDefendLeash(world: World, runtime: BotRuntimeState, targetId: number): boolean {
  if (runtime.role !== BotRole.Defender) return false;
  if (defenderPostGone(world, runtime)) return false;
  const team = world.players.team[runtime.playerId] ?? 0;
  const home = flagStandPosition(world, ownFlagId(world, team));
  const target = playerPoint(world, targetId);
  return Math.hypot(home.x - target.x, home.z - target.z) > DEFEND_ENGAGE_RADIUS;
}

/** A Defender engages within DEFEND_ENGAGE_RADIUS of its own flag stand while it still
 *  HAS a post (own flag home, nothing to escort); once the post is gone -- flag away or
 *  a carrier to bodyguard -- it engages anywhere, like an Attacker (isOutsideDefendLeash /
 *  defenderPostGone above). Row 9: engagedTargetId is re-derived fresh
 *  every call from a live scan, never trusted across ticks, so a target that died or
 *  disconnected between calls simply doesn't come back from findNearestVisibleEnemy.
 *
 *  Issue #32 carrier survival: with NO player target, the bot shoots the nearest
 *  attackable enemy base turret (perception.ts's findAttackableTurret -- plasma/sentry
 *  barrels only, standing, powered, in range, LOS) via combat.ts's aimAtPoint. The
 *  probes that motivated the #32 capture work measured ~70% of all carrier chip damage
 *  landing inside an enemy plasma turret's envelope -- the deck approach and the first
 *  hundred metres of the return walk home, exactly where every carrier must survive.
 *  `targetId` stays null (a turret is not a BotState target), so the caller keys the
 *  aim decision off `aiming` instead: true whenever this tick has a real aim solution,
 *  player OR structure.
 *
 *  Issue #32 escort priority and carrier fire discipline (the COMBAT slice, wired here):
 *  the player branch takes combat.ts's selectCombatTarget, which swaps a nearest-enemy
 *  pick for the enemy threatening the teammate carrier whenever this bot is escorting
 *  one, and the turret branch is gated by combat.ts's carrier hold-fire envelope so a
 *  carrying bot never pivots onto a structure it will not shoot. The player branch is
 *  deliberately NOT gated here: an ablation over four seeds measured that gating it cost
 *  35 kills (69 against 104 with the gate removed) and bought nothing -- zero extra
 *  carrier arrivals, zero refused ticks, and a flat both-flags share -- by keeping
 *  carriers out of fights they could win. What remains is combat.ts's trigger-level
 *  backstop, which holds a carrier's fire beyond CARRIER_FIRE_RANGE_M while letting it
 *  keep engaging: an aim solution is also a steering command (the caller composes
 *  `yaw = aiming ? combat.yaw : move.headingYaw`), so the backstop is about the route the
 *  carrier walks, and the fall-through reports `aiming: false` rather than a synthesized
 *  yaw -- a stale yaw would freeze the carrier on a fixed bearing while the route turned
 *  underneath it. */
export function decideCombat(
  world: World,
  runtime: BotRuntimeState,
): {
  yaw: number;
  pitch: number;
  fire: boolean;
  targetId: number | null;
  weaponId: WeaponId | null;
  aiming: boolean;
} {
  const targetId = selectCombatTarget(world, runtime.playerId);
  if (targetId !== null && !isOutsideDefendLeash(world, runtime, targetId)) {
    const { yaw, pitch, fire, weaponId } = aimAndFire(world, runtime, runtime.playerId, targetId);
    return { yaw, pitch, fire, targetId, weaponId, aiming: true };
  }
  runtime.engagedTargetId = -1;
  const turret = findAttackableTurret(world, runtime.playerId);
  if (turret !== null && !carrierHoldsFireOnPoint(world, runtime.playerId, turret.position)) {
    const { yaw, pitch, fire, weaponId } = aimAtPoint(
      world,
      runtime,
      runtime.playerId,
      turret.position,
    );
    return { yaw, pitch, fire, targetId: null, weaponId, aiming: true };
  }
  return {
    yaw: runtime.aimYaw,
    pitch: 0,
    fire: false,
    targetId: null,
    weaponId: null,
    aiming: false,
  };
}

/** Direct sim call, not a queued wire message (Global Constraints) -- a bot server-side
 *  has no socket, and a station-use decision is a one-shot state change exactly like a
 *  human's own Loadout request, just triggered from here instead of a decoded message.
 *
 *  Codex review round 2, finding (P2): this range check used X/Z only, while the real
 *  gate (baseObjects.ts's stationAt, called internally by applyLoadoutSelection) checks
 *  full 3D distance -- see findNearestFriendlyStation's own comment (perception.ts).
 *
 *  Issue #32 carrier survival: the request is now the full #55 selection form and asks
 *  for the ENERGY PACK (+0.15/tick recharge on top of the armor's own -- movement.ts's
 *  ENERGY_PACK_RECHARGE_BONUS) whenever the bot is not carrying a Repair Pack. The sim
 *  has no passive self-heal -- the repair beam explicitly skips the holder
 *  (repair.ts's findDamagedPlayerCandidate) -- so the only health recovery between
 *  stations is not taking damage, and sustained energy is what buys that: fall arrest,
 *  climb jets on the deck approaches, and the jet-escape ladder all drain the pool a
 *  pack-less carrier cannot refill. A bot on a Repair order keeps its pack (the
 *  `hasRepairPack` passthrough below); everyone else converts every station visit --
 *  opportunistic (walked past) or chased (decideHealGoal) -- into the recharge economy.
 *
 *  Issue #32 gear-up: the request condition is ALSO "no pack at all", not just the
 *  health/energy floors -- a pack-less full-bar bot standing in radius previously
 *  requested nothing (needsHealing false). A dedicated walk-to-a-station gear goal was
 *  tried and REJECTED (see decideGoal's comment); what survives is this request side:
 *  the selection is a pure upgrade for a pack-less bot, so any bot that legitimately
 *  reaches a station converts the visit into full bars plus the recharge pack. */
function maybeHeal(world: World, botId: number): void {
  const hasPack =
    world.players.hasRepairPack[botId] === 1 || world.players.hasEnergyPack[botId] === 1;
  if (!needsHealing(world, botId) && hasPack) return;
  if (friendlyStationInUseRange(world, botId) === null) return;
  applyLoadoutSelection(
    world,
    botId,
    world.players.armor[botId] as ArmorId,
    world.players.hasRepairPack[botId] === 1 ? PackId.Repair : PackId.Energy,
    0,
  );
}

/** The id of the nearest usable friendly station actually within STATION_USE_RADIUS of
 *  the bot (full 3D -- baseObjects.ts's stationAt gate), or null. The shared range gate
 *  for both station requests: maybeHeal's opportunistic heal/gear-up and a Repair
 *  order's equip (maybeEquipRepairPack). Split out so each caller stays under the lint
 *  complexity cap -- the per-axis nullish reads alone are six branches. */
function friendlyStationInUseRange(world: World, botId: number): number | null {
  const stationId = findNearestFriendlyStation(world, botId);
  if (stationId === null) return null;
  const base = botId * 3;
  const stationBase = stationId * 3;
  const dx = (world.players.position[base] ?? 0) - (world.baseObjects.position[stationBase] ?? 0);
  const dy =
    (world.players.position[base + 1] ?? 0) - (world.baseObjects.position[stationBase + 1] ?? 0);
  const dz =
    (world.players.position[base + 2] ?? 0) - (world.baseObjects.position[stationBase + 2] ?? 0);
  if (Math.hypot(dx, dy, dz) > STATION_USE_RADIUS) return null;
  return stationId;
}

/** Split out of stepBot to keep its own cyclomatic complexity under the lint cap -- both
 *  branch on the same "is this a Repair order" question stepBot's Repair-Pack handling
 *  needs twice (once to trigger the equip attempt, once to report packActive). */
function isRepairOrder(order: TeamOrder | null): order is TeamOrder {
  return order?.kind === OrderKind.Repair;
}

function isOwnRepairOrder(
  world: World,
  runtime: BotRuntimeState,
  order: TeamOrder | null,
): boolean {
  return isRepairOrder(order) && order.team === (world.players.team[runtime.playerId] ?? 0);
}

function applyRepairOrder(world: World, runtime: BotRuntimeState, order: TeamOrder | null): void {
  if (isOwnRepairOrder(world, runtime, order)) maybeEquipRepairPack(world, runtime.playerId);
}

function repairPackActive(
  world: World,
  runtime: BotRuntimeState,
  order: TeamOrder | null,
): boolean {
  return (
    isOwnRepairOrder(world, runtime, order) && world.players.hasRepairPack[runtime.playerId] === 1
  );
}

export function stepBot(
  world: World,
  graph: WaypointGraph,
  runtime: BotRuntimeState,
  order: TeamOrder | null,
): PlayerInput {
  maybeHeal(world, runtime.playerId);
  applyRepairOrder(world, runtime, order);
  const goal = decideGoal(world, runtime, order);
  const combat = decideCombat(world, runtime);
  // Issue #32 vehicles: a bot in a vehicle DRIVES it. Before this branch existed nothing in
  // the brain knew a bot was mounted, so a riding bot kept emitting walking input -- which a
  // vehicle reads as throttle and steer -- and kept pathing on foot. The craft steers toward
  // an absolute heading (`applyHoverSteering`, the flyer controller), so the drive input is
  // the bearing to the goal plus throttle, and `use` is the dismount once it is close enough
  // to walk the rest.
  if ((world.players.mountedVehicleId[runtime.playerId] ?? -1) !== -1) {
    const drive = driveInputFor(world, runtime.playerId, goal.position);
    runtime.aimYaw = drive.yaw;
    runtime.state = decideState(runtime, combat.targetId);
    return drivingInput(world, runtime, goal.position, combat);
  }
  const armor = armorFor(world, runtime.playerId);
  const energy = world.players.energy[runtime.playerId] ?? 0;
  const team = world.players.team[runtime.playerId] ?? 0;
  const currentPosition = playerPoint(world, runtime.playerId);
  const move = steerToward(
    graph,
    world,
    team,
    runtime,
    runtime.playerId,
    goal.position,
    goal.key,
    currentPosition,
    armor,
    energy,
  );
  // `aiming` (decideCombat) covers player AND structure aim solutions -- a turret target
  // keeps targetId null for decideState, so the yaw must key off `aiming`, not targetId.
  const yaw = combat.aiming ? combat.yaw : move.headingYaw;
  runtime.aimYaw = yaw;
  runtime.state = decideState(runtime, combat.targetId);
  return walkingInput(world, runtime, order, move, combat, yaw);
}

/** The input a walking bot sends: the steering solution plus the combat decision, with the
 *  mounting bit and the pack trigger the two callers below decide. Split out of stepBot
 *  alongside drivingInput to keep that function inside the lint's complexity budget. */
function walkingInput(
  world: World,
  runtime: BotRuntimeState,
  order: TeamOrder | null,
  move: { moveX?: number; moveZ?: number; jump?: boolean; jet?: boolean },
  combat: ReturnType<typeof decideCombat>,
  yaw: number,
): PlayerInput {
  return {
    moveX: move.moveX ?? 0,
    moveZ: move.moveZ ?? 0,
    yaw,
    pitch: combat.pitch,
    jump: move.jump ?? false,
    jet: move.jet ?? false,
    fire: combat.fire,
    altFire: false,
    // Codex review round 2, finding (P2): chooseWeapon (combat.ts) picked a real weapon by
    // range, but stepBot always sent slot: 0 ("no change" -- weapons.ts's own applySlot),
    // so every bot fired whatever it happened to already have equipped (the Blaster,
    // never switched away from at spawn) regardless of what combat.ts decided. weaponIdForSlot's
    // own inverse (slot = weaponId + 1, since slot 0 means "no change" and slots 1-5 map to
    // WeaponId 0-4) is the same mapping a human's weapon-select key press uses. No target
    // -> 0 (no change): weapon choice is only meaningful relative to an engagement distance.
    slot: combat.weaponId !== null ? combat.weaponId + 1 : 0,
    packActive: repairPackActive(world, runtime, order),
    // Real PlayerInput.use is a required field (M5, packages/sim/src/types.ts:23). Never a
    // queued wire message -- see Global Constraints on why mounting is a PlayerInput bit,
    // not a direct sim call: shouldUseVehicle re-checks range/occupancy fresh every tick and
    // stepVehicles itself edge-detects the bit, so holding this true for several consecutive
    // ticks still mounts exactly once, the same as a human holding E.
    use: shouldUseVehicle(world, runtime, runtime.playerId),
  };
}

/** The input a mounted bot sends: the craft steers toward an absolute heading, so this is the
 *  drive solution plus the combat decision it can still act on. Split out of stepBot to keep
 *  that function inside the lint's complexity budget. */
function drivingInput(
  world: World,
  runtime: BotRuntimeState,
  goal: Vec3,
  combat: ReturnType<typeof decideCombat>,
): PlayerInput {
  const drive = driveInputFor(world, runtime.playerId, goal);
  return {
    moveX: 0,
    moveZ: drive.moveZ,
    yaw: drive.yaw,
    // Level, with jets only to climb to a goal that is above the craft (see driveInputFor):
    // a flag stand sits on a base deck about 21 m up, which is the one vertical move the
    // controller needs to make a run reachable.
    pitch: 0,
    jump: false,
    jet: drive.jet,
    fire: combat.fire,
    altFire: false,
    slot: combat.weaponId !== null ? combat.weaponId + 1 : 0,
    // A driver runs no Repair Pack: the pack is a walking action, and the vehicle's own
    // repair rules are the sim's business.
    packActive: false,
    use: drive.use,
  };
}

/** `orders` is keyed by team, each value the team's already-expiry-resolved current order
 *  (or null) -- resolving `OrderBoard`/`currentOrder` is server's job (`@clans/server`'s
 *  `orders.ts`), not bots'. `@clans/bots` depends only on `@clans/sim` and `@clans/protocol`
 *  today, never on `@clans/server` (that dependency runs the other way), so it consumes the
 *  `TeamOrder` shape but never the server-side `OrderBoard`/`currentOrder` that produce it. */
export function stepBots(
  world: World,
  graph: WaypointGraph,
  runtimes: Map<number, BotRuntimeState>,
  orders: Map<number, TeamOrder | null>,
): Map<number, PlayerInput> {
  const inputs = new Map<number, PlayerInput>();
  for (const [botId, runtime] of runtimes) {
    if (!world.players.active[botId] || !world.players.alive[botId]) continue;
    const team = world.players.team[botId] ?? 0;
    inputs.set(botId, stepBot(world, graph, runtime, orders.get(team) ?? null));
  }
  return inputs;
}
