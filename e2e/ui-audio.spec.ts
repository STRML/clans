import { test, expect } from '@playwright/test';
import { AUDIO_SOURCES } from '../packages/assets/src/audio-sources.js';
import type { App } from '../packages/client/src/app.js';

test('original HUD artwork loads and all shipped recordings decode in Chromium', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(() =>
      page
        .locator('#hud-weapon-rack img')
        .evaluateAll(
          (images) =>
            images.length === 5 &&
            images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  const recordings = await page.evaluate(async (files) => {
    const context = new AudioContext();
    try {
      return await Promise.all(
        files.map(async (file) => {
          const response = await fetch('./katabatic/audio/' + file);
          if (!response.ok) return { file, duration: 0 };
          const audio = await context.decodeAudioData(await response.arrayBuffer());
          return { file, duration: audio.duration };
        }),
      );
    } finally {
      await context.close();
    }
  }, Object.keys(AUDIO_SOURCES));
  expect(recordings.filter((recording) => recording.duration <= 0)).toEqual([]);
  await expect(page.locator('#hud-status-art')).toHaveCSS('background-image', /hud_new_cog/);
  await page.screenshot({ path: testInfo.outputPath('infantry.jpg'), quality: 85 });

  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  await page.getByRole('button', { name: 'Shrike', exact: true }).click();
  await page.evaluate(() => {
    const app = window.__app as App;
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      for (let i = 0; i < 220; i++) app.frame(0.032);
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  });
  await expect(page.locator('#hud-vehicle .vehicle-icon')).toHaveAttribute(
    'src',
    /hud_veh_icon_shrike/,
  );
  await expect(page.locator('#crosshair')).toHaveCSS('background-image', /hud_ret_shrike/);
  expect(
    await page.evaluate(() => {
      const before = document.querySelector('#hud-vehicle .vehicle-dash');
      window.__app?.frame(0);
      return before === document.querySelector('#hud-vehicle .vehicle-dash');
    }),
  ).toBe(true);
  await expect
    .poll(() =>
      page
        .locator('#hud-vehicle img')
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cockpit.jpg'), quality: 85 });
});
