import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const PORT = 17790; // distinct from every other e2e spec's own server port.

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
      '1',
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

/** `page.keyboard.press` fires keydown/keyup back to back, fast enough that the game's own
 *  requestAnimationFrame loop can miss the down state entirely between two rendered frames --
 *  the same reasoning vehicles.spec.ts's own `tapE` gives for every other edge-triggered key
 *  this suite drives (commandCirclePressedThisFrame/digitPressedThisFrame are the same shape
 *  as usePressedThisFrame). */
async function tapKey(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await page.waitForTimeout(300);
  await page.keyboard.up(code);
  await page.waitForTimeout(300);
}

/** Retries `tapKey` until `check` passes, matching vehicles.spec.ts's own `pressEUntil` --
 *  covers a worker's shared browser process occasionally not routing a `page.keyboard` press
 *  to a newly created page/context (measured this session: `page.bringToFront()` alone did
 *  not reliably fix it either), the same class of "a single edge can land on a missed frame"
 *  risk `pressEUntil` already exists to cover, just from a different root cause. */
async function tapKeyUntil(page: Page, code: string, check: () => Promise<boolean>): Promise<void> {
  await expect(async () => {
    if (await check()) return;
    await tapKey(page, code);
    expect(await check()).toBe(true);
  }).toPass({ timeout: 20_000 });
}

test('issuing an Attack order from the commander map places a marker for the issuing team', async ({
  page,
}) => {
  // Single-player has no `net` at all -- an order is a server-authoritative message
  // (Global Constraints), so this needs a real connected client, like bot-combat.spec.ts and
  // server.spec.ts, not the plain `/` single-player boot the plan's own draft used.
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 20_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 20_000 });
  await page.bringToFront();
  const canvas = page.locator('#commander-map');
  await tapKeyUntil(page, 'KeyC', () => canvas.isVisible()); // open the commander map.
  await canvas.click({ position: { x: 300, y: 200 } });
  // `window.__app` is the e2e-only handle main.ts sets in dev. The marker only appears once
  // the server has echoed the order back on a snapshot -- matching "an order is a message,
  // not client state" (Global Constraints) -- so this is the retry check for the Digit1
  // confirm too, not just a final poll: if the press didn't land, no order ever appears and
  // tapKeyUntil re-sends it.
  const ordersPresent = async (): Promise<boolean> =>
    page.evaluate(
      () =>
        (window as unknown as { __app: { net: { orders: unknown[] } } }).__app.net.orders.length >
        0,
    );
  await tapKeyUntil(page, 'Digit1', ordersPresent); // confirm Attack.
});
