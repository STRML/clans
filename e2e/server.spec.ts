import type { App } from '../packages/client/src/app.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const PORT = 17788; // distinct from the 7777 default, so it never fights a running `pnpm dev`

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
      '3',
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

test('connects to a bots-only server and shows the right entity count', async ({ page }) => {
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await expect
    .poll(async () => Number(await page.locator('#debug-entities').getAttribute('data-value')), {
      timeout: 10_000,
    })
    .toBe(4);
});

test('a newly joined network player can walk away from spawn', async ({ page }) => {
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.net?.connected))
    .toBe(true);
  await page.waitForTimeout(200);
  const start = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    return app.world.players.position[app.playerId * 3 + 2]!;
  });
  await page.keyboard.down('KeyW');
  try {
    await expect
      .poll(
        () =>
          page.evaluate((origin) => {
            const app = (window as unknown as { __app: App }).__app;
            return app.world.players.position[app.playerId * 3 + 2]! - origin;
          }, start),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(8);
  } finally {
    await page.keyboard.up('KeyW');
  }
});
