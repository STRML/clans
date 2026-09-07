import { createApp } from './app.js';
import { createDebug } from './debug.js';

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

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

const serverUrl = new URLSearchParams(location.search).get('server');
const app = await createApp(container, { serverUrl });
window.__clansDebug = {
  teleportToFlag: (team) => app.debugTeleportToFlag(team),
  killGenerator: (team) => app.debugKillGenerator(team),
  repairGenerator: (team) => app.debugRepairGenerator(team),
  isStationPowered: (team) => app.debugIsStationPowered(team),
};
const debug = createDebug(app, document.body);
let last = performance.now();
const tick = (now: number): void => {
  app.frame((now - last) / 1000);
  debug.update();
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
