import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('hold Z zooms without taking the jet button, and release restores FOV', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const fov = () => page.evaluate(() => (window as unknown as { __app: App }).__app.camera.fov);
  await expect.poll(fov).toBe(90);
  await page.keyboard.down('KeyZ');
  await expect.poll(fov).toBe(45);
  await page.mouse.down({ button: 'right' });
  expect(await page.evaluate(() => (window as unknown as { __app: App }).__app.input.jet)).toBe(
    true,
  );
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('KeyZ');
  await expect.poll(fov).toBe(90);
});

test('offline laser draws a red beam on a miss even in a multi-tick frame', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const p = app.world.players,
      id = app.playerId;
    app.input.pitch = 0.6;
    p.weaponSlot[id] = 3;
    p.weaponState[id] = 1;
    p.weaponTimer[id] = 0;
    p.energy[id] = 100;
    app.input.fire = true;
    // At 32Hz this runs two ticks; the first tick's shot must survive the second.
    app.frame(2 / 32);
    app.input.fire = false;
    app.paused = true;
    const beams = app.scene.children.filter((node) => node.type === 'Line') as unknown as Array<{
      material: { color: { getHex(): number } };
      geometry: { getAttribute(name: string): { count: number; array: ArrayLike<number> } };
    }>;
    return beams.map((beam) => ({
      color: beam.material.color.getHex(),
      points: beam.geometry.getAttribute('position').count,
    }));
  });
  expect(result).toContainEqual({ color: 0xff2222, points: 2 });
  await page.screenshot({ path: testInfo.outputPath('laser-rifle.png') });
});
