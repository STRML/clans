import { fileURLToPath } from 'node:url';
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

test('jumping into a bunker ceiling leaves the player below it and able to move', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const simPath = `/@fs${fileURLToPath(new URL('../packages/sim/src/index.ts', import.meta.url))}`;
  const start = await page.evaluate(async (path) => {
    const sim = await import(path);
    const threePath = '/node_modules/.vite/deps/three.js';
    const T = await import(threePath);
    const app = (window as unknown as { __app: App }).__app;
    const bunker = app.assets.scene.interiors.find((item) => item.shape === 'sbunk2')!;
    const origin = new T.Vector3(20, 9, 0)
      .applyAxisAngle(
        new T.Vector3(...bunker.rotation.axis),
        (bunker.rotation.degrees * Math.PI) / 180,
      )
      .add(new T.Vector3(...bunker.position));
    const roof = sim.raycastInteriors(app.world.interiors, origin, { x: 0, y: 1, z: 0 }, 5);
    const floor = sim.raycastInteriors(app.world.interiors, origin, { x: 0, y: -1, z: 0 }, 10);
    if (!roof || !floor) throw new Error('Expected bunker floor and ceiling');
    app.world.players.position.set([origin.x, floor.point.y, origin.z], app.playerId * 3);
    app.world.players.velocity.set([0, 0, 0], app.playerId * 3);
    app.world.players.energy[app.playerId] = 60;
    return {
      tick: app.world.tick,
      roof: roof.point.y,
      floor: floor.point.y,
      x: origin.x,
      z: origin.z,
    };
  }, simPath);
  await page.keyboard.down('Space');
  await page.mouse.down({ button: 'right' });
  try {
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.world.tick), {
        timeout: 20000,
      })
      .toBeGreaterThan(start.tick + 40);
    const height = await page.evaluate(() => {
      const app = (window as unknown as { __app: App }).__app;
      return app.world.players.position[app.playerId * 3 + 1]!;
    });
    expect(height).toBeGreaterThan(start.floor + 0.5);
    expect(height).toBeLessThanOrEqual(start.roof - 2.3 + 0.01);
    await page.keyboard.up('Space');
    await page.mouse.up({ button: 'right' });
    await page.keyboard.down('KeyD');
    await expect
      .poll(
        () =>
          page.evaluate(({ x, z }) => {
            const app = (window as unknown as { __app: App }).__app;
            const p = app.world.players.position;
            return Math.hypot(p[app.playerId * 3]! - x, p[app.playerId * 3 + 2]! - z);
          }, start),
        { timeout: 20000 },
      )
      .toBeGreaterThan(1);
  } finally {
    await page.keyboard.up('Space');
    await page.mouse.up({ button: 'right' });
    await page.keyboard.up('KeyD');
  }
});
