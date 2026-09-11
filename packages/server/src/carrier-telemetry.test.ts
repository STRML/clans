import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyDamage,
  armorFor,
  buildInteriorCollider,
  createFlags,
  createWorld,
  FIXED_DT,
  FlagState,
  LIGHT_ARMOR,
  stepFlags,
  type Heightfield,
  type World,
} from '@clans/sim';
import {
  createCarrierTelemetry,
  finishCarrierTelemetry,
  sampleCarrierTelemetry,
  summarizeCarrierTelemetry,
  type CarrierRun,
  type CarrierTelemetry,
  type MatchTelemetry,
} from './carrier-telemetry.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 2000,
  originX: -1000,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

const TEAM_1_STAND = { x: -100, y: 0, z: 0 };
const TEAM_2_STAND = { x: 100, y: 0, z: 0 };

function flagWorld(): World {
  const world = createWorld(flat, 1, 32);
  createFlags(world, [
    { team: 1, position: TEAM_1_STAND },
    { team: 2, position: TEAM_2_STAND },
  ]);
  return world;
}

/** One simulated tick, ordered exactly as the real server's: stepFlags, then the tick
 *  counter, then the telemetry sample. stepFlags alone is enough here -- these tests move
 *  players by hand and never exercise movement, and every telemetry field reads flag or
 *  player state that stepFlags is what writes. */
function advance(world: World, telemetry: CarrierTelemetry, ticks = 1): void {
  for (let i = 0; i < ticks; i += 1) {
    stepFlags(world, FIXED_DT);
    world.tick += 1;
    sampleCarrierTelemetry(telemetry, world);
  }
}

/** A named accessor instead of `runs[i]?.field` chains: ESLint's complexity rule counts
 *  every optional chain as a branch, and these tests assert a dozen fields per run. */
function runAt(summary: MatchTelemetry, index: number): CarrierRun {
  const run = summary.runs[index];
  if (!run) throw new Error(`expected a carrier run at index ${String(index)}`);
  return run;
}

function runFor(summary: MatchTelemetry, carrierId: number): CarrierRun {
  const run = summary.runs.find((candidate) => candidate.carrierId === carrierId);
  if (!run) throw new Error(`expected a carrier run for player ${String(carrierId)}`);
  return run;
}

describe('carrier telemetry', () => {
  it('records a completed capture from pickup to stand, with the radius columns clean', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1); // on the enemy stand: picks up flag 1
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry); // pickup tick: flag 1 goes Home -> Carried
    world.players.position.set([TEAM_1_STAND.x, TEAM_1_STAND.y, TEAM_1_STAND.z], carrier * 3);
    advance(world, telemetry); // own flag 0 is Home: capture lands

    const summary = finishCarrierTelemetry(telemetry, world);
    expect(summary.sampledTicks).toBe(2);
    expect(summary.runs).toHaveLength(1);
    const run = runAt(summary, 0);
    expect(run.carrierId).toBe(carrier);
    expect(run.team).toBe(1);
    expect(run.flagId).toBe(1);
    expect(run.pickupTick).toBe(1);
    expect(run.endTick).toBe(2);
    expect(run.endReason).toBe('captured');
    expect(run.endFlagState).toBe(FlagState.Home);
    expect(run.runTicks).toBe(2);
    expect(run.closestApproachM).toBe(0);
    expect(run.radiusTicks).toBe(1);
    expect(run.radiusTicksOwnFlagHome).toBe(1);
    expect(run.ownFlagHomeTicks).toBe(2);
    expect(run.flagStateTimeline).toEqual([
      { tick: 1, state: FlagState.Carried },
      { tick: 2, state: FlagState.Home },
    ]);
    expect(summary.capturesPerTeam).toEqual([1, 0]);
    expect(summary.runsReachingRadius).toBe(1);
    expect(summary.refusedTicks).toBe(0);
  });

  it('counts ticks refused inside the capture radius while the own flag is out, then the capture once it is home', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1); // enemy stand: takes flag 1
    const thief = addPlayer(world, TEAM_1_STAND, 2); // own stand of team 1: takes flag 0
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry); // both flags Carried from this tick
    world.players.position.set([TEAM_1_STAND.x, TEAM_1_STAND.y, TEAM_1_STAND.z], carrier * 3); // walk the flag home, to its own stand
    advance(world, telemetry, 5); // ...and stand there, refused: own flag 0 is out

    const refused = summarizeCarrierTelemetry(telemetry);
    expect(refused.capturesPerTeam).toEqual([0, 0]);
    expect(refused.refusedTicks).toBe(5);
    expect(refused.bothFlagsCarriedTicks).toBe(6);

    // The thief's own flag comes home (a teammate recovering it, in a real match), and the
    // thief leaves the stand -- so nothing re-takes it before the carrier's next turn.
    world.players.position.set([0, 0, 0], thief * 3);
    world.flags.state[0] = FlagState.Home;
    world.flags.carrierId[0] = -1;
    advance(world, telemetry);

    const summary = finishCarrierTelemetry(telemetry, world);
    const run = runFor(summary, carrier);
    expect(run.endReason).toBe('captured');
    expect(run.radiusTicks).toBe(6);
    // Exactly one of those six ticks was capturable -- the one the own flag was home for.
    expect(run.radiusTicksOwnFlagHome).toBe(1);
    expect(summary.refusedTicks).toBe(5);
    expect(summary.capturesPerTeam).toEqual([1, 0]);
    // The thief's run ends the moment its flag is taken out of its hands -- no capture and
    // no death, so the return path, not matchEnd.
    const thiefRun = runFor(summary, thief);
    expect(thiefRun.endReason).toBe('flag returned');
    expect(thiefRun.endFlagState).toBe(FlagState.Home);
  });

  it('ends a run as died with the credited killer and the dropped flag it left behind', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const enemy = addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry);
    // Well short of its own stand: this one dies on the way home, not at the stand.
    world.players.position.set([0, 0, 0], carrier * 3);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, enemy, armorFor(world, carrier));
    advance(world, telemetry); // stepFlags drops the carried flag on the recorded death

    const summary = finishCarrierTelemetry(telemetry, world);
    expect(summary.runs).toHaveLength(1);
    const run = runAt(summary, 0);
    expect(run.endReason).toBe('died');
    expect(run.killerId).toBe(enemy);
    expect(run.endFlagState).toBe(FlagState.Dropped);
    expect(run.endHealthFraction).toBe(0);
    expect(run.endTick).toBe(2);
    // Died on the way home, not at the stand: the run never entered the capture radius.
    expect(run.radiusTicks).toBe(0);
    expect(run.closestApproachM).toBe(100);
    expect(summary.runsReachingRadius).toBe(0);
    expect(summary.refusedTicks).toBe(0);
  });

  it('records the death context: an enemy killer, who was nearby, and how far away it was', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const wingman = addPlayer(world, { x: 96, y: 0, z: 0 }, 1); // 4 m from the carrier
    const enemy = addPlayer(world, { x: 90, y: 0, z: 0 }, 2); // 10 m from the carrier
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry); // pickup, with both neighbours inside the 100 m envelope
    // Out on the walk home: a wingman 12 m back, a single interceptor 30 m ahead.
    world.players.position.set([0, 0, 0], carrier * 3);
    world.players.position.set([0, 0, 12], wingman * 3);
    world.players.position.set([0, 0, -30], enemy * 3);
    advance(world, telemetry);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, enemy, armorFor(world, carrier));
    advance(world, telemetry);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    expect(run.endReason).toBe('died');
    // runTicks at a death IS ticks since pickup: 3 sampled ticks, pickup on the first.
    expect(run.runTicks).toBe(3);
    expect(run.death).toEqual({
      killerId: enemy,
      killerTeam: 2,
      killerRelation: 'enemy',
      killerDistanceM: 30,
      enemiesWithin100m: 1,
      teammatesWithin100m: 1,
    });
    // Closest teammate over the whole run: the 4 m at the stand, not the 12 m later.
    expect(run.closestTeammateM).toBe(4);
  });

  it('classifies a credited teamkill as a teammate, not an enemy', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const friendly = addPlayer(world, { x: 110, y: 0, z: 0 }, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry);
    world.players.position.set([0, 0, 0], carrier * 3);
    world.players.position.set([0, 0, 5], friendly * 3);
    advance(world, telemetry);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, friendly, armorFor(world, carrier));
    advance(world, telemetry);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    // scoreForDeath credits a teamkill at -10 exactly as it credits an enemy kill at +10,
    // so a credited attacker id alone would have been read as enemy contact here.
    expect(run.killerId).toBe(friendly);
    expect(run.death?.killerTeam).toBe(1);
    expect(run.death?.killerRelation).toBe('teammate');
    expect(run.death?.killerDistanceM).toBe(5);
    expect(run.death?.enemiesWithin100m).toBe(0);
    expect(run.death?.teammatesWithin100m).toBe(1);
  });

  it('classifies a self-kill as self, never as a teamkill', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, carrier, armorFor(world, carrier));
    advance(world, telemetry);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    // scoreForDeath's own self-kill branch (attackerId === victimId), distinct from the
    // teamkill branch it would otherwise be folded into by a bare team comparison.
    expect(run.killerId).toBe(carrier);
    expect(run.death?.killerTeam).toBe(1);
    expect(run.death?.killerRelation).toBe('self');
    expect(run.death?.killerDistanceM).toBe(0);
  });

  it('counts only live players toward the escort distance', () => {
    const world = flagWorld();
    addPlayer(world, TEAM_2_STAND, 1);
    const deadWingman = addPlayer(world, { x: 70, y: 0, z: 0 }, 1); // 30 m away, but dead
    addPlayer(world, { x: -400, y: 0, z: 0 }, 1); // 500 m away, alive
    const telemetry = createCarrierTelemetry(world);
    world.players.alive[deadWingman] = 0;

    advance(world, telemetry, 2);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    // 500 m, not the corpse's 30 m: a dead teammate is not an escort.
    expect(run.closestTeammateM).toBe(500);
    expect(run.death).toBeNull();
    // Far, but not nobody: the one alive teammate is outside the 100 m envelope, and the
    // two absence classes must not be conflated.
    expect(run.escort.medianM).toBe(500);
    expect(run.escort.absentFraction).toBe(1);
    expect(run.escort.noTeammateFraction).toBe(0);
  });

  it('reports no closest teammate at all for a carrier who has none', () => {
    const world = flagWorld();
    addPlayer(world, TEAM_2_STAND, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry, 2);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    expect(run.closestTeammateM).toBeNull();
    expect(run.death).toBeNull(); // no death, so no death context
  });

  it('records killerId -1 for an unattributed death and keeps the final damage chunk that separates fall from chip damage', () => {
    const falling = flagWorld();
    const faller = addPlayer(falling, TEAM_2_STAND, 1);
    const fallTelemetry = createCarrierTelemetry(falling);
    advance(falling, fallTelemetry);
    applyDamage(falling, faller, LIGHT_ARMOR.maxDamage, -1, armorFor(falling, faller));
    advance(falling, fallTelemetry);

    const fallRun = runAt(finishCarrierTelemetry(fallTelemetry, falling), 0);
    expect(fallRun.endReason).toBe('died');
    expect(fallRun.killerId).toBe(-1);
    expect(fallRun.death?.killerRelation).toBe('unattributed');
    expect(fallRun.death?.killerDistanceM).toBe(-1);
    expect(fallRun.endDamage).toBe(LIGHT_ARMOR.maxDamage);

    // A chip death is many small hits: the end tick's damage is its last chip, not the bar.
    const chipped = flagWorld();
    const chippedCarrier = addPlayer(chipped, TEAM_2_STAND, 1);
    const chippedTelemetry = createCarrierTelemetry(chipped);
    advance(chipped, chippedTelemetry);
    const armor = armorFor(chipped, chippedCarrier);
    applyDamage(chipped, chippedCarrier, armor.maxDamage - 0.05, -1, armor);
    advance(chipped, chippedTelemetry); // survives: damage is only sampled per tick
    applyDamage(chipped, chippedCarrier, 0.05, -1, armor);
    advance(chipped, chippedTelemetry);

    const chippedRun = runAt(finishCarrierTelemetry(chippedTelemetry, chipped), 0);
    expect(chippedRun.endReason).toBe('died');
    expect(chippedRun.endDamage).toBeCloseTo(0.05, 6);
    expect(chippedRun.endDamage).toBeLessThan(LIGHT_ARMOR.maxDamage);
  });

  it('records the run shape: distance, pace, leg split, escort cadence and the end route', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry); // pickup tick at the enemy stand, 200 m from home
    for (const x of [96, 92, 88, 84, 80]) {
      world.players.position.set([x, 0, 0], carrier * 3);
      advance(world, telemetry);
    }
    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);

    expect(run.runTicks).toBe(6);
    // 4 m a tick over the five moving ticks; the pickup tick itself displaces nothing.
    expect(run.distanceM).toBe(20);
    expect(run.meanSpeedMps).toBeCloseTo(20 / (6 * FIXED_DT), 6);
    expect(run.p90SpeedMps).toBeCloseTo(4 / FIXED_DT, 6);
    // Picked up at the enemy stand (200 m from home), ended 180 m out.
    expect(run.pickupStandDistanceM).toBe(200);
    expect(run.endStandDistanceM).toBe(180);
    // ...and 20 m from the enemy stand the take happened at (x = +100).
    expect(run.endEnemyStandDistanceM).toBe(20);
    // The farthest point was the pickup itself, so exactly one tick is "away".
    expect(run.turnTick).toBe(run.pickupTick);
    expect(run.endLeg).toBe('home');
    expect(run.legs.away.ticks).toBe(1);
    expect(run.legs.away.distanceM).toBe(0);
    expect(run.legs.home.ticks).toBe(5);
    expect(run.legs.home.distanceM).toBe(20);
    expect(run.legs.home.meanSpeedMps).toBeCloseTo(4 / FIXED_DT, 6);
    // The escort cadence samples the pickup tick and nothing else inside six ticks.
    expect(run.escort.samples).toBe(1);
    // A carrier with no live teammate has no escort distance, and that is "absent", not
    // "not measured": the median is null and the absence share is 1.
    expect(run.escort.medianM).toBeNull();
    expect(run.escort.absentFraction).toBe(1);
    expect(run.escort.noTeammateFraction).toBe(1);
    expect(run.escort).toEqual(run.legs.away.escort);
    expect(run.encounterCount).toBe(0);
    expect(run.encounterSpeedsMps).toEqual([]);
    expect(run.startEnergy).toBe(LIGHT_ARMOR.maxEnergy);
    // Making ground on the final tick: no stall, no ticks since progress.
    expect(run.endRoute.ticksSinceProgress).toBe(0);
    expect(run.endRoute.stalledTicks).toBe(0);
    expect(run.endRoute.speedMps).toBeCloseTo(4 / FIXED_DT, 6);
    // The store's own velocity is untouched by these hand-set moves (no stepWorld), while
    // the committed displacement still says 4 m: the two fields are independent on purpose.
    expect(run.endRoute.velocityMps).toBe(0);
    expect(run.endRoute.interiorDistanceM).toBe(Infinity); // this world has no interiors
  });

  it('counts enemy encounters as rising edges and records the carrier speed at each', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const enemy = addPlayer(world, { x: 60, y: 0, z: 0 }, 2); // 40 m: inside the 50 m envelope
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry); // encounter 1 begins on the pickup tick itself
    world.players.position.set([90, 0, 0], carrier * 3); // 30 m: still inside, no new edge
    advance(world, telemetry);
    world.players.position.set([80, 0, 0], carrier * 3);
    world.players.position.set([10, 0, 0], enemy * 3); // 70 m: outside again
    advance(world, telemetry);
    world.players.position.set([70, 0, 0], carrier * 3);
    world.players.position.set([60, 0, 0], enemy * 3); // 10 m: encounter 2 begins
    advance(world, telemetry);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    expect(run.encounterCount).toBe(2);
    // Exposure counts ticks, not episodes: the pickup tick, the next tick, and the tick
    // that started the second encounter were all inside 50 m.
    expect(run.enemyNearTicks).toBe(3);
    // The pickup tick has no previous sample, so its recorded speed is zero; the second
    // encounter carries that tick's own 10 m of displacement.
    expect(run.encounterSpeedsMps[0]).toBe(0);
    expect(run.encounterSpeedsMps[1]).toBeCloseTo(10 / FIXED_DT, 6);
    // One encounter each side of the turn: the pickup tick is the farthest point.
    expect(run.legs.away.encounters).toBe(1);
    expect(run.legs.home.encounters).toBe(1);
  });

  it('measures net route stall, which the bots own displacement check cannot see', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    world.players.onGround[carrier] = 1;
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry); // pickup at x=100
    // Wall-grinding: 16 m of lateral motion every tick, and never one metre closer to home.
    for (let i = 0; i < 100; i += 1) {
      world.players.position.set([100, 0, i % 2 === 0 ? 8 : -8], carrier * 3);
      advance(world, telemetry);
    }
    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);

    expect(run.runTicks).toBe(101);
    // The body moved (and started on the far side of the stand, so its distance only ever
    // grows), so a displacement-based stuck check would pass it -- this run makes no ground.
    expect(run.endRoute.ticksSinceProgress).toBe(100);
    expect(run.endRoute.stalledTicks).toBeGreaterThan(30);
    expect(run.endRoute.stalledTicks).toBeLessThan(60);
    expect(run.endRoute.speedMps).toBeCloseTo(16 / FIXED_DT, 6);
    expect(run.endRoute.onGround).toBe(true);
  });

  it('splits a mid-field recovery into away and home legs at the farthest point', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const telemetry = createCarrierTelemetry(world);
    // The dropped-enemy-flag shape: taken where it lies, 100 m from the carrier's own stand.
    world.flags.state[1] = FlagState.Carried;
    world.flags.carrierId[1] = carrier;

    advance(world, telemetry); // pickup at x=0
    for (const x of [20, 10, -10, -50]) {
      world.players.position.set([x, 0, 0], carrier * 3);
      advance(world, telemetry);
    }
    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);

    // Farthest excursion is x=+20 (index 1): indices 0-1 away, 2-4 home.
    expect(run.turnTick).toBe(run.pickupTick + 1);
    expect(run.endLeg).toBe('home');
    expect(run.legs.away.ticks).toBe(2);
    expect(run.legs.away.distanceM).toBe(20);
    expect(run.legs.home.ticks).toBe(3);
    expect(run.legs.home.distanceM).toBe(70);
    expect(run.pickupStandDistanceM).toBe(100);
    expect(run.endStandDistanceM).toBe(50);
  });

  it('measures the distance to the nearest interior collider from the sim own bounds', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    world.interiors.push(
      buildInteriorCollider(
        { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10]) },
        { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } },
      ),
    );
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry);
    world.players.position.set([30, 0, 5], carrier * 3); // 20 m out in x from a 0..10 box
    advance(world, telemetry);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    expect(run.endRoute.interiorDistanceM).toBe(20);
  });

  it('closes a run still in progress as matchEnd on the final tick', () => {
    const world = flagWorld();
    addPlayer(world, TEAM_2_STAND, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry, 3);

    const summary = finishCarrierTelemetry(telemetry, world);
    expect(summary.runs).toHaveLength(1);
    const run = runAt(summary, 0);
    expect(run.endReason).toBe('matchEnd');
    expect(run.endTick).toBe(3);
    expect(run.endFlagState).toBe(FlagState.Carried);
    expect(run.runTicks).toBe(3);
    expect(run.pickupTick).toBe(1);
  });

  it('ends a run whose flag left the carrier without a death as flag returned', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry, 2);
    // The disconnect/rebalance shape (dropFlagsCarriedBy): the flag is dropped where the
    // carrier stood and its return timer arms, while the carrier itself lives on and walks
    // away -- away matters, or the carrier simply picks its own drop back up next tick.
    world.players.position.set([0, 0, 0], carrier * 3);
    world.flags.state[1] = FlagState.Dropped;
    world.flags.carrierId[1] = -1;
    world.flags.returnAt[1] = world.tick + 10;
    advance(world, telemetry);

    const run = runAt(finishCarrierTelemetry(telemetry, world), 0);
    expect(run.endReason).toBe('flag returned');
    expect(run.endFlagState).toBe(FlagState.Dropped);
    expect(run.killerId).toBe(-1);
    expect(run.endTick).toBe(3);
  });

  it('records a flag returned to its stand under a living carrier as Home, not as a capture', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry, 2);
    // net.ts's unkill shape: the flag goes back to its stand while its carrier lives --
    // and keeps living away from the stand, so it does not just pick it up again.
    world.players.position.set([0, 0, 0], carrier * 3);
    world.flags.state[1] = FlagState.Home;
    world.flags.carrierId[1] = -1;
    advance(world, telemetry);

    const summary = finishCarrierTelemetry(telemetry, world);
    const run = runAt(summary, 0);
    expect(run.endReason).toBe('flag returned');
    expect(run.endFlagState).toBe(FlagState.Home);
    expect(summary.capturesPerTeam).toEqual([0, 0]);
  });

  it('counts the both-flags-carried deadlock and accounts every sampled tick to a flag state', () => {
    const world = flagWorld();
    const team1 = addPlayer(world, TEAM_1_STAND, 1);
    const team2 = addPlayer(world, TEAM_2_STAND, 2);
    const telemetry = createCarrierTelemetry(world);

    world.flags.state[0] = FlagState.Carried;
    world.flags.carrierId[0] = team2;
    world.flags.state[1] = FlagState.Carried;
    world.flags.carrierId[1] = team1;

    for (let i = 0; i < 4; i += 1) {
      world.tick += 1;
      sampleCarrierTelemetry(telemetry, world);
    }
    world.flags.state[0] = FlagState.Dropped;
    world.flags.carrierId[0] = -1;
    world.tick += 1;
    sampleCarrierTelemetry(telemetry, world);

    const summary = finishCarrierTelemetry(telemetry, world);
    expect(summary.sampledTicks).toBe(5);
    expect(summary.bothFlagsCarriedTicks).toBe(4);
    expect(summary.flagStateTicks).toEqual([
      { team: 1, home: 0, carried: 4, dropped: 1 },
      { team: 2, home: 0, carried: 5, dropped: 0 },
    ]);
    // Both carriers were mid-run when flag 0 was dropped; one closed on that drop, the
    // other was still holding its flag when the match stopped.
    expect(summary.runs.map((run) => run.endReason)).toEqual(['flag returned', 'matchEnd']);
    expect(summary.runs.map((run) => run.team)).toEqual([2, 1]);
  });

  it('tracks separate run ids for a carrier that loses the flag and later picks one up again', () => {
    const world = flagWorld();
    const carrier = addPlayer(world, TEAM_2_STAND, 1);
    const telemetry = createCarrierTelemetry(world);

    advance(world, telemetry, 2);
    world.players.position.set([0, 0, 0], carrier * 3); // away from the drop
    world.flags.state[1] = FlagState.Dropped;
    world.flags.carrierId[1] = -1;
    world.flags.returnAt[1] = world.tick + 100;
    advance(world, telemetry); // first run closes as flag returned
    world.players.position.set([TEAM_2_STAND.x, TEAM_2_STAND.y, TEAM_2_STAND.z], carrier * 3);
    advance(world, telemetry); // steps back onto the dropped flag: a second run starts

    const summary = finishCarrierTelemetry(telemetry, world);
    expect(summary.runs).toHaveLength(2);
    expect(runAt(summary, 0).endReason).toBe('flag returned');
    expect(runAt(summary, 0).pickupTick).toBe(1);
    expect(runAt(summary, 1).pickupTick).toBe(4);
    expect(runAt(summary, 1).endReason).toBe('matchEnd');
  });
});
