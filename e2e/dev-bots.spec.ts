import type { App } from '../packages/client/src/app.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

// The user-reported dev-path regression: `pnpm dev` booted a game server full of bots while
// the dev page silently ran the offline single-player world, because nothing ever told the
// page where the server is. The fix pairs them with VITE_GAME_SERVER (scripts/dev.ts passes
// it, main.ts falls back to it when `?server=` is absent), so this suite reproduces that
// pairing in isolation: its own game server and its own vite with the variable set, on
// ports distinct from every other suite (server.spec's 17788, demo.spec's 17789/5174, the
// shared webServer's 5173) and from a live `pnpm dev` (7777/5173), so the regression never
// fights the developer's own running session.
const GAME_PORT = 17790;
const VITE_PORT = 5191;
const VITE_URL = `http://127.0.0.1:${String(VITE_PORT)}`;

let serverProcess: ChildProcess;
let viteProcess: ChildProcess;

test.beforeAll(async () => {
  // The exact argv shape `pnpm dev:server` produces, including the literal `--` pnpm 11
  // forwards into tsx's argv (cli.ts ignores unknown args, so this also pins that the
  // dev script's flags survive the passthrough).
  serverProcess = spawn(
    'pnpm',
    ['--filter', '@clans/server', 'start', '--', '--bots', '31', '--port', String(GAME_PORT)],
    { stdio: 'pipe' },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('game server did not start in time')),
      20_000,
    );
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', reject);
  });

  // The client half of `pnpm dev`: vite with VITE_GAME_SERVER in its environment. Vite only
  // exposes VITE_-prefixed variables to import.meta.env, which is the channel main.ts reads.
  viteProcess = spawn(
    'pnpm',
    ['--filter', '@clans/client', 'exec', 'vite', '--port', String(VITE_PORT), '--strictPort'],
    {
      env: { ...process.env, VITE_GAME_SERVER: `ws://127.0.0.1:${String(GAME_PORT)}` },
      stdio: 'pipe',
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('dev vite did not start in time')), 20_000);
    viteProcess.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready in')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    viteProcess.on('error', reject);
  });
});

test.afterAll(() => {
  serverProcess.kill();
  viteProcess.kill();
});

test('a bare dev page with no ?server= follows the paired game server and shows its bots', async ({
  page,
}) => {
  await page.goto(VITE_URL);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  // 31 bots plus this page's own player, the same bots+1 arithmetic server.spec.ts asserts.
  await expect
    .poll(async () => Number(await page.locator('#debug-entities').getAttribute('data-value')), {
      timeout: 10_000,
    })
    .toBe(32);
  // The pairing's success half of the connection chip: online, so the chip stays hidden.
  await expect(page.locator('#hud-connection')).toBeHidden();
});

test('?server=off opts a paired dev page out and lands in the offline single-player world', async ({
  page,
}) => {
  await page.goto(`${VITE_URL}/?server=off`);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await expect
    .poll(async () => Number(await page.locator('#debug-entities').getAttribute('data-value')), {
      timeout: 10_000,
    })
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __app: App }).__app.net?.connected ?? false),
    )
    .toBe(false);
  // The chip is the page's answer to "why are there no bots?": the offline world announces
  // itself instead of looking like a match whose bots all left.
  const chip = page.locator('#hud-connection');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('PRACTICE MODE (offline)');
});
