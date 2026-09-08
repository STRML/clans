import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('mission roofs support turrets and terrain is absent from every base cut-out', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.goto('/');
  await page.locator('#hud[data-ready="1"]').waitFor();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as unknown as { __app: App }).__app;
        return app.scene.children
          .filter((node) => node.userData.shapeUrl)
          .every((node) => node.userData.shapeStatus === 'loaded');
      }),
    )
    .toBe(true);
  const results = await page.evaluate(async () => {
    const threePath = '/node_modules/.vite/deps/three.js';
    const T = await import(threePath);
    const app = (window as unknown as { __app: App }).__app;
    app.scene.updateMatrixWorld(true);
    const interiors = app.scene.children.filter((node) =>
      app.assets.scene.interiors.some((placement) =>
        node.userData.shapeUrl?.endsWith(`/${placement.shape}.glb`),
      ),
    );
    const gaps = app.assets.scene.turrets.map(({ position: [x, y, z] }) => {
      const ray = new T.Raycaster(new T.Vector3(x, y + 0.1, z), new T.Vector3(0, -1, 0), 0, 1);
      const hit = ray.intersectObjects(interiors, true)[0];
      return hit ? Math.abs(y - hit.point.y) : 999;
    });
    const terrain = app.scene.getObjectByName('katabatic-terrain')!;
    const { gridSize, squareSize, origin } = app.assets.terrain;
    const holesWithTerrain = app.assets.terrain.emptySquares.filter((index) => {
      const x = origin.x + ((index % gridSize) + 0.5) * squareSize;
      const z = origin.z - (Math.floor(index / gridSize) + 0.5) * squareSize;
      return (
        new T.Raycaster(new T.Vector3(x, 1000, z), new T.Vector3(0, -1, 0)).intersectObject(terrain)
          .length > 0
      );
    }).length;
    const sentryUp = app.scene.children
      .filter(
        (node) =>
          node.userData.structureKind === 'turret' &&
          app.assets.scene.turrets[node.userData.structureId]?.barrel === 2,
      )
      .map((node) => new T.Vector3(0, 1, 0).applyQuaternion(node.quaternion).y);
    return { gaps, holes: app.assets.terrain.emptySquares.length, holesWithTerrain, sentryUp };
  });
  expect(results.gaps).toHaveLength(6);
  for (const gap of results.gaps) expect(gap).toBeLessThan(0.04);
  expect(results.holes).toBe(106);
  expect(results.holesWithTerrain).toBe(0);
  expect(results.sentryUp).toHaveLength(2);
  for (const up of results.sentryUp) expect(up).toBeLessThan(-0.99);
});
