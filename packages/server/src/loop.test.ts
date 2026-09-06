import { describe, expect, it } from 'vitest';
import { TICK_MS, startTickLoop } from './loop.js';

describe('startTickLoop', () => {
  it('runs one tick per scheduled interval with no overrun', () => {
    let clock = 0;
    const ticks: number[] = [];
    const overruns: unknown[] = [];
    let pending: (() => void) | null = null;
    const loop = startTickLoop({
      now: () => clock,
      schedule: (cb) => {
        pending = cb;
      },
      onTick: (tick) => ticks.push(tick),
      onOverrun: (ms, behind) => overruns.push({ ms, behind }),
    });
    clock += TICK_MS;
    (pending as (() => void) | null)?.();
    expect(ticks).toEqual([0]);
    expect(overruns).toHaveLength(0);
    loop.stop();
  });

  it('catches up after a 100ms stall without skipping ticks and logs the overrun', () => {
    let clock = 0;
    const ticks: number[] = [];
    const overruns: Array<{ ms: number; behind: number }> = [];
    let pending: (() => void) | null = null;
    const loop = startTickLoop({
      now: () => clock,
      schedule: (cb) => {
        pending = cb;
      },
      onTick: (tick) => ticks.push(tick),
      onOverrun: (ms, behind) => overruns.push({ ms, behind }),
    });
    clock += 100;
    (pending as (() => void) | null)?.();
    expect(ticks).toEqual([0, 1, 2]);
    expect(overruns).toEqual([{ ms: 68, behind: 2 }]);
    loop.stop();
  });

  it('stops calling onTick after stop()', () => {
    let clock = 0;
    const ticks: number[] = [];
    let pending: (() => void) | null = null;
    const loop = startTickLoop({
      now: () => clock,
      schedule: (cb) => {
        pending = cb;
      },
      onTick: (tick) => ticks.push(tick),
      onOverrun: () => {},
    });
    loop.stop();
    clock += TICK_MS;
    (pending as (() => void) | null)?.();
    expect(ticks).toEqual([]);
  });
});
