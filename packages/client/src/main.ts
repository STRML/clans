import { createApp, type App } from './app.js';
import { createDebug } from './debug.js';

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

const serverUrl = new URLSearchParams(location.search).get('server');
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
const debug = createDebug(app, document.body);
let last = performance.now();
const tick = (now: number): void => {
  app.frame((now - last) / 1000);
  debug.update();
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
