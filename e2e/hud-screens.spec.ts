import { expect, test } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';

/** Issue #55's acceptance asks for "on-foot, zoom, vehicle, station and commander screens at
 *  matching aspect ratios". This captures our side of that comparison at the reference frame's
 *  own 16:10 (the committed WSGF vehicle frame in docs/ui-audio-reference.md is `ingame_16x10`),
 *  so the visual comparison is a matter of putting these next to the reference images rather
 *  than re-deriving a screen state by hand. Each screen asserts the state it is in, so a shot
 *  cannot silently capture the wrong thing: the write only happens after the assertion passes.
 *
 *  The images land in `docs/hud-screens/` on purpose -- Playwright's own output directory is
 *  wiped between runs, and these are meant to be looked at. */
test.use({ viewport: { width: 1280, height: 800 } });

const SHOT_DIR = 'docs/hud-screens';
/** JPEG at this quality because these are comparison artifacts and the reference frames they
 *  will be compared against are JPEGs too: the same five screens are 4.2 MB as PNG and under
 *  900 KB as JPEG, and HUD layout comparison does not need lossless. */
const SHOT_OPTIONS = { type: 'jpeg', quality: 80 } as const;

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
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
  await page.locator('#app canvas').first().click();
}

async function settle(page: import('@playwright/test').Page, frames: number): Promise<void> {
  await page.evaluate((count) => {
    const app = (window as unknown as { __app: App }).__app;
    const render = app.renderer.render;
    app.renderer.render = () => {};
    try {
      for (let i = 0; i < count; i += 1) app.frame(0.032);
    } finally {
      app.renderer.render = render;
      app.frame(0);
    }
  }, frames);
}

test('captures the five screens issue #55 compares, at the reference aspect ratio', async ({
  page,
}) => {
  await boot(page);

  // 1. On foot: the HUD with a weapon reticle.
  await expect(page.locator('#hud')).toBeVisible();
  const onFootReticle = await page.evaluate(
    () => getComputedStyle(document.getElementById('crosshair')!).backgroundImage,
  );
  expect(onFootReticle).toMatch(/RET_.*\.png/);
  await settle(page, 10);
  await page.screenshot({ path: `${SHOT_DIR}/01-on-foot.jpg`, ...SHOT_OPTIONS });

  // 2. Zoom: holding Z narrows the camera to the zoom's own fov.
  await page.keyboard.down('KeyZ');
  await settle(page, 10);
  const zoomed = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    return { fov: app.camera.fov, zooming: app.input.isZooming() };
  });
  expect(zoomed.zooming).toBe(true);
  expect(zoomed.fov).toBe(45);
  await page.screenshot({ path: `${SHOT_DIR}/02-zoom.jpg`, ...SHOT_OPTIONS });
  await page.keyboard.up('KeyZ');

  // 3. Vehicle: the pad menu, a purchased Tank, its cockpit and its own reticle.
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  await expect(page.getByRole('button', { name: 'Beowulf', exact: true })).toBeVisible();
  await page.keyboard.press('Digit2');
  await settle(page, 400);
  const vehicle = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const vehicleId = app.world.players.mountedVehicleId[app.playerId] ?? -1;
    return {
      kind: app.world.vehicles.kind[vehicleId],
      reticle: getComputedStyle(document.getElementById('crosshair')!).backgroundImage,
    };
  });
  expect(vehicle.kind).toBe(4); // VehicleKind.Tank (sim/src/vehicles.ts:24)
  expect(vehicle.reticle).toContain('hud_ret_tankchaingun.png');
  await expect(page.locator('#hud')).toHaveAttribute('data-piloting', 'true');
  await page.screenshot({ path: `${SHOT_DIR}/03-vehicle.jpg`, ...SHOT_OPTIONS });

  // 4. Station: the menu only opens on foot, so leave the Tank first with the use key (E),
  // which is the same press the client's own dismount prompt asks for.
  await page.keyboard.down('KeyE');
  await settle(page, 30);
  await page.keyboard.up('KeyE');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __app: App }).__app.world.players.mountedVehicleId[
            (window as unknown as { __app: App }).__app.playerId
          ],
      ),
    )
    .toBe(-1);
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
  await page.screenshot({ path: `${SHOT_DIR}/04-station.jpg`, ...SHOT_OPTIONS });
  // The menu's own close control, which is also what clears input.setUiOpen: a bare Escape
  // keypress is not wired to the menu, and while the UI is open the key listeners ignore keys.
  await page.getByRole('button', { name: 'Close (Esc)', exact: true }).click();
  await expect(page.locator('#station-menu')).toBeHidden();

  // 5. Commander: the C key's map screen.
  // Held across a frame on purpose: the toggle is an edge read inside app.frame(), so a
  // press that goes down and up between two frames is a press the client never sees.
  await page.keyboard.down('KeyC');
  await settle(page, 5);
  await page.keyboard.up('KeyC');
  await expect(page.locator('#commander-map')).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/05-commander.jpg`, ...SHOT_OPTIONS });
});
