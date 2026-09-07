import { expect, test } from '@playwright/test';

test('loads Katabatic and reaches running speed', async ({ page }) => {
  await page.goto('/');
  // The overlay stays hidden until F1; its data attributes update regardless.
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  // Run first, then hold Space. A held jump fires on every landing, so pressing both from a
  // standstill would measure hopping, not running.
  //
  // W+D, not W alone: M4 added real interior collision, and the default facing direction
  // (yaw 0, W alone) runs straight into a wall of the sbunk2 interior a short distance from
  // this team's spawn point within about 1.6 s -- a real, correct wall collision against the
  // committed Katabatic geometry, not a sim bug. This test has no pointer lock to steer via
  // mouse look, so W+D's diagonal heading is the way to pick a different world direction with
  // only keyboard input; it was checked directly against the same collision data (a headless
  // sim run, not just this e2e test) to confirm it stays clear and sustains a running speed
  // comfortably over this test's >5 m/s bar.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(2_000);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1_000);
  const speed = Number(await page.locator('#debug-speed').getAttribute('data-value'));
  expect(speed).toBeGreaterThan(5);
  const ground = Number(await page.locator('#debug-ground').getAttribute('data-value'));
  expect([0, 1]).toContain(ground);
});
