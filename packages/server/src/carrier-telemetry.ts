import { armorFor, FIXED_DT, FlagState, PICKUP_RADIUS, type World } from '@clans/sim';

/**
 * Issue #32 carrier telemetry: what actually happens to a flag carrier between the enemy
 * stand and its own.
 *
 * The acceptance harness measures kills, flag touches, and stall windows, and those three
 * numbers cannot tell the two candidate explanations for a zero-capture match apart:
 *
 *   1. carriers die on the ~1 km walk home (turrets, roaming enemies, fall damage), or
 *   2. carriers arrive at their own stand and are REFUSED, because `ownFlagHome`
 *      (packages/sim/src/flags.ts) refuses a capture while the carrier's own flag is out.
 *
 * This module measures both directly. Every quantity is read from world state on the tick
 * it happens -- nothing is inferred, sampled, or extrapolated.
 *
 * Shape: pure functions over the world plus one caller-owned accumulator. `sample` advances
 * one tick, `finish` closes whatever is still open and returns the summary. No module-level
 * state, so two matches (or two seeds) can be measured side by side in one process.
 */

/** How a carrier run ended.
 *
 *  `flag returned` is the drop/return path: the flag left the carrier's hands without a
 *  capture and without the carrier dying -- a disconnect or rebalance drop
 *  (dropFlagsCarriedBy in packages/server/src/world.ts), a carrier id removed mid-run, or
 *  the sim returning the flag under a living player (net.ts's unkill). `endFlagState`
 *  separates the already-Home case from the Dropped-with-return-timer-armed one.
 *
 *  `matchEnd` closes a run whose carrier was still holding the flag when the harness
 *  stopped ticking: an open run is not a finished one, and calling it anything else would
 *  invent an ending that never happened. */
export type CarrierRunEnd = 'captured' | 'died' | 'flag returned' | 'matchEnd';

/** The "same fight" envelope for the death-context counts, ours (not sourced). A
 *  proximity bucket, NOT a weapon-reach claim: the Laser Rifle reaches 1000 m
 *  (WEAPON_DATA.maxRange), so a neighbour inside this radius was not necessarily shooting
 *  at the carrier. It is wide enough to catch an interceptor at the edge of a base deck
 *  and narrow enough that a bot on the far side of the base is not counted as company. */
const NEARBY_RADIUS_M = 100;

/** Escort sampling cadence, ours: 60 ticks = 1.92 s at the sim's 32 ms fixed tick. The
 *  death-context counts answer "who was there at the instant it died"; this cadence is the
 *  same question asked through the whole run, so an escort that was never there is
 *  distinguishable from one that had been scattered by the time the carrier died. */
const ESCORT_SAMPLE_TICKS = 60;

/** An "encounter", ours: a tick on which the nearest live enemy is inside this 3D radius
 *  after the previous tick had none inside it. 50 m is a small fraction of the Laser
 *  Rifle's 1000 m reach on purpose: this is the envelope in which an interceptor can bring
 *  its own body into the fight, not the envelope in which it can shoot. */
const ENCOUNTER_RADIUS_M = 50;

/** Net route progress, ours: 1 m of improvement in the carrier's distance to its own
 *  stand. The same figure the bots' own stuck check uses as STUCK_MIN_PROGRESS
 *  (packages/bots/src/steering.ts) -- smaller than any real travel between two ticks
 *  (Light run speed is 15 m/s, 0.48 m/tick) and larger than the drift of a body pressed
 *  against a wall. */
const PROGRESS_MIN_M = 1;

/** Stall window, ours: 60 ticks, the bots' own STUCK_CHECK_TICKS. A tick counts as
 *  stalled when this many ticks have passed since the carrier last brought its
 *  distance-to-own-stand down by PROGRESS_MIN_M. That is deliberately stricter than the
 *  bots' own detector, which only asks whether the body moved 1 m at all and therefore
 *  cannot see a bot sliding laterally along a wall it is stuck against (#32). */
const STALL_CHECK_TICKS = 60;

/** Who a credited killer was to the carrier. Four classes, not two: scoreForDeath also
 *  gives a SELF-kill its own -10 branch (attackerId === victimId), so folding self-kills in
 *  with teamkills would misreport a carrier killed by its own splash. `unattributed` also
 *  covers an id on neither real team (never joined, or already removed), which is not a
 *  side we can name rather than a fifth kind of kill. */
export type KillerRelation = 'enemy' | 'teammate' | 'self' | 'unattributed';

/** How close the fight around a carrier was when it died, and who was credited. Recorded
 *  on the death tick from the live player store, so it is a snapshot of who was actually
 *  standing nearby, not a reconstruction. */
export interface CarrierDeathContext {
  /** The credited killer, -1 when nobody was credited (fall damage, kill plane, turret
   *  shot). Same source as CarrierRun.killerId. */
  killerId: number;
  /** The killer's team, or -1 when unattributed. */
  killerTeam: number;
  /** The killer's side relative to the carrier. `scoreForDeath` credits an enemy kill at
   *  +10, a teamkill at -10 and a self-kill at -10, so a credited attacker id is not by
   *  itself evidence of enemy contact -- this field is. */
  killerRelation: KillerRelation;
  /** 3D distance from the carrier's death position to the credited killer, -1 when
   *  unattributed. Read this next to `enemiesWithin100m`: the Laser Rifle reaches 1000 m
   *  (WEAPON_DATA.maxRange), so a carrier can die to a killer far outside the 100 m
   *  envelope, and the two fields together are what separate a lone close interceptor from
   *  a shooter standing off at range. */
  killerDistanceM: number;
  /** Live enemies (active, alive, other team) within NEARBY_RADIUS_M of the death. */
  enemiesWithin100m: number;
  /** Live teammates (active, alive, same team) within NEARBY_RADIUS_M of the death. */
  teammatesWithin100m: number;
}

/** Which half of a run a tick belongs to. `away` is the outbound half -- pickup to the
 *  run's farthest excursion from the carrier's own stand -- and `home` is everything after
 *  that turn. A clean pickup happens AT the enemy stand, which is normally the farthest
 *  point of the run, so the away leg is one tick and the home leg is the whole walk; the
 *  split stops being trivial exactly when a run was picked up mid-field (a dropped flag) or
 *  the carrier was turned around and pushed back toward the enemy base. */
export type CarrierRunLeg = 'away' | 'home';

/** Escort presence over a run or over one of its legs, sampled every ESCORT_SAMPLE_TICKS.
 *  `medianM` is null when the leg held no sample at all (an empty leg), which is not the
 *  same measurement as "no teammate anywhere". */
export interface CarrierEscortSample {
  samples: number;
  medianM: number | null;
  /** Share of samples with NO live teammate within NEARBY_RADIUS_M (a null sample -- no
   *  live teammate anywhere -- counts as absent). 0 when there were no samples. */
  absentFraction: number;
  /** Share of samples with NO live teammate anywhere. The rest of the absence is a
   *  teammate who is alive but more than NEARBY_RADIUS_M away, and the two need different
   *  fixes -- a broken escort formation versus a teammate who was dead -- so they are
   *  counted apart. 0 when there were no samples. */
  noTeammateFraction: number;
}

/** One leg's own numbers. Ticks/distance/speed are the run's, partitioned at the turn; the
 *  escort sample and encounter counts are the events that fell inside the leg. */
export interface CarrierRunLegMetrics {
  ticks: number;
  /** Σ per-tick carrier displacement on this leg, metres (3D). */
  distanceM: number;
  /** distanceM / (ticks * FIXED_DT); 0 on an empty leg. */
  meanSpeedMps: number;
  encounters: number;
  escort: CarrierEscortSample;
}

/** Where the carrier stood against its own route when the run ended -- the stall evidence
 *  a kill count cannot show. Two different failures look alike in a death tally: a carrier
 *  shot down while running, and a carrier pressed against a wall making no progress until
 *  something eventually killed it. These four numbers separate them for every ending,
 *  including the runs that ended with nobody dying at all. */
export interface CarrierRunEndState {
  /** Ticks since the carrier last improved its best distance-to-own-stand by
   *  PROGRESS_MIN_M. 0 means the last tick of the run was still making ground. */
  ticksSinceProgress: number;
  /** Ticks of the run on which a full STALL_CHECK_TICKS window had passed with no such
   *  improvement -- net route stall, not the bots' own displacement check. */
  stalledTicks: number;
  /** The player store's own onGround flag on the end tick (Uint8Array 1 -> true). A carrier
   *  stalled against a wall is standing, not falling or skiing. */
  onGround: boolean;
  /** Distance from the end position to the nearest interior collider's bounding box, from
   *  the InteriorInstance.bounds AABB raycastInteriors (interiors.ts) itself tests against.
   *  Read directly rather than cast, because occlusion.ts exposes only a boolean segment
   *  test and no distance. Infinity only in a world built with no interiors. */
  interiorDistanceM: number;
  /** The carrier's last per-tick speed (displacement / FIXED_DT). Fast + no progress is the
   *  wall-slide signature; slow + no progress is a body that has given up or is pinned. */
  speedMps: number;
  /** The player store's own velocity magnitude on the end tick. Read next to speedMps: on a
   *  death tick the body can be moving at full speed while its committed displacement is
   *  short (a collision response, a wall), and the store's velocity is what the sim actually
   *  had at the moment the run ended. */
  velocityMps: number;
}

export interface CarrierRun {
  carrierId: number;
  team: number;
  /** The carried flag's own id (the enemy of `team`). */
  flagId: number;
  pickupTick: number;
  endTick: number;
  endReason: CarrierRunEnd;
  /** The killer's player id, or -1 when nobody was credited: fall damage, the kill plane,
   *  or a turret shot (projectiles.ts spawns turret shots with ownerId -1, the same
   *  unattributed convention fall damage uses), and also -1 on a run that did not end in a
   *  death. Read from `world.pendingDeaths`, which movement.ts's stepPlayers clears at the
   *  START of each stepWorld call and the rest of that same call refills, so after a
   *  stepWorld returns it holds exactly that tick's deaths; a harness that samples after
   *  stepWorld therefore sees the death on its own tick. */
  killerId: number;
  /** Populated only when `endReason` is 'died'; null on every other ending. `runTicks` at a
   *  death is, by construction, the ticks since pickup, so it is not duplicated here. */
  death: CarrierDeathContext | null;
  /** Closest 3D approach any live teammate made to the carrier during the run, or null if
   *  the carrier was never within a world where a teammate existed. The escort screen's
   *  whole claim is that teammates stay near the carrier (ESCORT_AHEAD_M 100 and friends),
   *  and this is the number that says whether they ever were. */
  closestTeammateM: number | null;
  endFlagState: FlagState;
  /** 1 = untouched, 0 = dead. Computed as `1 - damage/maxDamage` from the carrier's own
   *  armor datablock, the same expression every HUD consumer uses. */
  endHealthFraction: number;
  /** The carrier's armor energy on the end tick, in armor units (LIGHT's max is 60). */
  endEnergy: number;
  /** Health lost on the end tick alone. A fall or impact death lands as one large drop
   *  (applyFallDamage applies the whole chunk at once); an accumulated turret death is a
   *  small final chip. Both record killerId -1, so this is what separates the two
   *  unattributed causes in the aggregate. */
  endDamage: number;
  /** Closest 3D approach to the carrier's own stand over the run -- the same 3D metric
   *  flags.ts's own `distance()` uses for the 2 m capture radius. Seeded at the pickup
   *  position, so a run that never gets a follow-up tick still has a real number here
   *  rather than Infinity. */
  closestApproachM: number;
  /** Closest horizontal approach to that same stand. A carrier can walk the base at deck
   *  level or in the basement under it; the 3D metric alone cannot say which happened. */
  closestApproach2dM: number;
  /** Ticks of the run spent inside PICKUP_RADIUS (2 m, 3D) of its own stand. */
  radiusTicks: number;
  /** Of `radiusTicks`, those on which the carrier's own flag was Home -- the only ticks on
   *  which a capture was possible at all. `radiusTicks - radiusTicksOwnFlagHome` is exactly
   *  the refused-tick count, the failure matrix row 3 state. */
  radiusTicksOwnFlagHome: number;
  /** Ticks of the run on which the carrier's own flag was Home, wherever the carrier was. */
  ownFlagHomeTicks: number;
  /** Ticks the carrier held the flag (the run's own length in ticks). */
  runTicks: number;
  /** Σ of the run's per-tick carrier displacement, metres, 3D (a Katabatic run covers real
   *  vertical distance, and fall arrest is part of the route). `distanceM / (runTicks *
   *  FIXED_DT)` is the run's average pace. */
  distanceM: number;
  /** Mean ground speed over the run: distanceM / (runTicks * FIXED_DT). */
  meanSpeedMps: number;
  /** 90th-percentile per-tick speed. A mean dragging under the p90 says the carrier spent
   *  the run slow or stopped; the two moving together says the carrier was fast the whole
   *  way and still lost. */
  p90SpeedMps: number;
  /** Distance to the carrier's own stand on the pickup tick -- where the run started from,
   *  which is the enemy stand on a clean take and mid-field on a dropped-flag recovery. */
  pickupStandDistanceM: number;
  /** Distance to that stand on the end tick, next to closestApproachM: how far the run got
   *  and how much of it was left. */
  endStandDistanceM: number;
  /** Distance from the end position to the ENEMY stand the flag was taken from. On a
   *  death, this is the pickup-to-exit question: a small number means the carrier died on
   *  the enemy deck right after the take, a large one means it died out in the open. */
  endEnemyStandDistanceM: number;
  /** Absolute tick of the run's farthest excursion from its own stand (ties resolve to the
   *  earliest). The leg split's turn point. */
  turnTick: number;
  /** Which leg the run ended on: `away` means the carrier never got back inside its own
   *  outbound trace, `home` means it had turned for home and then stopped. */
  endLeg: CarrierRunLeg;
  /** The run's own legs, split at turnTick; together they account for every tick. */
  legs: { away: CarrierRunLegMetrics; home: CarrierRunLegMetrics };
  /** Enemy-within-ENCOUNTER_RADIUS_M episodes over the whole run (see ENCOUNTER_RADIUS_M
   *  for the rising-edge rule). */
  encounterCount: number;
  /** The carrier's speed (m/s) on the tick each encounter began, oldest first. */
  encounterSpeedsMps: number[];
  /** Carrier energy at pickup, armor units (LIGHT's max is 60). Read next to endEnergy:
   *  a carrier that arrives drained spent its budget on the route; one that arrives full
   *  never needed it. */
  startEnergy: number;
  /** Ticks of the run on which the nearest live enemy was inside ENCOUNTER_RADIUS_M. The
   *  encounters above count episodes; this counts exposure, which is what separates "a
   *  carrier milling on its own" from "a carrier being run down for half a minute". */
  enemyNearTicks: number;
  /** Escort presence over the whole run: the median nearest-live-teammate distance at the
   *  ESCORT_SAMPLE_TICKS cadence, and the share of samples with nobody within 100 m. */
  escort: CarrierEscortSample;
  /** Route progress, ground contact, interior proximity and last speed at the end tick. */
  endRoute: CarrierRunEndState;
  /** The carried flag's own state transitions during the run, oldest first: the pickup
   *  tick's Carried entry, then one entry per state change (Dropped on a death, Home on a
   *  capture, Dropped on a disconnect drop). */
  flagStateTimeline: Array<{ tick: number; state: FlagState }>;
}

export interface FlagStateTickShares {
  team: number;
  home: number;
  carried: number;
  dropped: number;
}

export interface MatchTelemetry {
  /** Ticks sampled. Every share and tick count below is a subset of this. */
  sampledTicks: number;
  runs: CarrierRun[];
  /** Runs whose carrier got inside PICKUP_RADIUS of its own stand -- the run-level form of
   *  "did anybody actually arrive?". */
  runsReachingRadius: number;
  /** Ticks spent inside the capture radius with the carrier's own flag NOT Home. Nonzero
   *  here is the refusal blocker; it is invisible to kill/touch/stall accounting. */
  refusedTicks: number;
  /** Index 0 = team 1, index 1 = team 2 (the world's own team numbering). */
  capturesPerTeam: [number, number];
  /** Per flag (its `team` field names the team that owns it). */
  flagStateTicks: FlagStateTickShares[];
  /** Ticks on which BOTH flags were Carried at once: the capture deadlock itself, since
   *  neither side can score while its own flag is out. */
  bothFlagsCarriedTicks: number;
  /** Σ runTicks over every CLOSED run: the ticks any carrier held a flag. The denominator
   *  for carrierStallTicks, and the honest size of the carrier population's exposure. */
  carrierTicks: number;
  /** Σ run.endRoute.stalledTicks: ticks a carrier held the flag while a full
   *  STALL_CHECK_TICKS window had passed with no net progress toward its own stand. This is
   *  the carrier-side share of what #32's acceptance is about -- bots that do not advance
   *  rather than bots that cannot fight. */
  carrierStallTicks: number;
}

/** One run still in progress. Same fields as CarrierRun plus the per-tick bookkeeping the
 *  summary does not keep (previous damage sample, previous flag state). */
interface ActiveCarrierRun {
  carrierId: number;
  team: number;
  flagId: number;
  pickupTick: number;
  closestApproachM: number;
  closestApproach2dM: number;
  closestTeammateM: number | null;
  radiusTicks: number;
  radiusTicksOwnFlagHome: number;
  ownFlagHomeTicks: number;
  runTicks: number;
  lastDamage: number;
  lastFlagState: FlagState;
  endDamage: number;
  lastNearby: NearbyPlayers;
  /** Per-tick series, indexed by `run.runTicks` at the time of the sample (0 = the pickup
   *  tick): carrier displacement that tick and the carrier's own stand distance. The leg
   *  partition in `runRecord` slices both. */
  tickDistancesM: number[];
  tickStandDistancesM: number[];
  /** Escort samples (run-tick index and the nearest live teammate at that tick, null when
   *  the carrier had no live teammate at all). */
  escortSampleIndex: number[];
  escortSampleM: Array<number | null>;
  /** Encounter episodes: the run-tick index each began on, and the carrier's speed there. */
  encounterIndex: number[];
  encounterSpeedsMps: number[];
  /** Nearest live enemy distance on the previous tick, for the encounter rising edge. */
  lastClosestEnemyM: number | null;
  /** Ticks with the nearest live enemy inside ENCOUNTER_RADIUS_M (episode count is derived
   *  from `encounterIndex`; this is the exposure the episodes cover). */
  enemyNearTicks: number;
  /** Position after the previous sample, for this tick's displacement. */
  lastPosition: [number, number, number];
  startEnergy: number;
  flagStateTimeline: Array<{ tick: number; state: FlagState }>;
}

export interface CarrierTelemetry {
  /** Runs that have ENDED, in end order. A run still in progress lives in `active` only --
   *  it joins this list when it closes (by any of the four reasons, including matchEnd). */
  runs: CarrierRun[];
  active: Map<number, ActiveCarrierRun>;
  flagStateTicks: FlagStateTickShares[];
  lastTeamScore: [number, number];
  sampledTicks: number;
  bothFlagsCarriedTicks: number;
  /** The three match-level counters below are accumulated per TICK (and, for captures, at
   *  the close it happens on) rather than derived from `runs` at summary time, so a
   *  mid-match summary reports what has happened so far instead of only what has already
   *  ended -- which for a run still in progress is exactly the interesting half. */
  runsReachingRadius: number;
  refusedTicks: number;
  capturesPerTeam: [number, number];
  /** Total ticks any run spent carrying, and how many of those were stall ticks (a full
   *  `STALL_CHECK_TICKS` window with no net progress toward the carrier's own stand). The
   *  denominator and the numerator of the stall share the sweep prints, accumulated per tick
   *  so a run still in progress is counted rather than only the runs that have ended. */
  carrierTicks: number;
  carrierStallTicks: number;
}

export function createCarrierTelemetry(world: World): CarrierTelemetry {
  return {
    runs: [],
    active: new Map(),
    flagStateTicks: Array.from({ length: world.flags.team.length }, (_, flagId) => ({
      team: world.flags.team[flagId] ?? 0,
      home: 0,
      carried: 0,
      dropped: 0,
    })),
    lastTeamScore: [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0],
    sampledTicks: 0,
    bothFlagsCarriedTicks: 0,
    runsReachingRadius: 0,
    refusedTicks: 0,
    capturesPerTeam: [0, 0],
    carrierTicks: 0,
    carrierStallTicks: 0,
  };
}

/** A team's own flag id, or -1 in a world built without that team's stand. */
function ownFlagId(world: World, team: number): number {
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    if (world.flags.team[flagId] === team) return flagId;
  }
  return -1;
}

/** Mirrors flags.ts's private `ownFlagHome` -- the exact gate `tryCapture` refuses on. */
function isOwnFlagHome(world: World, team: number): boolean {
  const flagId = ownFlagId(world, team);
  return flagId >= 0 && world.flags.state[flagId] === FlagState.Home;
}

/** 3D and horizontal distance from player `base` to `team`'s own stand. */
function standDistance(world: World, team: number, base: number): { d3: number; d2: number } {
  const stand = ownFlagId(world, team) * 3;
  const dx = (world.players.position[base] ?? 0) - (world.flags.standPosition[stand] ?? 0);
  const dy = (world.players.position[base + 1] ?? 0) - (world.flags.standPosition[stand + 1] ?? 0);
  const dz = (world.players.position[base + 2] ?? 0) - (world.flags.standPosition[stand + 2] ?? 0);
  return { d3: Math.hypot(dx, dy, dz), d2: Math.hypot(dx, dz) };
}

/** Per-axis position gap from `fromId` to `toId`, for callers that need more than one
 *  distance from the same pair (3D and horizontal, say) without re-reading the store. */
function axisGaps(world: World, fromId: number, toId: number): [number, number, number] {
  const from = fromId * 3;
  const to = toId * 3;
  return [
    (world.players.position[from] ?? 0) - (world.players.position[to] ?? 0),
    (world.players.position[from + 1] ?? 0) - (world.players.position[to + 1] ?? 0),
    (world.players.position[from + 2] ?? 0) - (world.players.position[to + 2] ?? 0),
  ];
}

/** Which side a credited killer was on, or that there is no side to name. A match is team 1
 *  vs team 2, so an id on neither is `unattributed` -- the same bucket as no killer id at
 *  all, because neither names an opposing side. Deaths are checked in this order so a
 *  self-kill (its own -10 branch in scoreForDeath) can never be read as a teamkill. */
function killRelation(
  carrierId: number,
  team: number,
  killerId: number,
  killerTeam: number,
): KillerRelation {
  if (killerId < 0) return 'unattributed';
  if (killerId === carrierId) return 'self';
  if (killerTeam !== 1 && killerTeam !== 2) return 'unattributed';
  return killerTeam === team ? 'teammate' : 'enemy';
}

/** Who was standing near a carrier: how many live enemies and live teammates within
 *  NEARBY_RADIUS_M, and the closest of each at any range. One pass over the player store. */
interface NearbyPlayers {
  enemiesWithin100m: number;
  teammatesWithin100m: number;
  closestTeammateM: number | null;
  /** Nearest live non-teammate at any range; this is what the encounter detection reads. */
  closestEnemyM: number | null;
}

function nearbyPlayers(world: World, carrierId: number, team: number): NearbyPlayers {
  const nearby: NearbyPlayers = {
    enemiesWithin100m: 0,
    teammatesWithin100m: 0,
    closestTeammateM: null,
    closestEnemyM: null,
  };
  for (let id = 0; id < world.players.count; id += 1) {
    if (id === carrierId) continue;
    if (world.players.active[id] !== 1 || world.players.alive[id] !== 1) continue;
    const distance = Math.hypot(...axisGaps(world, carrierId, id));
    if (world.players.team[id] === team) {
      nearby.closestTeammateM =
        nearby.closestTeammateM === null ? distance : Math.min(nearby.closestTeammateM, distance);
      if (distance <= NEARBY_RADIUS_M) nearby.teammatesWithin100m += 1;
      continue;
    }
    nearby.closestEnemyM =
      nearby.closestEnemyM === null ? distance : Math.min(nearby.closestEnemyM, distance);
    if (distance <= NEARBY_RADIUS_M) nearby.enemiesWithin100m += 1;
  }
  return nearby;
}

function startRun(world: World, carrierId: number, flagId: number): ActiveCarrierRun {
  const team = world.players.team[carrierId] ?? 0;
  const { d3, d2 } = standDistance(world, team, carrierId * 3);
  const nearby = nearbyPlayers(world, carrierId, team);
  const base = carrierId * 3;
  return {
    carrierId,
    team,
    flagId,
    pickupTick: world.tick,
    closestApproachM: d3,
    closestApproach2dM: d2,
    closestTeammateM: nearby.closestTeammateM,
    radiusTicks: 0,
    radiusTicksOwnFlagHome: 0,
    ownFlagHomeTicks: 0,
    runTicks: 0,
    lastDamage: world.players.damage[carrierId] ?? 0,
    lastFlagState: FlagState.Carried,
    endDamage: 0,
    lastNearby: nearby,
    tickDistancesM: [],
    tickStandDistancesM: [],
    escortSampleIndex: [],
    escortSampleM: [],
    encounterIndex: [],
    encounterSpeedsMps: [],
    lastClosestEnemyM: null,
    enemyNearTicks: 0,
    lastPosition: [
      world.players.position[base] ?? 0,
      world.players.position[base + 1] ?? 0,
      world.players.position[base + 2] ?? 0,
    ],
    startEnergy: world.players.energy[carrierId] ?? 0,
    flagStateTimeline: [{ tick: world.tick, state: FlagState.Carried }],
  };
}

function recordFlagTick(share: FlagStateTickShares | undefined, flagState: FlagState): void {
  if (!share) return;
  if (flagState === FlagState.Carried) share.carried += 1;
  else if (flagState === FlagState.Dropped) share.dropped += 1;
  else share.home += 1;
}

/** Per-tick flag accounting, plus pickup detection: a flag in Carried state whose carrier
 *  has no open run starts one on this tick. Keyed by carrier id because a player can only
 *  ever carry one flag (`tryPickupOrReturn` never touches a flag already Carried). */
function sampleFlagStates(state: CarrierTelemetry, world: World): void {
  let carriedFlags = 0;
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    const flagState = world.flags.state[flagId] ?? FlagState.Home;
    recordFlagTick(state.flagStateTicks[flagId], flagState);
    if (flagState !== FlagState.Carried) continue;
    carriedFlags += 1;
    const carrierId = world.flags.carrierId[flagId] ?? -1;
    if (carrierId >= 0 && !state.active.has(carrierId)) {
      state.active.set(carrierId, startRun(world, carrierId, flagId));
    }
  }
  if (carriedFlags >= 2) state.bothFlagsCarriedTicks += 1;
}

/** Why a still-open run is over, or null while the carrier still holds the flag.
 *
 *  Death is checked before the capture score delta on purpose: a teammate can pick up a
 *  flag a dead carrier dropped and capture it within the SAME tick
 *  (handleTouchesAndCaptures walks players in id order, and a capture is only possible from
 *  a live player), so a tick that both kills our carrier and scores for its team belongs to
 *  the dead carrier as a death, not to the run it never finished. */
function runEndReason(
  world: World,
  run: ActiveCarrierRun,
  flagState: FlagState,
  scoreDelta: [number, number],
): CarrierRunEnd | null {
  const stillCarried =
    flagState === FlagState.Carried && world.flags.carrierId[run.flagId] === run.carrierId;
  if (stillCarried && world.players.alive[run.carrierId] === 1) return null;
  if (world.players.active[run.carrierId] !== 1) return 'flag returned';
  if (world.players.alive[run.carrierId] !== 1) return 'died';
  if ((scoreDelta[run.team - 1] ?? 0) > 0) return 'captured';
  return 'flag returned';
}

/** Per-tick proximity bookkeeping: this tick's nearby-player counts (which the death
 *  context reads if the run dies on this tick) and the run's closest-ever teammate. */
function trackProximity(run: ActiveCarrierRun, world: World): void {
  run.lastNearby = nearbyPlayers(world, run.carrierId, run.team);
  const closest = run.lastNearby.closestTeammateM;
  if (closest === null) return;
  run.closestTeammateM =
    run.closestTeammateM === null ? closest : Math.min(run.closestTeammateM, closest);
}

/** Encounter tracking for one tick: exposure ticks (any tick with an enemy inside the
 *  radius) and episodes (the rising edge of that condition, carrying the carrier's own speed
 *  on the tick it began, which is what separates "caught while slow" from "caught despite
 *  moving well"). Split out of `sampleRunTick` to keep that function inside the lint's
 *  complexity budget. */
function trackEncounter(run: ActiveCarrierRun, displacement: number): void {
  const closestEnemy = run.lastNearby.closestEnemyM;
  if (closestEnemy !== null && closestEnemy <= ENCOUNTER_RADIUS_M) run.enemyNearTicks += 1;
  const wasOutside = run.lastClosestEnemyM === null || run.lastClosestEnemyM > ENCOUNTER_RADIUS_M;
  if (wasOutside && closestEnemy !== null && closestEnemy <= ENCOUNTER_RADIUS_M) {
    run.encounterIndex.push(run.runTicks);
    run.encounterSpeedsMps.push(displacement / FIXED_DT);
  }
  run.lastClosestEnemyM = closestEnemy;
}

/** One tick of per-run measurement: displacement, own-stand distance, encounter rising
 *  edges, and the escort sample cadence. Indexed by `run.runTicks` at entry, which is the
 *  0-based tick index within the run (0 = the pickup tick -- `sampleCarrierTelemetry` runs
 *  this for a run on the very tick it starts), so every series lines up with the leg
 *  partition `runRecord` takes at close. */
function sampleRunTick(run: ActiveCarrierRun, world: World): void {
  const base = run.carrierId * 3;
  const x = world.players.position[base] ?? 0;
  const y = world.players.position[base + 1] ?? 0;
  const z = world.players.position[base + 2] ?? 0;
  const displacement = Math.hypot(
    x - run.lastPosition[0],
    y - run.lastPosition[1],
    z - run.lastPosition[2],
  );
  run.lastPosition = [x, y, z];
  run.tickDistancesM.push(displacement);
  run.tickStandDistancesM.push(standDistance(world, run.team, base).d3);
  trackEncounter(run, displacement);
  if (run.runTicks % ESCORT_SAMPLE_TICKS === 0) {
    run.escortSampleIndex.push(run.runTicks);
    run.escortSampleM.push(run.lastNearby.closestTeammateM);
  }
}

function advanceRun(
  state: CarrierTelemetry,
  run: ActiveCarrierRun,
  world: World,
  scoreDelta: [number, number],
): void {
  const { d3, d2 } = standDistance(world, run.team, run.carrierId * 3);
  run.closestApproachM = Math.min(run.closestApproachM, d3);
  run.closestApproach2dM = Math.min(run.closestApproach2dM, d2);
  trackProximity(run, world);
  sampleRunTick(run, world);
  const ownFlagHome = isOwnFlagHome(world, run.team);
  if (ownFlagHome) run.ownFlagHomeTicks += 1;
  if (d3 <= PICKUP_RADIUS) {
    run.radiusTicks += 1;
    if (run.radiusTicks === 1) state.runsReachingRadius += 1;
    if (ownFlagHome) run.radiusTicksOwnFlagHome += 1;
    else state.refusedTicks += 1;
  }
  run.runTicks += 1;
  const damage = world.players.damage[run.carrierId] ?? 0;
  run.endDamage = damage - run.lastDamage;
  run.lastDamage = damage;
  const flagState = world.flags.state[run.flagId] ?? FlagState.Home;
  if (flagState !== run.lastFlagState) {
    run.flagStateTimeline.push({ tick: world.tick, state: flagState });
    run.lastFlagState = flagState;
  }
  const endReason = runEndReason(world, run, flagState, scoreDelta);
  if (endReason !== null) closeRun(state, run, world, endReason);
}

/** Who the sim credited for a carrier's death, and on which team. -1/-1 when nobody was
 *  credited (fall damage, kill plane, turret shot). */
function killCredit(world: World, carrierId: number): { killerId: number; killerTeam: number } {
  const killerId = world.pendingDeaths.find((death) => death.id === carrierId)?.attackerId ?? -1;
  return { killerId, killerTeam: killerId >= 0 ? (world.players.team[killerId] ?? -1) : -1 };
}

function deathContext(
  world: World,
  run: ActiveCarrierRun,
  credit: { killerId: number; killerTeam: number },
): CarrierDeathContext {
  return {
    killerId: credit.killerId,
    killerTeam: credit.killerTeam,
    killerRelation: killRelation(run.carrierId, run.team, credit.killerId, credit.killerTeam),
    killerDistanceM:
      credit.killerId >= 0 ? Math.hypot(...axisGaps(world, run.carrierId, credit.killerId)) : -1,
    enemiesWithin100m: run.lastNearby.enemiesWithin100m,
    teammatesWithin100m: run.lastNearby.teammatesWithin100m,
  };
}

/** Median of a non-empty list; null for an empty one, so a leg with no samples reports
 *  "not measured" instead of a zero that would read as a measurement. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Nearest-rank quantile of a list (index `ceil(q * n) - 1`, clamped); 0 for an empty one.
 *  A p90 over a per-tick series answers "how fast was it when it was moving", which a mean
 *  cannot when a run is half spent stopped. */
function quantileOf(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** Index of the FIRST maximum; 0 for an empty series. Ties resolve to the earliest tick so
 *  a carrier that holds its farthest point for a while is split at the first arrival. */
function argmaxIndex(values: number[]): number {
  let best = -Infinity;
  let bestIndex = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? 0;
    if (value > best) {
      best = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function escortMetrics(samples: Array<number | null>): CarrierEscortSample {
  const present = samples.filter((distance): distance is number => distance !== null);
  let absent = 0;
  let noTeammate = 0;
  for (const distance of samples) {
    if (distance === null) {
      absent += 1;
      noTeammate += 1;
      continue;
    }
    if (distance > NEARBY_RADIUS_M) absent += 1;
  }
  return {
    samples: samples.length,
    medianM: medianOf(present),
    absentFraction: samples.length === 0 ? 0 : absent / samples.length,
    noTeammateFraction: samples.length === 0 ? 0 : noTeammate / samples.length,
  };
}

/** The escort samples whose run-tick index falls in [from, to) -- one leg's share. */
function legEscortSamples(run: ActiveCarrierRun, from: number, to: number): Array<number | null> {
  const samples: Array<number | null> = [];
  for (let i = 0; i < run.escortSampleIndex.length; i += 1) {
    const index = run.escortSampleIndex[i] ?? 0;
    if (index >= from && index < to) samples.push(run.escortSampleM[i] ?? null);
  }
  return samples;
}

/** One leg's totals: ticks [from, to) of the run's own per-tick series, plus the escort
 *  samples and encounter episodes that fall inside the leg. */
function legMetrics(run: ActiveCarrierRun, from: number, to: number): CarrierRunLegMetrics {
  const ticks = Math.max(0, to - from);
  let distanceM = 0;
  for (let i = from; i < to; i += 1) distanceM += run.tickDistancesM[i] ?? 0;
  let encounters = 0;
  for (const index of run.encounterIndex) {
    if (index >= from && index < to) encounters += 1;
  }
  return {
    ticks,
    distanceM,
    meanSpeedMps: ticks === 0 ? 0 : distanceM / (ticks * FIXED_DT),
    encounters,
    escort: escortMetrics(legEscortSamples(run, from, to)),
  };
}

/** Distance from player `id` to the nearest interior collider's bounding box. Reads the
 *  same `InteriorInstance.bounds` AABB `raycastInteriors` (interiors.ts) tests a ray
 *  against, instead of casting one -- occlusion.ts exposes only a boolean segment test and
 *  no distance, and a point-to-box distance needs no ray at all. Infinity only in a world
 *  built without interiors. */
function nearestInteriorDistanceM(world: World, id: number): number {
  const base = id * 3;
  const x = world.players.position[base] ?? 0;
  const y = world.players.position[base + 1] ?? 0;
  const z = world.players.position[base + 2] ?? 0;
  let nearest = Infinity;
  for (const interior of world.interiors) {
    const { bounds } = interior;
    const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
    const dy = Math.max(bounds.minY - y, 0, y - bounds.maxY);
    const dz = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
    nearest = Math.min(nearest, Math.hypot(dx, dy, dz));
  }
  return nearest;
}

/** Net-progress accounting over the run's own distance-to-own-stand series: the running
 *  best (smallest) distance is the baseline, and every tick STALL_CHECK_TICKS past that
 *  baseline's last improvement with no PROGRESS_MIN_M of new ground counts as stalled. A
 *  carrier skiing home improves this baseline every tick or two; a carrier grinding along a
 *  base wall does not, however fast its own body is moving -- which is exactly the case the
 *  bots' own displacement-based check (steering.ts's checkStuck) cannot see. */
function routeEndState(
  run: ActiveCarrierRun,
  world: World,
  endSpeedMps: number,
): CarrierRunEndState {
  const distances = run.tickStandDistancesM;
  let best = distances[0] ?? 0;
  let bestIndex = 0;
  let stalledTicks = 0;
  for (let i = 0; i < distances.length; i += 1) {
    const distance = distances[i] ?? 0;
    if (distance <= best - PROGRESS_MIN_M) {
      best = distance;
      bestIndex = i;
    }
    if (i - bestIndex >= STALL_CHECK_TICKS) stalledTicks += 1;
  }
  const base = run.carrierId * 3;
  return {
    ticksSinceProgress: Math.max(0, distances.length - 1 - bestIndex),
    stalledTicks,
    onGround: world.players.onGround[run.carrierId] === 1,
    interiorDistanceM: nearestInteriorDistanceM(world, run.carrierId),
    speedMps: endSpeedMps,
    velocityMps: Math.hypot(
      world.players.velocity[base] ?? 0,
      world.players.velocity[base + 1] ?? 0,
      world.players.velocity[base + 2] ?? 0,
    ),
  };
}

/** Distance from the carrier's end position to the stand the carried flag belongs to: the
 *  enemy stand it was taken from. A dropped flag's own position is not the pickup point, so
 *  the stand is the honest reference -- it is exactly where a clean take happened. */
function enemyStandDistanceM(world: World, run: ActiveCarrierRun): number {
  const base = run.carrierId * 3;
  const stand = run.flagId * 3;
  return Math.hypot(
    (world.players.position[base] ?? 0) - (world.flags.standPosition[stand] ?? 0),
    (world.players.position[base + 1] ?? 0) - (world.flags.standPosition[stand + 1] ?? 0),
    (world.players.position[base + 2] ?? 0) - (world.flags.standPosition[stand + 2] ?? 0),
  );
}

function runRecord(world: World, run: ActiveCarrierRun, endReason: CarrierRunEnd): CarrierRun {
  const credit = killCredit(world, run.carrierId);
  const damage = world.players.damage[run.carrierId] ?? 0;
  // The per-tick series length IS run.runTicks (advanceRun samples once per tick, from the
  // pickup tick on), so the leg partition and the duration cannot disagree.
  const runTicks = run.tickDistancesM.length;
  const distanceM = run.tickDistancesM.reduce((sum, tick) => sum + tick, 0);
  const turnIndex = argmaxIndex(run.tickStandDistancesM);
  const endSpeedMps = (run.tickDistancesM[runTicks - 1] ?? 0) / FIXED_DT;
  return {
    carrierId: run.carrierId,
    team: run.team,
    flagId: run.flagId,
    pickupTick: run.pickupTick,
    endTick: world.tick,
    endReason,
    killerId: credit.killerId,
    death: endReason === 'died' ? deathContext(world, run, credit) : null,
    closestTeammateM: run.closestTeammateM,
    endFlagState: world.flags.state[run.flagId] ?? FlagState.Home,
    endHealthFraction: Math.max(0, 1 - damage / armorFor(world, run.carrierId).maxDamage),
    endEnergy: world.players.energy[run.carrierId] ?? 0,
    endDamage: run.endDamage,
    closestApproachM: run.closestApproachM,
    closestApproach2dM: run.closestApproach2dM,
    radiusTicks: run.radiusTicks,
    radiusTicksOwnFlagHome: run.radiusTicksOwnFlagHome,
    ownFlagHomeTicks: run.ownFlagHomeTicks,
    runTicks: run.runTicks,
    distanceM,
    meanSpeedMps: runTicks === 0 ? 0 : distanceM / (runTicks * FIXED_DT),
    p90SpeedMps: quantileOf(run.tickDistancesM, 0.9) / FIXED_DT,
    pickupStandDistanceM: run.tickStandDistancesM[0] ?? 0,
    endStandDistanceM: run.tickStandDistancesM[runTicks - 1] ?? 0,
    endEnemyStandDistanceM: enemyStandDistanceM(world, run),
    turnTick: run.pickupTick + turnIndex,
    endLeg: turnIndex >= runTicks - 1 ? 'away' : 'home',
    legs: {
      away: legMetrics(run, 0, turnIndex + 1),
      home: legMetrics(run, turnIndex + 1, runTicks),
    },
    encounterCount: run.encounterSpeedsMps.length,
    encounterSpeedsMps: [...run.encounterSpeedsMps],
    enemyNearTicks: run.enemyNearTicks,
    startEnergy: run.startEnergy,
    escort: escortMetrics(run.escortSampleM),
    endRoute: routeEndState(run, world, endSpeedMps),
    flagStateTimeline: run.flagStateTimeline,
  };
}

function closeRun(
  state: CarrierTelemetry,
  run: ActiveCarrierRun,
  world: World,
  endReason: CarrierRunEnd,
): void {
  state.active.delete(run.carrierId);
  const teamIndex = run.team - 1;
  if (endReason === 'captured' && (teamIndex === 0 || teamIndex === 1)) {
    state.capturesPerTeam[teamIndex] = (state.capturesPerTeam[teamIndex] ?? 0) + 1;
  }
  const record = runRecord(world, run, endReason);
  state.carrierTicks += record.runTicks;
  state.carrierStallTicks += record.endRoute.stalledTicks;
  state.runs.push(record);
}

/** Advances the accumulator by one tick, sampling state AFTER that tick's stepWorld (the
 *  reason `pendingDeaths` and the capture score delta are both readable here). */
export function sampleCarrierTelemetry(state: CarrierTelemetry, world: World): void {
  state.sampledTicks += 1;
  sampleFlagStates(state, world);
  const scoreDelta: [number, number] = [
    (world.teamScores[1] ?? 0) - state.lastTeamScore[0],
    (world.teamScores[2] ?? 0) - state.lastTeamScore[1],
  ];
  state.lastTeamScore = [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0];
  for (const run of [...state.active.values()]) advanceRun(state, run, world, scoreDelta);
}

/** Closes every still-open run as `matchEnd` on the current tick and returns the summary.
 *  Call once, after the last sample. */
export function finishCarrierTelemetry(state: CarrierTelemetry, world: World): MatchTelemetry {
  for (const run of [...state.active.values()]) closeRun(state, run, world, 'matchEnd');
  return summarizeCarrierTelemetry(state);
}

export function summarizeCarrierTelemetry(state: CarrierTelemetry): MatchTelemetry {
  return {
    sampledTicks: state.sampledTicks,
    runs: state.runs.slice(),
    runsReachingRadius: state.runsReachingRadius,
    refusedTicks: state.refusedTicks,
    capturesPerTeam: [state.capturesPerTeam[0], state.capturesPerTeam[1]],
    flagStateTicks: state.flagStateTicks.map((share) => ({ ...share })),
    bothFlagsCarriedTicks: state.bothFlagsCarriedTicks,
    carrierTicks: state.carrierTicks,
    carrierStallTicks: state.carrierStallTicks,
  };
}
