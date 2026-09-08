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
const errorPanel = document.getElementById('demo-error');
const errorDetail = document.getElementById('demo-error-detail');
const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

// Row 25 of the M7 failure matrix: never open a socket with no (or empty) `?server=` value.
// The instructions screen is the only thing that renders in that case.
const server = new URLSearchParams(location.search).get('server');
if (!server) {
  if (instructions) instructions.hidden = false;
} else {
  const app = await createApp(container, { serverUrl: server });
  // Codex review round 1 of the M7 PR: an unreachable ?server value used to render a fully
  // unconnected app with no explanation at all -- container.hidden never flips back on, and
  // Transport has no error surface of its own, so this reads app.net's own `connected`
  // getter (== the transport's own isOpen(), true while CONNECTING) after a real-world
  // refused-connection window. A genuinely working connection reaches the server's Welcome
  // well inside this; an unreachable one has already closed by then (this repo's own e2e
  // servers report "listening" inside 20s, an order of magnitude looser).
  setTimeout(() => {
    if (app.net && !app.net.connected && errorPanel && errorDetail) {
      errorDetail.textContent = `Could not reach ${server}.`;
      errorPanel.hidden = false;
      container.hidden = true;
    }
  }, 8_000);
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
