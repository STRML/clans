import { test, expect } from '@playwright/test';
import { AUDIO_SOURCES } from '../packages/assets/src/audio-sources.js';
import type { App } from '../packages/client/src/app.js';

test('original HUD artwork loads and all shipped recordings decode in Chromium', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  // #55: the rack renders exactly the player's carried weapon set (armor-allowed defaults
  // before any station visit), hides uncarried cells, and every rendered icon must load.
  // Fresh spawn here is Light armor, so the Mortar cell is hidden and the other four show.
  const rack = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const id = app.playerId;
    const stored = app.world.players.carriedWeapons[id] ?? 0;
    const armor = app.world.players.armor[id] ?? 0;
    // Mirror of sim/baseObjects.ts's allowedWeaponMask, indexed by ArmorId.
    const allowedByArmor: Record<number, number> = {
      0: (1 << 0) | (1 << 1) | (1 << 3) | (1 << 4), // Light: Laser Rifle, no Mortar
      1: (1 << 0) | (1 << 1) | (1 << 4), // Medium: neither
      2: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 4), // Heavy: Mortar, no Laser Rifle
    };
    const carried = stored === 0 ? (allowedByArmor[armor] ?? 0) : stored;
    const slots = [...document.querySelectorAll<HTMLElement>('#hud-weapon-rack .hud-weapon-slot')];
    return {
      carried,
      slots: slots.map((slot, index) => ({
        index,
        hidden: slot.hidden,
        loads: ((slot.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? 0) > 0,
      })),
    };
  });
  expect(rack.carried).toBeGreaterThan(0);
  for (const slot of rack.slots) {
    expect(slot.hidden, `rack slot ${String(slot.index)} visibility`).toBe(
      (rack.carried & (1 << slot.index)) === 0,
    );
    if (!slot.hidden) expect(slot.loads, `rack slot ${String(slot.index)} icon`).toBe(true);
  }
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
