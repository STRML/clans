import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  buildInteriorCollider,
  createWorld,
  LIGHT_ARMOR,
  type Heightfield,
} from '@clans/sim';
import {
  checkStuck,
  STUCK_CHECK_TICKS,
  STUCK_SKIP_THRESHOLD,
  steerToward,
  worldDirectionToLocalMove,
} from './steering.js';
import { buildWaypointGraph } from './waypoints.js';
import { createBotRuntimeState, BotRole } from './types.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 2000,
  originX: -1000,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('worldDirectionToLocalMove', () => {
  it('facing +Z (yaw 0), moving toward +Z gives pure forward', () => {
    const { moveX, moveZ } = worldDirectionToLocalMove({ x: 0, y: 0, z: 1 }, 0);
    expect(moveZ).toBeCloseTo(1, 5);
    expect(moveX).toBeCloseTo(0, 5);
  });

  it('facing +Z (yaw 0), moving toward world +X gives a pure strafe with no forward component', () => {
    // Adapted from the plan's draft, which expected moveX = +1 here. Real movement.ts's
    // own heading formula (`heading.x = moveZ*sin(yaw) - moveX*cos(yaw)`) is the ground
    // truth this function inverts exactly (verified algebraically): at yaw 0, a positive
    // moveX (the D key) produces world heading (-1, 0, 0), not (+1, 0, 0) -- so the
    // correct inverse for a world +X direction is moveX = -1, not +1. Only the sign in
    // the plan's own expectation was wrong; the implementation matches real movement.ts.
    const { moveX, moveZ } = worldDirectionToLocalMove({ x: 1, y: 0, z: 0 }, 0);
    expect(moveX).toBeCloseTo(-1, 5);
    expect(moveZ).toBeCloseTo(0, 5);
  });

  it('facing 90 degrees (+X), moving toward +X gives pure forward', () => {
    const { moveX, moveZ } = worldDirectionToLocalMove({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    expect(moveZ).toBeCloseTo(1, 5);
    expect(moveX).toBeCloseTo(0, 5);
  });
});

describe('checkStuck', () => {
  it('is false immediately after a fresh goal', () => {
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    runtime.goalKey = 'flag:1';
    const world = { tick: 0 } as unknown as Parameters<typeof checkStuck>[1];
    expect(checkStuck(runtime, world, { x: 0, y: 0, z: 0 })).toBe(false);
  });

  it('is true after STUCK_CHECK_TICKS with under STUCK_MIN_PROGRESS of movement', () => {
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    runtime.goalKey = 'flag:1';
    const worldAt = (tick: number) => ({ tick }) as unknown as Parameters<typeof checkStuck>[1];
    checkStuck(runtime, worldAt(0), { x: 0, y: 0, z: 0 }); // sets the baseline
    const result = checkStuck(runtime, worldAt(61), { x: 0.2, y: 0, z: 0 });
    expect(result).toBe(true);
  });

  it('resets its baseline after reporting stuck, so a second stall is detected independently', () => {
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    runtime.goalKey = 'flag:1';
    const worldAt = (tick: number) => ({ tick }) as unknown as Parameters<typeof checkStuck>[1];
    checkStuck(runtime, worldAt(0), { x: 0, y: 0, z: 0 });
    expect(checkStuck(runtime, worldAt(61), { x: 0, y: 0, z: 0 })).toBe(true);
    // Baseline reset to tick 61 / position (0,0,0) by the call above -- 60 ticks later with
    // real movement in between must NOT report stuck again immediately.
    expect(checkStuck(runtime, worldAt(90), { x: 5, y: 0, z: 0 })).toBe(false);
  });
});

describe('steerToward net-progress stall detection (issue #32)', () => {
  it('arms the escape for a bot orbiting its waypoint without closing the gap, where the absolute-distance window never fired', () => {
    // The measured carrier shape: in a production seed-1 match (BOT_TELEMETRY=1) carrier 11
    // held one graph node as its target for 3020 ticks -- closest approach 3.5 m, last
    // sample 37.5 m -- circling it in a ~35 m pocket while closing 19 m of a 995 m route
    // and travelling 2886 m. The old window compared the scalar distance against its
    // baseline with Math.hypot, so a lap that swings the radius by more than a metre read
    // as progress every window and the streak never left 0 (0 escape fires in the run).
    const world = createWorld(flat, 1);
    const graph = buildWaypointGraph([{ position: { x: 0, y: 0, z: 0 }, label: 'a' }]);
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    const goal = { x: 0, y: 0, z: 0 };
    const stuckPosition = { x: 0, y: 0, z: 0 };
    // One lap per window, radius swinging 15 m -> 30 m -> 15 m: every window changes the
    // scalar distance by ~15 m (the old metric's idea of progress) while the running best
    // is never beaten after the first approach.
    let escaped = false;
    const ticks = STUCK_CHECK_TICKS * (STUCK_SKIP_THRESHOLD + 3);
    for (let t = 0; t <= ticks; t += 1) {
      world.tick = t;
      const radius = 22.5 + 7.5 * Math.sin((t / STUCK_CHECK_TICKS) * Math.PI * 2);
      steerToward(
        graph,
        world,
        1,
        runtime,
        1,
        goal,
        'goal:a',
        { x: stuckPosition.x, y: 0, z: radius },
        LIGHT_ARMOR,
        60,
      );
      if (runtime.path.length === 2) escaped = true;
    }
    expect(escaped).toBe(true);
  });

  it('does not fire while the gap keeps coming down, however slowly the route turns', () => {
    // The other half of the contract: net progress is a shrinking gap, so a bot that keeps
    // closing ground toward its waypoint must never be flagged -- a false positive here
    // would fabricate a lateral escape mid-route. Position steps 0.5 m per tick toward the
    // target, well under STUCK_MIN_PROGRESS per window only in aggregate: the running best
    // improves every tick.
    const world = createWorld(flat, 1);
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 0, y: 0, z: 400 }, label: 'b' },
    ]);
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    const goal = { x: 0, y: 0, z: 400 };
    for (let t = 0; t <= STUCK_CHECK_TICKS * (STUCK_SKIP_THRESHOLD + 2); t += 1) {
      world.tick = t;
      steerToward(
        graph,
        world,
        1,
        runtime,
        1,
        goal,
        'goal:b',
        { x: 0, y: 0, z: -4000 + t * 0.5 },
        LIGHT_ARMOR,
        60,
      );
      expect(runtime.stuckStreak).toBe(0);
    }
    // Still on the graph route: the escape fabricates exactly two points, so a route of
    // three or more is proof the ladder never armed.
    expect(runtime.path.length).toBeGreaterThan(2);
  });
});

describe('steerToward stuck-skip (Codex review round 3, P1)', () => {
  it('after STUCK_SKIP_THRESHOLD consecutive stalls, escapes along a perpendicular offset before re-approaching the goal instead of steering straight into the same wall (#32)', () => {
    const world = createWorld(flat, 1);
    world.tick = 0;
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 50, y: 0, z: 0 }, label: 'b' },
      { position: { x: 100, y: 0, z: 0 }, label: 'c' },
    ]);
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    // The bot's position never actually changes across every call below -- simulating a
    // waypoint the coarse graph offers but real movement can never reach (a wall, a cliff,
    // any 3D obstacle a 2D straight-line edge can't see).
    const stuckPosition = { x: 0, y: 0, z: 0 };
    const goal = { x: 100, y: 0, z: 0 };
    steerToward(graph, world, 1, runtime, 1, goal, 'goal:c', stuckPosition, LIGHT_ARMOR, 60);
    expect(runtime.path.length).toBeGreaterThan(1); // still following the multi-node graph route
    for (let i = 0; i < STUCK_SKIP_THRESHOLD; i += 1) {
      world.tick += STUCK_CHECK_TICKS + 1;
      steerToward(graph, world, 1, runtime, 1, goal, 'goal:c', stuckPosition, LIGHT_ARMOR, 60);
    }
    // The pre-#32 fallback steered straight at the literal goal -- the exact wall the bot
    // has been wedged against for three straight windows. The escape now aims 12 m left
    // (first skip flips the side from its +1 default to -1) of the approach line, THEN at
    // the goal from the new side.
    expect(runtime.path).toEqual([
      { x: 0, z: -12 },
      { x: goal.x, z: goal.z },
    ]);
    expect(runtime.pathIndex).toBe(0);
  });

  it('preserves consecutive stalls between per-tick checks, so the perpendicular escape is reachable in a real match', () => {
    const world = createWorld(flat, 1);
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 50, y: 0, z: 0 }, label: 'b' },
      { position: { x: 100, y: 0, z: 0 }, label: 'c' },
    ]);
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    const stuckPosition = { x: 0, y: 0, z: 0 };
    const goal = { x: 100, y: 0, z: 0 };

    for (world.tick = 0; world.tick <= STUCK_CHECK_TICKS * STUCK_SKIP_THRESHOLD; world.tick += 1) {
      steerToward(graph, world, 1, runtime, 1, goal, 'goal:c', stuckPosition, LIGHT_ARMOR, 60);
    }

    expect(runtime.path.length).toBe(2); // escape point + the real goal, not a one-point suicide run
    expect(runtime.path[1]).toEqual({ x: goal.x, z: goal.z });
  });

  it('refuses to fabricate an escape whose run to the goal crosses a wall, leaving the graph route alone', () => {
    // The escape is the only path steering writes itself, so it carries the same interior
    // check the graph's own edges do. Measured before the gate existed: armed by the
    // net-progress window, the unvalidated rung fired 10-22 times per 6000-tick match and
    // bots spent 583-900 ticks walking those straight lines toward goals up to a kilometre
    // away -- in the matched pair the first flag pickup slipped from ticks
    // 2413/2734/2777/2347 to 5586/5860/3203/never. Falling back to skipping the wedged
    // waypoint measured just as costly (5661/never/4475/3055); leaving the route alone
    // cost nothing (2465/3277/2692/3386), so a blocked escape does not touch the path.
    const world = createWorld(flat, 1);
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 50, y: 0, z: 0 }, label: 'b' },
      { position: { x: 100, y: 0, z: 0 }, label: 'c' },
    ]);
    // A wall at x = 50 spanning z -40..-4 (y 0..10): the escape's sideways step
    // (0,0,0) -> (0,0,-12) clears it, but the straight run from there to (100,0,0) crosses
    // it at z ~= -6.
    world.interiors = [
      buildInteriorCollider(
        {
          positions: new Float32Array([
            50, 0, -40, 50, 10, -40, 50, 10, -4, 50, 0, -40, 50, 10, -4, 50, 0, -4,
          ]),
        },
        { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } },
      ),
    ];
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    const stuckPosition = { x: 0, y: 0, z: 0 };
    const goal = { x: 100, y: 0, z: 0 };
    for (let t = 0; t <= STUCK_CHECK_TICKS * STUCK_SKIP_THRESHOLD; t += 1) {
      world.tick = t;
      steerToward(graph, world, 1, runtime, 1, goal, 'goal:c', stuckPosition, LIGHT_ARMOR, 60);
    }
    // Still a graph route (which always ends at the literal goal), not the fabricated
    // offset -> goal pair.
    expect(runtime.path.length).toBeGreaterThan(2);
    expect(runtime.path[runtime.path.length - 1]?.x).toBe(100);
  });
});

describe('steerToward goal-drift repath (closes #33)', () => {
  it('repaths when the goal position drifts far past GOAL_DRIFT_REPATH_M even though goalKey is unchanged', () => {
    // Today's needsNewPath only checks goalKey/pathIndex/path.length, never whether the
    // goal itself moved -- an escort or flag-chase target that walks away from its first
    // steerToward call leaves the bot's path heading toward the stale original position
    // forever, since the goalKey ('escort:<id>' or similar) never changes.
    const world = createWorld(flat, 1);
    world.tick = 0;
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 50, y: 0, z: 0 }, label: 'b' },
      { position: { x: 100, y: 0, z: 0 }, label: 'c' },
    ]);
    const runtime = createBotRuntimeState(1, BotRole.Attacker, 1);
    const position = { x: 0, y: 0, z: 0 };

    steerToward(
      graph,
      world,
      1,
      runtime,
      1,
      { x: 100, y: 0, z: 0 },
      'goal:carrier',
      position,
      LIGHT_ARMOR,
      60,
    );
    // Waypoints now carry their y along (issue #32 pocket detection reads it); flat
    // worlds snap every y to 0.
    expect(runtime.path.at(-1)).toEqual({ x: 100, z: 0, y: 0 });

    // Same goalKey, goal moved 100 m -- far past GOAL_DRIFT_REPATH_M (6 m).
    steerToward(
      graph,
      world,
      1,
      runtime,
      1,
      { x: 0, y: 0, z: 0 },
      'goal:carrier',
      position,
      LIGHT_ARMOR,
      60,
    );
    expect(runtime.path.at(-1)).toEqual({ x: 0, z: 0, y: 0 });
  });
});

describe('steerToward fall arrest (issue #32)', () => {
  /** Drops bot 1 at `height` above the flat ground with vertical velocity `vy` and runs
   *  one steerToward toward (100, 0, 0). Fall damage is the measured #1 carrier killer on
   *  real Katabatic (every carrier death in the traced seed-1 production match was
   *  attackerId -1 at 30-90 m/s landing speeds), so an airborne bot whose predicted
   *  landing speed clears the damage-free minJumpSpeed by a real margin must spend jets
   *  on the fall. */
  function steerFalling(height: number, vy: number, onGround: number) {
    const world = createWorld(flat, 1);
    const bot = addPlayer(world, { x: 0, y: height, z: 0 }, 1);
    world.players.velocity.set([0, vy, 0], bot * 3);
    world.players.onGround[bot] = onGround;
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 100, y: 0, z: 0 }, label: 'b' },
    ]);
    const runtime = createBotRuntimeState(bot, BotRole.Attacker, 1);
    return steerToward(
      graph,
      world,
      1,
      runtime,
      bot,
      { x: 100, y: 0, z: 0 },
      'goal:far',
      { x: 0, y: height, z: 0 },
      LIGHT_ARMOR,
      60,
    );
  }

  it('jets a fast high fall instead of eating the landing', () => {
    // 50 m up at vy -30: predicted impact sqrt(30^2 + 2*20*50) ~= 54 m/s -- nearly twice
    // the damage-free landing speed. The arrest also suppresses the held-jump landing hop,
    // which would re-launch the fall it just paid energy to soften.
    const input = steerFalling(50, -30, 0);
    expect(input.jet).toBe(true);
    expect(input.jump).toBe(false);
  });

  it('never burns energy on a grounded bot', () => {
    const input = steerFalling(0, 0, 1);
    expect(input.jet).toBe(false);
    expect(input.jump).toBe(false);
  });

  it('leaves short low-speed hops alone: predicted impact under the damage threshold', () => {
    // 3 m up at vy -10: predicted impact ~= 14.8 m/s, UNDER LIGHT minJumpSpeed (20) --
    // the landing is free, and the ski-hop that launched it is the point of skiing.
    const input = steerFalling(3, -10, 0);
    expect(input.jet).toBe(false);
  });
});
