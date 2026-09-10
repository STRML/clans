import { describe, expect, it } from 'vitest';
import type { App } from './app.js';
import { extraFor, pinNetworkTimeScale } from './debug.js';

/** A minimal fake NetClient/App -- only the fields these tests actually read (net.bots,
 *  net.remotePlayers, net.recentEvents, net.projectiles for extraFor; net-nullness and
 *  timeScale for pinNetworkTimeScale) need real values; everything else on App/NetClient
 *  this file never touches is irrelevant and is cast away, matching the narrow-fixture
 *  style this codebase's own sim tests already use (e.g. bots' steering.test.ts casting
 *  a bare `{ tick }` to `World` for checkStuck). */
function fakeApp(net: Record<string, unknown> | null, timeScale = 1): App {
  return {
    net,
    timeScale,
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

describe('pinNetworkTimeScale', () => {
  it('pins a networked session back to time scale 1 no matter what moved it (issue #7)', () => {
    // The F1 slider used to feed app.timeScale straight into the local accumulator, so a
    // scale above 1 in netplay stepped prediction past the server every frame. The pin
    // runs at panel construction and every frame after; a non-null `net` is the
    // networked-session signal (it exists exactly when launched with ?server=).
    const app = fakeApp({}, 4);
    expect(pinNetworkTimeScale(app)).toBe(true);
    expect(app.timeScale).toBe(1);
    // Already pinned: nothing to correct, so the caller skips the slider display refresh.
    expect(pinNetworkTimeScale(app)).toBe(false);
    expect(app.timeScale).toBe(1);
  });

  it('leaves single-player time scaling alone', () => {
    const app = fakeApp(null, 4);
    expect(pinNetworkTimeScale(app)).toBe(false);
    expect(app.timeScale).toBe(4);
  });
});
