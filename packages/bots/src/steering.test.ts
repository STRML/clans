import { describe, expect, it } from 'vitest';
import { checkStuck, worldDirectionToLocalMove } from './steering.js';
import { createBotRuntimeState, BotRole } from './types.js';

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
