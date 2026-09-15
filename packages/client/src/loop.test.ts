import { describe, expect, it } from 'vitest';
import { MAX_STEPS_PER_FRAME, advance, frameDue, type Accumulator } from './loop.js';

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

describe('frameDue', () => {
  it('renders every other arrival on a 120 Hz display with a 60 fps budget', () => {
    let last = 0;
    const rendered: number[] = [];
    for (let i = 1; i <= 8; i += 1) {
      const now = i * 8.333;
      if (frameDue(last, now, 1000 / 60)) {
        last = now;
        rendered.push(i);
      }
    }
    expect(rendered).toEqual([2, 4, 6, 8]);
  });

  it('renders every arrival when the display runs at the budget itself', () => {
    let last = 0;
    let renders = 0;
    for (let i = 1; i <= 10; i += 1) {
      const now = i * (1000 / 60);
      if (frameDue(last, now, 1000 / 60)) {
        last = now;
        renders += 1;
      }
    }
    expect(renders).toBe(10);
  });

  it('renders the first frame after a long stall immediately', () => {
    expect(frameDue(0, 5000, 1000 / 60)).toBe(true);
    // Just-rendered: an immediately-following rAF arrival is skipped, jitter absorbed.
    expect(frameDue(5000, 5000 + 1000 / 240, 1000 / 60)).toBe(false);
  });
});
