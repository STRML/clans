import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('committed Draco shapes decode into complete structures and vehicles', async ({ page }) => {
  test.setTimeout(30_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Shape load failed')) {
      errors.push(message.text());
    }
  });
  await page.goto('/');
  await page.locator('#hud[data-ready="1"]').waitFor();
  // Exercise both real vehicle assets, even when no player has bought one yet.
  await page.evaluate(async () => {
    const app = (window as unknown as { __app: App }).__app;
    const modulePath = '/src/vehicle-view.ts';
    const { createVehicleView } = await import(modulePath);
    createVehicleView(app.scene, app.assets).sync(
      [0, 1].map((kind) => ({
        id: kind,
        kind,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        roll: 0,
        destroyed: 0,
      })),
    );
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = (window as unknown as { __app: App }).__app;
          let total = 0;
          let loaded = 0;
          app.scene.traverse((node) => {
            if (!node.userData.shapeUrl) return;
            total++;
            if (node.userData.shapeStatus === 'loaded') loaded++;
          });
          return total > 60 && loaded === total;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  const generatorMeshes = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const root = app.scene.children.find((node) =>
      String(node.userData.shapeUrl).includes('station_generator_large'),
    )!;
    let meshes = 0;
    root.traverse((node) => {
      if (node.type === 'Mesh') meshes++;
    });
    return meshes;
  });
  expect(generatorMeshes).toBeGreaterThan(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as unknown as { __app: App }).__app;
        const largeTurrets = app.scene.children.filter((node) => node.userData.barrelMounted);
        return (
          largeTurrets.length === 4 &&
          largeTurrets.every((root) => {
            root.updateWorldMatrix(true, true);
            const socket = root.getObjectByName('Mount0')!;
            const mount = root.getObjectByName('Mountpoint')!;
            return (
              socket
                .getWorldPosition(socket.position.clone())
                .distanceTo(mount.getWorldPosition(mount.position.clone())) < 0.00001
            );
          })
        );
      }),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});
