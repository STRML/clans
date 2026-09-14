import { expect, test, type Page } from '@playwright/test';
import type { App } from '../packages/client/src/app.js';
import { FAVORITES_STORAGE_KEY } from '../packages/client/src/stationMenu.js';

/** Standing on a powered team-1 inventory pad auto-opens the menu (app.ts's
 *  syncInventoryStationEntry); teleporting the player onto the pad is the deterministic
 *  route e2e/menus.spec.ts uses to reach that state, minus the pointer-lock capture that
 *  spec exercises separately. */
async function standOnInventoryStation(page: Page): Promise<void> {
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
}

test('a confirmed loadout persists as favorites and prefills after a reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await standOnInventoryStation(page);
  const menu = page.locator('#station-menu');
  await expect(menu).toBeVisible();

  // The grenade row is present but inert in every state: checked (the sim's single thrown
  // grenade is always carried) and disabled (the Loadout wire message has no grenade
  // field to carry a choice -- stationMenu.ts's grenade row comment). Light grants 5.
  const grenade = page.getByRole('checkbox', { name: 'Hand Grenade' });
  await expect(grenade).toBeDisabled();
  await expect(grenade).toBeChecked();
  await expect(page.locator('#station-grenade-note')).toContainText('×5');

  // A deliberately distinctive loadout: nothing about it matches the fresh-spawn defaults
  // (Light / no pack / Spinfusor+Chaingun+Laser Rifle), so the post-reload prefill below
  // can only come from the persisted favorites.
  await page.getByRole('button', { name: 'Heavy', exact: true }).click();
  await expect(page.locator('#station-grenade-note')).toContainText('×8');
  await page.getByRole('button', { name: 'Energy Pack', exact: true }).click();
  // The armor switch already dropped the Laser Rifle (Heavy disallows it); uncheck the
  // Chaingun and take Mortar + Blaster instead.
  await page.getByRole('checkbox', { name: 'Chaingun' }).uncheck();
  await page.getByRole('checkbox', { name: 'Mortar' }).check();
  await page.getByRole('checkbox', { name: 'Blaster' }).check();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(menu).toBeHidden();

  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
    FAVORITES_STORAGE_KEY,
  );
  expect(saved).toEqual({
    armor: 2, // ArmorId.Heavy
    pack: 2, // PackId.Energy
    weapons: (1 << 0) | (1 << 2) | (1 << 4), // Spinfusor + Mortar + Blaster
  });

  // A reload resets the world to a fresh Light spawn; only the persisted favorites can
  // restore the Heavy/Energy picks.
  await page.reload();
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await standOnInventoryStation(page);
  await expect(menu).toBeVisible();
  await expect(page.getByRole('button', { name: 'Heavy', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Energy Pack', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('checkbox', { name: 'Spinfusor' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Mortar' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Blaster' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Chaingun' })).not.toBeChecked();
  await expect(grenade).toBeDisabled();

  // Clear favorites empties storage and disables itself.
  const clear = page.getByRole('button', { name: 'Clear favorites', exact: true });
  await clear.click();
  await expect(clear).toBeDisabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), FAVORITES_STORAGE_KEY)).toBeNull();

  // The next open after a clear prefills from the carried loadout again, not favorites.
  await page.reload();
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached' });
  await standOnInventoryStation(page);
  await expect(menu).toBeVisible();
  await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('checkbox', { name: 'Mortar' })).not.toBeChecked();
  await expect(clear).toBeDisabled();
});
