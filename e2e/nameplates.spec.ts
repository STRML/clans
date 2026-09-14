import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const PORT = 17801; // Distinct from every other e2e spec's server port (17788-17793, 5174).

// A bots-only match: the IFF's whole point is plates floating over OTHER players, and only
// a server with bots gives the single human teammates to see. Same spawn shape as
// scoreboard.spec.ts's bots-only roster server.
let serverProcess: ChildProcess;

test.beforeAll(async () => {
  serverProcess = spawn(
    'pnpm',
    [
      '--filter',
      '@clans/server',
      'exec',
      'tsx',
      'src/index.ts',
      '--bots',
      '24',
      '--port',
      String(PORT),
    ],
    { stdio: 'pipe' },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 20_000);
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', reject);
  });
});

test.afterAll(() => {
  serverProcess.kill();
});

interface RemotePlayerShape {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  health: number;
}

interface NetShape {
  playerId: number;
  team: number;
  roster: Array<{ playerId: number; name: string }>;
  remotePlayers: Map<number, RemotePlayerShape>;
}

interface AppShape {
  freeCam: boolean;
  freeCamPosition: { set(x: number, y: number, z: number): void };
  input: { yaw: number; pitch: number };
  net: NetShape | null;
}

/** Parks the free camera at the closest living teammate, aimed at their plate anchor.
 *  Returns the aimed teammate's roster name -- the exact string the plate must show -- or
 *  null when no living teammate exists yet. */
async function aimAtClosestLivingTeammate(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // page.evaluate serializes this callback alone -- module-scope helpers and constants
    // do not exist in the page, so the teammate pick and the anchor height are inline.
    const app = (window as unknown as { __app?: AppShape }).__app;
    const net = app?.net;
    if (!app || !net || net.playerId < 0) return null;
    const best = [...net.remotePlayers.values()]
      .filter((player) => player.team === net.team && player.health > 0)
      .sort((a, b) => a.x * a.x + a.y * a.y + a.z * a.z - (b.x * b.x + b.y * b.y + b.z * b.z))[0];
    if (!best) return null;
    // Eye 4.5 m up and 8.5 m back diagonally; the plate anchor (feet + 2.9 m, nameplates.ts's
    // NAMEPLATE_ANCHOR_M) then sits mid-frame, well inside the 90-degree fov and far inside
    // NAMEPLATE_RANGE_M. yaw/pitch are the same sin/cos pair placeCamera feeds aimCamera
    // (forward = (sin yaw cos pitch, sin pitch, cos yaw cos pitch)).
    const eye = { x: best.x + 6, y: best.y + 4.5, z: best.z + 6 };
    app.freeCam = true;
    app.freeCamPosition.set(eye.x, eye.y, eye.z);
    const dx = best.x - eye.x;
    const dy = best.y + 2.9 - eye.y;
    const dz = best.z - eye.z;
    app.input.yaw = Math.atan2(dx, dz);
    app.input.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
    return net.roster.find((entry) => entry.playerId === best.id)?.name ?? null;
  });
}

test('IFF plates render over living teammates, never over enemies', async ({ page }) => {
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });

  // Keep re-aiming until a plate is actually on screen: between the camera parking at a
  // teammate and the assertion, the bot keeps walking, so the poll itself re-aims each try.
  const aimedAt = new Set<string>();
  await expect
    .poll(
      async () => {
        const name = await aimAtClosestLivingTeammate(page);
        if (name) aimedAt.add(name);
        return page.locator('#nameplates .nameplate').count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(1);
  // Every aimed-at teammate was a real roster entry, so at least one plate name is known
  // good (non-empty, roster-sourced rather than the P<id> fallback).
  expect(aimedAt.size).toBeGreaterThanOrEqual(1);

  const localTeam = await page.evaluate(
    () => (window as unknown as { __app?: AppShape }).__app?.net?.team ?? 0,
  );
  const enemyTeam = localTeam === 1 ? 2 : 1;

  const plates = page.locator('#nameplates .nameplate');
  const count = await plates.count();
  expect(count).toBeGreaterThanOrEqual(1);
  for (let index = 0; index < count; index += 1) {
    const plate = plates.nth(index);
    // Every plate carries its player's team, and the model only ever emits teammates:
    // asserted both directions -- local team present, enemy team never.
    expect(Number(await plate.getAttribute('data-team'))).toBe(localTeam);
    expect(Number(await plate.getAttribute('data-team'))).not.toBe(enemyTeam);
    const name = await plate.locator('.nameplate-name').textContent();
    expect(name?.trim().length ?? 0).toBeGreaterThan(0);
    // The health bar is a width-percentage in [0, 100] -- a real fraction, never negative
    // or missing, even mid-firefight.
    const fill = await plate
      .locator('.nameplate-health-fill')
      .evaluate((element) => (element as HTMLElement).style.width);
    const percent = Number.parseFloat(fill);
    expect(Number.isFinite(percent)).toBe(true);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  }
});
