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
