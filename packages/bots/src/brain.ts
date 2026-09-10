import {
  applyLoadoutSelection,
  armorFor,
  FlagState,
  PackId,
  STATION_USE_RADIUS,
  type ArmorId,
  type PlayerInput,
  type Vec3,
  type WeaponId,
  type World,
} from '@clans/sim';
import { OrderKind, type TeamOrder } from '@clans/protocol';
import { aimAndFire, aimAtPoint } from './combat.js';
import {
  findAttackableTurret,
  findCarrierHealStation,
  findEnemyFlagCarrier,
  findEscortedCarrier,
  findNearestFriendlyStation,
  findNearestVisibleEnemy,
  LOW_HEALTH_FRACTION,
  needsHealing,
} from './perception.js';
import { steerToward } from './steering.js';
import { BotRole, BotState, type BotRuntimeState } from './types.js';
import { decideVehicleGoal, shouldUseVehicle } from './vehicles.js';
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

/** Attacker: carrying the enemy flag -> head home (backing off to regroup when a close
 *  threat has no friendly answer nearby -- carrierShouldRegroup above); otherwise -> head
 *  to the enemy flag wherever it currently is (home, dropped, or being carried by a
 *  teammate you're about to catch up to and pass, which is fine -- there's nothing wrong
 *  with two teammates converging on the same flag). */

function decideAttackerGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } {
  const team = world.players.team[runtime.playerId] ?? 0;
  const ownId = ownFlagId(world, team);
  const enemyId = enemyFlagId(world, team);
  if (world.flags.carrierId[enemyId] === runtime.playerId) {
    const home = flagStandPosition(world, ownId);
    if (carrierShouldRegroup(world, runtime)) {
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
        key: `home:${String(ownId)}`,
      };
    }
    return { position: home, key: `home:${String(ownId)}` };
  }
  return { position: flagPosition(world, enemyId), key: `enemyFlag:${String(enemyId)}` };
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

/** The escort's goal: the close screen-ahead hold point (escortPoint) once it is within
 *  ESCORT_CATCHUP_M of the carrier, or -- while it is still far away -- the point ahead
 *  of the carrier along the straight route to the home stand (clamped to the stand
 *  itself on the final approach). A carrier below CARRIER_CLOSE_HEALTH pulls the point
 *  in to ESCORT_CLOSE_M so the escort stops pacing and closes. Same `escort:<id>` goal
 *  key either way, so steering's drift repathing keeps following the moving point
 *  exactly as before. */
function escortGoal(world: World, runtime: BotRuntimeState, carrierId: number): Vec3 {
  const carrier = playerPoint(world, carrierId);
  const me = playerPoint(world, runtime.playerId);
  const gap = Math.hypot(me.x - carrier.x, me.z - carrier.z);
  if (gap <= ESCORT_CATCHUP_M) return escortPoint(world, runtime, carrierId);
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

/** True when the bot is the enemy-flag carrier. The carry is time-critical (the moment
 *  it dies the flag drops and a return timer starts), so a carrier's heal behavior is
 *  deliberately different from everyone else's: full cross-map heal chases walked
 *  carriers backwards off their return route (observed carriers bouncing mid-map for
 *  10k+ ticks between heal goals at under half the distance home they had already
 *  covered), but NO heal at all let attrition kill them 100 m from home -- see
 *  decideHealGoal's bounded carrier detour. */
function isCarryingEnemyFlag(world: World, runtime: BotRuntimeState): boolean {
  const team = world.players.team[runtime.playerId] ?? 0;
  return world.flags.carrierId[enemyFlagId(world, team)] === runtime.playerId;
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

function decideHealGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } | null {
  const armor = armorFor(world, runtime.playerId);
  const health = 1 - (world.players.damage[runtime.playerId] ?? 0) / armor.maxDamage;
  const carrying = isCarryingEnemyFlag(world, runtime);
  if (health >= healGateFor(carrying)) {
    resetHealChase(runtime);
    return null;
  }
  const team = world.players.team[runtime.playerId] ?? 0;
  if (carrying) forgiveHealCooldown(world, runtime);
  const stationId = carrying
    ? findCarrierHealStation(
        world,
        runtime.playerId,
        flagStandPosition(world, ownFlagId(world, team)),
        CARRIER_HEAL_MAX_MARGINAL_M,
      )
    : findNearestFriendlyStation(world, runtime.playerId);
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
// Top up earlier than the bare LOW_HEALTH_FRACTION line: the carrier's job (survive to
// the stand) dies to attrition, so the refill must happen while there is health to save.
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
  if (world.flags.state[ownFlagId(world, team)] !== FlagState.Home) return true;
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
 *  player OR structure. */
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
  const targetId = findNearestVisibleEnemy(world, runtime.playerId);
  if (targetId !== null && !isOutsideDefendLeash(world, runtime, targetId)) {
    const { yaw, pitch, fire, weaponId } = aimAndFire(world, runtime, runtime.playerId, targetId);
    return { yaw, pitch, fire, targetId, weaponId, aiming: true };
  }
  runtime.engagedTargetId = -1;
  const turret = findAttackableTurret(world, runtime.playerId);
  if (turret !== null) {
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
  const combat = decideCombat(world, runtime);
  // `aiming` (decideCombat) covers player AND structure aim solutions -- a turret target
  // keeps targetId null for decideState, so the yaw must key off `aiming`, not targetId.
  const yaw = combat.aiming ? combat.yaw : move.headingYaw;
  runtime.aimYaw = yaw;
  runtime.state = decideState(runtime, combat.targetId);
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
