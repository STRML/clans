import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('a fresh player can walk out of spawn without teleporting', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const start = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    return Array.from(app.world.players.position.slice(app.playerId * 3, app.playerId * 3 + 3));
  });
  await page.keyboard.down('KeyW');
  try {
    // Software WebGL can spend seconds compiling textured materials. Assert actual
    // travel, not how many simulation frames happened in a two-second wall-clock window.
    await expect
      .poll(
        () =>
          page.evaluate((startZ) => {
            const app = (window as unknown as { __app: App }).__app;
            return app.world.players.position[app.playerId * 3 + 2]! - startZ;
          }, start[2]!),
        { timeout: 20000 },
      )
      .toBeGreaterThan(8);
  } finally {
    await page.keyboard.up('KeyW');
  }
});

test('base walls, floors, and equipment have loaded original diffuse textures', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = (window as unknown as { __app: App }).__app;
          let mapped = 0,
            missing = 0;
          app.scene.traverse((node) => {
            const mesh = node as import('three').Mesh;
            if (!mesh.isMesh) return;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              if (!material.userData.resource_path) continue;
              const map = (material as import('three').MeshStandardMaterial).map;
              if (map?.image?.width > 0) mapped++;
              else missing++;
            }
          });
          return { missing, enough: mapped > 100 };
        }),
      { timeout: 30000 },
    )
    .toEqual({ missing: 0, enough: true });
});

test('an ended match explains frozen movement prominently', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    app.world.gameOver = true;
  });
  const notice = page.locator('#hud-game-over');
  await expect(notice).toContainText('Movement is paused');
  const box = await notice.boundingBox();
  expect(box!.y).toBeLessThan(400);
  expect(box!.width).toBeGreaterThan(300);
});
