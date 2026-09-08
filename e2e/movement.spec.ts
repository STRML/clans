import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('loads Katabatic and reaches running speed', async ({ page }) => {
  await page.goto('/');
  // The overlay stays hidden until F1; its data attributes update regardless.
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  // Test acceleration on the open center valley, independently of the bunker spawn's walls.
  await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const terrain = app.assets.terrain;
    const col = 128,
      row = 128;
    const y =
      app.assets.heights[row * terrain.gridSize + col]! / terrain.heightScale + terrain.origin.y;
    app.world.players.position.set(
      [
        terrain.origin.x + col * terrain.squareSize,
        y + 0.1,
        terrain.origin.z - row * terrain.squareSize,
      ],
      app.playerId * 3,
    );
    app.world.players.velocity.fill(0, app.playerId * 3, app.playerId * 3 + 3);
  });
  // Run first, then hold Space; starting with both measures hopping rather than running.
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

test('jetting preserves airborne horizontal momentum', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const startTick = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    // Isolate flight from terrain slopes and walls; the sim regression covers takeoff.
    app.world.players.position.set([0, 200, 0], app.playerId * 3);
    app.world.players.velocity.set([0, 0, 15], app.playerId * 3);
    return app.world.tick;
  });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  await page.mouse.down({ button: 'right' });
  try {
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.world.tick), {
        timeout: 20000,
      })
      .toBeGreaterThan(startTick + 30);
    const state = await page.evaluate(() => {
      const app = (window as unknown as { __app: App }).__app;
      return {
        speed: app.world.players.velocity[app.playerId * 3 + 2],
        grounded: app.world.players.onGround[app.playerId],
        energy: app.world.players.energy[app.playerId],
      };
    });
    expect(state.grounded).toBe(0);
    expect(state.energy).toBeLessThan(60);
    expect(state.speed).toBeCloseTo(15, 5);
  } finally {
    await page.mouse.up({ button: 'right' });
    await page.keyboard.up('Space');
    await page.keyboard.up('KeyW');
  }
});
