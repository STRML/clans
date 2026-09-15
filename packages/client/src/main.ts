import { createApp, type App } from './app.js';
import { createDebug } from './debug.js';
import { frameDue } from './loop.js';

declare global {
  interface Window {
    __clansDebug?: {
      teleportToFlag(team: number): void;
      killGenerator(team: number): void;
      repairGenerator(team: number): void;
      isStationPowered(team: number): boolean;
      teleportToVehiclePad(team: number): void;
    };
    __app?: App;
  }
}

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

// An explicit `?server=` always wins; `?server=off` opts out entirely (demo.spec row 25's
// offline-first contract). Bare `pnpm dev` pairs this page with the game server it spawns
// via VITE_GAME_SERVER (scripts/dev.ts), so the default dev flow reaches the bots without
// anyone hand-typing a ws URL; `pnpm dev:client` and the production build never set the
// variable and stay offline-first.
const requestedServer = new URLSearchParams(location.search).get('server');
const serverUrl =
  requestedServer === 'off'
    ? null
    : (requestedServer ?? (import.meta.env.VITE_GAME_SERVER as string | undefined) ?? null);
const app = await createApp(container, { serverUrl });
window.__clansDebug = {
  teleportToFlag: (team) => app.debugTeleportToFlag(team),
  killGenerator: (team) => app.debugKillGenerator(team),
  repairGenerator: (team) => app.debugRepairGenerator(team),
  isStationPowered: (team) => app.debugIsStationPowered(team),
  teleportToVehiclePad: (team) => app.debugTeleportToVehiclePad(team),
};
// e2e-only handle (Playwright's command-circuit.spec.ts polls net.orders off it) -- never
// ships in a production Pages build.
if (import.meta.env.DEV || import.meta.env.MODE === 'test') window.__app = app;
/**
 * The render loop's rate cap. rAF fires at the display's own refresh -- 120 Hz on the
 * ProMotion Macs this game gets played on -- and every per-frame cost (three's scene
 * graph, the shadow pass, the HUD and nameplate DOM syncs) scales with it, so an uncapped
 * loop burns multiple cores for frames nobody sees. 60 is the cap the source era ran at;
 * `?fps=` overrides for experiments (?fps=30 on a weak GPU, ?fps=0 = uncapped).
 */
const MAX_FPS = Number(new URLSearchParams(location.search).get('fps') ?? 60) || Infinity;
const FRAME_BUDGET_MS = 1000 / MAX_FPS;
const debug = createDebug(app, document.body);
let last = performance.now();
const tick = (now: number): void => {
  // Schedule first so a throw inside frame() still keeps the loop alive, then skip the
  // whole frame when the display is faster than the cap: `last` only advances on frames
  // actually rendered, so the sim's dt stays the real elapsed time across skipped frames.
  requestAnimationFrame(tick);
  if (!frameDue(last, now, FRAME_BUDGET_MS)) return;
  const dt = Math.min((now - last) / 1000, 0.2);
  last = now;
  app.frame(dt);
  debug.update();
};
requestAnimationFrame(tick);
