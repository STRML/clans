import { createApp, createDebug, type App } from '@clans/client';

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
function showConnectError(detail: string): void {
  if (!errorPanel || !errorDetail) return;
  errorDetail.textContent = detail;
  errorPanel.hidden = false;
  const appContainer = document.getElementById('app');
  if (appContainer) appContainer.hidden = true;
}

const server = new URLSearchParams(location.search).get('server');
if (!server) {
  if (instructions) instructions.hidden = false;
} else {
  let app: App;
  try {
    // Codex review round 2 of the M7 PR: `new WebSocket(url)` throws synchronously for some
    // malformed URLs -- e.g. `?server=ftp://x` (an explicit non-ws/wss scheme) -- and that
    // throw used to happen inside createApp, before the error panel below was ever wired up,
    // leaving an unhandled rejection and a blank page. (A schemeless value like `not-a-url`
    // does NOT hit this path: the browser resolves it relative to the page's own origin
    // instead of rejecting it outright, and the resulting connection attempt just fails the
    // same way an unreachable host does, caught by the timeout check below.)
    app = await createApp(container, { serverUrl: server });
  } catch (error) {
    showConnectError(`Could not connect to ${server}: ${String(error)}`);
    throw error;
  }
  // Codex review round 1 of the M7 PR: an unreachable ?server value used to render a fully
  // unconnected app with no explanation at all. Round 2 found this first fix incomplete --
  // app.net.connected only reflects the transport's own isOpen() (true for OPEN AND
  // CONNECTING), so a socket that accepts the TCP connection but never sends a Welcome (a
  // non-Clans WebSocket endpoint, say) stayed "connected" forever and never tripped this.
  // net.playerId only leaves its -1 sentinel once a real Welcome with WelcomeStatus.Ok has
  // actually been decoded (netclient.ts's own handleWelcome) -- checking both covers "the
  // socket never opened at all" and "it opened but never spoke the protocol" alike. A
  // genuinely working connection reaches Welcome well inside this window; this repo's own
  // e2e servers report "listening" inside 20s, an order of magnitude looser.
  setTimeout(() => {
    if (app.net && (!app.net.connected || app.net.playerId === -1)) {
      showConnectError(`Could not reach ${server}.`);
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
