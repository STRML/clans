import * as THREE from 'three';
import {
  FIXED_DT,
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
import { addEnvironment, createTerrain } from './terrain.js';

// Light armor is 2.3 m tall; the camera sits just below the top of the bounding box.
const EYE_HEIGHT = 2.0;
const FREE_CAM_SPEED = 40;
const FREE_CAM_FAST = 4;
const IDLE: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };

export interface AppStats {
  fps: number;
  frameMs: number;
  simMs: number;
}

export interface App {
  world: World;
  playerId: number;
  input: Input;
  assets: KatabaticAssets;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
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

export async function createApp(container: HTMLElement): Promise<App> {
  const assets = await loadKatabatic();
  const terrain = toHeightfield(assets);
  const world = createWorld(terrain, 1);
  const playerId = addPlayer(world, spawnPoint(assets, terrain));

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
  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  const acc: Accumulator = { remainder: 0 };
  let fpsWindowStart = performance.now();
  let fpsFrames = 0;

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
    stats: { fps: 0, frameMs: 0, simMs: 0 },
    frame(dtSeconds: number): void {
      const frameStart = performance.now();
      let steps = advance(acc, dtSeconds, app.paused ? 0 : app.timeScale, FIXED_DT);
      if (app.stepOnce) {
        steps = 1;
        app.stepOnce = false;
      }
      const inputs = new Map<number, PlayerInput>([
        [playerId, app.freeCam ? { ...IDLE, yaw: input.yaw } : input.snapshot()],
      ]);
      const simStart = performance.now();
      for (let step = 0; step < steps; step += 1) stepWorld(world, inputs);
      app.stats.simMs = performance.now() - simStart;
      if (app.freeCam) moveFreeCam(app, dtSeconds);
      placeCamera(app, sky);
      renderer.render(scene, camera);
      app.stats.frameMs = performance.now() - frameStart;
      fpsFrames += 1;
      if (frameStart - fpsWindowStart >= 500) {
        app.stats.fps = (fpsFrames * 1000) / (frameStart - fpsWindowStart);
        fpsWindowStart = frameStart;
        fpsFrames = 0;
      }
    },
  };
  return app;
}
