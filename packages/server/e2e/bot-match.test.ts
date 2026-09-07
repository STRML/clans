import { describe, expect, it } from 'vitest';
import { stepWorld } from '@clans/sim';
import { createBotManager, rebalanceTeams, stepBotManager, TARGET_TEAM_SIZE } from '../src/bots.js';
import { createOrderBoard } from '../src/orders.js';
import { loadKatabaticWorld } from '../src/world.js';

const MATCH_TICKS = 5000; // Ours -- long enough at 32ms/tick (160s of simulated time) for
// a bot-only 16v16 match to plausibly produce at least one kill or capture, matching M2's
// own precedent (its bots-under-tick-budget bench also runs 5000 ticks).

describe('bot-only match', () => {
  it('produces at least one kill or a flag capture within MATCH_TICKS', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    const landmarks = spawns.map((s) => ({
      position: { x: s.position[0], y: s.position[1], z: s.position[2] },
      label: 'spawn',
    }));
    const manager = createBotManager(world, spawns, landmarks, TARGET_TEAM_SIZE * 2);
    rebalanceTeams(manager, world, spawns);
    const board = createOrderBoard();
    let anyDeath = false;
    for (let tick = 0; tick < MATCH_TICKS; tick += 1) {
      const inputs = stepBotManager(manager, world, board);
      stepWorld(world, inputs);
      if (world.pendingDeaths.length > 0) anyDeath = true;
      if (world.gameOver) break;
    }
    const anyCapture = (world.teamScores[1] ?? 0) > 0 || (world.teamScores[2] ?? 0) > 0;
    expect(anyDeath || anyCapture).toBe(true);
  }, 60_000);
});
