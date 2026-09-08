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

test('original disc, chaingun, mortar and blaster animate with simulated fire states', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __app: App }).__app.weaponModel.root.children.filter(
            (m) => m.userData.shapeStatus === 'loaded',
          ).length,
      ),
    )
    .toBe(5);
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    // Exercise simulation and pose updates without flooding the software GPU queue.
    // The separate rendering test verifies drawing; restore and draw the final pose here.
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      const p = app.world.players,
        id = app.playerId;
      const model = (weapon: number) => app.weaponModel.root.children[weapon]!;
      function ready(weapon: number) {
        app.input.fire = false;
        p.weaponSlot[id] = weapon;
        p.weaponState[id] = 1;
        p.weaponTimer[id] = 0;
        p.energy[id] = 100;
        p.ammo.fill(100);
        for (let i = 0; i < 20; i++) app.frame(1 / 32);
      }
      ready(0);
      const disc = model(0).getObjectByName('Disc110')!;
      const spin = disc.quaternion.clone();
      app.frame(1 / 32);
      const discSpins = !spin.equals(disc.quaternion);
      app.input.fire = true;
      app.frame(1 / 32);
      app.input.fire = false;
      const discHidden = !model(0).getObjectByName('Disc')!.visible;
      for (let i = 0; i < 45; i++) app.frame(1 / 32);
      const discReloads = model(0).getObjectByName('Disc')!.visible;
      ready(1);
      const barrel = model(1).getObjectByName('DumSpin')!;
      const beforeSpin = barrel.quaternion.clone();
      let chainFlash = false;
      app.input.fire = true;
      for (let i = 0; i < 30; i++) {
        app.frame(1 / 32);
        chainFlash ||= model(1).getObjectByName('MuzzleFlashFront_')!.visible;
      }
      const chainSpins = !beforeSpin.equals(barrel.quaternion);
      ready(2);
      const hood = model(2).getObjectByName('M_Hood_100')!;
      const beforeHood = hood.position.clone();
      app.input.fire = true;
      for (let i = 0; i < 5; i++) app.frame(1 / 32);
      const mortarRecoil = !beforeHood.equals(hood.position);
      ready(4);
      let blasterFlash = false;
      app.input.fire = true;
      for (let i = 0; i < 10; i++) {
        app.frame(1 / 32);
        blasterFlash ||= model(4).getObjectByName('Muzzle_Flash_Front_')!.visible;
      }
      app.input.fire = false;
      return {
        discSpins,
        discHidden,
        discReloads,
        chainSpins,
        chainFlash,
        mortarRecoil,
        blasterFlash,
      };
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  });
  expect(result).toEqual({
    discSpins: true,
    discHidden: true,
    discReloads: true,
    chainSpins: true,
    chainFlash: true,
    mortarRecoil: true,
    blasterFlash: true,
  });
});
