import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const PORT = 17789; // distinct from server.spec.ts's own 17788 and the 7777 dev default.

let serverProcess: ChildProcess;

test.beforeAll(async () => {
  serverProcess = spawn(
    'pnpm',
    [
      '--filter',
      '@clans/server',
      'exec',
      'tsx',
      'src/index.ts',
      '--bots',
      '8',
      '--port',
      String(PORT),
    ],
    { stdio: 'pipe' },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 20_000);
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', reject);
  });
});

test.afterAll(() => {
  serverProcess.kill();
});

/** Parses debug.ts's own `formatTeamBots` text ("Team 1: 4 bots (1 idle, 2 attack, 1
 *  defend)") back into a total count, so this test can assert on the real bot roster without
 *  duplicating the format string. */
function totalBots(text: string): number {
  const match = /(\d+) bots \(/.exec(text);
  return match ? Number(match[1]) : 0;
}

// Judgment call (noted in the PR body): this test does NOT wait for an actual combat
// engagement (a PlayerKilled/LaserFired event, or a bot's debug state leaving Idle for
// Attack/Defend -- decideState (packages/bots/src/brain.ts) only leaves Idle once a bot has
// an acquired, in-range enemy target). Measured empirically this session: with 8 bots split
// 4v4 on a fresh Katabatic spawn, every bot stayed Idle for a full 30 seconds straight, zero
// PlayerKilled/LaserFired events -- team spawn clusters sit far enough apart that natural
// contact takes real wall-clock time well past what a single bounded test can safely wait
// for. That is the same class of risk the resource-safety rules already ruled out for a
// human "real journey" e2e test (see e2e/weapons.spec.ts and this milestone's Task 11 note).
// This test instead proves the real, merged bot system (server bot manager, team rebalancing,
// client bot rendering and the debug roster readout) is genuinely live and correctly rostered
// -- fast and deterministic -- rather than waiting on an unbounded natural engagement.
test('a human sees bots rendered and connected through the real bot manager, correctly rostered per team', async ({
  page,
}) => {
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 20_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 20_000 });
  // A worker reuses one browser process across every test file it runs, and a newly created
  // context/page is not always the CDP-active one for keyboard input without this immediately
  // before the first key press -- see voice-binds.spec.ts's own comment for the full
  // diagnosis (measured this session).
  await page.bringToFront();
  await page.keyboard.press('F1'); // reveals the (already-updating) debug overlay.

  // entities = the human plus every bot (matches server.spec.ts's own `--bots 3` -> 4 check).
  await expect
    .poll(async () => Number(await page.locator('#debug-entities').getAttribute('data-value')), {
      timeout: 10_000,
    })
    .toBe(9);

  // rebalanceTeams (packages/server/src/bots.ts) fills the team with fewer players first, so
  // an 8-bot budget with no humans on either team splits evenly, 4 and 4.
  await expect
    .poll(async () => totalBots((await page.locator('#debug-bots-team1').textContent()) ?? ''), {
      timeout: 10_000,
    })
    .toBe(4);
  await expect
    .poll(async () => totalBots((await page.locator('#debug-bots-team2').textContent()) ?? ''), {
      timeout: 10_000,
    })
    .toBe(4);
});
