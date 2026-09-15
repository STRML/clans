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
/**
 * Whether a render is due. The rAF driver fires at the display's refresh (120 Hz on the
 * ProMotion Macs this gets played on), and every per-frame cost -- three's scene graph and
 * shadow pass, the HUD and nameplate DOM syncs -- scales with it, so the loop skips whole
 * frames once the elapsed time drops under the frame budget (half a millisecond of slack
 * absorbs rAF jitter). `last` stays at the last rendered frame's timestamp, so skipped
 * frames accumulate and the next render sees the real elapsed time as its dt.
 */
export function frameDue(last: number, now: number, frameBudgetMs: number): boolean {
  return now - last >= frameBudgetMs - 0.5;
}
