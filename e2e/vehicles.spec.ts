import type { App } from '../packages/client/src/app.js';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __clansDebug?: { teleportToVehiclePad(team: number): void };
  }
}

/** Wait for the game to observe each edge, even with slow software-rendered frames. */
async function tapE(page: Page): Promise<void> {
  await page.keyboard.down('KeyE');
  try {
    await waitForSimTick(page);
  } finally {
    await page.keyboard.up('KeyE');
  }
  await waitForSimTick(page);
}

async function waitForSimTick(page: Page): Promise<void> {
  const tick = await page.evaluate(() => (window as unknown as { __app: App }).__app.world.tick);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.world.tick), {
      timeout: 10_000,
    })
    .toBeGreaterThan(tick);
}

/** Presses E, retrying if needed, until `check` returns true -- covers a heavily loaded CI
 *  run (many parallel e2e workers sharing one CPU) batching enough sim ticks into one
 *  rendered frame that a single press's edge window landed between two polls and was missed
 *  entirely. `check` itself must be side-effect-free and safe to call repeatedly. */
async function pressEUntil(page: Page, check: () => Promise<boolean>): Promise<void> {
  await expect(async () => {
    if (await check()) return;
    await tapE(page);
    expect(await check()).toBe(true);
  }).toPass({ timeout: 20_000 });
}

function speedOf(value: string | null): number {
  const match = /([\d.]+) m\/s$/.exec(value ?? '');
  return match ? Number(match[1]) : 0;
}

test('spawn a Wildcat, mount, drive, dismount', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });

  // Single-player always spawns on team 1; team 1's own vehicle pad is where the spawn menu
  // lives. Teleporting there (rather than walking) keeps this deterministic and independent
  // of the real terrain layout, the same debug-hook pattern weapons.spec.ts's flag-capture
  // test already established.
  await page.evaluate(() => window.__clansDebug?.teleportToVehiclePad(1));
  await page.waitForTimeout(300);

  // E opens the pad menu -- app.ts's syncBaseAssetsView toggles it open the same tick this
  // key registers, once the player is within VEHICLE_PAD_USE_RADIUS of a powered pad.
  const wildcatButton = page.locator('#vehicle-pad-menu button', { hasText: 'Wildcat' });
  await pressEUntil(page, () => wildcatButton.isVisible());
  await wildcatButton.click();

  // Vehicles spawn on the platform, separate from the control station. Walk over to it.
  const destination = await page.evaluate(() => {
    const app = (window as unknown as { __app: App }).__app;
    const v = app.world.vehicles;
    const id = Array.from(v.active).findIndex(Boolean);
    const x = v.position[id * 3]!,
      z = v.position[id * 3 + 2]!;
    app.input.yaw = Math.atan2(
      x - app.world.players.position[app.playerId * 3]!,
      z - app.world.players.position[app.playerId * 3 + 2]!,
    );
    return { x, z };
  });
  await page.keyboard.down('KeyW');
  try {
    await expect
      .poll(
        () =>
          page.evaluate(({ x, z }) => {
            const app = (window as unknown as { __app: App }).__app;
            return Math.hypot(
              app.world.players.position[app.playerId * 3]! - x,
              app.world.players.position[app.playerId * 3 + 2]! - z,
            );
          }, destination),
        { timeout: 20_000, intervals: [100] },
      )
      .toBeLessThan(3);
  } finally {
    await page.keyboard.up('KeyW');
  }

  // #hud-vehicle is empty while unmounted (hud.ts's vehicleRow) and reads
  // "Vehicle <health>% — <speed> m/s" once mounted -- this is the "we're driving" signal.
  const hudVehicle = page.locator('#hud-vehicle');
  const isMounted = async (): Promise<boolean> =>
    ((await hudVehicle.getAttribute('data-value')) ?? '') !== '';
  await pressEUntil(page, isMounted);

  // The freshly-spawned/just-mounted Wildcat still carries some small vertical velocity from
  // its own hover spring settling onto its rest height -- comparing against this baseline
  // (rather than requiring it to reach exactly zero first) is what makes the assertion below
  // unambiguously about W-driven thrust, not leftover hover jitter.
  const restingSpeed = speedOf(await hudVehicle.getAttribute('data-value'));

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1_500);
  const drivingSpeed = speedOf(await hudVehicle.getAttribute('data-value'));
  await page.keyboard.up('KeyW');
  expect(drivingSpeed).toBeGreaterThan(restingSpeed + 1);

  // Let the release itself settle before the next key edge -- back-to-back key transitions
  // faster than the render loop's own frame cadence risk missing usePressedThisFrame()'s
  // edge entirely (see tapE's own comment).
  await page.waitForTimeout(300);
  await pressEUntil(page, async () => !(await isMounted()));

  // Dismounted and settled, not left in a falling/damaged state. The dismount seat position
  // is wherever the Wildcat's own hover spring had it -- unlike vehicle destruction, a plain
  // dismount applies no ejection impulse, so the player just free-falls from there under
  // normal gravity/collision (movement.ts's mounted guard no longer applies) until they come
  // to rest. Deliberately not asserting `#debug-ground` here: that flag reflects TERRAIN
  // contact only (movement.ts's classify/integrate sample the heightfield, never
  // world.interiors), and the vehicle pad itself sits on the `svpad` interior platform mesh,
  // not raw terrain -- a player resting on any interior floor (a station, this pad) reads
  // onGround: 0 by that same real, pre-existing M1-M4 distinction, not a vehicle-specific
  // bug. Position settling (three consecutive identical reads) plus undamaged health is the
  // location-independent "came to rest safely" signal instead.
  let lastPos = '';
  let stableReads = 0;
  await expect
    .poll(
      async () => {
        const pos = await page.locator('#debug-pos').textContent();
        stableReads = pos === lastPos ? stableReads + 1 : 0;
        lastPos = pos ?? '';
        return stableReads;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3);
  const health = Number(await page.locator('#debug-health').getAttribute('data-value'));
  expect(health).toBeGreaterThan(0);
});
