import type { App } from '../packages/client/src/app.js';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __clansDebug?: { teleportToVehiclePad(team: number): void };
  }
}

/** The Wildcat datablock's own chase end: `cameraMaxDist = 5.0; cameraOffset = 0.7;` in
 *  `vehicle_wildcat.cs` (`ScoutVehicle`), the numbers `VEHICLE_DATA` carries into the client.
 *  T2's `ShapeBase::getCameraTransform` uses the model's `Eye` node at the other end. */
const WILDCAT_CAMERA_MAX_DIST = 5;
const WILDCAT_CAMERA_OFFSET = 0.7;

/** Mount a Wildcat the way vehicles.spec.ts does, advancing the app's own tick loop rather
 *  than wall time so the fabrication clock is deterministic under a software GPU. */
async function mountWildcat(page: Page): Promise<number> {
  await page.goto('/');
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  const wildcatButton = page.locator('#vehicle-pad-menu button', { hasText: 'Wildcat' });
  await expect(wildcatButton).toBeVisible();
  await wildcatButton.click();
  return page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      for (let tick = 0; tick < 210; tick++) app.frame(0.032);
      return app.world.players.mountedVehicleId[app.playerId] ?? -1;
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  });
}

interface CameraReadout {
  eyeDistance: number;
  upAlignment: number;
  fov: number;
  horizontalDistance: number;
  heightAbove: number;
  slider: number;
}

/** Run `frames` app ticks with rendering stubbed out, then measure the camera against the
 *  mounted model. No input is held: the camera is the only thing under test. */
async function readCamera(page: Page, vehicleId: number, frames: number): Promise<CameraReadout> {
  return page.evaluate(
    ({ id, count }) => {
      const app = (window as unknown as { __app: App }).__app;
      const render = app.renderer.render;
      app.renderer.render = () => {};
      try {
        for (let tick = 0; tick < count; tick++) app.frame(0.032);
        const vehicles = app.world.vehicles;
        const base = id * 3;
        const vehicle = {
          x: vehicles.position[base] ?? 0,
          y: vehicles.position[base + 1] ?? 0,
          z: vehicles.position[base + 2] ?? 0,
        };
        const mesh = app.scene.getObjectByName(`vehicle-${String(id)}`)!;
        const eye = mesh.getObjectByName('Eye')!.getWorldPosition(app.camera.position.clone());
        const vehicleUp = app.camera.up.clone().applyQuaternion(mesh.quaternion);
        const cameraUp = app.camera.up.clone().applyQuaternion(app.camera.quaternion);
        return {
          eyeDistance: eye.distanceTo(app.camera.position),
          upAlignment: vehicleUp.dot(cameraUp),
          fov: app.camera.fov,
          horizontalDistance: Math.hypot(
            app.camera.position.x - vehicle.x,
            app.camera.position.z - vehicle.z,
          ),
          heightAbove: app.camera.position.y - vehicle.y,
          slider: app.vehicleCameraPos,
        };
      } finally {
        app.renderer.render = render;
        app.frame(0);
      }
    },
    { id: vehicleId, count: frames },
  );
}

test('the Wildcat camera rests on its Eye node, and X pulls it back to the script chase end', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const vehicleId = await mountWildcat(page);
  expect(vehicleId).toBeGreaterThanOrEqual(0);
  // The model attaches to the vehicle root when its GLB resolves, so the authored nodes are
  // not there on the very first frame after mounting -- same wait vehicle-launch.spec.ts does.
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            !!(window as unknown as { __app: App }).__app.scene
              .getObjectByName(`vehicle-${String(id)}`)
              ?.getObjectByName('Eye'),
          vehicleId,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);

  // T2's `GameConnection::mFirstPerson` defaults true, so the resting view is the model's own
  // eye node -- the same end the Shrike's cockpit test pins.
  const firstPerson = await readCamera(page, vehicleId, 8);
  expect(firstPerson.eyeDistance).toBeLessThan(0.001);
  expect(firstPerson.upAlignment).toBeGreaterThan(0.999);
  expect(firstPerson.fov).toBe(90);
  expect(firstPerson.slider).toBe(0);

  // X selects the datablock's chase end: the slider travels at T2's mCameraSpeed = 10 (0.1 s
  // for the whole run), then the tail end settles under its own cameraLag.
  await page.keyboard.down('KeyX');
  await readCamera(page, vehicleId, 2);
  await page.keyboard.up('KeyX');
  await expect
    .poll(async () => (await readCamera(page, vehicleId, 8)).horizontalDistance, {
      timeout: 10_000,
    })
    .toBeGreaterThan(WILDCAT_CAMERA_MAX_DIST - 0.3);
  const chase = await readCamera(page, vehicleId, 8);
  expect(chase.slider).toBe(1);
  expect(chase.horizontalDistance).toBeLessThan(WILDCAT_CAMERA_MAX_DIST + 0.3);
  expect(chase.heightAbove).toBeGreaterThan(WILDCAT_CAMERA_OFFSET - 0.3);
  expect(chase.eyeDistance).toBeGreaterThan(2);

  // And back: one more press returns the camera to the eye node exactly.
  await page.keyboard.down('KeyX');
  await readCamera(page, vehicleId, 2);
  await page.keyboard.up('KeyX');
  await expect
    .poll(async () => (await readCamera(page, vehicleId, 8)).eyeDistance, { timeout: 10_000 })
    .toBeLessThan(0.001);

  // The Wildcat's own cockpit instruments are the same HUD the dash has always drawn, so the
  // first-person view is a cockpit rather than an empty screen.
  await expect(page.locator('#hud-vehicle')).toBeAttached();
});
