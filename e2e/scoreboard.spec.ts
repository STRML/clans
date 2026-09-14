import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const PORT = 17789; // Distinct from server.spec's 17788 and the 7777 dev default.

// A bots-only match on one page: the roster's whole point is that 24 simulated players --
// none of which have a connection to measure a ping on -- still render a complete,
// populated score table next to the one human.
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
      '24',
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

test('holding Tab shows a fully populated roster overlay and releasing hides it', async ({
  page,
}) => {
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });

  // Hidden until the key goes down: the overlay must not exist on screen at rest.
  await expect(page.locator('#scoreboard')).toHaveAttribute('data-visible', '0');

  await page.keyboard.down('Tab');
  const scoreboard = page.locator('#scoreboard');
  await expect(scoreboard).toHaveAttribute('data-visible', '1');

  // 24 bots joined before us, so the table lists the full match: well over the 20-row
  // floor, every row with a name and integer count columns (bots legitimately show 0 ping
  // -- there is no connection to measure -- which is still a populated, sane column).
  const rows = page.locator('#scoreboard .scoreboard-row');
  await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBeGreaterThan(20);

  const rowCount = await rows.count();
  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const name = await row.locator('.scoreboard-name').textContent();
    expect(name?.trim().length ?? 0).toBeGreaterThan(0);
    for (const column of ['.scoreboard-kills', '.scoreboard-deaths', '.scoreboard-ping']) {
      const value = Number(await row.locator(column).getAttribute('data-value'));
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }

  // Exactly one row is marked as the local player, and it is this client's own roster row.
  await expect(scoreboard.locator('.scoreboard-row[data-local="1"]')).toHaveCount(1);

  // T2's scoreboard is held, not toggled: release Tab and it goes away.
  await page.keyboard.up('Tab');
  await expect(scoreboard).toHaveAttribute('data-visible', '0');
});
