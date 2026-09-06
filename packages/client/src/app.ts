import * as THREE from 'three';
import {
  FIXED_DT,
  FIXED_TICK_MS,
  addPlayer,
  createWorld,
  sampleTerrain,
  stepWorld,
  type Heightfield,
  type PlayerInput,
  type World,
} from '@clans/sim';
import { loadKatabatic, type KatabaticAssets } from './assets.js';
import { Input } from './input.js';
import { advance, type Accumulator } from './loop.js';
import { NetClient, type RemoteSnapshot } from './netclient.js';
import { RemoteBuffer, syncRemoteMeshes } from './remote.js';
import { addEnvironment, createTerrain } from './terrain.js';
import { WebSocketTransport } from './transport.js';

// Light armor is 2.3 m tall; the camera sits just below the top of the bounding box.
const EYE_HEIGHT = 2.0;
const FREE_CAM_SPEED = 40;
const FREE_CAM_FAST = 4;
const IDLE: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };

export interface AppStats {
  fps: number;
  frameMs: number;
  simMs: number;
  ping: number;
  bytesPerSecond: number;
  packetLossEstimate: number;
  predictionErrorM: number;
  entityCount: number;
}

export interface App {
  world: World;
  playerId: number;
  input: Input;
  assets: KatabaticAssets;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  /**
   * WONTFIX (PR #4, M2 status table): only reachable through the F1 debug panel
   * (debug.ts), never during normal play. Codex round 15 found that running this above
   * 1 in networked mode calls net.tick() faster than the server's fixed-rate queue can
   * drain, silently evicting older queued inputs once the per-client backlog exceeds
   * MAX_PENDING_INPUTS and desyncing that player's own prediction. It affects only the
   * player who opens the debug panel and moves this slider, with no effect on server
   * stability or other players, so this is an accepted debug-tool caveat, not a defect.
   */
  timeScale: number;
  paused: boolean;
  stepOnce: boolean;
  freeCam: boolean;
  freeCamPosition: THREE.Vector3;
  stats: AppStats;
  frame(dtSeconds: number): void;
}

function toHeightfield(assets: KatabaticAssets): Heightfield {
  const { gridSize, squareSize, origin, heightScale } = assets.terrain;
  return {
    gridSize,
    squareSize,
    originX: origin.x,
    originY: origin.y,
    originZ: origin.z,
    heightScale,
    heights: assets.heights,
    emptySquares: new Set(assets.terrain.emptySquares),
  };
}

function spawnPoint(
  assets: KatabaticAssets,
  terrain: Heightfield,
): { x: number; y: number; z: number } {
  const spawn = assets.scene.spawns.find((candidate) => candidate.team === 1);
  if (!spawn) throw new Error('Katabatic scene has no team 1 spawn');
  const [x, y, z] = spawn.position;
  const ground = sampleTerrain(terrain, x, z).height;
  return { x, y: Math.max(y, ground + 0.1), z };
}

function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  container.replaceChildren(renderer.domElement);
  return renderer;
}

/** Camera looks along (sin yaw, 0, cos yaw) for yaw 0, which is Three's rotation.y = yaw + PI. */
function aimCamera(camera: THREE.PerspectiveCamera, yaw: number, pitch: number): void {
  camera.rotation.set(pitch, yaw + Math.PI, 0, 'YXZ');
}

function moveFreeCam(app: App, dt: number): void {
  const speed = FREE_CAM_SPEED * (app.input.isDown('ShiftLeft') ? FREE_CAM_FAST : 1) * dt;
  const forward = new THREE.Vector3();
  app.camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, app.camera.up).normalize();
  const move = app.input.snapshot();
  app.freeCamPosition.addScaledVector(forward, move.moveZ * speed);
  app.freeCamPosition.addScaledVector(right, move.moveX * speed);
  if (app.input.isDown('Space')) app.freeCamPosition.y += speed;
  if (app.input.isDown('ControlLeft')) app.freeCamPosition.y -= speed;
}

function placeCamera(app: App, sky: THREE.Object3D): void {
  aimCamera(app.camera, app.input.yaw, app.input.pitch);
  if (app.freeCam) {
    app.camera.position.copy(app.freeCamPosition);
  } else {
    const base = app.playerId * 3;
    const position = app.world.players.position;
    app.camera.position.set(
      position[base] ?? 0,
      (position[base + 1] ?? 0) + EYE_HEIGHT,
      position[base + 2] ?? 0,
    );
  }
  sky.position.copy(app.camera.position);
}

export interface AppOptions {
  serverUrl?: string | null;
}

function createNetClient(
  serverUrl: string | null | undefined,
  terrain: Heightfield,
): NetClient | null {
  return serverUrl ? new NetClient(new WebSocketTransport(serverUrl), terrain) : null;
}

function setupResize(
  container: HTMLElement,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
): void {
  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
}

function updateFps(app: App, frameStart: number, fps: FpsWindow): void {
  fps.frames += 1;
  if (frameStart - fps.windowStart >= 500) {
    app.stats.fps = (fps.frames * 1000) / (frameStart - fps.windowStart);
    fps.windowStart = frameStart;
    fps.frames = 0;
  }
}

interface FpsWindow {
  windowStart: number;
  frames: number;
}

function stepSinglePlayer(world: World, playerId: number, input: PlayerInput, steps: number): void {
  const inputs = new Map<number, PlayerInput>([[playerId, input]]);
  for (let step = 0; step < steps; step += 1) stepWorld(world, inputs);
}

function stepNetworked(
  net: NetClient,
  stats: AppStats,
  input: PlayerInput,
  steps: number,
  scene: THREE.Scene,
  remoteMeshes: Map<number, THREE.Mesh>,
  remoteBuffers: Map<number, RemoteBuffer>,
): void {
  for (let step = 0; step < steps; step += 1) net.tick(input);
  updateRemotes(net, scene, remoteMeshes, remoteBuffers, performance.now());
  stats.ping = net.stats.ping;
  stats.bytesPerSecond = net.stats.bytesPerSecond;
  stats.packetLossEstimate = net.stats.packetLossEstimate;
  stats.predictionErrorM = net.stats.predictionErrorM;
  stats.entityCount = net.stats.entityCount;
}

function applyRemoteSnapshot(
  buffers: Map<number, RemoteBuffer>,
  snapshot: RemoteSnapshot,
  atMs: number,
): void {
  for (const [id, player] of snapshot.players) {
    const buffer = buffers.get(id) ?? new RemoteBuffer();
    buffers.set(id, buffer);
    buffer.push(atMs, player);
  }
}

/** Drops any buffer for an id the most recent snapshot no longer reports (left or died). */
function pruneStaleRemoteBuffers(buffers: Map<number, RemoteBuffer>, latest: RemoteSnapshot): void {
  for (const id of [...buffers.keys()]) {
    if (!latest.players.has(id)) buffers.delete(id);
  }
}

/**
 * Exported for a focused unit test. `nowMs` must be the same clock RemoteBuffer.positionAt
 * is later queried on (the caller's performance.now()).
 */
export function updateRemotes(
  activeNet: Pick<NetClient, 'remoteSnapshots' | 'connected'>,
  targetScene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  buffers: Map<number, RemoteBuffer>,
  nowMs: number,
): void {
  // remoteSnapshots only grows when a snapshot arrives, and nothing else clears it once
  // the socket drops -- a plain disconnect (no final empty snapshot) left every remote
  // mesh, and the GPU resources syncRemoteMeshes' pruning now disposes, stranded until
  // the page itself tore down. Clearing every buffer here lets that same pruning path
  // remove and dispose them on the very next call.
  if (!activeNet.connected) {
    buffers.clear();
    syncRemoteMeshes(targetScene, meshes, buffers, nowMs);
    return;
  }
  // Codex round 10 (PR #4): reading only the latest remotePlayers/remoteTick once per
  // render call meant any earlier snapshot that arrived within the same frame (a frame
  // stall, or simply more than one landing before the next paint) was already gone --
  // RemoteBuffer's interpolation history silently lost that sample, so a remote snapped
  // instead of smoothing through it. Draining every queued snapshot here instead keeps
  // that history complete regardless of how render and network delivery interleave.
  const pending = activeNet.remoteSnapshots.splice(0, activeNet.remoteSnapshots.length);
  const latest = pending.at(-1);
  for (const snapshot of pending) {
    // Codex round 11 (PR #4): stamping every drained snapshot with the same nowMs stored
    // genuinely different positions at identical timestamps, and RemoteBuffer's
    // interpolate() treats equal timestamps as one sample, falling back to it instead of
    // bracketing between them -- the remote still jumped rather than smoothed. tick maps
    // 1:1 to FIXED_TICK_MS of real server time, so offsetting behind nowMs by however many
    // ticks a snapshot trails the newest one in this batch gives every entry its own,
    // correctly-ordered timestamp.
    const atMs = latest ? nowMs - (latest.tick - snapshot.tick) * FIXED_TICK_MS : nowMs;
    applyRemoteSnapshot(buffers, snapshot, atMs);
  }
  if (latest) pruneStaleRemoteBuffers(buffers, latest);
  syncRemoteMeshes(targetScene, meshes, buffers, nowMs);
}

export async function createApp(container: HTMLElement, options: AppOptions = {}): Promise<App> {
  const assets = await loadKatabatic();
  const terrain = toHeightfield(assets);
  const net = createNetClient(options.serverUrl, terrain);
  const world = net ? net.world : createWorld(terrain, 1);
  const playerId = net ? 0 : addPlayer(world, spawnPoint(assets, terrain));

  const scene = new THREE.Scene();
  addEnvironment(scene, assets);
  scene.add(await createTerrain(assets));
  const sky = scene.getObjectByName('sky');
  if (!sky) throw new Error('addEnvironment did not add the sky');

  const camera = new THREE.PerspectiveCamera(
    90,
    container.clientWidth / container.clientHeight,
    0.1,
    1200,
  );
  const renderer = createRenderer(container);
  const input = new Input(renderer.domElement);
  input.attach();
  setupResize(container, camera, renderer);

  const acc: Accumulator = { remainder: 0 };
  const remoteMeshes = new Map<number, THREE.Mesh>();
  const remoteBuffers = new Map<number, RemoteBuffer>();
  const fps: FpsWindow = { windowStart: performance.now(), frames: 0 };

  const app: App = {
    world,
    playerId,
    input,
    assets,
    camera,
    scene,
    renderer,
    timeScale: 1,
    paused: false,
    stepOnce: false,
    freeCam: false,
    freeCamPosition: new THREE.Vector3(),
    stats: {
      fps: 0,
      frameMs: 0,
      simMs: 0,
      ping: 0,
      bytesPerSecond: 0,
      packetLossEstimate: 0,
      predictionErrorM: 0,
      entityCount: 1,
    },
    frame(dtSeconds: number): void {
      const frameStart = performance.now();
      let steps = advance(acc, dtSeconds, app.paused ? 0 : app.timeScale, FIXED_DT);
      if (app.stepOnce) {
        steps = 1;
        app.stepOnce = false;
      }
      const currentInput = app.freeCam ? { ...IDLE, yaw: input.yaw } : input.snapshot();
      const simStart = performance.now();
      if (net) {
        stepNetworked(net, app.stats, currentInput, steps, scene, remoteMeshes, remoteBuffers);
      } else {
        stepSinglePlayer(world, playerId, currentInput, steps);
      }
      app.stats.simMs = performance.now() - simStart;
      if (app.freeCam) moveFreeCam(app, dtSeconds);
      placeCamera(app, sky);
      renderer.render(scene, camera);
      app.stats.frameMs = performance.now() - frameStart;
      updateFps(app, frameStart, fps);
    },
  };
  return app;
}
