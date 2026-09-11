import { test, expect } from '@playwright/test';
import { AUDIO_SOURCES } from '../packages/assets/src/audio-sources.js';
import type { App } from '../packages/client/src/app.js';
import { ARMORS, ArmorId } from '../packages/sim/src/armor.js';
import { defaultWeaponMask } from '../packages/sim/src/baseObjects.js';

test('original HUD artwork loads and all shipped recordings decode in Chromium', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  // #55: the rack renders exactly the player's carried weapon set and hides uncarried cells,
  // and the expectation comes from the simulation's own rule rather than a copy of the table.
  // A fresh spawn in Light armor has never visited a station, so it carries the armor's
  // DEFAULT loadout: three weapons, not the four the armor merely allows. This spec used to
  // mirror `allowedWeaponMask` by hand, so it silently disagreed with the client the moment
  // the weapon-slot cap landed (Light's allowed set is four weapons while its cap is three).
  // Importing the real helper is what keeps the two from drifting apart again.
  const state = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const id = app.playerId;
    const slots = [...document.querySelectorAll<HTMLElement>('#hud-weapon-rack .hud-weapon-slot')];
    return {
      stored: app.world.players.carriedWeapons[id] ?? 0,
      armor: app.world.players.armor[id] ?? 0,
      slots: slots.map((slot, index) => ({
        index,
        hidden: slot.hidden,
        loads: ((slot.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? 0) > 0,
      })),
    };
  });
  const armor = ARMORS[state.armor as ArmorId];
  const carried = state.stored === 0 ? defaultWeaponMask(armor) : state.stored;
  expect(carried).toBeGreaterThan(0);
  // The rack shows exactly as many cells as the armor has weapon slots, which is the cap the
  // station menu and the sim both enforce -- a fifth visible cell would mean the cap leaked.
  expect(state.slots.filter((slot) => !slot.hidden)).toHaveLength(armor.maxWeapons);
  for (const slot of state.slots) {
    expect(slot.hidden, `rack slot ${String(slot.index)} visibility`).toBe(
      (carried & (1 << slot.index)) === 0,
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
