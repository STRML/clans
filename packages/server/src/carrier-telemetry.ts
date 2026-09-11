import { armorFor, FlagState, PICKUP_RADIUS, type World } from '@clans/sim';

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
 *  NEARBY_RADIUS_M, and the closest teammate at any range. One pass over the player store. */
interface NearbyPlayers {
  enemiesWithin100m: number;
  teammatesWithin100m: number;
  closestTeammateM: number | null;
}

function nearbyPlayers(world: World, carrierId: number, team: number): NearbyPlayers {
  const nearby: NearbyPlayers = {
    enemiesWithin100m: 0,
    teammatesWithin100m: 0,
    closestTeammateM: null,
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
    if (distance <= NEARBY_RADIUS_M) nearby.enemiesWithin100m += 1;
  }
  return nearby;
}

function startRun(world: World, carrierId: number, flagId: number): ActiveCarrierRun {
  const team = world.players.team[carrierId] ?? 0;
  const { d3, d2 } = standDistance(world, team, carrierId * 3);
  const nearby = nearbyPlayers(world, carrierId, team);
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

function runRecord(world: World, run: ActiveCarrierRun, endReason: CarrierRunEnd): CarrierRun {
  const credit = killCredit(world, run.carrierId);
  const damage = world.players.damage[run.carrierId] ?? 0;
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
  state.runs.push(runRecord(world, run, endReason));
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
  };
}
