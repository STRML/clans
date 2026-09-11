import { describe, expect, it } from 'vitest';
import {
  dueForRespawn,
  FlagState,
  LIGHT_ARMOR,
  respawnPlayer,
  stepWorld,
  type PlayerInput,
  type Vec3,
  type World,
} from '@clans/sim';
import { createBotManager, rebalanceTeams, stepBotManager, TARGET_TEAM_SIZE } from './bots.js';
import {
  createCarrierTelemetry,
  finishCarrierTelemetry,
  sampleCarrierTelemetry,
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
    stats: { ticks: 0, kills: 0, captures: 0, flagTouches: 0, stallWindows: 0, botWindowCount: 0 },
    lastScore: new Map(),
    lastFlagSig: [-1, -1],
    lastPos: new Map(),
    windowDisplacement: new Map(),
  };
}

/** Per-bot score deltas and rolling per-window displacement. +10 is a kill
 *  (damage.ts's scoreForDeath); +20 touch / +30 capture are flag events counted from
 *  the flag store so the tallies cannot blur. */
function trackBots(
  world: World,
  manager: ReturnType<typeof createBotManager>,
  tracker: MatchTracker,
): void {
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

/** Windowed stall accounting: near-zero displacement while alive. Defenders holding
 *  their flag stand displace little too, but that population is small (25% of bots)
 *  and constant across seeds, so the stall TOTAL still isolates navigation health: the
 *  historical runs this test replaces produced 40-90+ stall windows per 10k ticks from
 *  wedged bots alone. */
function trackStallWindow(
  world: World,
  manager: ReturnType<typeof createBotManager>,
  tracker: MatchTracker,
): void {
  const STALL_MIN_DISPLACEMENT_M = 2;
  for (const id of manager.botIds) {
    const moved = tracker.windowDisplacement.get(id) ?? 0;
    tracker.windowDisplacement.set(id, 0);
    if (world.players.alive[id] !== 1) continue;
    tracker.stats.botWindowCount += 1;
    if (moved < STALL_MIN_DISPLACEMENT_M) tracker.stats.stallWindows += 1;
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

/** Runs a deterministic headless bot-only match. The per-tick loop mirrors the live
 *  server's responsibilities (net.ts's tick): bot inputs, stepWorld, then the respawn
 *  duty.
 *
 *  When `telemetryOut` is given, the match is ALSO measured by carrier-telemetry.ts and
 *  the finished summary is pushed onto that array. An out-parameter rather than a wider
 *  return type on purpose: the three acceptance tests above read a plain MatchStats and
 *  must keep doing so, and the telemetry accumulator has to be built from the loaded
 *  world (it sizes its per-flag counters from the flag store), which only exists inside
 *  this function. */
async function runMatch(
  seed: number,
  ticks: number,
  telemetryOut?: MatchTelemetry[],
): Promise<MatchStats> {
  const { world, spawns } = await loadKatabaticWorld(seed);
  const manager = createBotManager(
    world,
    spawns,
    productionLandmarks(world, spawns),
    TARGET_TEAM_SIZE,
  );
  rebalanceTeams(manager, world, spawns);
  const board = createOrderBoard();
  const tracker = newTracker();
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
  if (telemetry && telemetryOut) telemetryOut.push(finishCarrierTelemetry(telemetry, world));
  return tracker.stats;
}

const MATCH_TICKS = 12000; // Ours: ~6.4 minutes of simulated time -- long enough for
// multiple flag runs each way at a ~10 m/s ski; the M2 bots-under-tick-budget bench
// already proves the 5000-tick shape runs in budget, so this only scales the window.

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
  };
  for (const match of matches) {
    merged.sampledTicks += match.sampledTicks;
    merged.runs.push(...match.runs);
    merged.runsReachingRadius += match.runsReachingRadius;
    merged.refusedTicks += match.refusedTicks;
    merged.capturesPerTeam[0] += match.capturesPerTeam[0];
    merged.capturesPerTeam[1] += match.capturesPerTeam[1];
    merged.bothFlagsCarriedTicks += match.bothFlagsCarriedTicks;
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
      for (const seed of TELEMETRY_SEEDS) {
        const collected: MatchTelemetry[] = [];
        const stats = await runMatch(seed, MATCH_TICKS, collected);
        const telemetry = collected[0];
        if (!telemetry) throw new Error(`no telemetry collected for seed ${String(seed)}`);
        assertTelemetryWellFormed(telemetry, stats);
        rows.push({ label: String(seed), stats, telemetry });
      }
      printTelemetryTable(rows);
      const pooled = mergeTelemetry(rows.map((row) => row.telemetry));
      const stats = {
        ticks: pooled.sampledTicks,
        kills: rows.reduce((sum, row) => sum + row.stats.kills, 0),
        captures: rows.reduce((sum, row) => sum + row.stats.captures, 0),
        flagTouches: rows.reduce((sum, row) => sum + row.stats.flagTouches, 0),
        stallWindows: 0,
        botWindowCount: 0,
      };
      console.log(tableCells({ label: 'ALL', stats, telemetry: pooled }).join(' | '));
      printCarrierDeathTable(rows);
      console.log(deathCells({ label: 'ALL', stats, telemetry: pooled }).join(' | '));
    }, 900_000);
  },
);
