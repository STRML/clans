import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

// Distinct from playwright.config.ts's own client webServer (5173) and server.spec.ts's own
// spawned server (17788), so this suite never fights either while running concurrently.
const DEMO_PORT = 5174;
const SERVER_PORT = 17789;
const DEMO_URL = `http://127.0.0.1:${String(DEMO_PORT)}`;

let demoProcess: ChildProcess;
let serverProcess: ChildProcess;

test.beforeAll(async () => {
  demoProcess = spawn('pnpm', ['--filter', '@clans/demo', 'exec', 'vite'], { stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('demo dev server did not start in time')),
      20_000,
    );
    demoProcess.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready in')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    demoProcess.on('error', reject);
  });

  serverProcess = spawn(
    'pnpm',
    [
      '--filter',
      '@clans/server',
      'exec',
      'tsx',
      'src/index.ts',
      '--bots',
      '3',
      '--port',
      String(SERVER_PORT),
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
  demoProcess.kill();
  serverProcess.kill();
});

test('loading the demo with no server query param shows the connect-instructions screen (row 25)', async ({
  page,
}) => {
  await page.goto(DEMO_URL);
  await expect(page.locator('#demo-instructions')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('loading the demo with a server query param boots the real client against it', async ({
  page,
}) => {
  await page.goto(`${DEMO_URL}/?server=ws://127.0.0.1:${String(SERVER_PORT)}`);
  await expect(page.locator('#demo-instructions')).toBeHidden();
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });
});
