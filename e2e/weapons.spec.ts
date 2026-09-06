import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __clansDebug?: { teleportToFlag(team: number): void };
  }
}

test('fires a Spinfusor at terrain and the projectile it creates cleans up', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });

  // Digit1 selects the Spinfusor; held until the HUD confirms the switch landed, so the ammo
  // baseline read below is actually the Spinfusor's, not whatever slot spawned equipped.
  await page.keyboard.down('Digit1');
  await expect
    .poll(async () => page.locator('#hud-weapon').textContent(), { timeout: 5_000 })
    .toBe('Spinfusor');
  const startAmmo = Number(await page.locator('#hud-ammo').textContent());

  await page.mouse.move(640, 360);
  await page.mouse.down();
  // Release the instant ammo drops, rather than holding for a fixed window or waiting to see
  // the live projectile count go positive. Under this suite's heavy concurrent WebGL load,
  // packages/client/src/loop.ts's MAX_STEPS_PER_FRAME can batch several sim ticks into one
  // rendered frame -- when the disc is fired at close terrain, its whole fire-travel-detonate
  // cycle can land inside a single batch, so `#debug-projectiles` never reads >0 in any DOM
  // snapshot an external poll can observe, no matter how tightly it polls. Ammo has no such
  // gap: it only ever decreases, so whatever frame the drop lands in, the next sample sees it.
  // Releasing as soon as it's seen also caps this to one shot, so a run that's unlucky here
  // doesn't also burn through the rest of the clip retrying every ~1.75s reload cycle.
  await expect
    .poll(async () => Number(await page.locator('#hud-ammo').textContent()), { timeout: 15_000 })
    .toBeLessThan(startAmmo);
  await page.mouse.up();
  await page.keyboard.up('Digit1');

  // The disc detonates on terrain contact, or at worst at its 5 s lifetime (Task 3); either
  // way, once the ammo drop above proved tryFireWeapon ran, this just confirms it doesn't
  // linger forever. This side isn't subject to the same race as a live ">0" read would be --
  // 0 is a resting state we wait to reach, not a spike a batched frame could step over.
  await expect
    .poll(async () => Number(await page.locator('#debug-projectiles').getAttribute('data-value')), {
      timeout: 15_000,
    })
    .toBe(0);
});

test('captures a flag using the debug teleport hook', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });

  const before = await page.locator('#hud-team-scores').getAttribute('data-value');

  // Single-player always spawns on team 1 (packages/client/src/app.ts's spawnPoint picks the
  // team 1 spawn); team 2 holds the enemy flag to steal.
  await page.evaluate(() => window.__clansDebug?.teleportToFlag(2));
  await expect
    .poll(async () => page.locator('#hud-flag-status').getAttribute('data-value'), {
      timeout: 2_000,
    })
    .toBe('carrying the enemy flag');

  // Home, with the enemy flag in hand and our own flag untouched: this captures.
  await page.evaluate(() => window.__clansDebug?.teleportToFlag(1));
  await expect
    .poll(async () => page.locator('#hud-team-scores').getAttribute('data-value'), {
      timeout: 2_000,
    })
    .not.toBe(before);
});
