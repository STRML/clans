import { expect, test } from '@playwright/test';

test('loads Katabatic and reaches running speed', async ({ page }) => {
  await page.goto('/');
  // The overlay stays hidden until F1; its data attributes update regardless.
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  await page.waitForTimeout(3_000);
  const speed = Number(await page.locator('#debug-speed').getAttribute('data-value'));
  expect(speed).toBeGreaterThan(5);
  const ground = Number(await page.locator('#debug-ground').getAttribute('data-value'));
  expect([0, 1]).toContain(ground);
});
