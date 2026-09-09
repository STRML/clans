import { test, expect } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('number-key order animates the pad and wings, then seats the purchaser at the cockpit eye', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  await expect(page.getByRole('button', { name: 'Shrike', exact: true })).toBeVisible();
  await page.keyboard.press('Digit1');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(window as unknown as { __app: App }).__app.scene
            .getObjectByName('vehicle-0')
            ?.getObjectByName('Eye'),
      ),
    )
    .toBe(true);
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      const v = app.world.vehicles;
      const mesh = app.scene.getObjectByName('vehicle-0')!;
      const wing = mesh.getObjectByName('DumActWingL')!;
      while (v.spawnTime[0]! > 2.8) app.frame(0.032);
      const folded = wing.quaternion.toArray();
      const waiting = app.world.players.mountedVehicleId[app.playerId] === -1;
      const field = !!app.scene.getObjectByName('vehicle-fabrication');
      const hidden = !mesh.visible;
      while (v.spawnTime[0]! > 0.4) app.frame(0.032);
      const opened = wing.quaternion.toArray();
      const revealed = mesh.visible;
      for (let i = 0; i < 16; i++) app.frame(0.032);
      v.yaw[0] = 0.7;
      v.pitch[0] = 0.3;
      v.roll[0] = 0.2;
      app.frame(0);
      const eye = mesh.getObjectByName('Eye')!.getWorldPosition(app.camera.position.clone());
      const vehicleUp = app.camera.up.clone().applyQuaternion(mesh.quaternion);
      const cameraUp = app.camera.up.clone().applyQuaternion(app.camera.quaternion);
      return {
        folded,
        opened,
        waiting,
        field,
        hidden,
        revealed,
        mounted: app.world.players.mountedVehicleId[app.playerId],
        fieldGone: !app.scene.getObjectByName('vehicle-fabrication'),
        eyeDistance: eye.distanceTo(app.camera.position),
        upAlignment: vehicleUp.dot(cameraUp),
        fov: app.camera.fov,
      };
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  });
  expect(result.waiting && result.field && result.hidden && result.revealed).toBe(true);
  expect(result.opened).not.toEqual(result.folded);
  expect(result.mounted).toBe(0);
  expect(result.fieldGone).toBe(true);
  expect(result.eyeDistance).toBeLessThan(0.001);
  expect(result.upAlignment).toBeGreaterThan(0.999);
  expect(result.fov).toBe(65);
  await expect(page.locator('#hud')).toHaveAttribute('data-piloting', 'true');
  await expect(page.locator('#hud-weapon-rack')).toBeHidden();
  await expect(page.locator('.vehicle-silhouette')).toBeVisible();
});
