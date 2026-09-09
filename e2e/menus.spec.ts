import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

test('inventory menu releases captured mouse and accepts a real loadout click', async ({
  page,
}) => {
  test.setTimeout(30_000);
  // macOS Chromium rejects native pointer lock when the test window lacks OS focus.
  // Exercise the browser API boundary deterministically; native headed capture was
  // separately reproduced and verified during development.
  await page.addInitScript(() => {
    let captured: Element | null = null;
    Object.defineProperty(document, 'pointerLockElement', { get: () => captured });
    HTMLElement.prototype.requestPointerLock = async function () {
      captured = document.querySelector('#app canvas');
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    document.exitPointerLock = () => {
      captured = null;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
  });
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.locator('#app canvas').first().click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement !== null)).toBe(true);
  await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const objects = app.world.baseObjects;
    const station = Array.from(objects.kind).findIndex(
      (kind, id) => kind === 2 && objects.team[id] === 1,
    );
    app.world.players.position.set(
      objects.position.slice(station * 3, station * 3 + 3),
      app.playerId * 3,
    );
    app.world.players.velocity.set([0, 0, 0], app.playerId * 3);
  });
  await expect(page.locator('#station-menu')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await page.keyboard.press('KeyC');
  await page.keyboard.press('KeyV');
  await expect(page.locator('#commander-map')).toBeHidden();
  await expect(page.locator('#voice-menu')).toBeHidden();
  await page.keyboard.down('KeyG');
  await page.keyboard.down('Space');
  await page.getByRole('button', { name: 'Heavy', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as unknown as { __app: App }).__app;
        return app.world.players.armor[app.playerId];
      }),
    )
    .toBe(2);
  await expect(page.locator('#station-menu')).toBeHidden();
  expect(
    await page.evaluate(() => (window as unknown as { __app: App }).__app.input.snapshot()),
  ).toMatchObject({ jump: false, altFire: false });
  await page.keyboard.up('KeyG');
  await page.keyboard.up('Space');
});

test('walking onto the separate vehicle station opens its menu and permits a spawn', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const station = app.assets.scene.baseObjects.find(
      (item) => item.kind === 3 && item.team === 1,
    )!;
    const [x, y, z] = station.usePosition!;
    app.world.players.position.set([x, y, z - 2], app.playerId * 3);
    app.world.players.velocity.set([0, 0, 0], app.playerId * 3);
    app.input.yaw = 0;
  });
  await expect(page.locator('#interaction-prompt')).toBeHidden();
  await expect(page.locator('#vehicle-pad-menu')).toBeHidden();
  await page.keyboard.down('KeyW');
  await expect(page.locator('#vehicle-pad-menu')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Digit2');
  await expect(page.locator('#vehicle-pad-menu')).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as unknown as { __app: App }).__app;
        return Array.from(app.world.vehicles.active).filter(Boolean).length;
      }),
    )
    .toBe(1);
  // Closing it while still on the trigger must not reopen it every frame.
  const tick = await page.evaluate(() => (window as unknown as { __app: App }).__app.world.tick);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.world.tick))
    .toBeGreaterThan(tick + 8);
  await expect(page.locator('#vehicle-pad-menu')).toBeHidden();
});
