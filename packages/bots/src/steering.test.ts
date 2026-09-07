import { describe, expect, it } from 'vitest';
import { createWorld, LIGHT_ARMOR, type Heightfield } from '@clans/sim';
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

describe('steerToward stuck-skip (Codex review round 3, P1)', () => {
  it('bypasses the graph and steers straight at the goal after STUCK_SKIP_THRESHOLD consecutive stalls, instead of retrying the identical unreachable route forever', () => {
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
    expect(runtime.path).toEqual([{ x: goal.x, z: goal.z }]);
    expect(runtime.pathIndex).toBe(0);
  });
});
