import { describe, expect, it } from 'vitest';
import type { App } from './app.js';
import { extraFor } from './debug.js';

/** A minimal fake NetClient/App -- only the fields extraFor actually reads (net.bots,
 *  net.remotePlayers, net.recentEvents, net.projectiles) need real values; everything
 *  else on App/NetClient this function never touches is irrelevant to it and is cast
 *  away, matching the narrow-fixture style this codebase's own sim tests already use
 *  (e.g. bots' steering.test.ts casting a bare `{ tick }` to `World` for checkStuck). */
function fakeApp(net: Record<string, unknown> | null): App {
  return {
    net,
    // Only reached when net is null (extraFor's activeProjectileCount fallback).
    world: { projectiles: { count: 0, active: new Uint8Array(0) } },
  } as unknown as App;
}

describe('extraFor', () => {
  it('splits bots by team, counting idle/attack/defend from BotState', () => {
    const app = fakeApp({
      bots: [
        { playerId: 1, state: 0 }, // team 1, idle
        { playerId: 2, state: 1 }, // team 1, attack
        { playerId: 3, state: 2 }, // team 2, defend
        { playerId: 4, state: 0 }, // team 2, idle
      ],
      remotePlayers: new Map([
        [1, { team: 1 }],
        [2, { team: 1 }],
        [3, { team: 2 }],
        [4, { team: 2 }],
      ]),
      projectiles: [],
      recentEvents: [],
    });
    const extra = extraFor(app);
    expect(extra.botsByTeam[0]).toBe('Team 1: 2 bots (1 idle, 1 attack, 0 defend)');
    expect(extra.botsByTeam[1]).toBe('Team 2: 2 bots (1 idle, 0 attack, 1 defend)');
  });

  it('skips a bot id with no matching remote player rather than crashing', () => {
    const app = fakeApp({
      bots: [{ playerId: 99, state: 1 }],
      remotePlayers: new Map(),
      projectiles: [],
      recentEvents: [],
    });
    const extra = extraFor(app);
    expect(extra.botsByTeam[0]).toBe('Team 1: 0 bots (0 idle, 0 attack, 0 defend)');
    expect(extra.botsByTeam[1]).toBe('Team 2: 0 bots (0 idle, 0 attack, 0 defend)');
  });

  it('reports zero bots on both teams with no net connection', () => {
    const app = fakeApp(null);
    const extra = extraFor(app);
    expect(extra.botsByTeam[0]).toBe('Team 1: 0 bots (0 idle, 0 attack, 0 defend)');
    expect(extra.botsByTeam[1]).toBe('Team 2: 0 bots (0 idle, 0 attack, 0 defend)');
  });
});
