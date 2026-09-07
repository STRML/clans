import { describe, expect, it } from 'vitest';
import { stepWorld } from '@clans/sim';
import { createBotManager, rebalanceTeams, stepBotManager, TARGET_TEAM_SIZE } from './bots.js';
import { createOrderBoard } from './orders.js';
import { loadKatabaticWorld } from './world.js';

describe('bot tick budget', () => {
  it('32 bots stay comfortably under the 32ms tick budget, isolated from network cost', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    const manager = createBotManager(world, spawns, [], TARGET_TEAM_SIZE * 2);
    rebalanceTeams(manager, world, spawns);
    const board = createOrderBoard();
    const start = performance.now();
    for (let tick = 0; tick < 5000; tick += 1) {
      const inputs = stepBotManager(manager, world, board);
      stepWorld(world, inputs);
    }
    const elapsed = performance.now() - start;
    const perTick = elapsed / 5000;
    expect(perTick).toBeLessThan(32);
  }, 60_000);
});
