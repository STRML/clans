import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
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

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A raw TCP server that completes the WebSocket opening handshake (so the browser's own
 *  `WebSocket` reaches `readyState === OPEN`) and then sends nothing else, ever -- no Clans
 *  protocol Welcome message, no close. Reproduces Codex review round 2 of the M7 PR: a socket
 *  that accepts the connection but never speaks the app protocol, which `net.connected`
 *  (== the transport's own isOpen(), true for OPEN) alone can't distinguish from a genuinely
 *  working connection still in its first tick. Built on node:net directly rather than the
 *  `ws` package, which isn't a root dependency e2e/ can resolve. */
function startSilentWsStub(port: number): net.Server {
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const match = /Sec-WebSocket-Key: (\S+)/i.exec(chunk.toString('latin1'));
      if (!match) return;
      const accept = createHash('sha1')
        .update(match[1] + WS_MAGIC_GUID)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Handshake complete; deliberately never write another byte.
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

test('an accepted connection that never speaks the protocol shows a connection-failed message, not a permanently blank app (Codex review round 2 of the M7 PR)', async ({
  page,
}) => {
  const STUB_PORT = 17793;
  const stub = startSilentWsStub(STUB_PORT);
  try {
    await page.goto(`${DEMO_URL}/?server=ws://127.0.0.1:${String(STUB_PORT)}`);
    await expect(page.locator('#demo-error')).toBeVisible({ timeout: 15_000 });
  } finally {
    stub.close();
  }
});

test('a malformed server URL shows a connection-failed message instead of an unhandled rejection (Codex review round 2 of the M7 PR)', async ({
  page,
}) => {
  // `new WebSocket('ftp://x')` throws synchronously inside createApp (an explicit non-ws/wss
  // scheme) -- this covers the try/catch main.ts now wraps that call in, not the
  // timeout-based check the other two connection-failure tests exercise. A schemeless value
  // like `not-a-url` does NOT hit this path: verified this session that a real page resolves
  // it relative to its own origin rather than rejecting it outright, so that case is already
  // covered by the timeout-based check instead (main.ts's own comment explains why).
  await page.goto(`${DEMO_URL}/?server=ftp://x`);
  await expect(page.locator('#demo-error')).toBeVisible({ timeout: 5_000 });
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
  await expect(page.locator('#hud')).toHaveCSS('display', 'block');
  await expect(page.locator('#hud-status-art')).toHaveCSS('background-image', /hud_new_cog/);
});

test('an unreachable server shows a connection-failed message instead of a silently blank app (Codex review round 1 of the M7 PR)', async ({
  page,
}) => {
  // Port 9 ("discard") refuses a TCP connection near-instantly, so the socket closes well
  // inside main.ts's own 8s check -- no real server needed for this repro.
  await page.goto(`${DEMO_URL}/?server=ws://127.0.0.1:9`);
  await expect(page.locator('#demo-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#demo-error-detail')).toContainText('127.0.0.1:9');
});
