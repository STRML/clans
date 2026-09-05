import { describe, expect, it } from 'vitest';
import { runBenchmark } from './bench.js';
import { addBots, loadKatabaticWorld } from './world.js';

describe('headless bot benchmark', () => {
  it('runs 5000 ticks with 32 idle bots under the 32ms tick budget', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    addBots(world, spawns, 32);
    const result = runBenchmark(world, 5000);
    console.info(
      `[bench] avg ${result.avgMs.toFixed(3)}ms max ${result.maxMs.toFixed(3)}ms over 5000 ticks`,
    );
    expect(result.avgMs).toBeLessThan(32);
  }, 30_000);
});
