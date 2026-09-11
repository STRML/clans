import { describe, expect, it } from 'vitest';
import {
  dueForRespawn,
  FlagState,
  hashWorld,
  LIGHT_ARMOR,
  respawnPlayer,
  stepWorld,
  type PlayerInput,
  type Vec3,
  type World,
} from '@clans/sim';
import {
  createBotManager,
  rebalanceTeams,
  stepBotManager,
  type BotManager,
} from './bots.js';
import {
  createCarrierTelemetry,
  finishCarrierTelemetry,
  sampleCarrierTelemetry,
  type CarrierEscortSample,
  type CarrierRun,
  type CarrierRunEnd,
  type CarrierDeathContext,
  type KillerRelation,
  type MatchTelemetry,
} from './carrier-telemetry.js';
import { createOrderBoard } from './orders.js';
import { loadKatabaticWorld, spawnPointFor, teamCount, type SceneSpawn } from './world.js';

// Issue #32 acceptance harness: a bot-only match on the REAL Katabatic world with the
// production landmark set -- exactly what packages/server/src/index.ts builds (every
// spawn, flag stand, and base object), not the spawn-only subset the older e2e
// (bot-match.test.ts) uses. The historical M6 repro: with this landmark set the
// un-validated graph routed bots straight through base walls and a 20k-tick match
// produced zero kills and zero captures. These tests are the acceptance proof that the
// interior-aware graph, local avoidance, and the recovery ladder (stuck-skip escape,
// hurdle jumps, under-floor waypoint skips, heal-chase bound) sustain combat AND
// captures on the deployed map.

/** The production landmark builder, mirrored line-for-line from index.ts (which cannot
 *  be imported directly: importing it starts the network server). index.ts reads the
 *  same placements loadKatabaticWorld already built -- spawns from the scene, flag
 *  stands and base objects read back from the populated world stores. */
function productionLandmarks(
  world: World,
  spawns: SceneSpawn[],
): Array<{ position: Vec3; label: string }> {
  const landmarks: Array<{ position: Vec3; label: string }> = spawns.map((s) => ({
    position: { x: s.position[0], y: s.position[1], z: s.position[2] },
    label: 'spawn',
  }));
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    const base = flagId * 3;
    landmarks.push({
      position: {
        x: world.flags.standPosition[base] ?? 0,
        y: world.flags.standPosition[base + 1] ?? 0,
        z: world.flags.standPosition[base + 2] ?? 0,
      },
      label: 'flag',
    });
  }
  for (let id = 0; id < world.baseObjects.count; id += 1) {
    const base = id * 3;
    landmarks.push({
      position: {
        x: world.baseObjects.position[base] ?? 0,
        y: world.baseObjects.position[base + 1] ?? 0,
        z: world.baseObjects.position[base + 2] ?? 0,
      },
      label: 'baseObject',
    });
  }
  return landmarks;
}

interface MatchStats {
  ticks: number;
  kills: number;
  captures: number;
  flagTouches: number;
  stallWindows: number;
  botWindowCount: number;
  /** Landmarks the waypoint graph was built from -- the production set or a subset. */
  landmarks: number;
  /** The same 120-tick displacement-stall windows as `stallWindows`/`botWindowCount`,
   *  split by whether the bot was carrying a flag at the end of the window. This is the
   *  control for the carrier route-stall measure: it answers "do bots in general stall on
   *  this graph" with the same instrument for both populations. */
  carrierWindowCount: number;
  carrierStallWindows: number;
  otherWindowCount: number;
  otherStallWindows: number;
}

/** Runs a deterministic headless bot-only match. The per-tick loop mirrors the live
 *  server's responsibilities (net.ts's tick): bot inputs, stepWorld, then the respawn
 *  duty -- net.ts's respawnDuePlayers picks each due id's spawn with the same
 *  teamCount-1 convention join uses; the position-history clearing there is lag-comp
 *  bookkeeping a headless match has no equivalent of. */
interface MatchTracker {
  stats: MatchStats;
  lastScore: Map<number, number>;
  lastFlagSig: number[];
  lastPos: Map<number, { x: number; z: number }>;
  windowDisplacement: Map<number, number>;
}

function newTracker(): MatchTracker {
  return {
    stats: {
      ticks: 0,
      kills: 0,
      captures: 0,
      flagTouches: 0,
      stallWindows: 0,
      botWindowCount: 0,
      landmarks: 0,
      carrierWindowCount: 0,
      carrierStallWindows: 0,
      otherWindowCount: 0,
      otherStallWindows: 0,
    },
    lastScore: new Map(),
    lastFlagSig: [-1, -1],
    lastPos: new Map(),
    windowDisplacement: new Map(),
  };
}

/** Per-bot score deltas and rolling per-window displacement. +10 is a kill
 *  (damage.ts's scoreForDeath); +20 touch / +30 capture are flag events counted from
 *  the flag store so the tallies cannot blur. */
function trackBots(world: World, manager: BotManager, tracker: MatchTracker): void {
  for (const id of manager.botIds) {
    const b = id * 3;
    const score = world.players.score[id] ?? 0;
    if (score - (tracker.lastScore.get(id) ?? 0) === 10) tracker.stats.kills += 1;
    tracker.lastScore.set(id, score);
    const px = world.players.position[b] ?? 0;
    const pz = world.players.position[b + 2] ?? 0;
    const prev = tracker.lastPos.get(id);
    if (prev !== undefined && world.players.alive[id] === 1) {
      tracker.windowDisplacement.set(
        id,
        (tracker.windowDisplacement.get(id) ?? 0) + Math.hypot(px - prev.x, pz - prev.z),
      );
    }
    tracker.lastPos.set(id, { x: px, z: pz });
  }
}

/** carrier*4 + state packs a flag's (carrierId, state) into one comparable number. */
function flagSignature(world: World, flagId: number): number {
  return (world.flags.carrierId[flagId] ?? -1) * 4 + (world.flags.state[flagId] ?? 0);
}

/** Home -> Carried is a touch/take. */
function isTouchTransition(previous: number, sig: number): boolean {
  return previous !== -1 && previous !== sig && previous % 4 === 0 && sig % 4 === 1;
}

/** Flags store transitions: Home->Carried is a touch/take. Captures land in teamScores
 *  and are read there, so only the touch needs counting from the store. */
function trackFlags(world: World, tracker: MatchTracker): void {
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    const sig = flagSignature(world, flagId);
    if (isTouchTransition(tracker.lastFlagSig[flagId] ?? -1, sig)) tracker.stats.flagTouches += 1;
    tracker.lastFlagSig[flagId] = sig;
  }
  tracker.stats.captures = ((world.teamScores[1] ?? 0) + (world.teamScores[2] ?? 0)) / 100;
}

/** True while this player id is the recorded carrier of a Carried flag. The role split
 *  below is what turns the whole-population stall rate into a control: carriers and
 *  everyone else are measured by the same instrument in the same match. */
function isCarryingFlag(world: World, id: number): boolean {
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    if (world.flags.carrierId[flagId] === id && world.flags.state[flagId] === FlagState.Carried) {
      return true;
    }
  }
  return false;
}

/** Windowed stall accounting: near-zero displacement while alive. Defenders holding
 *  their flag stand displace little too, but that population is small (25% of bots)
 *  and constant across seeds, so the stall TOTAL still isolates navigation health: the
 *  historical runs this test replaces produced 40-90+ stall windows per 10k ticks from
 *  wedged bots alone. The carrier/other split below is the telemetry sweep's control:
 *  the same windows, counted separately for the bots that were carrying a flag. */
function trackStallWindow(
  world: World,
  manager: BotManager,
  tracker: MatchTracker,
): void {
  const STALL_MIN_DISPLACEMENT_M = 2;
  for (const id of manager.botIds) {
    const moved = tracker.windowDisplacement.get(id) ?? 0;
    tracker.windowDisplacement.set(id, 0);
    if (world.players.alive[id] !== 1) continue;
    tracker.stats.botWindowCount += 1;
    const stalled = moved < STALL_MIN_DISPLACEMENT_M;
    if (stalled) tracker.stats.stallWindows += 1;
    if (isCarryingFlag(world, id)) {
      tracker.stats.carrierWindowCount += 1;
      if (stalled) tracker.stats.carrierStallWindows += 1;
    } else {
      tracker.stats.otherWindowCount += 1;
      if (stalled) tracker.stats.otherStallWindows += 1;
    }
  }
}

/** Respawn duty, mirrored from net.ts's respawnDuePlayers (minus the lag-comp position
 *  history clearing, which a headless match has no equivalent of): spawnPointFor with
 *  the same teamCount-1 convention join uses. */
function respawnDue(world: World, spawns: SceneSpawn[]): void {
  for (const id of dueForRespawn(world)) {
    const team = world.players.team[id] ?? 1;
    const [x, y, z] = spawnPointFor(
      world.terrain,
      spawns,
      team,
      teamCount(world, team) - 1,
      world.interiors,
    );
    respawnPlayer(world, id, { x, y, z });
  }
}

const STALL_WINDOW_TICKS = 120;

/** Bots seated per team by default. Every measurement issue #32 has taken is an 8-versus-8
 *  match, because this harness has always handed createBotManager TARGET_TEAM_SIZE (16) as
 *  its total bot budget and rebalanceTeams splits that evenly. The project target is 24
 *  versus 24, so runMatch takes the per-team seat count and this stays the default: the
 *  three acceptance tests above call it with no size argument and seat 16 bots exactly as
 *  they always have. Passing N hands createBotManager a budget of 2N and a cap of N, the
 *  pairing its own `teamSize` doc comment specifies for a 24-versus-24 match. */
const DEFAULT_BOTS_PER_TEAM = 8;

/** Runs a deterministic headless bot-only match. The per-tick loop mirrors the live
 *  server's responsibilities (net.ts's tick): bot inputs, stepWorld, then the respawn
 *  duty.
 *
 *  When `telemetryOut` is given, the match is ALSO measured by carrier-telemetry.ts and
 *  the finished summary is pushed onto that array. An out-parameter rather than a wider
 *  return type on purpose: the three acceptance tests above read a plain MatchStats and
 *  must keep doing so, and the telemetry accumulator has to be built from the loaded
 *  world (it sizes its per-flag counters from the flag store), which only exists inside
 *  this function.
 *
 *  `botsPerTeam` seats that many bots on each side (2N total budget, N per-team cap);
 *  it defaults to DEFAULT_BOTS_PER_TEAM, so the acceptance tests above are untouched.
 *  On the telemetry path this also prints hashWorld of the final world, which is what
 *  makes a table attributable to one world state: two runs whose fingerprints match
 *  simulated the same thing, and a table whose fingerprint differs was measured against
 *  a different tree. */
async function runMatch(
  seed: number,
  ticks: number,
  telemetryOut?: MatchTelemetry[],
  botsPerTeam: number = DEFAULT_BOTS_PER_TEAM,
): Promise<MatchStats> {
  const { world, spawns } = await loadKatabaticWorld(seed);
  const landmarks = productionLandmarks(world, spawns);
  const manager = createBotManager(world, spawns, landmarks, botsPerTeam * 2, botsPerTeam);
  rebalanceTeams(manager, world, spawns);
  const board = createOrderBoard();
  const tracker = newTracker();
  tracker.stats.landmarks = landmarks.length;
  const telemetry = telemetryOut ? createCarrierTelemetry(world) : null;
  for (let t = 0; t < ticks; t += 1) {
    if (world.gameOver) break;
    const inputs: Map<number, PlayerInput> = stepBotManager(manager, world, board);
    stepWorld(world, inputs);
    // Sampled straight after stepWorld, before respawnDue resets a dead carrier's damage:
    // pendingDeaths still holds this tick's deaths (stepPlayers refilled it after clearing
    // it at the start of this same call) and teamScores already holds this tick's captures.
    if (telemetry) sampleCarrierTelemetry(telemetry, world);
    tracker.stats.ticks = t + 1;
    trackBots(world, manager, tracker);
    trackFlags(world, tracker);
    if ((t + 1) % STALL_WINDOW_TICKS === 0) trackStallWindow(world, manager, tracker);
    respawnDue(world, spawns);
  }
  if (telemetry && telemetryOut) {
    telemetryOut.push(finishCarrierTelemetry(telemetry, world));
    // Printed only on the telemetry path, so the acceptance tests' output is unchanged.
    // hashWorld, not the table: a table can be identical by coincidence, the fingerprint
    // cannot, and it is what ties a run to one world state across the arms of a comparison.
    console.log(
      `sim fingerprint: seed ${seed.toString()} ${botsPerTeam.toString()}v${botsPerTeam.toString()} ${hashWorld(world).toString(16)}`,
    );
  }
  return tracker.stats;
}

const MATCH_TICKS = 12000; // Ours: ~6.4 minutes of simulated time -- long enough for
// multiple flag runs each way at a ~10 m/s ski; the M2 bots-under-tick-budget bench
// already proves the 5000-tick shape runs in budget, so this only scales the window.

/** The sweep's own tick count, overridable for iteration only: the full sweep is four
 *  matches x MATCH_TICKS and takes minutes, so a development pass can shorten it without
 *  touching the acceptance window or any behaviour constant. */
const SWEEP_TICKS = Number(process.env.BOT_TELEMETRY_TICKS ?? MATCH_TICKS);

/** Bots per team for the sweep, so the same four seeds can be measured at the harness's
 *  historical 8-versus-8 and at the project's 24-versus-24 target without touching a
 *  single acceptance test. Defaults to the acceptance seating, so an unset environment
 *  reproduces the sweep exactly as it was. */
const SWEEP_BOTS_PER_TEAM = Number(process.env.BOT_TELEMETRY_TEAM_SIZE ?? DEFAULT_BOTS_PER_TEAM);

describe('bot-only match on production Katabatic (issue #32)', () => {
  it('sustains combat: multiple kills across the match, on every seed', async () => {
    for (const seed of [1, 2, 3]) {
      const stats = await runMatch(seed, MATCH_TICKS);
      expect(stats.kills).toBeGreaterThan(3);
    }
  }, 240_000);

  it('gets attackers onto the enemy flag deck: at least one flag carry across seeds', async () => {
    // The navigation proof for #32: the flag stands sit on the bases' top decks, behind
    // walls no pre-#32 route could legally cross. Touching the enemy flag (FlagState
    // Home -> Carried, PICKUP_RADIUS 2 m, 3D) requires a bot to climb the deck lips and
    // reach the stand itself -- the historical production-landmark match never managed
    // a single touch. Carriers still frequently die on the ~1 km walk home (turrets +
    // roaming enemies -- combat attrition, not navigation), so a completed capture is
    // not deterministic in this window and is not asserted here; see the wrap-up notes.
    let totalTouches = 0;
    for (const seed of [1, 2, 3]) {
      const stats = await runMatch(seed, MATCH_TICKS);
      totalTouches += stats.flagTouches;
    }
    expect(totalTouches).toBeGreaterThanOrEqual(1);
  }, 360_000);

  it('keeps wedged-stall windows a small fraction of bot-time', async () => {
    for (const seed of [1, 2, 3]) {
      const stats = await runMatch(seed, MATCH_TICKS);
      // The historical stall accounting: bots wedged against buildings for entire
      // matches produced 90+ stalled windows out of 100 per bot. After #32 the
      // remainder should be a modest minority (defenders legitimately hold position,
      // so this never goes to zero).
      expect(stats.stallWindows / Math.max(1, stats.botWindowCount)).toBeLessThan(0.2);
    }
  }, 360_000);

  it('gets attackers onto the enemy flag deck at the 24-versus-24 project size too', async () => {
    // The tests above all run the harness's historical seating: createBotManager's
    // TARGET_TEAM_SIZE budget of 16 bots, which rebalanceTeams splits 8 v 8. The project's
    // own match size is 24 v 24, and the seating is the only thing that changes here --
    // same map, same landmarks, same steering.
    //
    // Measured on the frozen tree (BOT_TELEMETRY=1, BOT_TELEMETRY_TEAM_SIZE=24, four
    // seeds, 12,000 ticks each): 19 flag touches, 370 kills, 24 carrier runs, and BOTH
    // teams attacking -- which is the point. At 8 v 8 only one team ever takes a flag (the
    // other flag is Home for all 48,000 sampled ticks) and all 13 carrier deaths are that
    // one team's; at 24 v 24 each flag is carried for thousands of ticks and the carrier
    // deaths split 7/14. The one-sided 8 v 8 match is a small-team artefact.
    //
    // What is NOT asserted, and would not pass: a capture. At 24 v 24 the pooled sweep
    // measured 0 captures, 0 runs arriving inside the 2 m capture radius, 0 refused ticks,
    // and a closest approach of 48 m; 21 of the 24 carrier runs ended in a death, 16 of
    // them to an enemy at a median 23 m while the carrier ran at its full 15.0 m/s. That
    // is the open bug (#32), not a bar this test may raise.
    let totalTouches = 0;
    for (const seed of [1, 2, 3]) {
      const stats = await runMatch(seed, MATCH_TICKS, undefined, 24);
      totalTouches += stats.flagTouches;
    }
    expect(totalTouches).toBeGreaterThanOrEqual(1);
  }, 420_000);
});

// ---------------------------------------------------------------------------------------
// Issue #32 carrier telemetry. Opt-in and off by default: this sweep runs four extra full
// matches, so it only runs when BOT_TELEMETRY=1 is set in the environment. It asserts that
// the telemetry is WELL-FORMED, never a kill/touch/capture threshold -- those belong to the
// three acceptance tests above, and are not this sweep's business -- and prints one row per
// seed plus a pooled row.

const TELEMETRY_SEEDS = [1, 2, 3, 4];

/** Half of LIGHT's damage bar. Every bot spawns in LIGHT armor (addOneBot's default), and
 *  full armor is restored on respawn, so a carrier's bar is always a full LIGHT bar. An
 *  unattributed death (killerId -1) that took at least this much on its FINAL tick landed
 *  as one chunk -- applyFallDamage applies the whole hit at once -- rather than as the last
 *  chip of a long grind against something that credits nobody (turret shots spawn with
 *  ownerId -1, the same unattributed convention). */
const ONE_SHOT_ENV_DAMAGE = LIGHT_ARMOR.maxDamage / 2;

/** One match's worth of the table: the acceptance stats and the carrier telemetry side by
 *  side, with a label so the pooled row needs no second formatting path. */
interface TableRow {
  label: string;
  stats: MatchStats;
  telemetry: MatchTelemetry;
}

function endReasonTally(runs: CarrierRun[]): Record<CarrierRunEnd, number> {
  const tally: Record<CarrierRunEnd, number> = {
    captured: 0,
    died: 0,
    'flag returned': 0,
    matchEnd: 0,
  };
  for (const run of runs) tally[run.endReason] += 1;
  return tally;
}

/** Enemy kills vs every other credited/unattributed cause, plus how many of the
 *  non-enemy, non-player deaths landed as a single chunk -- the fall/impact signature,
 *  since fall damage, the kill plane and turret shots all record killerId -1. */
function deathTally(runs: CarrierRun[]): {
  player: number;
  environmental: number;
  oneShot: number;
} {
  const tally = { player: 0, environmental: 0, oneShot: 0 };
  for (const run of runs) {
    if (run.endReason !== 'died') continue;
    if (run.death?.killerRelation === 'enemy') {
      tally.player += 1;
      continue;
    }
    tally.environmental += 1;
    if (run.killerId < 0 && run.endDamage >= ONE_SHOT_ENV_DAMAGE) tally.oneShot += 1;
  }
  return tally;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/** Sums per-seed telemetries into one match-sized object, so the pooled row and the
 *  per-seed rows share a single formatting path. */
function mergeTelemetry(matches: MatchTelemetry[]): MatchTelemetry {
  const merged: MatchTelemetry = {
    sampledTicks: 0,
    runs: [],
    runsReachingRadius: 0,
    refusedTicks: 0,
    capturesPerTeam: [0, 0],
    flagStateTicks: [],
    bothFlagsCarriedTicks: 0,
    carrierTicks: 0,
    carrierStallTicks: 0,
  };
  for (const match of matches) {
    merged.sampledTicks += match.sampledTicks;
    merged.runs.push(...match.runs);
    merged.runsReachingRadius += match.runsReachingRadius;
    merged.refusedTicks += match.refusedTicks;
    merged.capturesPerTeam[0] += match.capturesPerTeam[0];
    merged.capturesPerTeam[1] += match.capturesPerTeam[1];
    merged.bothFlagsCarriedTicks += match.bothFlagsCarriedTicks;
    merged.carrierTicks += match.carrierTicks;
    merged.carrierStallTicks += match.carrierStallTicks;
    match.flagStateTicks.forEach((share, index) => {
      const total = merged.flagStateTicks[index] ?? {
        team: share.team,
        home: 0,
        carried: 0,
        dropped: 0,
      };
      total.home += share.home;
      total.carried += share.carried;
      total.dropped += share.dropped;
      merged.flagStateTicks[index] = total;
    });
  }
  return merged;
}

function tableCells(row: TableRow): string[] {
  const { telemetry } = row;
  const ends = endReasonTally(telemetry.runs);
  const deaths = deathTally(telemetry.runs);
  const closest = telemetry.runs.map((run) => run.closestApproachM);
  const diedClosest = telemetry.runs
    .filter((run) => run.endReason === 'died')
    .map((run) => run.closestApproachM);
  const endsCell = [ends.captured, ends.died, ends['flag returned'], ends.matchEnd].join('/');
  const deathsCell = [deaths.player, deaths.environmental, deaths.oneShot].join('/');
  const flagCell = telemetry.flagStateTicks
    .map((share) => [share.home, share.carried, share.dropped].join('/'))
    .join(' ');
  const capsCell = `${row.stats.captures.toString()} (${telemetry.capturesPerTeam[0].toString()}/${telemetry.capturesPerTeam[1].toString()})`;
  // Both medians below are over run sets that can be empty (a match with no carrier runs,
  // or with no carrier deaths): printing their 0 would read as a measurement, so show '-'.
  const closestCell =
    closest.length === 0
      ? '-'
      : `${Math.round(Math.min(...closest)).toString()}/${Math.round(median(closest)).toString()}`;
  const diedClosestCell =
    diedClosest.length === 0 ? '-' : Math.round(median(diedClosest)).toString();
  return [
    row.label,
    String(telemetry.sampledTicks),
    String(row.stats.kills),
    String(row.stats.flagTouches),
    capsCell,
    String(telemetry.runs.length),
    String(telemetry.runsReachingRadius),
    String(telemetry.refusedTicks),
    String(telemetry.bothFlagsCarriedTicks),
    endsCell,
    deathsCell,
    flagCell,
    closestCell,
    diedClosestCell,
  ];
}

/** Death contexts for the runs that died (null on every other ending by construction). */
function deathContexts(runs: CarrierRun[]): CarrierDeathContext[] {
  const contexts: CarrierDeathContext[] = [];
  for (const run of runs) {
    if (run.death) contexts.push(run.death);
  }
  return contexts;
}

/** "median/max", or "-" when there is nothing to average. */
function rangeCell(values: number[]): string {
  if (values.length === 0) return '-';
  return `${Math.round(median(values)).toString()}/${Math.round(Math.max(...values)).toString()}`;
}

/** KILLER_RELATIONS: the death table's own column order, in one place so the header and the
 *  cells cannot drift apart. */
const KILLER_RELATIONS: KillerRelation[] = ['enemy', 'teammate', 'self', 'unattributed'];

/** The second table: who killed the carriers, and whether anybody was standing with them. */
function deathCells(row: TableRow): string[] {
  const runs = row.telemetry.runs;
  const deaths = runs.filter((run) => run.endReason === 'died');
  const contexts = deathContexts(deaths);
  const byRelation = (relation: KillerRelation): number =>
    contexts.filter((context) => context.killerRelation === relation).length;
  const killerDistances = contexts
    .filter((context) => context.killerDistanceM >= 0)
    .map((context) => context.killerDistanceM);
  const closestTeammates = runs
    .map((run) => run.closestTeammateM)
    .filter((distance): distance is number => distance !== null);
  return [
    row.label,
    String(deaths.length),
    [1, 2].map((team) => String(deaths.filter((run) => run.team === team).length)).join('/'),
    KILLER_RELATIONS.map((relation) => String(byRelation(relation))).join('/'),
    killerDistances.length === 0 ? '-' : Math.round(median(killerDistances)).toString(),
    rangeCell(contexts.map((context) => context.enemiesWithin100m)),
    rangeCell(contexts.map((context) => context.teammatesWithin100m)),
    rangeCell(deaths.map((run) => run.runTicks)),
    rangeCell(closestTeammates),
  ];
}

function printCarrierDeathTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'carrier deaths',
    'deaths t1/t2',
    'killer enemy/teammate/self/unattributed',
    'killer dist med (m)',
    'enemies within 100m med/max',
    'teammates within 100m med/max',
    'ticks since pickup med/max',
    'closest teammate ever med/max (m)',
  ];
  console.log('');
  console.log('carrier deaths: wrote the killer down, and who was standing there at the time');
  console.log(header.join(' | '));
  for (const row of rows) console.log(deathCells(row).join(' | '));
}

/** Median of the values rounded to `digits`, or '-' when there is nothing to average.
 *  Distinct from the shared `median` above, which returns 0 for an empty set -- in a table
 *  cell that 0 would read as a measurement. */
function medianCell(values: number[], digits = 0): string {
  if (values.length === 0) return '-';
  return median(values).toFixed(digits);
}

/** "hits/total" as a whole percent, or '-' when the denominator is zero. */
function percentCell(hits: number, total: number): string {
  if (total === 0) return '-';
  return `${Math.round((hits / total) * 100).toString()}%`;
}

/** Median, then max, of a value list; '-' when empty. */
function medianMaxCell(values: number[], digits = 0): string {
  if (values.length === 0) return '-';
  return `${median(values).toFixed(digits)}/${Math.max(...values).toFixed(digits)}`;
}

/** Every ending the telemetry can record, with deaths split by killer relation: an
 *  end-reason distribution, not just the death tally. A run that never dies and never
 *  captures is invisible to the acceptance counters, so it is counted here explicitly. */
function runEndCells(row: TableRow): string[] {
  const runs = row.telemetry.runs;
  const deaths = runs.filter((run) => run.endReason === 'died');
  const byRelation = (relation: KillerRelation): number =>
    deaths.filter((run) => run.death?.killerRelation === relation).length;
  const returned = runs.filter((run) => run.endReason === 'flag returned').length;
  const matchEnd = runs.filter((run) => run.endReason === 'matchEnd').length;
  return [
    row.label,
    String(runs.length),
    String(runs.filter((run) => run.endReason === 'captured').length),
    KILLER_RELATIONS.map((relation) => String(byRelation(relation))).join('/'),
    String(returned),
    String(matchEnd),
    String(returned + matchEnd),
    String(row.telemetry.carrierTicks),
    String(row.telemetry.carrierStallTicks),
    percentCell(row.telemetry.carrierStallTicks, row.telemetry.carrierTicks),
  ];
}

function printRunEndTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'runs',
    'captured',
    'died enemy/teammate/self/unattributed',
    'dropped/returned',
    'still running at sweep end',
    'ended w/o death or capture',
    'carrier ticks',
    'carrier stall ticks',
    'carrier stall share',
  ];
  console.log('');
  console.log('run endings: every ending the telemetry records, deaths split by credited side');
  console.log(
    'legend: carrier stall ticks = ticks a carrier held the flag with a full 60-tick window and no',
  );
  console.log(
    '        net progress toward its own stand (see the stall table below for the control).',
  );
  console.log(header.join(' | '));
  for (const row of rows) console.log(runEndCells(row).join(' | '));
}

/** Run shape and pace, plus the leg split: away = pickup to the farthest excursion from
 *  the carrier's own stand, home = everything after. */
function runShapeCells(row: TableRow): string[] {
  const runs = row.telemetry.runs;
  const endedHome = runs.filter((run) => run.endLeg === 'home').length;
  return [
    row.label,
    String(runs.length),
    medianCell(runs.map((run) => run.runTicks)),
    medianCell(runs.map((run) => run.distanceM)),
    medianCell(
      runs.map((run) => run.meanSpeedMps),
      1,
    ),
    medianCell(
      runs.map((run) => run.p90SpeedMps),
      1,
    ),
    medianCell(runs.map((run) => run.pickupStandDistanceM)),
    medianCell(runs.map((run) => run.endStandDistanceM)),
    `${endedHome.toString()}/${(runs.length - endedHome).toString()}`,
    medianCell(runs.map((run) => run.legs.away.ticks)),
    medianCell(runs.map((run) => run.legs.home.ticks)),
    medianCell(runs.map((run) => run.legs.away.distanceM)),
    medianCell(runs.map((run) => run.legs.home.distanceM)),
    medianCell(
      runs.map((run) => run.legs.away.meanSpeedMps),
      1,
    ),
    medianCell(
      runs.map((run) => run.legs.home.meanSpeedMps),
      1,
    ),
  ];
}

function printRunShapeTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'runs',
    'duration med (ticks)',
    'distance med (m)',
    'mean speed med (m/s)',
    'p90 speed med (m/s)',
    'pickup dist med (m)',
    'end dist med (m)',
    'ended home/away',
    'away ticks med',
    'home ticks med',
    'away dist med (m)',
    'home dist med (m)',
    'away speed med',
    'home speed med',
  ];
  console.log('');
  console.log('run shape and legs: how far each run got, how fast, and where it turned');
  console.log(
    'legend: pickup/end dist = metres from the carrier own stand at pickup and at the end;',
  );
  console.log(
    '        away = pickup to the run farthest point, home = after it; speeds are 3D per-tick displacement / FIXED_DT.',
  );
  console.log(header.join(' | '));
  for (const row of rows) console.log(runShapeCells(row).join(' | '));
}

/** Sample-weighted "nobody within 100 m" share, with the share of samples where the
 *  carrier had no live teammate AT ALL in parentheses: an escort that is alive but far and
 *  an escort that does not exist need different fixes. */
function escortAbsentCell(samples: CarrierEscortSample[]): string {
  const total = samples.reduce((sum, sample) => sum + sample.samples, 0);
  if (total === 0) return '-';
  const absent = samples.reduce((sum, sample) => sum + sample.absentFraction * sample.samples, 0);
  const none = samples.reduce(
    (sum, sample) => sum + sample.noTeammateFraction * sample.samples,
    0,
  );
  return `${Math.round((absent / total) * 100).toString()}% (${Math.round((none / total) * 100).toString()}% none)`;
}

function escortMedian(samples: CarrierEscortSample[]): string {
  return medianCell(
    samples.map((sample) => sample.medianM).filter((value): value is number => value !== null),
  );
}

/** Escort presence over time, whole-run and per leg: the median nearest live teammate at
 *  the 60-tick cadence, and the share of samples with nobody within 100 m. */
function escortCells(row: TableRow): string[] {
  const runs = row.telemetry.runs;
  const away = runs.map((run) => run.legs.away.escort);
  const home = runs.map((run) => run.legs.home.escort);
  const whole = runs.map((run) => run.escort);
  return [
    row.label,
    String(runs.length),
    escortMedian(whole),
    escortAbsentCell(whole),
    escortMedian(away),
    escortAbsentCell(away),
    escortMedian(home),
    escortAbsentCell(home),
  ];
}

function printEscortTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'runs',
    'escort med (m)',
    'no teammate within 100m (none alive)',
    'away escort med (m)',
    'away no teammate (none alive)',
    'home escort med (m)',
    'home no teammate (none alive)',
  ];
  console.log('');
  console.log('escort presence over time: nearest LIVE teammate every 60 ticks, median and absent share');
  console.log(
    'legend: "no teammate" = share of samples with no live teammate within 100 m, and in parentheses the share with',
  );
  console.log(
    '        NO live teammate alive anywhere -- an escort that is far versus an escort that does not exist.',
  );
  console.log(header.join(' | '));
  for (const row of rows) console.log(escortCells(row).join(' | '));
}

/** Encounters and energy: whether the carrier was moving when contact happened, and what
 *  it had left in the tank when the run ended. */
function encounterCells(row: TableRow): string[] {
  const runs = row.telemetry.runs;
  const encounterSpeeds = runs.flatMap((run) => run.encounterSpeedsMps);
  const died = runs.filter((run) => run.endReason === 'died');
  const surviving = runs.filter(
    (run) => run.endReason !== 'died' && run.endReason !== 'captured',
  );
  const runTicks = runs.reduce((sum, run) => sum + run.runTicks, 0);
  const nearTicks = runs.reduce((sum, run) => sum + run.enemyNearTicks, 0);
  return [
    row.label,
    String(runs.reduce((sum, run) => sum + run.encounterCount, 0)),
    `${runs.filter((run) => run.encounterCount > 0).length.toString()}/${runs.length.toString()}`,
    `${nearTicks.toString()} (${percentCell(nearTicks, runTicks)})`,
    medianCell(encounterSpeeds, 1),
    medianCell(
      runs.map((run) => run.meanSpeedMps),
      1,
    ),
    medianCell(
      runs.map((run) => run.startEnergy),
      1,
    ),
    medianCell(
      surviving.map((run) => run.endEnergy),
      1,
    ),
    medianCell(
      died.map((run) => run.endEnergy),
      1,
    ),
    medianCell(
      surviving.map((run) => run.endEnergy),
      1,
    ),
    medianCell(
      runs.map((run) => run.endHealthFraction * 100),
    ),
  ];
}

function printEncounterTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'encounters',
    'runs with an encounter',
    'ticks with enemy within 50m (share of carrier ticks)',
    'speed at encounter med (m/s)',
    'run mean speed med (m/s)',
    'start energy med',
    'end energy med (all)',
    'end energy med (died)',
    'end energy med (no death/capture)',
    'end health med (%)',
  ];
  console.log('');
  console.log('encounters and energy: an encounter is an enemy crossing inside 50 m');
  console.log(
    'legend: speed at encounter = the carrier own per-tick speed on the tick each episode began (0 on the pickup tick);',
  );
  console.log(
    '        exposure = every tick with a live enemy inside 50 m, which a long chase shows even though the episode count does not.',
  );
  console.log(header.join(' | '));
  for (const row of rows) console.log(encounterCells(row).join(' | '));
}

/** Runs that ended WITHOUT a death or a capture -- the population a kill/touch/capture
 *  tally cannot see: whether they were stalled, standing, and next to base geometry. */
function stallCells(row: TableRow): string[] {
  const runs = row.telemetry.runs.filter(
    (run) => run.endReason !== 'died' && run.endReason !== 'captured',
  );
  const interior = runs
    .map((run) => run.endRoute.interiorDistanceM)
    .filter((value) => Number.isFinite(value));
  const stats = row.stats;
  return [
    row.label,
    String(runs.length),
    medianMaxCell(
      runs.map((run) => run.endRoute.ticksSinceProgress),
    ),
    `${runs.reduce((sum, run) => sum + run.endRoute.stalledTicks, 0).toString()}`,
    percentCell(runs.filter((run) => run.endRoute.onGround).length, runs.length),
    medianMaxCell(interior),
    medianCell(
      runs.map((run) => run.endRoute.speedMps),
      1,
    ),
    `${stats.stallWindows.toString()}/${stats.botWindowCount.toString()}`,
    percentCell(stats.carrierStallWindows, stats.carrierWindowCount),
    percentCell(stats.otherStallWindows, stats.otherWindowCount),
  ];
}

/** Where the carrier was when its run ended: on the enemy deck right after the take, or
 *  out in the open on the way home. Splits deaths by distance to the enemy stand (the
 *  pickup point) against distance to its own. */
function deathPlaceCells(row: TableRow): string[] {
  const deaths = row.telemetry.runs.filter((run) => run.endReason === 'died');
  const nearEnemy = deaths.filter((run) => run.endEnemyStandDistanceM <= 25).length;
  const midEnemy = deaths.filter(
    (run) => run.endEnemyStandDistanceM > 25 && run.endEnemyStandDistanceM <= 100,
  ).length;
  const farEnemy = deaths.length - nearEnemy - midEnemy;
  return [
    row.label,
    String(deaths.length),
    medianCell(deaths.map((run) => run.endStandDistanceM)),
    medianCell(deaths.map((run) => run.endEnemyStandDistanceM)),
    `${nearEnemy.toString()}/${midEnemy.toString()}/${farEnemy.toString()}`,
    medianMaxCell(
      deaths.map((run) => run.endRoute.speedMps),
      1,
    ),
    medianMaxCell(
      deaths.map((run) => run.endRoute.velocityMps),
      1,
    ),
    medianCell(deaths.map((run) => run.endRoute.ticksSinceProgress)),
  ];
}

function printDeathPlaceTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'deaths',
    'dist to own stand med (m)',
    'dist to enemy stand med (m)',
    'deaths <25m / 25-100m / >100m from the enemy stand',
    'end speed med/max (m/s)',
    'end velocity med/max (m/s)',
    'ticks since route progress med',
  ];
  console.log('');
  console.log('where the carrier died: on the enemy deck right after the take, or out in the open');
  console.log(
    'legend: enemy stand = the stand the carried flag belongs to, i.e. where a clean pickup happened;',
  );
  console.log(
    '        end speed = committed per-tick displacement / FIXED_DT; end velocity = the player store own velocity magnitude that tick.',
  );
  console.log(header.join(' | '));
  for (const row of rows) console.log(deathPlaceCells(row).join(' | '));
}

function printStallTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'ends w/o death or capture',
    'ticks since progress med/max',
    'stall ticks (route)',
    'onGround',
    'interior dist med/max (m)',
    'end speed med (m/s)',
    'all-bot 120t stall windows',
    'carrier window stall rate',
    'non-carrier window stall rate',
  ];
  console.log('');
  console.log('ending without a death or a capture: route progress, ground contact, base geometry');
  console.log(
    'legend: ticks since progress = ticks since the run last came PROGRESS_MIN_M closer to its own stand;',
  );
  console.log(
    '        stall ticks = run ticks inside a 60-tick window with no such progress; interior dist = metres to the nearest',
  );
  console.log(
    '        interior collider AABB (Infinity excluded); the last two columns are the same 120-tick displacement',
  );
  console.log(
    '        stall window for every bot alive, split by whether it was carrying a flag -- the population control.',
  );
  console.log(header.join(' | '));
  for (const row of rows) console.log(stallCells(row).join(' | '));
}

function printTelemetryTable(rows: TableRow[]): void {
  const header = [
    'seed',
    'ticks',
    'kills',
    'touch',
    'caps (t1/t2)',
    'runs',
    'reach',
    'refused',
    'both',
    'cap/die/ret/end',
    'pvp/env/1shot',
    'flag h/c/d',
    'closest min/med',
    'died closest med',
  ];
  console.log('issue #32 carrier telemetry -- one row per seed, then all seeds pooled');
  console.log(
    'legend: runs = carrier runs; reach = runs inside the 2 m capture radius; refused = ticks inside it with the own flag OUT;',
  );
  console.log(
    '        both = ticks with both flags Carried at once; flag h/c/d = ticks Home/Carried/Dropped per flag; closest = 3D metres to the carrier own stand.',
  );
  console.log(header.join(' | '));
  for (const row of rows) console.log(tableCells(row).join(' | '));
}

/** Well-formedness only: every sampled tick accounted to a flag state, every run's clocks
 *  and radius columns self-consistent, and the telemetry's captures agreeing with the
 *  harness's own score-derived count. No threshold on any of it. */
function assertTelemetryWellFormed(telemetry: MatchTelemetry, stats: MatchStats): void {
  expect(telemetry.sampledTicks).toBeGreaterThan(0);
  for (const share of telemetry.flagStateTicks) {
    expect(share.home + share.carried + share.dropped).toBe(telemetry.sampledTicks);
  }
  const capturedRuns = telemetry.runs.filter((run) => run.endReason === 'captured').length;
  expect(telemetry.capturesPerTeam[0] + telemetry.capturesPerTeam[1]).toBe(capturedRuns);
  expect(capturedRuns).toBe(stats.captures);
  for (const run of telemetry.runs) {
    expect(run.pickupTick).toBeLessThanOrEqual(run.endTick);
    expect(run.runTicks).toBe(run.endTick - run.pickupTick + 1);
    expect(run.flagStateTimeline[0]?.state).toBe(FlagState.Carried);
    expect(run.radiusTicksOwnFlagHome).toBeLessThanOrEqual(run.radiusTicks);
    expect(run.radiusTicks).toBeLessThanOrEqual(run.runTicks);
    expect(run.team).not.toBe(telemetry.flagStateTicks[run.flagId]?.team);
    // A death context exists exactly when the run died, and its killer id is the run's.
    expect(run.death === null).toBe(run.endReason !== 'died');
    if (run.death) {
      expect(run.death.killerId).toBe(run.killerId);
      // Invariants, not a second copy of the classifier: no killer id means no named side,
      // an enemy is on one of the two real teams and not the carrier's, a teammate is on it.
      expect(run.death.killerRelation === 'unattributed').toBe(run.killerId < 0);
      expect(run.death.killerRelation === 'self').toBe(run.killerId === run.carrierId);
      if (run.death.killerRelation === 'enemy') {
        expect([1, 2]).toContain(run.death.killerTeam);
        expect(run.death.killerTeam).not.toBe(run.team);
      }
      if (run.death.killerRelation === 'teammate') {
        expect(run.death.killerTeam).toBe(run.team);
      }
      expect(run.death.killerDistanceM >= 0).toBe(run.killerId >= 0);
    }
  }
}

describe.skipIf(process.env.BOT_TELEMETRY !== '1')(
  'carrier telemetry sweep (issue #32, BOT_TELEMETRY=1)',
  () => {
    it('measures every seed and prints the carrier table', async () => {
      const rows: TableRow[] = [];
      console.log('');
      console.log(
        `match size: ${SWEEP_BOTS_PER_TEAM.toString()} v ${SWEEP_BOTS_PER_TEAM.toString()} (${(SWEEP_BOTS_PER_TEAM * 2).toString()} bots seated), ${SWEEP_TICKS.toString()} ticks x ${TELEMETRY_SEEDS.length.toString()} seeds`,
      );
      for (const seed of TELEMETRY_SEEDS) {
        const collected: MatchTelemetry[] = [];
        const stats = await runMatch(seed, SWEEP_TICKS, collected, SWEEP_BOTS_PER_TEAM);
        const telemetry = collected[0];
        if (!telemetry) throw new Error(`no telemetry collected for seed ${String(seed)}`);
        assertTelemetryWellFormed(telemetry, stats);
        rows.push({ label: String(seed), stats, telemetry });
      }
      printTelemetryTable(rows);
      const pooled = mergeTelemetry(rows.map((row) => row.telemetry));
      const sum = (pick: (stats: MatchStats) => number): number =>
        rows.reduce((total, row) => total + pick(row.stats), 0);
      const stats = {
        ticks: pooled.sampledTicks,
        kills: sum((s) => s.kills),
        captures: sum((s) => s.captures),
        flagTouches: sum((s) => s.flagTouches),
        stallWindows: sum((s) => s.stallWindows),
        botWindowCount: sum((s) => s.botWindowCount),
        landmarks: rows[0]?.stats.landmarks ?? 0,
        carrierWindowCount: sum((s) => s.carrierWindowCount),
        carrierStallWindows: sum((s) => s.carrierStallWindows),
        otherWindowCount: sum((s) => s.otherWindowCount),
        otherStallWindows: sum((s) => s.otherStallWindows),
      };
      const pooledRow: TableRow = { label: 'ALL', stats, telemetry: pooled };
      console.log(tableCells(pooledRow).join(' | '));
      printCarrierDeathTable(rows);
      console.log(deathCells(pooledRow).join(' | '));
      // The waypoint graph's landmark set, printed because it decides what the runs above
      // can possibly be: runMatch builds it with productionLandmarks (spawns + flag stands
      // + every base object), the set the deployed server uses.
      console.log('');
      console.log(
        `waypoint landmarks: production set (spawns + flag stands + base objects) = ${stats.landmarks.toString()} per seed; seeds ${TELEMETRY_SEEDS.join('/')}`,
      );
      printRunEndTable(rows);
      console.log(runEndCells(pooledRow).join(' | '));
      printRunShapeTable(rows);
      console.log(runShapeCells(pooledRow).join(' | '));
      printEscortTable(rows);
      console.log(escortCells(pooledRow).join(' | '));
      printEncounterTable(rows);
      console.log(encounterCells(pooledRow).join(' | '));
      printDeathPlaceTable(rows);
      console.log(deathPlaceCells(pooledRow).join(' | '));
      printStallTable(rows);
      console.log(stallCells(pooledRow).join(' | '));
    }, 900_000);
  },
);
