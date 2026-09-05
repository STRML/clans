import { describe, expect, it } from 'vitest';
import { MAX_STEPS_PER_FRAME, advance, type Accumulator } from './loop.js';

const DT = 0.032;

describe('advance', () => {
  it('accumulates sub-tick frames into whole steps', () => {
    const acc: Accumulator = { remainder: 0 };
    let steps = 0;
    for (let frame = 0; frame < 32; frame += 1) steps += advance(acc, 1 / 60, 1, DT);
    expect(steps).toBe(16);
    expect(acc.remainder).toBeCloseTo(32 / 60 - 16 * DT);
  });

  it('caps a long frame and drops the excess time', () => {
    const acc: Accumulator = { remainder: 0 };
    expect(advance(acc, 1, 1, DT)).toBe(MAX_STEPS_PER_FRAME);
    expect(acc.remainder).toBe(0);
  });

  it('runs nothing at time scale zero or for a negative frame', () => {
    const acc: Accumulator = { remainder: 0 };
    expect(advance(acc, 0.1, 0, DT)).toBe(0);
    expect(advance(acc, -0.1, 1, DT)).toBe(0);
    expect(acc.remainder).toBe(0);
  });

  it('scales frame time by the time scale', () => {
    const acc: Accumulator = { remainder: 0 };
    expect(advance(acc, DT, 4, DT)).toBe(4);
  });
});
