import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('all five original first-person weapons load textured geometry and render when selected', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = (window as unknown as { __app: App }).__app;
          return app.weaponModel.root.children.filter(
            (model) => model.userData.shapeStatus === 'loaded',
          ).length;
        }),
      { timeout: 20_000 },
    )
    .toBe(5);
  for (let weapon = 0; weapon < 5; weapon++) {
    await page.evaluate((id) => {
      const app = (window as unknown as { __app: App }).__app;
      app.world.players.weaponSlot[app.playerId] = id;
    }, weapon);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const app = (window as unknown as { __app: App }).__app;
          return app.weaponModel.root.userData.weaponId;
        }),
      )
      .toBe(weapon);
    const rendered = await page.evaluate(() => {
      const app = (window as unknown as { __app: App }).__app;
      const root = app.weaponModel.root;
      const models = root.children.filter((model) => model.visible);
      let textured = 0;
      models[0]!.traverseVisible((node) => {
        const mesh = node as unknown as { material?: { map?: unknown } | Array<{ map?: unknown }> };
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        textured += materials.filter((material) => material?.map).length;
      });
      return {
        models: models.length,
        textured,
        attached: root.parent?.type,
        calls: app.renderer.info.render.calls,
      };
    });
    expect(rendered.models).toBe(1);
    expect(rendered.textured).toBeGreaterThan(0);
    expect(rendered.attached).toBe('Scene');
    expect(rendered.calls).toBeGreaterThan(0);
  }
});
