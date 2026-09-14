import { spawn } from 'node:child_process';

// The pairing this script exists for: the dev page must reach the bots the dev server
// prints in its own startup log ("listening on ws://127.0.0.1:7777 with N bots"). Vite only
// exposes VITE_-prefixed environment variables to the client bundle (import.meta.env), so
// the address rides in as VITE_GAME_SERVER and main.ts falls back to it when the page has
// no explicit `?server=` -- before this, the bare dev page silently ran the offline
// single-player world (createWorld(terrain, 1)) while dev:server's bots sat unseen, which
// is exactly the "dev:server says it's starting bots but I don't see any" report. The port
// duplicates the `--port 7777` in package.json's dev:server script on purpose: dev:server
// is a pnpm script (not importable), and a one-line cross-referenced literal beats a
// package.json parser for dev tooling. `pnpm dev:client` run without this script never
// sets the variable, nor does Playwright's webServer command, so both keep their
// offline-first contract (demo.spec.ts row 25); `?server=` still wins, `?server=off` opts a
// paired page out.
const DEV_GAME_SERVER_URL = 'ws://127.0.0.1:7777';

const children = [
  spawn('pnpm', ['run', 'dev:server'], { stdio: 'inherit' }),
  spawn('pnpm', ['run', 'dev:client'], {
    env: { ...process.env, VITE_GAME_SERVER: DEV_GAME_SERVER_URL },
    stdio: 'inherit',
  }),
];

function shutdown(): void {
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) shutdown();
  });
}
