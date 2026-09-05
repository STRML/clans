import { stepWorld, type PlayerInput, type World } from '@clans/sim';

export interface BenchmarkResult {
  avgMs: number;
  maxMs: number;
}

export function runBenchmark(world: World, ticks: number): BenchmarkResult {
  const inputs = new Map<number, PlayerInput>(); // empty: every bot gets the sim's idle default
  let total = 0;
  let max = 0;
  for (let i = 0; i < ticks; i += 1) {
    const start = performance.now();
    stepWorld(world, inputs);
    const elapsed = performance.now() - start;
    total += elapsed;
    if (elapsed > max) max = elapsed;
  }
  return { avgMs: total / ticks, maxMs: max };
}
