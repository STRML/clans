import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('destroyed turrets remain visible for repairs', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as unknown as { __app: App }).__app;
        const turret = app.scene.children.find((node) => node.userData.structureKind === 'turret');
        return turret?.children.every((node) => node.userData.shapeStatus === 'loaded');
      }),
    )
    .toBe(true);
  const visible = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    app.paused = true;
    const turret = app.scene.children.find((node) => node.userData.structureKind === 'turret')!;
    const id = turret.userData.structureId as number;
    app.world.turrets.destroyed[id] = 1;
    app.frame(0);
    let meshes = 0;
    turret.traverseVisible((node) => {
      if (node.type === 'Mesh') meshes++;
    });
    return meshes;
  });
  expect(visible).toBeGreaterThan(0);
});

test('Spinfusor impact uses the original animated blue explosion', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/disc-explosion.ts';
        const { createDiscExplosion } = await import(path);
        const effect = createDiscExplosion({ x: 0, y: 0, z: 0 });
        effect?.dispose();
        return !!effect;
      }),
    )
    .toBe(true);
  const result = await page.evaluate(async () => {
    const app = (window as unknown as { __app: App }).__app;
    app.paused = true;
    const path = '/src/disc-explosion.ts';
    const { createDiscExplosion } = await import(path);
    const position = app.camera
      .getWorldDirection(app.camera.position.clone())
      .multiplyScalar(12)
      .add(app.camera.position);
    const effect = createDiscExplosion(position)!;
    app.scene.add(effect.mesh);
    effect.update(0.15, app.camera);
    app.frame(0);
    let textured = 0;
    effect.mesh.traverseVisible((node: { material?: { map?: unknown } }) => {
      if (node.material?.map) textured++;
    });
    return { name: effect.mesh.name, textured, lifetime: effect.ttl };
  });
  expect(result.name).toBe('disc-explosion');
  expect(result.textured).toBeGreaterThan(0);
  expect(result.lifetime).toBeGreaterThanOrEqual(0.5);
  await page.screenshot({ path: testInfo.outputPath('spinfusor-explosion.png') });
});

test('loaded large turret points its muzzle toward the tracked player', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as unknown as { __app: App }).__app;
        return app.scene.children.some(
          (node) =>
            node.userData.structureKind === 'turret' &&
            node.userData.vehicleTargets === false &&
            !!node.getObjectByName('Muzzlepoint'),
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    // Issue #54: the mount advances in simulated seconds now, so pausing the app freezes the
    // presentation and this test can no longer hold the world still that way. Keep the world
    // running and make the tracked player invulnerable (sim applyDamage no-ops on godMode);
    // the poll below re-pins the turret's target id and the player's position every sample,
    // because stepTurrets would otherwise retarget and gravity would drop the player.
    app.godMode = true;
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = (window as unknown as { __app: App }).__app;
          const turret = app.scene.children.find(
            (node) =>
              node.userData.structureKind === 'turret' &&
              node.userData.vehicleTargets === false &&
              !!node.getObjectByName('Muzzlepoint'),
          )!;
          const id = turret.userData.structureId as number;
          const spot = {
            x: turret.position.x + 25,
            y: turret.position.y + 4,
            z: turret.position.z + 25,
          };
          app.world.turrets.targetId[id] = app.playerId;
          app.world.players.position.set([spot.x, spot.y, spot.z], app.playerId * 3);
          const muzzle = turret
            .getObjectByName('Muzzlepoint')!
            .getWorldPosition(app.camera.position.clone());
          const mount = turret
            .getObjectByName('Mountpoint')!
            .getWorldPosition(app.camera.position.clone());
          const base = app.playerId * 3;
          const target = app.camera.position
            .clone()
            .set(
              app.world.players.position[base]!,
              app.world.players.position[base + 1]! + 1.15,
              app.world.players.position[base + 2]!,
            );
          return muzzle.sub(mount).normalize().dot(target.sub(mount).normalize());
        }),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.9);
});
