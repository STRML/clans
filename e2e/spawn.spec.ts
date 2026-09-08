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
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  const end = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    return Array.from(app.world.players.position.slice(app.playerId * 3, app.playerId * 3 + 3));
  });
  expect(end[2]! - start[2]!).toBeGreaterThan(8);
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
