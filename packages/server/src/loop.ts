import { FIXED_TICK_MS } from '@clans/sim';

export const TICK_MS = FIXED_TICK_MS;

export interface TickLoopOptions {
  onTick: (tick: number) => void;
  onOverrun: (overrunMs: number, ticksBehind: number) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => void;
}
export interface TickLoop {
  stop(): void;
}

/**
 * Runs onTick once per TICK_MS. If a call to runDueTicks finds more than one tick due, it
 * runs all of them in order — never fewer — and reports the overrun once, with how many
 * extra ticks it had to catch up on.
 */
export function startTickLoop(options: TickLoopOptions): TickLoop {
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ??
    ((callback, delayMs) => {
      setTimeout(callback, delayMs);
    });
  let nextTickAt = now() + TICK_MS;
  let tick = 0;
  let stopped = false;

  function runDueTicks(): void {
    const current = now();
    const startedAt = nextTickAt;
    let ticksToRun = 0;
    while (nextTickAt <= current) {
      nextTickAt += TICK_MS;
      ticksToRun += 1;
    }
    if (ticksToRun > 1) options.onOverrun(current - startedAt, ticksToRun - 1);
    for (let i = 0; i < ticksToRun; i += 1) {
      options.onTick(tick);
      tick += 1;
    }
  }

  function frame(): void {
    if (stopped) return;
    runDueTicks();
    schedule(frame, Math.max(0, nextTickAt - now()));
  }
  schedule(frame, TICK_MS);
  return {
    stop: () => {
      stopped = true;
    },
  };
}
