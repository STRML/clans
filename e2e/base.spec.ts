import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __clansDebug?: {
      teleportToFlag(team: number): void;
      killGenerator(team: number): void;
      repairGenerator(team: number): void;
      isStationPowered(team: number): boolean;
    };
  }
}

test("destroying both of a team's generators unpowers its stations; repairing one restores them", async ({
  page,
}) => {
  await page.goto('/');
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });

  const poweredBeforeDamage = await page.evaluate(() => window.__clansDebug?.isStationPowered(1));
  expect(poweredBeforeDamage).toBe(true);

  await page.evaluate(() => window.__clansDebug?.killGenerator(1));
  await expect
    .poll(async () => page.evaluate(() => window.__clansDebug?.isStationPowered(1)), {
      timeout: 5_000,
    })
    .toBe(false);

  await page.evaluate(() => window.__clansDebug?.repairGenerator(1));
  await expect
    .poll(async () => page.evaluate(() => window.__clansDebug?.isStationPowered(1)), {
      timeout: 5_000,
    })
    .toBe(true);
});

test('the HUD and crosshair actually render inside the viewport, not just in the DOM', async ({
  page,
}) => {
  // Every one of this suite's other specs only ever checks `data-ready`/textContent, which
  // says an element exists and is populated, not that a human can actually see it -- index.html
  // used to have positioning CSS for #debug-stats only, so #hud (and every other overlay:
  // station/vehicle-pad menus, the commander map, the voice menu) sat in plain document flow
  // below the WebGL canvas, `overflow: hidden` on <body> making it permanently unreachable.
  // toBeVisible() alone would not have caught this -- it only requires a non-zero, non-hidden
  // box, which an off-screen element still has. Checking the box's own position is what would
  // have failed here, and is what keeps this bug class from regressing silently again.
  await page.goto('/');
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport size');

  const hudBox = await page.locator('#hud').boundingBox();
  expect(hudBox).not.toBeNull();
  expect(hudBox?.y).toBeGreaterThanOrEqual(0);
  expect(hudBox?.y).toBeLessThan(viewport.height);

  const crosshairBox = await page.locator('#crosshair').boundingBox();
  expect(crosshairBox).not.toBeNull();
  expect(crosshairBox?.x).toBeGreaterThanOrEqual(0);
  expect(crosshairBox?.x).toBeLessThan(viewport.width);
  expect(crosshairBox?.y).toBeGreaterThanOrEqual(0);
  expect(crosshairBox?.y).toBeLessThan(viewport.height);
});
