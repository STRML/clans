import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';
import { SNOW_FLAKE_COUNT } from '../packages/client/src/snow.js';

test('katabatic scene carries the snow field with the pinned flake count', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/');
  await page.locator('#hud[data-ready="1"]').waitFor();
  // Step the sim so a few frames render and the field has advanced past spawn.
  await page.evaluate(async () => {
    const app = (window as unknown as { __app: App }).__app;
    const snow = app.scene.getObjectByName('katabatic-snow') as unknown as {
      userData: {
        snow: { update: (dt: number, cam: { x: number; y: number; z: number }) => void };
      };
    };
    const cam = app.camera.position;
    for (let i = 0; i < 10; i += 1) snow.userData.snow.update(1 / 30, cam);
  });
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const snow = app.scene.getObjectByName('katabatic-snow');
    if (!snow) return { present: false as const };
    const positions = (
      snow as unknown as { geometry: { getAttribute: (n: string) => { count: number } } }
    ).geometry.getAttribute('position');
    return { present: true as const, count: positions.count };
  });
  expect(result.present).toBe(true);
  expect(result.count).toBe(SNOW_FLAKE_COUNT);
  // Visual proof for Main's eyeball pass at integration.
  await page.screenshot({ path: 'test-results/snow.png' });
});
