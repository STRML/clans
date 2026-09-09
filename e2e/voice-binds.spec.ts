import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { AUDIO_SOURCES } from '../packages/assets/src/audio-sources.js';

const PORT = 17791; // distinct from every other e2e spec's own server port.

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
 *  this suite drives. Same shape as command-circuit.spec.ts's own `tapKey`. */
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

test('pressing V then a digit plays the original voice recording after its server broadcast', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const probe = window as unknown as { __playedDurations: number[]; __decodedCount: number };
    probe.__playedDurations = [];
    probe.__decodedCount = 0;
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (bytes: ArrayBuffer) {
      return decode.call(this, bytes).then((buffer) => {
        probe.__decodedCount++;
        return buffer;
      });
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      if (this.buffer) probe.__playedDurations.push(this.buffer.duration);
      start.apply(this, args);
    };
  });
  // Single-player has no event stream at all (hudSourceFrom's own single-player branch
  // always returns []), so playback -- which only ever fires off the server's own
  // VoiceBindPlayed broadcast, sender included -- needs a real connected client, like
  // command-circuit.spec.ts, not the plain `/` single-player boot the plan's own draft used.
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 20_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 20_000 });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __decodedCount: number }).__decodedCount),
    )
    .toBeGreaterThanOrEqual(Object.keys(AUDIO_SOURCES).length);
  const expectedDuration = await page.evaluate(async () => {
    const context = new AudioContext();
    try {
      const response = await fetch('./katabatic/audio/voice-target-destroyed.m4a');
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      return buffer.duration;
    } finally {
      await context.close();
    }
  });
  await page.bringToFront();
  const menuVisible = async (): Promise<boolean> => page.locator('#voice-menu').isVisible();
  await tapKeyUntil(page, 'KeyV', menuVisible);
  await tapKeyUntil(page, 'Digit1', async () => !(await menuVisible()));
  await expect
    .poll(
      () =>
        page.evaluate(
          (duration) =>
            (window as unknown as { __playedDurations: number[] }).__playedDurations.some(
              (played) => Math.abs(played - duration) < 0.001,
            ),
          expectedDuration,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
});
