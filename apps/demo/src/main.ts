import { createApp, createDebug } from '@clans/client';

declare global {
  interface Window {
    __clansDebug?: {
      teleportToFlag(team: number): void;
      killGenerator(team: number): void;
      repairGenerator(team: number): void;
      isStationPowered(team: number): boolean;
      teleportToVehiclePad(team: number): void;
    };
  }
}

const instructions = document.getElementById('demo-instructions');
const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

// Row 25 of the M7 failure matrix: never open a socket with no (or empty) `?server=` value.
// The instructions screen is the only thing that renders in that case.
const server = new URLSearchParams(location.search).get('server');
if (!server) {
  if (instructions) instructions.hidden = false;
} else {
  const app = await createApp(container, { serverUrl: server });
  window.__clansDebug = {
    teleportToFlag: (team) => app.debugTeleportToFlag(team),
    killGenerator: (team) => app.debugKillGenerator(team),
    repairGenerator: (team) => app.debugRepairGenerator(team),
    isStationPowered: (team) => app.debugIsStationPowered(team),
    teleportToVehiclePad: (team) => app.debugTeleportToVehiclePad(team),
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
}
