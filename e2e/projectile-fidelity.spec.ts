import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('hold Z zooms without taking the jet button, and release restores FOV', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const fov = () => page.evaluate(() => (window as unknown as { __app: App }).__app.camera.fov);
  await expect.poll(fov).toBe(90);
  await page.keyboard.down('KeyZ');
  await expect.poll(fov).toBe(45);
  await page.mouse.down({ button: 'right' });
  expect(await page.evaluate(() => (window as unknown as { __app: App }).__app.input.jet)).toBe(
    true,
  );
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('KeyZ');
  await expect.poll(fov).toBe(90);
});

test('offline laser draws a red beam on a miss even in a multi-tick frame', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const result = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const p = app.world.players,
      id = app.playerId;
    app.input.pitch = 0.6;
    p.weaponSlot[id] = 3;
    p.weaponState[id] = 1;
    p.weaponTimer[id] = 0;
    p.energy[id] = 100;
    app.input.fire = true;
    // At 32Hz this runs two ticks; the first tick's shot must survive the second.
    app.frame(2 / 32);
    app.input.fire = false;
    app.paused = true;
    const beams = app.scene.children.filter((node) => node.type === 'Line') as unknown as Array<{
      material: { color: { getHex(): number } };
      geometry: { getAttribute(name: string): { count: number; array: ArrayLike<number> } };
    }>;
    return beams.map((beam) => ({
      color: beam.material.color.getHex(),
      points: beam.geometry.getAttribute('position').count,
    }));
  });
  expect(result).toContainEqual({ color: 0xff2222, points: 2 });
  await page.screenshot({ path: testInfo.outputPath('laser-rifle.png') });
});

test('Shrike and chaingun render original glowing tracer textures', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const result = await page.evaluate(async () => {
    const app = (window as unknown as { __app: App }).__app;
    app.paused = true;
    const modulePath = '/src/weapons-view.ts';
    const { createProjectileMesh } = await import(modulePath);
    const results = [];
    for (const [type, weaponId, x] of [
      [4, 7, -2],
      [1, 1, 2],
      [0, 0, 0],
    ]) {
      const mesh = createProjectileMesh({
        id: type,
        type,
        weaponId,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: -425,
        ownerId: -1,
        armed: 1,
      });
      const pos = app.camera.position
        .clone()
        .set(x, 0, -12)
        .applyQuaternion(app.camera.quaternion)
        .add(app.camera.position);
      mesh.position.copy(pos);
      mesh.quaternion.copy(app.camera.quaternion);
      mesh.rotateY(Math.PI / 3);
      mesh.scale.z = 0.25;
      app.scene.add(mesh);
      const texture = mesh.material.map;
      if (!texture.image?.complete)
        await new Promise<void>((resolve) =>
          texture.image
            ? texture.image.addEventListener('load', () => resolve(), { once: true })
            : setTimeout(resolve, 500),
        );
      results.push({
        type,
        textured: !!texture.image?.width,
        additive: mesh.material.blending === 2,
        depthWrite: mesh.material.depthWrite,
      });
    }
    app.frame(0);
    return results;
  });
  expect(result).toEqual([
    { type: 4, textured: true, additive: true, depthWrite: false },
    { type: 1, textured: true, additive: true, depthWrite: false },
    { type: 0, textured: true, additive: true, depthWrite: false },
  ]);
  await page.screenshot({ path: testInfo.outputPath('tracer-textures.png') });
});

test("the Blaster bolt renders the datablock's own bolt and cross textures at their sizes", async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  const result = await page.evaluate(async () => {
    const app = (window as unknown as { __app: App }).__app;
    app.paused = true;
    const modulePath = '/src/weapons-view.ts';
    const { createProjectileMesh } = await import(modulePath);
    const mesh = createProjectileMesh({
      id: 3,
      type: 3, // ProjectileType.Energy
      weaponId: 4, // WeaponId.Blaster
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: -425,
      ownerId: -1,
      armed: 1,
    });
    const position = app.camera.position
      .clone()
      .set(0, 0.4, -8)
      .applyQuaternion(app.camera.quaternion)
      .add(app.camera.position);
    mesh.position.copy(position);
    mesh.quaternion.copy(app.camera.quaternion);
    mesh.rotateY(Math.PI / 3);
    app.scene.add(mesh);
    const textures = [mesh.material.map, mesh.getObjectByName('tracer-head')?.material.map];
    for (const texture of textures) {
      if (!texture?.image?.complete)
        await new Promise<void>((resolve) =>
          texture?.image
            ? texture.image.addEventListener('load', () => resolve(), { once: true })
            : setTimeout(resolve, 500),
        );
    }
    app.frame(0);
    return {
      // EnergyBolt's own numbers (blaster.cs:255, :256).
      trail: [mesh.geometry.parameters.width, mesh.geometry.parameters.height],
      cross: [
        mesh.getObjectByName('tracer-head')?.geometry.parameters.width,
        mesh.getObjectByName('tracer-head')?.geometry.parameters.height,
      ],
      textured: textures.map((texture) => !!texture?.image?.width),
    };
  });
  expect(result.trail).toEqual([0.25, 20]);
  expect(result.cross).toEqual([0.55, 0.55]);
  expect(result.textured).toEqual([true, true]);
  await page.screenshot({ path: testInfo.outputPath('blaster-bolt.png') });
});
