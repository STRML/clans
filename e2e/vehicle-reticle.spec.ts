import { test, expect } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

// Issue #55: the vehicle reticles come from the game's own HUD table (`hud.cs:39-53`), which
// gives the Tank (datablock AssaultVehicle, vehicle_tank.cs:197) reticles of its own. Before
// this the client drew the on-foot weapon crosshair for every vehicle except the Shrike.
test('riding a Tank draws the Tank reticle from the source HUD table, not the on-foot crosshair', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  // The pad menu opens a frame after the teleport, so wait for its own entries to exist before
  // pressing: a digit pressed at an unopened menu purchases nothing.
  // The menu names each vehicle by its script's own targetNameTag, so the Tank's row is
  // "Beowulf" (vehicle_tank.cs:333), not "Tank".
  await expect(page.getByRole('button', { name: 'Beowulf', exact: true })).toBeVisible();
  // Pad order is the source's own (`vehicles/serverVehicleHud.cs`): Wildcat, Tank, MPB, Shrike,
  // Bomber, Havoc, so the Tank is key 2.
  await page.keyboard.press('Digit2');
  const result = await page.evaluate(async () => {
    const app = (window as unknown as { __app: App }).__app;
    // Fabrication is simulated seconds with the render loop frozen, exactly as the launch spec
    // drives it: one long evaluate rather than a poll that competes with rAF.
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      for (let i = 0; i < 400; i += 1) app.frame(0.032);
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
    const crosshair = document.getElementById('crosshair');
    const background = crosshair ? getComputedStyle(crosshair).backgroundImage : '';
    const url = background.slice(5, -2); // url("...") -> the URL
    const loaded = await new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
    const vehicleId = app.world.players.mountedVehicleId[app.playerId] ?? -1;
    return { kind: app.world.vehicles.kind[vehicleId], background, url, loaded };
  });
  await page.screenshot({ path: testInfo.outputPath('tank-reticle.png') });
  expect(result.kind).toBe(4); // VehicleKind.Tank (sim/src/vehicles.ts:24)
  expect(result.url).toContain('hud_ret_tankchaingun.png');
  expect(result.loaded).toBe(true);
});
