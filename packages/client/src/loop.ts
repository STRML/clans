export const MAX_STEPS_PER_FRAME = 5;

export interface Accumulator {
  remainder: number;
}

/**
 * Fixed-step accumulator. Returns the number of simulation steps to run for this frame.
 * A frame longer than MAX_STEPS_PER_FRAME steps drops the excess instead of spiralling.
 */
export function advance(
  acc: Accumulator,
  frameSeconds: number,
  timeScale: number,
  fixedDt: number,
): number {
  acc.remainder += Math.max(0, frameSeconds) * timeScale;
  const steps = Math.floor(acc.remainder / fixedDt);
  if (steps > MAX_STEPS_PER_FRAME) {
    acc.remainder = 0;
    return MAX_STEPS_PER_FRAME;
  }
  acc.remainder -= steps * fixedDt;
  return steps;
}
