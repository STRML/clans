import { test, expect } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';
test('an idle Shrike stays alive and undamaged on its vehicle platform', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  await page.getByRole('button', { name: 'Shrike', exact: true }).click();
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    // Exercise simulation and pose updates without flooding the software GPU queue.
    // The separate rendering test verifies drawing; restore and draw the final pose here.
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      const records = [];
      for (let i = 0; i < 160; i++) {
        app.frame(1 / 32);
        const v = app.world.vehicles;
        if (i < 8 || i % 10 === 0 || v.destroyed[0])
          records.push({
            i,
            active: v.active[0],
            destroyed: v.destroyed[0],
            pos: Array.from(v.position.slice(0, 3)),
            vel: Array.from(v.velocity.slice(0, 3)),
            energy: v.energy[0],
            damage: v.damage[0],
          });
        if (v.destroyed[0]) break;
      }
      return records;
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  });
  expect(result.at(-1)?.damage).toBe(0);
  expect(result.at(-1)?.energy).toBe(280);
  expect(result.at(-1)?.vel[1]).toBeCloseTo(0);
  expect(result.at(-1)?.destroyed).toBe(0);
});
