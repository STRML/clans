import { test, expect } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';
test('an idle Shrike stays alive and undamaged on its vehicle platform', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  await page.getByRole('button', { name: 'Shrike', exact: true }).click();
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    // Exercise simulation and pose updates without flooding the software GPU queue.
    // The separate rendering test verifies drawing; restore and draw the final pose here.
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      const records = [];
      for (let i = 0; i < 160; i++) {
        app.frame(1 / 32);
        const v = app.world.vehicles;
        if (i < 8 || i % 10 === 0 || v.destroyed[0])
          records.push({
            i,
            active: v.active[0],
            destroyed: v.destroyed[0],
            pos: Array.from(v.position.slice(0, 3)),
            vel: Array.from(v.velocity.slice(0, 3)),
            energy: v.energy[0],
            damage: v.damage[0],
          });
        if (v.destroyed[0]) break;
      }
      return records;
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  });
  expect(result.at(-1)?.damage).toBe(0);
  expect(result.at(-1)?.energy).toBe(280);
  expect(result.at(-1)?.vel[1]).toBeCloseTo(0);
  expect(result.at(-1)?.destroyed).toBe(0);
});

test('Shrike boards automatically, faces its flight heading, and shows crash destruction', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  await page.getByRole('button', { name: 'Shrike', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as unknown as { __app: App }).__app;
        return !!app.scene.getObjectByName('vehicle-0')?.getObjectByName('Jetnozzle0');
      }),
    )
    .toBe(true);
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      for (let i = 0; i < 32; i++) app.frame(1 / 32);
      const v = app.world.vehicles,
        p = app.world.players;
      const position = Array.from(v.position.slice(0, 3));
      p.position.set(position, app.playerId * 3);
      p.velocity.set([0, 0, 0], app.playerId * 3);
      app.frame(1 / 32);
      const boarded = p.mountedVehicleId[app.playerId];
      v.yaw[0] = 0.6;
      v.pitch[0] = 0.2;
      app.frame(0);
      const mesh = app.scene.getObjectByName('vehicle-0')!;
      const cockpit = mesh.getObjectByName('Mount0')!;
      const exhaust = mesh.getObjectByName('Jetnozzle0')!;
      const nose = cockpit
        .getWorldPosition(mesh.position.clone())
        .sub(exhaust.getWorldPosition(mesh.position.clone()))
        .normalize();
      const heading = mesh.position
        .clone()
        .set(Math.sin(0.6) * Math.cos(0.2), Math.sin(0.2), Math.cos(0.6) * Math.cos(0.2));
      const alignment = nose.dot(heading);
      const behind = app.camera.position.clone().sub(mesh.position).dot(heading);
      const impact = (speed: number) => {
        v.position.set(position, 0);
        v.velocity.set([0, -speed, 0], 0);
        app.frame(1 / 32);
        return { energy: v.energy[0], damage: v.damage[0], destroyed: v.destroyed[0] };
      };
      const shielded = impact(40);
      v.energy[0] = 0;
      const hullHit = impact(40);
      const lethal = impact(220);
      return {
        boarded,
        alignment,
        behind,
        shielded,
        hullHit,
        lethal,
        ejected: p.mountedVehicleId[app.playerId] === -1,
        explosion: !!app.scene.getObjectByName('vehicle-explosion'),
        removed: !app.scene.getObjectByName('vehicle-0'),
      };
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  });
  expect(result.boarded).toBe(0);
  expect(result.alignment).toBeGreaterThan(0.98);
  expect(result.behind).toBeLessThan(0);
  expect(result.shielded.energy).toBeLessThan(280);
  expect(result.shielded.damage).toBe(0);
  expect(result.hullHit.damage).toBeGreaterThan(0);
  expect(result.hullHit.destroyed).toBe(0);
  expect(result.lethal.destroyed).toBe(1);
  expect(result.ejected && result.explosion && result.removed).toBe(true);
});
