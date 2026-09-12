import { createInteractionPrompt } from './interaction-prompt.js';
import { createWeaponModel } from './weapon-model.js';
import * as THREE from 'three';
import {
  applyBaseObjectDamage,
  applyLoadoutSelection,
  armorFor,
  ArmorId,
  BASE_OBJECT_DATA,
  BaseObjectKind,
  FIXED_DT,
  FIXED_TICK_MS,
  FlagState,
  hasLineOfSight,
  segmentBlockedByInteriors,
  VEHICLE_DATA,
  type VehicleData,
  VehicleKind,
  WeaponId,
  WeaponState,
  addPlayer,
  canSendVehicleUse,
  createBaseObjects,
  createFlags,
  createTurrets,
  createWorld,
  dueForRespawn,
  respawnPlayer,
  findSpawnPosition,
  setGodMode,
  requestVehicleAtPad,
  repairBeamTarget,
  stepPower,
  stepWorld,
  vehiclePadAt,
  type Heightfield,
  type PlayerInput,
  type PlayerSnapshotData,
  type ProjectileImpact,
  type Vec3,
  type World,
} from '@clans/sim';
import { EventKind, OrderKind, MessageType } from '@clans/protocol';
import type {
  BaseObjectSnapshotData,
  ProjectileSnapshotData,
  TurretSnapshotData,
  VehicleSnapshotData,
} from '@clans/protocol';
import { loadKatabatic, type KatabaticAssets } from './assets.js';
import { createAudioEngine, FOOTSTEP_INTERVAL_S, type AudioEngine } from './audio.js';
import {
  baseObjectsFromWorld,
  createBaseObjectView,
  raycastAimedStructure,
  turretsFromWorld,
} from './base-object-view.js';
import {
  canvasToWorld,
  drawCommanderMap,
  drawOrderMarkers,
  friendlySensorCircles,
  playersFromWorld,
  sensedEnemyIds,
  type PlayerPosition,
} from './commander-map.js';
import { flagsFromWorld, syncFlagMeshes } from './flag-view.js';
import { createHud, type HudSource } from './hud.js';
import { Input } from './input.js';
import { loadInteriorColliders } from './interior-collision.js';
import { advance, type Accumulator } from './loop.js';
import {
  NetClient,
  type RemoteSnapshot,
  type RemoteVehicleSnapshot,
  type TimestampedEvent,
} from './netclient.js';
import { RemoteBuffer, syncRemoteMeshes } from './remote.js';
import {
  createRepairBeamView,
  repairBeamStatusText,
  type RepairBeamFeedback,
  type RepairBeamView,
} from './repair-beam.js';
import {
  createStationMenu,
  currentLoadoutChoice,
  inventoryStationTriggerAt,
  stationMenuVisible,
  type LoadoutChoice,
  type StationMenu,
} from './stationMenu.js';
import { addEnvironment, createTerrain } from './terrain.js';
import { WebSocketTransport } from './transport.js';
import {
  createVehicleView,
  vehicleRenderDataFrom,
  vehiclesFromWorld,
  VehicleBuffer,
  type VehicleView,
} from './vehicle-view.js';
import {
  createVehiclePadMenu,
  vehiclePadMenuVisible,
  vehicleStationTriggerAt,
  type VehiclePadMenu,
} from './vehiclePadMenu.js';
import { createVoiceMenu, speakVoiceLine, type VoiceMenu } from './voicebinds.js';
import {
  projectilesFromWorld,
  spawnProjectileImpacts,
  spawnVehicleExplosion,
  spawnLaserBeams,
  syncProjectileMeshes,
  updateEffects,
  type Effect,
} from './weapons-view.js';

// Light armor is 2.3 m tall; the camera sits just below the top of the bounding box.
const EYE_HEIGHT = 2.0;
const FREE_CAM_SPEED = 40;
const FREE_CAM_FAST = 4;
/** T2 `GameConnection::mCameraSpeed` (game/gameConnection.cc): the vehicle camera crosses
 *  its whole first-person-to-chase slider in 0.1 s, which is what one toggle costs. */
const VEHICLE_CAMERA_SPEED = 10;
const IDLE: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  jet: false,
  fire: false,
  altFire: false,
  slot: 0,
  packActive: false,
  use: false,
};

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
  net: NetClient | null;
  input: Input;
  assets: KatabaticAssets;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  weaponModel: ReturnType<typeof createWeaponModel>;
  /**
   * Local time scale. Pinned to 1 whenever a network transport exists.
   *
   * The F1 debug panel (debug.ts) exposes it, and the pin is why that panel's slider now
   * renders disabled in netplay: Codex round 15 found that running this above 1 in
   * networked mode calls net.tick() faster than the server's fixed-rate queue can drain,
   * silently evicting older queued inputs once the per-client backlog exceeds
   * MAX_PENDING_INPUTS and desyncing that player's own prediction. `pinNetworkTimeScale`
   * rewrites the value every frame in netplay (debug.ts), so the desync is unreachable
   * rather than accepted.
   */
  timeScale: number;
  paused: boolean;
  stepOnce: boolean;
  freeCam: boolean;
  freeCamPosition: THREE.Vector3;
  /** T2's vehicle camera switch (`GameConnection::mFirstPerson`, default true in
   *  game/gameConnection.cc): true rests the mounted camera on the model's own `Eye` node,
   *  false at the datablock's chase distance. Session-wide, like the pref it mirrors. */
  vehicleCameraFirstPerson: boolean;
  /** The 0..1 slider between those two ends (`GameConnection::mCameraPos`), travelled at
   *  VEHICLE_CAMERA_SPEED so a toggle animates instead of cutting. */
  vehicleCameraPos: number;
  godMode: boolean;
  stats: AppStats;
  frame(dtSeconds: number): void;
  debugTeleportToFlag(team: number): void;
  debugKillGenerator(team: number): void;
  debugRepairGenerator(team: number): void;
  debugIsStationPowered(team: number): boolean;
  debugTeleportToVehiclePad(team: number): void;
  /** Closes the underlying AudioContext (Codex review round 1 of the M7 PR: nothing
   *  previously called AudioEngine's own `dispose`, so every `createApp()` call -- a hot
   *  reload, a test harness constructing several -- leaked a real OS-level audio device
   *  context). Idempotent; safe to call more than once. */
  dispose(): void;
}

function weaponAnimationDelta(app: App, dt: number): number {
  return app.paused || app.world.gameOver ? 0 : dt * app.timeScale;
}

const PILOT_YAW_LIMIT = Math.PI - 0.001;

function shortestAngle(angle: number): number {
  return angle - Math.round(angle / (2 * Math.PI)) * 2 * Math.PI;
}

/**
 * Keeps absolute mouse look usable as a vehicle heading request. Input.yaw deliberately
 * accumulates without a wrap, whereas vehicle yaw is wrapped every simulation tick. Once a
 * look angle was more than half a turn away, passing it through directly made the simulator's
 * shortest-arc controller choose the opposite turn. Track the vehicle in the same unwrapped
 * space, and keep one submitted target within one unambiguous half-turn of it.
 */
export class PilotYawController {
  private vehicleYaw: number | null = null;

  reset(vehicleYaw: number): void {
    this.vehicleYaw = vehicleYaw;
  }

  constrain(lookYaw: number, wrappedVehicleYaw: number): number {
    const previous = this.vehicleYaw;
    const vehicleYaw =
      previous === null
        ? wrappedVehicleYaw
        : previous + shortestAngle(wrappedVehicleYaw - shortestAngle(previous));
    this.vehicleYaw = vehicleYaw;
    return vehicleYaw + Math.max(-PILOT_YAW_LIMIT, Math.min(PILOT_YAW_LIMIT, lookYaw - vehicleYaw));
  }
}

function gameplayInput(app: App, usePressed: boolean, pilotYaw: PilotYawController): PlayerInput {
  const { input, world, playerId } = app;
  if (app.freeCam) return { ...IDLE, yaw: input.yaw, pitch: input.pitch };
  const mounted = world.players.mountedVehicleId[playerId] ?? -1;
  if (mounted !== -1) {
    // Rebase look yaw after capping it. Continued mouse movement advances the target, while a
    // stopped mouse lets the craft settle instead of requesting endless rotations.
    input.yaw = pilotYaw.constrain(input.yaw, world.vehicles.yaw[mounted] ?? 0);
  }
  return {
    ...input.snapshot(),
    use: !input.uiOpen && usePressed && canSendVehicleUse(world, playerId),
  };
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

/** Everything the vehicle camera needs from the world and the model, gathered in one place so
 *  the camera math below stays branch-light: the live pose (`world.vehicles`, never the
 *  interpolation buffer, so a locally-predicted camera cannot lag the mesh it sits on), the
 *  script's camera numbers, and the model's authored `Eye` node. Every shipped model has that
 *  node -- it is the one T2's own first-person end uses -- so the fallback offset exists only
 *  so a model without one cannot strand the camera. */
function vehicleCameraSource(
  app: App,
  vehicleId: number,
): {
  data: VehicleData;
  position: THREE.Vector3;
  heading: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  eye: THREE.Vector3;
} {
  const vehicles = app.world.vehicles;
  const base = vehicleId * 3;
  const position = new THREE.Vector3(
    vehicles.position[base] ?? 0,
    vehicles.position[base + 1] ?? 0,
    vehicles.position[base + 2] ?? 0,
  );
  const yaw = vehicles.yaw[vehicleId] ?? 0;
  const pitch = vehicles.pitch[vehicleId] ?? 0;
  const heading = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  );
  const eyeNode = app.scene.getObjectByName(`vehicle-${String(vehicleId)}`)?.getObjectByName('Eye');
  return {
    data: VEHICLE_DATA[vehicles.kind[vehicleId] as VehicleKind],
    position,
    heading,
    yaw,
    pitch,
    roll: vehicles.roll[vehicleId] ?? 0,
    eye: eyeNode
      ? eyeNode.getWorldPosition(new THREE.Vector3())
      : position.clone().add(new THREE.Vector3(0, 1.4, 0.5)),
  };
}

/** T2's vehicle camera switch, read once per frame: the pref picks which end of
 *  placeVehicleCamera's slider the mounted camera rests at, and the slider itself animates
 *  the change, so a toggle is never a cut. Harmless while walking -- nothing reads the pref
 *  unless a vehicle is mounted. */
function applyCameraToggle(app: App, input: Input): void {
  if (input.cameraTogglePressedThisFrame()) {
    app.vehicleCameraFirstPerson = !app.vehicleCameraFirstPerson;
  }
}

/**
 * T2's vehicle camera is one camera on a slider between two authored ends, not two cameras.
 * `ShapeBase::getCameraTransform` (game/shapeBase.cc) uses the model's `Eye` node at slider
 * position 0 and, for any position above 0, keeps that same eye orientation while moving the
 * position back by `(cameraMaxDist - cameraMinDist) * pos` and up by `cameraOffset`;
 * `GameConnection::getControlCameraTransform` slides the position at `mCameraSpeed`, with
 * `GameConnection::mFirstPerson` (the `$firstPerson` pref, default true) deciding which end
 * it rests at. Both shipped datablocks author the other end (Wildcat cameraMaxDist 5.0 /
 * cameraOffset 0.7, Shrike 15 / 2.5), so this is the source game's own camera. Two engine
 * extras are not reproduced: the collision ray that shortens the chase when terrain is
 * behind the vehicle, and the chase queue (`chaseCam`) that delays the tail end, which our
 * `cameraLag` smoothing stands in for.
 */
function placeVehicleCamera(app: App, vehicleId: number, dt: number): boolean {
  const source = vehicleCameraSource(app, vehicleId);
  const target = app.vehicleCameraFirstPerson ? 0 : 1;
  const travel = VEHICLE_CAMERA_SPEED * dt;
  app.vehicleCameraPos =
    target > app.vehicleCameraPos
      ? Math.min(target, app.vehicleCameraPos + travel)
      : Math.max(target, app.vehicleCameraPos - travel);

  const chase = source.position
    .clone()
    .addScaledVector(source.heading, -source.data.cameraMaxDist)
    .add(new THREE.Vector3(0, source.data.cameraOffset, 0));
  // The slider is a straight run between the two ends, and the eye end is exact: the
  // Shrike's cockpit test pins the camera to that node to the millimetre, so there is nothing
  // left to smooth once the slider is home. `cameraLag` -- a per-second rate that closes its
  // own fraction of the remaining distance each 32 ms tick -- only smooths the chase end,
  // where the engine's chase queue also sits. Neither script exposes the engine's smoothing
  // formula, only this tuning constant.
  const t = app.vehicleCameraPos <= 0 ? 1 : 1 - Math.pow(1 - source.data.cameraLag, dt / FIXED_DT);
  app.camera.position.lerp(source.eye.clone().lerp(chase, app.vehicleCameraPos), t);
  aimCamera(app.camera, source.yaw, source.pitch);
  app.camera.rotateZ(-source.roll);
  return true;
}

function syncPilotInput(app: App, previous: number, pilotYaw: PilotYawController): number {
  const mounted = app.world.players.mountedVehicleId[app.playerId] ?? -1;
  if (mounted !== -1 && mounted !== previous) {
    const yaw = app.world.vehicles.yaw[mounted] ?? 0;
    app.input.yaw = yaw;
    app.input.pitch = app.world.vehicles.pitch[mounted] ?? 0;
    pilotYaw.reset(yaw);
  }
  if (mounted === -1 && previous !== -1) pilotYaw.reset(app.input.yaw);
  return mounted;
}

function cameraFov(app: App, mounted: number): number {
  if (!app.freeCam && mounted === -1 && app.input.isZooming()) return 45;
  return !app.freeCam && mounted !== -1 && app.world.vehicles.kind[mounted] === VehicleKind.Shrike
    ? 65
    : 90;
}

function placeCamera(app: App, sky: THREE.Object3D, dt: number): void {
  const mountedVehicleId = app.world.players.mountedVehicleId[app.playerId] ?? -1;
  const fov = cameraFov(app, mountedVehicleId);
  if (app.camera.fov !== fov) {
    app.camera.fov = fov;
    app.camera.updateProjectionMatrix();
  }
  if (app.freeCam) {
    aimCamera(app.camera, app.input.yaw, app.input.pitch);
    app.camera.position.copy(app.freeCamPosition);
  } else if (mountedVehicleId !== -1) {
    placeVehicleCamera(app, mountedVehicleId, dt);
  } else {
    aimCamera(app.camera, app.input.yaw, app.input.pitch);
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

/**
 * Exported for a focused unit test. Codex review round 4, finding 1 (PR #9): single-player has
 * no server, so nothing else ever called the `dueForRespawn`/`respawnPlayer` pair
 * packages/server/src/net.ts's own tick loop uses for exactly this purpose -- a single-player
 * death sat forever once the 5 s respawn timer elapsed, since nothing was watching for it.
 * Checking every step (not just once after the batch) matches the server's per-tick cadence,
 * so a death mid-batch still respawns on the same tick its timer expires rather than waiting
 * for the next call into this function.
 */
export function stepSinglePlayer(
  world: World,
  playerId: number,
  input: PlayerInput,
  steps: number,
  spawn: { x: number; y: number; z: number },
  afterStep?: (flagsBefore: FlagAudioState[]) => void,
): void {
  const inputs = new Map<number, PlayerInput>([[playerId, input]]);
  for (let step = 0; step < steps; step += 1) {
    const flagsBefore = snapshotFlagAudioState(world);
    stepWorld(world, inputs);
    afterStep?.(flagsBefore);
    // Codex review round 5, finding 3 (PR #9): stepWorld can flip world.gameOver to true
    // partway through THIS call (the time limit landing on this exact step), and this
    // loop's respawn handling ran unconditionally regardless of that -- the same class of
    // bug already fixed server-side in packages/server/src/net.ts's runOneTick (round 4,
    // finding 6). Without this guard, a dead player whose respawn timer expired on the
    // same step the match ended still respawned into a supposedly-frozen match.
    if (world.gameOver) continue;
    for (const id of dueForRespawn(world)) respawnPlayer(world, id, spawn);
  }
}

export interface FlagAudioState {
  state: number;
  carrierId: number;
}

export function snapshotFlagAudioState(world: World): FlagAudioState[] {
  return Array.from(world.flags.state, (state, id) => ({
    state,
    carrierId: world.flags.carrierId[id] ?? -1,
  }));
}

/** Plays transitions from one completed solo simulation tick exactly once. This is kept out
 * of syncWorldView because that function runs once per rendered frame and can otherwise miss
 * a pickup/drop/capture occurring in an earlier step of a multi-step frame. */
export function playFlagStateAudio(
  audio: AudioEngine,
  before: readonly FlagAudioState[],
  world: World,
  playerId = 0,
): void {
  const localTeam = world.players.team[playerId] ?? 0;
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const previous = before[id];
    if (!previous) continue;
    playFlagTransition(audio, previous, world, id, localTeam);
  }
}

function playFlagTransition(
  audio: AudioEngine,
  previous: FlagAudioState,
  world: World,
  flagId: number,
  localTeam: number,
): void {
  const state = world.flags.state[flagId] ?? FlagState.Home;
  const carrierId = world.flags.carrierId[flagId] ?? -1;
  const ownFlag = (world.flags.team[flagId] ?? 0) === localTeam;
  if (flagWasTaken(previous, carrierId)) audio.flagTouch(ownFlag);
  if (flagWasDropped(previous, state)) audio.flagDrop();
  if (flagWasCaptured(previous, state)) audio.flagCapture(ownFlag);
  if (flagWasReturned(previous, state)) audio.flagReturn();
}

function flagWasTaken(previous: FlagAudioState, carrierId: number): boolean {
  return previous.carrierId === -1 && carrierId !== -1;
}

function flagWasDropped(previous: FlagAudioState, state: number): boolean {
  return previous.state === FlagState.Carried && state === FlagState.Dropped;
}

function flagWasCaptured(previous: FlagAudioState, state: number): boolean {
  return previous.state === FlagState.Carried && state === FlagState.Home;
}

function flagWasReturned(previous: FlagAudioState, state: number): boolean {
  return previous.state === FlagState.Dropped && state === FlagState.Home;
}

/**
 * Exported for a focused unit test. Codex review round 4, finding 5 (PR #9): single-player used
 * to run stepWorld first and only afterward reactively zero damage / revive on the spot -- the
 * same class of bug Codex review round 3 fixed server-side by moving invulnerability into the
 * sim itself (PlayerStore.godMode, checked at the top of applyDamage, via setGodMode). stepWorld
 * runs stepPlayers -> stepWeapons -> stepProjectiles -> stepFlags in one synchronous pass, so a
 * lethal hit that reached applyDamage had already dropped a carried flag and recorded a
 * kill/score event before any post-hoc revive could undo it. Setting the sim's flag directly,
 * once, at the moment the debug UI toggles god mode (mirroring net.ts's handleGod) makes it
 * proactive here too: applyDamage no-ops before any of that downstream state ever changes.
 */
export function setLocalGodMode(world: World, playerId: number, enabled: boolean): void {
  setGodMode(world, playerId, enabled);
}

/**
 * Exported for a focused unit test. Codex review round 1, finding 14 (PR #9): netclient.ts's
 * recentEvents is a rolling buffer that evicts its oldest entry past its cap, so tracking
 * "new since last frame" via a `slice(index)` into that same mutating array breaks forever
 * once eviction starts -- the index no longer lines up with any live position, and every
 * event after that point silently stops rendering. TimestampedEvent's `seq` is assigned
 * once, at receipt, and is never reused or shifted, so comparing against it survives
 * eviction; the 100-event cap on the buffer itself is unrelated and stays as-is.
 */
export function drainNewEvents(
  events: readonly TimestampedEvent[],
  cursor: { seq: number },
): TimestampedEvent[] {
  const newEvents = events.filter((event) => event.seq > cursor.seq);
  const newest = events.at(-1);
  if (newest) cursor.seq = newest.seq;
  return newEvents;
}

interface BaseAssetsViewState {
  world: World;
  playerId: number;
  net: NetClient | null;
  input: Input;
  assets: KatabaticAssets;
  camera: THREE.Camera;
  hud: { update(source: HudSource): void };
  baseObjectView: ReturnType<typeof createBaseObjectView>;
  stationMenu: StationMenu;
  stationMenuState: { open: boolean; triggerStation: number | null };
  vehicleView: VehicleView;
  vehicleBuffers: Map<number, VehicleBuffer>;
  vehiclePadMenu: VehiclePadMenu;
  vehiclePadMenuState: { open: boolean; triggerPad: number | null };
  commanderMapCanvas: HTMLCanvasElement;
  orderState: { pending: { x: number; z: number } | null };
  voiceMenu: VoiceMenu;
  audio: AudioEngine;
}

function remoteToPlayerPosition(player: PlayerSnapshotData): PlayerPosition {
  return { id: player.id, team: player.team, x: player.x, z: player.z, alive: player.health > 0 };
}

/** See commander-map.ts's `PlayerPosition` doc comment: NetClient's own prediction world only
 *  ever holds the local player, so a networked client's full roster needs net.remotePlayers
 *  merged in too -- single-player has every player in `world.players` already and no `net`
 *  to merge. Exported for app.test.ts (Codex round 2 review of PR #11). */
export function commanderMapPlayers(
  world: World,
  net: Pick<NetClient, 'remotePlayers'> | null,
): PlayerPosition[] {
  const local = playersFromWorld(world);
  return net
    ? [...local, ...Array.from(net.remotePlayers.values()).map(remoteToPlayerPosition)]
    : local;
}

function drawCommanderMapForTeam(state: BaseAssetsViewState): void {
  const ctx = state.commanderMapCanvas.getContext('2d');
  if (!ctx) return;
  const localTeam = state.world.players.team[state.playerId] ?? 1;
  const circles = friendlySensorCircles(state.world, localTeam);
  const players = commanderMapPlayers(state.world, state.net);
  const sensedIds = sensedEnemyIds(players, localTeam, circles, state.world);
  drawCommanderMap(ctx, state.assets, state.world, players, localTeam, sensedIds);
  const { minX, minZ, width: areaWidth, depth: areaDepth } = state.assets.scene.missionArea;
  const { width, height } = ctx.canvas;
  const toCanvas = (x: number, z: number): [number, number] => [
    ((x - minX) / areaWidth) * width,
    ((z - minZ) / areaDepth) * height,
  ];
  drawOrderMarkers(ctx, state.net?.orders ?? [], localTeam, toCanvas);
}

/** Order confirm/cancel and voice-bind line confirm/cancel share one digit/Escape read per
 *  frame -- both are edge-triggered and consumed once (see Input's own doc comments), so they
 *  cannot each call `digitPressedThisFrame`/`escapePressedThisFrame` separately. A click on
 *  the (visible) commander map already stashed a pending world position in
 *  `state.orderState.pending` (see the click listener set up alongside `commanderMapCanvas`'s
 *  own creation); a digit 1-3 while that's set turns it into a sent CommandOrder. An order is
 *  a message, not client state (Global Constraints) -- this never mutates `state.net.orders`
 *  itself, only sends the request; the marker `drawCommanderMapForTeam` draws only appears
 *  once the server echoes the order back on a later snapshot. Otherwise, while the voice menu
 *  is open, any digit sends that line's VoiceBind and closes the menu. */
/** Confirms a pending commander-map order-kind click, if `digit` (1-3) and a pending click are
 *  both present. Returns true when it sent one, so the caller doesn't also try to read the
 *  same digit as a voice-line pick. */
function confirmPendingOrder(state: BaseAssetsViewState, digit: number): boolean {
  const pending = state.orderState.pending;
  if (!pending || digit < 1 || digit > 3) return false;
  const kind = digit === 1 ? OrderKind.Attack : digit === 2 ? OrderKind.Defend : OrderKind.Repair;
  state.net?.sendCommandOrder(kind, pending.x, pending.z);
  state.orderState.pending = null;
  return true;
}

function confirmVoiceLine(state: BaseAssetsViewState, digit: number): void {
  if (!state.voiceMenu.visible) return;
  // A digit either drills into a category (menu stays open on its line list) or picks a
  // line; the returned id is the flat protocol VoiceBind id, exactly what the pre-#55
  // single-level menu sent, so the wire and the receiving clients' audio mapping are
  // unchanged (#55).
  const lineId = state.voiceMenu.pick(digit);
  if (lineId === null) return;
  if (state.net) state.net.sendVoiceBind(lineId);
  else speakVoiceLine(lineId, state.audio);
  state.voiceMenu.hide();
}

/** Order confirm/cancel and voice-bind line confirm/cancel share one digit/Escape read per
 *  frame -- both are edge-triggered and consumed once (see Input's own doc comments), so they
 *  cannot each call `digitPressedThisFrame`/`escapePressedThisFrame` separately. See
 *  `confirmPendingOrder`'s own comment for why an order takes priority over a voice line on
 *  the same digit. An order is a message, not client state (Global Constraints) -- this never
 *  mutates `state.net.orders` itself, only sends the request; the marker
 *  `drawCommanderMapForTeam` draws only appears once the server echoes the order back on a
 *  later snapshot. */
function syncCommandOrders(state: BaseAssetsViewState): void {
  const digit = state.input.digitPressedThisFrame();
  if (state.input.escapePressedThisFrame()) {
    state.orderState.pending = null;
    state.voiceMenu.hide();
    state.stationMenuState.open = false;
    state.vehiclePadMenuState.open = false;
    state.stationMenu.hide();
    state.vehiclePadMenu.hide();
    state.commanderMapCanvas.hidden = true;
  }
  if (!confirmPendingOrder(state, digit)) confirmVoiceLine(state, digit);
}

/** Syncs base-object/turret meshes, the station menu, the commander map, and the HUD's
 *  aimedStructure row -- everything Tasks 11-13 added -- to the latest sim or net state.
 *  Pulled out of `frame` for the same reason `syncWorldView` already is: keeping `frame`'s
 *  own branching under this repo's complexity budget. */
/** The station menu and the vehicle pad menu react to the exact same edge-triggered E press
 *  (`pressed`, read once by the caller -- usePressedThisFrame() is stateful and consumed on
 *  read, so it cannot be called twice for one frame). Split out of syncBaseAssetsView to keep
 *  that function's own complexity under budget. */
function syncMenus(state: BaseAssetsViewState, pressed: boolean): void {
  const { world, playerId } = state;
  syncInventoryStationEntry(state);
  if (pressed) toggleUseMenu(state);
  state.stationMenuState.open =
    stationMenuVisible(world, playerId, state.stationMenuState.open) &&
    !!world.players.alive[playerId];
  // #55: every open re-prefills from the loadout the player currently carries -- the source
  // station shows your existing inventory, not whatever the last visit left in the DOM.
  if (state.stationMenuState.open) state.stationMenu.show(currentLoadoutChoice(world, playerId));
  else state.stationMenu.hide();
  syncVehicleStationMenu(state);
}

function syncInventoryStationEntry(state: BaseAssetsViewState): void {
  const menu = state.stationMenuState;
  const trigger = inventoryStationTriggerAt(state.world, state.playerId);
  if (
    trigger !== null &&
    trigger !== menu.triggerStation &&
    state.commanderMapCanvas.hidden &&
    !state.voiceMenu.visible &&
    !state.vehiclePadMenuState.open
  )
    menu.open = true;
  menu.triggerStation = trigger;
}

function toggleUseMenu(state: BaseAssetsViewState): void {
  if (state.stationMenuState.open || state.vehiclePadMenuState.open) {
    state.stationMenuState.open = false;
    state.vehiclePadMenuState.open = false;
    return;
  }
  if (!state.commanderMapCanvas.hidden || state.voiceMenu.visible) return;
  if (canSendVehicleUse(state.world, state.playerId)) return;
  state.stationMenuState.open = stationMenuVisible(state.world, state.playerId, true);
  state.vehiclePadMenuState.open =
    !state.stationMenuState.open && vehiclePadMenuVisible(state.world, state.playerId, true);
}

function syncVehicleStationMenu(state: BaseAssetsViewState): void {
  const { world, playerId, vehiclePadMenuState: menu } = state;
  const trigger = vehicleStationTriggerAt(world, playerId);
  if (
    trigger !== null &&
    trigger !== menu.triggerPad &&
    state.commanderMapCanvas.hidden &&
    !state.voiceMenu.visible
  ) {
    menu.open = true;
    state.stationMenuState.open = false;
    state.stationMenu.hide();
  }
  menu.triggerPad = trigger;
  menu.open = vehiclePadMenuVisible(world, playerId, menu.open) && !!world.players.alive[playerId];
  const padId = menu.open ? vehiclePadAt(world, playerId) : null;
  if (padId !== null) state.vehiclePadMenu.show(padId);
  else state.vehiclePadMenu.hide();
}

/**
 * Builds the flat array vehicle-view.ts's `sync` renders from -- single-player reads
 * `world.vehicles` directly (no snapshot delay to smooth in the first place, exactly
 * `commanderMapPlayers`' own local/networked split just above). Networked, the local
 * player's OWN driven vehicle (if any) is drawn live off `world.vehicles` too -- the same
 * source placeVehicleCamera already chases -- while every other vehicle comes out of
 * `updateVehicleBuffers`' interpolation history (Codex review round 1, this PR, finding 9)
 * instead of net.vehicles' single latest, snap-to-new-position-every-snapshot sample.
 * Exported for a focused unit test.
 */
export function vehicleRenderData(state: {
  world: World;
  playerId: number;
  net: Pick<NetClient, 'connected' | 'vehicleSnapshots'> | null;
  vehicleBuffers: Map<number, VehicleBuffer>;
}): VehicleSnapshotData[] {
  const { world, playerId, net } = state;
  const connected = net ? net.connected : true;
  if (!net || !connected) {
    // Mirrors updateRemotes' own disconnect handling: clears any stale interpolation
    // history so a later reconnect doesn't resume blending from a socket-drop-stale sample.
    state.vehicleBuffers.clear();
    return vehiclesFromWorld(world);
  }
  const nowMs = performance.now();
  updateVehicleBuffers(net, state.vehicleBuffers, nowMs);
  const mountedId = world.players.mountedVehicleId[playerId] ?? -1;
  const out = vehicleRenderDataFrom(state.vehicleBuffers, nowMs, mountedId);
  if (mountedId !== -1) {
    const mounted = vehiclesFromWorld(world).find((v) => v.id === mountedId);
    if (mounted) out.push(mounted);
  }
  return out;
}

/** The commander-map (`C`) and voice-menu (`V`) toggles, plus drawing the map while it's
 *  open -- pulled out of `syncBaseAssetsView` to keep that function's own complexity under
 *  budget, the same reason `syncMenus` already exists as its own function. */
function syncMapAndVoiceToggles(state: BaseAssetsViewState): void {
  const { input } = state;
  const mapPressed = input.commandCirclePressedThisFrame();
  const voicePressed = input.voiceMenuPressedThisFrame();
  if (state.stationMenuState.open || state.vehiclePadMenuState.open) return;
  if (mapPressed) {
    state.voiceMenu.hide();
    state.commanderMapCanvas.hidden = !state.commanderMapCanvas.hidden;
    if (state.commanderMapCanvas.hidden) state.orderState.pending = null;
  }
  if (!state.commanderMapCanvas.hidden) drawCommanderMapForTeam(state);
  if (voicePressed) {
    state.commanderMapCanvas.hidden = true;
    state.orderState.pending = null;
    if (state.voiceMenu.visible) state.voiceMenu.hide();
    else state.voiceMenu.show();
  }
}

function turretTargetPositions(
  world: World,
  playerId: number,
  net: NetClient | null,
  connected: boolean,
): Map<number, THREE.Vector3> {
  const targets =
    net && connected ? networkTurretTargets(world, playerId, net) : worldTurretTargets(world);
  const vehicles = net && connected ? net.vehicles : vehiclesFromWorld(world);
  for (const vehicle of vehicles)
    targets.set(-vehicle.id - 2, new THREE.Vector3(vehicle.x, vehicle.y, vehicle.z));
  return targets;
}

function playerTargetPosition(world: World, playerId: number): THREE.Vector3 {
  const offset = playerId * 3;
  return new THREE.Vector3(
    world.players.position[offset] ?? 0,
    (world.players.position[offset + 1] ?? 0) + 1.15,
    world.players.position[offset + 2] ?? 0,
  );
}

function worldTurretTargets(world: World): Map<number, THREE.Vector3> {
  const targets = new Map<number, THREE.Vector3>();
  for (let id = 0; id < world.players.count; id += 1) {
    targets.set(id, playerTargetPosition(world, id));
  }
  return targets;
}

function networkTurretTargets(
  world: World,
  playerId: number,
  net: NetClient,
): Map<number, THREE.Vector3> {
  const targets = new Map<number, THREE.Vector3>();
  for (const player of net.remotePlayers.values()) {
    targets.set(player.id, new THREE.Vector3(player.x, player.y + 1.15, player.z));
  }
  targets.set(localNetworkId(net, playerId), playerTargetPosition(world, playerId));
  return targets;
}

function syncBaseAssetsView(
  state: BaseAssetsViewState,
  usePressed: boolean,
  turretTiming: { dt: number; timeScale: number },
): void {
  const { world, playerId, net } = state;
  const connected = net ? net.connected : true;
  const baseObjectData: BaseObjectSnapshotData[] =
    net && connected ? net.baseObjects : baseObjectsFromWorld(world);
  const turretData: TurretSnapshotData[] = net && connected ? net.turrets : turretsFromWorld(world);
  state.baseObjectView.sync(
    baseObjectData,
    turretData,
    turretTargetPositions(world, playerId, net, connected),
    turretTiming,
  );
  state.vehicleView.sync(vehicleRenderData(state));

  // `usePressed` is computed once by the caller (frame()), the same edge-triggered read
  // that also gates the outgoing `use` wire bit -- see frame()'s own comment for why
  // usePressedThisFrame() cannot be called a second time here.
  syncMenus(state, usePressed);
  syncMapAndVoiceToggles(state);
  syncCommandOrders(state);
  state.input.setUiOpen(
    state.stationMenuState.open ||
      state.vehiclePadMenuState.open ||
      !state.commanderMapCanvas.hidden ||
      state.voiceMenu.visible,
  );

  // A second, redundant hud.update immediately after syncWorldView's own -- see
  // hudSourceFrom's own comment for why aimedStructure isn't computed inside that
  // already-tested pure function (it needs the camera and the base-object view, neither of
  // which hudSourceFrom's signature carries).
  state.hud.update({
    ...hudSourceFrom(world, playerId, net),
    aimedStructure: raycastAimedStructure(state.camera, state.baseObjectView, world),
  });
}

/**
 * Syncs projectile/flag/laser-beam meshes and the HUD to the latest sim or net state. Pulled
 * out of `frame` to keep its own branching (net vs. single-player, free cam, god mode) under
 * the project's complexity budget.
 *
 * Exported for a focused unit test. Codex review round 6, finding P2 (PR #9): NetClient never
 * clears `projectiles`/`flags` once the socket disconnects -- they just hold whatever the last
 * snapshot decoded -- and this function used to read them unconditionally off `net` regardless
 * of connection state, so a disconnect left the last snapshot's projectile and flag meshes
 * live in the scene forever (their pruning logic in weapons-view.ts/flag-view.ts only removes a
 * mesh whose id is no longer in the *current* list, and that list never changed). This mirrors
 * `updateRemotes`' existing disconnect handling in this same file: once `net.connected` is
 * false, feed the mesh-sync functions an empty list so their own pruning naturally clears
 * everything, rather than mutating NetClient state from here.
 */
/** Keep travel loops in sync with visible projectiles. Issue #52 residual: a projectile
 *  vanishing from this list stops its travel loop and plays NOTHING else -- it may have
 *  expired silently or never appeared in any snapshot, so a disappearance was never
 *  evidence of an impact. The authoritative impact records are the only impact-cue source
 *  now (playImpactAudio), exactly like the visual path this mirrors. */
function syncProjectileAudio(
  audio: AudioEngine,
  previous: Map<number, ProjectileSnapshotData>,
  current: ProjectileSnapshotData[],
): void {
  const live = new Map(current.map((p) => [p.id, p]));
  for (const last of previous.values()) {
    const next = live.get(last.id);
    if (next?.type === last.type && next.weaponId === last.weaponId) continue;
    audio.setProjectileSound(last.id, last.weaponId, last.type, last, false);
  }
  for (const p of current) audio.setProjectileSound(p.id, p.weaponId, p.type, p, true);
}

/** Task 7 (audio): flag touch/capture cues, keyed off the same decoded event list the HUD's
 *  kill feed and weapons-view.ts's laser beams already read -- single-player has no event
 *  stream (hudSourceFrom's own single-player branch always returns []), so these stay silent
 *  there, the same limitation spawnLaserBeams already accepts. */
function playFlagEventAudio(
  audio: AudioEngine,
  events: readonly TimestampedEvent[],
  localTeam: number,
  flagTeam: (flagId: number) => number,
): void {
  for (const event of events) {
    if (event.kind === EventKind.FlagTouched) audio.flagTouch(flagTeam(event.b) === localTeam);
    else if (event.kind === EventKind.FlagCaptured) audio.flagCapture(event.a !== localTeam);
    else if (event.kind === EventKind.FlagDropped) audio.flagDrop();
    else if (event.kind === EventKind.FlagReturned) audio.flagReturn();
  }
}

/** A VoiceBindPlayed event (`a` = speaker playerId, `b` = lineId) is broadcast back to every
 *  client, sender included -- that broadcast, not a local-only echo, is what makes "played for
 *  the local player's own action" true, matching Task 6's own contract. */
function playVoiceBindAudio(audio: AudioEngine, events: readonly TimestampedEvent[]): void {
  for (const event of events) {
    if (event.kind === EventKind.VoiceBindPlayed) speakVoiceLine(event.b, audio);
  }
}

function localNetworkId(net: { playerId: number | null } | null, fallback: number): number {
  return net?.playerId ?? fallback;
}

function syncEventAudio(
  audio: AudioEngine | undefined,
  events: readonly TimestampedEvent[],
  world: World,
  playerId: number,
  net: Pick<NetClient, 'team' | 'flags'> | null,
): void {
  if (!audio) return;
  const localTeam = net ? net.team : (world.players.team[playerId] ?? 0);
  const flagTeam = (flagId: number): number =>
    net?.flags.find((flag) => flag.id === flagId)?.team ?? world.flags.team[flagId] ?? 0;
  playFlagEventAudio(audio, events, localTeam, flagTeam);
  playVoiceBindAudio(audio, events);
}

/** The authoritative impact records (#52) among this frame's newly received events, in
 *  arrival order. drainNewEvents already guarantees each TimestampedEvent is handed out
 *  exactly once (cursor advanced per receipt sequence), which is what makes the networked
 *  impact path exactly-once end to end: the sim emits one record, the server broadcasts one
 *  Event, the client renders one effect. */
function impactRecordsFromEvents(events: readonly TimestampedEvent[]): ProjectileImpact[] {
  const impacts: ProjectileImpact[] = [];
  for (const event of events) {
    if (event.kind !== EventKind.ProjectileImpact || !event.impact) continue;
    impacts.push(event.impact);
  }
  return impacts;
}

/** #52 residual: the audio twin of spawnProjectileImpacts -- one projectileImpact cue per
 *  record, in arrival order. Callers pass each record exactly once (networked: the drained
 *  event stream; solo: world.projectiles.lastImpacts inside the per-tick afterStep, the
 *  same overwrite-per-call convention lastFireEvents uses), the same exactly-once contract
 *  the visual path documents. Exported for a focused unit test. */
export function playImpactAudio(
  audio: Pick<AudioEngine, 'projectileImpact'> | undefined,
  impacts: readonly ProjectileImpact[],
): void {
  if (!audio) return;
  for (const impact of impacts) audio.projectileImpact(impact);
}

export function syncWorldView(
  world: World,
  playerId: number,
  net: Pick<
    NetClient,
    | 'playerId'
    | 'team'
    | 'remotePlayers'
    | 'projectiles'
    | 'flags'
    | 'teamScores'
    | 'gameOver'
    | 'winnerTeam'
    | 'timeRemainingS'
    | 'gameOverReason'
    | 'recentEvents'
    | 'connected'
  > | null,
  scene: THREE.Scene,
  hud: { update(source: HudSource): void },
  effects: Effect[],
  projectileMeshes: Map<number, THREE.Mesh>,
  previousProjectiles: Map<number, ProjectileSnapshotData>,
  flagMeshes: Map<number, THREE.Group>,
  seenEventSeq: { seq: number },
  dtSeconds: number,
  audio?: AudioEngine,
): void {
  const connected = net ? net.connected : true;
  const projectiles = net ? (connected ? net.projectiles : []) : projectilesFromWorld(world);
  // Issue #52: projectile FX come from the sim's authoritative impact records now -- a
  // projectile vanishing from this snapshot list is no longer evidence of an impact (it may
  // have expired silently, or never appeared in any snapshot at all), so no disappearance
  // diff runs here and the same shot can never produce a duplicate effect.
  if (audio) syncProjectileAudio(audio, previousProjectiles, projectiles);
  syncProjectileMeshes(scene, projectileMeshes, projectiles, dtSeconds);
  previousProjectiles.clear();
  for (const projectile of projectiles) previousProjectiles.set(projectile.id, projectile);

  syncFlagMeshes(scene, flagMeshes, net ? (connected ? net.flags : []) : flagsFromWorld(world));

  const allEvents: TimestampedEvent[] = net ? net.recentEvents : [];
  const newEvents = drainNewEvents(allEvents, seenEventSeq);
  syncEventAudio(audio, newEvents, world, playerId, net);
  spawnLaserBeams(
    scene,
    effects,
    newEvents,
    (id) => positionOfPlayer(world, net, id),
    localNetworkId(net, playerId),
  );
  const impacts = impactRecordsFromEvents(newEvents);
  spawnProjectileImpacts(scene, effects, impacts);
  playImpactAudio(audio, impacts);

  hud.update(hudSourceFrom(world, playerId, net));
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

// --- Vehicle sibling of the remote-player interpolation pair just above (Codex review
// round 1, this PR, finding 9) -- same shape, applied to RemoteVehicleSnapshot/VehicleBuffer
// instead of RemoteSnapshot/RemoteBuffer.
function applyVehicleRemoteSnapshot(
  buffers: Map<number, VehicleBuffer>,
  snapshot: RemoteVehicleSnapshot,
  atMs: number,
): void {
  for (const vehicle of snapshot.vehicles) {
    const buffer = buffers.get(vehicle.id) ?? new VehicleBuffer();
    buffers.set(vehicle.id, buffer);
    buffer.push(atMs, vehicle);
  }
}

function pruneStaleVehicleBuffers(
  buffers: Map<number, VehicleBuffer>,
  latest: RemoteVehicleSnapshot,
): void {
  const liveIds = new Set(latest.vehicles.map((v) => v.id));
  for (const id of [...buffers.keys()]) {
    if (!liveIds.has(id)) buffers.delete(id);
  }
}

/**
 * Exported for a focused unit test, same convention as updateRemotes just above. Drains
 * every queued vehicle snapshot (never just the latest -- see updateRemotes' own comment for
 * why) into per-id VehicleBuffers, stamping each with the same tick-offset-behind-nowMs
 * timestamp scheme.
 */
export function updateVehicleBuffers(
  activeNet: Pick<NetClient, 'vehicleSnapshots' | 'connected'>,
  buffers: Map<number, VehicleBuffer>,
  nowMs: number,
): void {
  if (!activeNet.connected) {
    buffers.clear();
    return;
  }
  const pending = activeNet.vehicleSnapshots.splice(0, activeNet.vehicleSnapshots.length);
  const latest = pending.at(-1);
  for (const snapshot of pending) {
    const atMs = latest ? nowMs - (latest.tick - snapshot.tick) * FIXED_TICK_MS : nowMs;
    applyVehicleRemoteSnapshot(buffers, snapshot, atMs);
  }
  if (latest) pruneStaleVehicleBuffers(buffers, latest);
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

/**
 * Exported for a focused unit test. Single-player has no remote roster, so `net` is null there
 * and every id but the local player is unresolvable; networked, the local id reads world state
 * (this client's own predicted position) while any other id reads the last decoded snapshot.
 */
export function positionOfPlayer(
  world: World,
  net: Pick<NetClient, 'playerId' | 'remotePlayers'> | null,
  id: number,
): { x: number; y: number; z: number } | null {
  if (!net) return null;
  if (id === net.playerId) {
    return {
      x: world.players.position[0] ?? 0,
      y: world.players.position[1] ?? 0,
      z: world.players.position[2] ?? 0,
    };
  }
  const remote = net.remotePlayers.get(id);
  return remote ? { x: remote.x, y: remote.y, z: remote.z } : null;
}

/** Exported for a focused unit test. Single-player has no server-authoritative CTF/clock state,
 * so it derives the same shape straight from the sim world (Task 7's loadKatabaticWorld plus
 * the server's own tick loop compute the networked equivalents). */
export function hudSourceFrom(
  world: World,
  playerId: number,
  net: Pick<
    NetClient,
    | 'playerId'
    | 'teamScores'
    | 'flags'
    | 'gameOver'
    | 'winnerTeam'
    | 'timeRemainingS'
    | 'gameOverReason'
    | 'recentEvents'
  > | null,
): HudSource {
  return net
    ? {
        world,
        playerId,
        // Codex review round 5, finding 4 (PR #9): `playerId` above is the fixed local
        // prediction slot (0), not the id the server actually assigned this connection --
        // see HudSource.networkPlayerId's own comment for why hud.ts's flag-carrier check
        // needs the real one instead.
        networkPlayerId: net.playerId,
        teamScores: net.teamScores,
        flags: net.flags,
        gameOver: net.gameOver,
        winnerTeam: net.winnerTeam,
        timeRemainingS: net.timeRemainingS,
        gameOverReason: net.gameOverReason,
        recentEvents: net.recentEvents,
        // Wired to a real raycast against base-object-view.ts's meshes once app.ts's frame
        // loop calls this with a camera/view available -- see Task 14.
        aimedStructure: null,
      }
    : {
        world,
        playerId,
        // Single-player has no separate network identity: the sim's own player id already
        // is the real one.
        networkPlayerId: playerId,
        teamScores: [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0],
        flags: flagsFromWorld(world),
        gameOver: world.gameOver,
        winnerTeam: world.winnerTeam,
        timeRemainingS: Math.max(0, (world.timeLimitTicks - world.tick) * FIXED_DT),
        gameOverReason: world.gameOverReason,
        recentEvents: [],
        aimedStructure: null,
      };
}

/**
 * Exported for a focused unit test. Reads the team's flag *current* position (not a hardcoded
 * map coordinate or its home stand), so it stays correct after the flag has been picked up,
 * dropped, or returned, and regardless of where Katabatic's real flag stands end up landing.
 */
export function teleportPlayerToFlag(world: World, playerId: number, team: number): void {
  const flagId = [...world.flags.team].findIndex((candidate) => candidate === team);
  if (flagId < 0) return;
  const base = flagId * 3;
  world.players.position.set(
    [
      world.flags.position[base] ?? 0,
      world.flags.position[base + 1] ?? 0,
      world.flags.position[base + 2] ?? 0,
    ],
    playerId * 3,
  );
}

/** Exported for a focused unit test and the Playwright e2e spec's own fast setup (Task 14),
 *  mirroring teleportPlayerToFlag's own shape: places the player at their team's vehicle
 *  pad rather than walking there, so the spec can drive spawn/mount/dismount deterministically
 *  without depending on WASD movement or the real terrain layout. */
export function teleportPlayerToVehiclePad(world: World, playerId: number, team: number): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] !== BaseObjectKind.StationVehiclePad || bases.team[id] !== team) continue;
    const base = id * 3;
    world.players.position.set(
      [
        bases.usePosition[base] ?? 0,
        bases.usePosition[base + 1] ?? 0,
        bases.usePosition[base + 2] ?? 0,
      ],
      playerId * 3,
    );
    return;
  }
}

/** Exported for a focused unit test, mirroring teleportPlayerToFlag's own shape. Overkills
 *  every one of the team's generators directly via applyBaseObjectDamage and re-derives
 *  power -- bypassing real weapon damage timings on purpose, so the e2e test this backs is
 *  fast and deterministic rather than waiting out a Chaingun's real fire rate. */
export function debugKillGenerator(world: World, team: number): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] !== BaseObjectKind.Generator || bases.team[id] !== team) continue;
    applyBaseObjectDamage(world, id, BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10);
  }
  stepPower(world);
}

/** Revives exactly one of the team's generators. Kept as a debug-only shortcut that stays
 *  distinct from the in-game Repair Pack: since issue #50 the pack itself rebuilds destroyed
 *  generators and stations (~455 ticks of sustained beam work per generator, see
 *  repair.ts's healCandidate rebuild threshold), while this stays an instant e2e/test hook
 *  that bypasses beam targeting, range and line-of-sight entirely. */
export function debugRepairGenerator(world: World, team: number): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] !== BaseObjectKind.Generator || bases.team[id] !== team) continue;
    bases.damage[id] = 0;
    bases.destroyed[id] = 0;
    bases.energy[id] = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxEnergy;
    stepPower(world);
    return;
  }
}

export function debugIsStationPowered(world: World, team: number): boolean {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] === BaseObjectKind.StationInventory && bases.team[id] === team) {
      return bases.powered[id] === 1;
    }
  }
  return false;
}

// Task 7 (audio): local player's own gunshots only -- `world.lastFireEvents` is set fresh
// every simulated tick (empty when nothing fired), from world.pendingFireEvents, and
// NetClient.tick only ever simulates the LOCAL_SLOT input, so a remote player's shot never
// appears here (positional audio for other players is out of scope this milestone, see the
// AudioEngine interface's unused `position` params). Callers must gate this on `steps > 0` --
// otherwise a paused frame would replay the last tick's already-played shot every frame.
function playWeaponFireAudio(world: World, playerId: number, audio: AudioEngine): void {
  for (const event of world.lastFireEvents) {
    if (event.playerId !== playerId) continue;
    audio.weaponFire(event.weaponId, event.origin);
  }
}

function playVehicleFireAudio(world: World, audio: AudioEngine): void {
  for (const event of world.lastVehicleFireEvents) {
    audio.vehicleWeaponFire('shrike', event.origin);
  }
}

interface FootstepState {
  timer: number;
}

const FOOTSTEP_SPEED_THRESHOLD_MPS = 0.5; // Ours: ignores idle jitter/wall-press micro-velocity.

function localPlayerPosition(world: World, playerId: number): Vec3 {
  const base = playerId * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: world.players.position[base + 1] ?? 0,
    z: world.players.position[base + 2] ?? 0,
  };
}

function localPlayerHorizontalSpeed(world: World, playerId: number): number {
  const base = playerId * 3;
  const vx = world.players.velocity[base] ?? 0;
  const vz = world.players.velocity[base + 2] ?? 0;
  return Math.hypot(vx, vz);
}

function updateJetAudio(
  world: World,
  playerId: number,
  audio: AudioEngine,
  jetInputActive: boolean,
): void {
  const energy = world.players.energy[playerId] ?? 0;
  audio.setJetting(
    playerId,
    jetInputActive && energy > 0 && (world.players.mountedVehicleId[playerId] ?? -1) === -1,
    energy / armorFor(world, playerId).maxEnergy,
  );
}

/** Cadence-gated (FOOTSTEP_INTERVAL_S) footsteps -- only while grounded, not
 *  skiing or mounted, and moving faster than idle jitter. #56: the footstep cue carries the
 *  player's armor so the variant table (footstepCue) can pick the surface/armor recording;
 *  only light armor's sample is committed today, so the heard feel is unchanged. Exported
 *  for a focused unit test. */
export function updateFootstepAudio(
  world: World,
  playerId: number,
  audio: AudioEngine,
  skiing: boolean,
  speed: number,
  footstep: FootstepState,
  dtSeconds: number,
): void {
  const onGround = (world.players.onGround[playerId] ?? 0) === 1;
  const mounted = (world.players.mountedVehicleId[playerId] ?? -1) !== -1;
  const running = onGround && !skiing && !mounted && speed > FOOTSTEP_SPEED_THRESHOLD_MPS;
  if (!running) {
    footstep.timer = 0;
    return;
  }
  footstep.timer += dtSeconds;
  if (footstep.timer < FOOTSTEP_INTERVAL_S) return;
  footstep.timer -= FOOTSTEP_INTERVAL_S;
  audio.footstep(localPlayerPosition(world, playerId), {
    armor: (world.players.armor[playerId] ?? ArmorId.Light) as ArmorId,
  });
}

/** The per-frame audio responses to the state the simulation just produced. Split out of
 *  `App.frame` to keep that function inside the lint's complexity budget, and because the
 *  three cases it handles read as one decision: fire cues (networked only, and only on a
 *  frame that actually stepped -- a zero-step frame has no new fire events to report),
 *  movement loops while the player can drive them, and the free-cam case below.
 *
 *  Codex review round 1 of the M7 PR: skipping the movement update entirely while free cam is
 *  active meant a jet/ski loop already running at the moment free cam was toggled on never
 *  got its own stop call -- setJetting/setSkiing are exactly what makes that stop happen, and
 *  neither ran again until free cam was toggled back off. Forcing both off here closes that
 *  gap instead of just not looking at it, and setLoop already no-ops a stop of a key that
 *  never started, so it is cheap every frame. */
function updateFrameAudio(options: {
  steps: number;
  net: NetClient | null;
  world: World;
  playerId: number;
  audio: AudioEngine;
  freeCam: boolean;
  jetInputActive: boolean;
  footstep: FootstepState;
  dtSeconds: number;
}): void {
  if (options.steps > 0 && options.net) {
    playWeaponFireAudio(options.world, options.playerId, options.audio);
    playVehicleFireAudio(options.world, options.audio);
  }
  if (options.freeCam) {
    options.audio.setJetting(options.playerId, false, 0);
    options.audio.setSkiing(options.playerId, false, 0);
    return;
  }
  updateMovementAudio(
    options.world,
    options.playerId,
    options.audio,
    options.jetInputActive,
    options.footstep,
    options.dtSeconds,
  );
}

/** The frame's `use` edge. `usePressedThisFrame()` is edge-triggered and consumed once per
 *  call, so it can only be read once per frame -- computed here and threaded through both the
 *  outgoing input (the wire-level `use` bit, gated by canSendVehicleUse so an E press near
 *  neither a vehicle nor while mounted doesn't spam the server with a meaningless mount
 *  attempt) and syncBaseAssetsView's own station/pad menu toggles, rather than each calling it
 *  separately. Free cam does not consume the edge at all. */
function frameUsePressed(app: { freeCam: boolean }, input: Input): boolean {
  if (app.freeCam) return false;
  return input.usePressedThisFrame();
}

/** Whether the audience at `listener` should hear a cue at `position` as muffled: the same
 *  two-part visibility rule the simulation uses everywhere it asks whether two points can
 *  see each other. Terrain is the march `hasLineOfSight` runs; built geometry is
 *  `segmentBlockedByInteriors`, the shared test turrets, projectiles and repair targeting
 *  consult, whose force-field half is keyed to `team` because a field is team-passable.
 *
 *  Issue #56's occlusion residual: this was the terrain march alone, so a cue firing from
 *  inside a bunker, or through a powered opposing field, sounded unobstructed. Exported for a
 *  focused test, like the other read-only twins in this file. */
export function audioOcclusionAt(
  world: World,
  listener: Vec3,
  position: Vec3,
  team: number,
): boolean {
  return (
    !hasLineOfSight(world, listener, position) ||
    segmentBlockedByInteriors(world, listener, position, team)
  );
}

/** Task 7 (audio): jet/ski loops and cadence-gated footsteps for the local player, read
 *  straight off the just-simulated world state -- `ski`/`onGround`/`energy`/`velocity` are
 *  real PlayerStore fields (types.ts), not derived here. Split into one small function per
 *  effect (jet/footstep) to stay under the complexity budget; skiing itself is cheap enough
 *  to stay inline here. #56 lifecycle: death stops every local-player loop the same frame
 *  (the sim stops moving a dead player, so the loops would otherwise ride their last state
 *  until respawn), and the explicit false calls are what actually stop them -- skipping the
 *  update would leave the engine's per-player loop state frozen at its death-frame value.
 *  Exported for a focused unit test. */
export function updateMovementAudio(
  world: World,
  playerId: number,
  audio: AudioEngine,
  jetInputActive: boolean,
  footstep: FootstepState,
  dtSeconds: number,
): void {
  if ((world.players.alive[playerId] ?? 0) !== 1) {
    audio.setJetting(playerId, false, 0);
    audio.setSkiing(playerId, false, 0);
    footstep.timer = 0;
    return;
  }
  updateJetAudio(world, playerId, audio, jetInputActive);

  const speed = localPlayerHorizontalSpeed(world, playerId);
  const skiing =
    (world.players.ski[playerId] ?? 0) === 1 &&
    (world.players.mountedVehicleId[playerId] ?? -1) === -1;
  audio.setSkiing(playerId, skiing, speed);

  updateFootstepAudio(world, playerId, audio, skiing, speed, footstep, dtSeconds);
}

/** `position[base + i] ?? 0` for a base object's placement row -- one helper instead of three
 *  inline coalescences, the same reason vecAt exists sim-side (turrets.ts). */
function basePositionAt(store: World['baseObjects'], id: number): Vec3 {
  const base = id * 3;
  return {
    x: store.position[base] ?? 0,
    y: store.position[base + 1] ?? 0,
    z: store.position[base + 2] ?? 0,
  };
}

/** Task 7 (audio): one persistent hum loop per team generator, transitioning with
 *  `world.baseObjects.powered` -- setStationHum/setLoop already no-op a redundant start or a
 *  stop of a key that never started, so calling this every frame for every generator is cheap
 *  and still only ever actually starts/stops audio on a genuine power transition. #56
 *  lifecycle: `connected` false (a dropped socket -- the last snapshot's base objects keep
 *  their powered bits in the prediction world, but nothing behind a dead socket should keep
 *  singing) silences every hum until a connection returns. Exported for a focused unit
 *  test. */
export function updateStationHumAudio(world: World, audio: AudioEngine, connected = true): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    const kind = bases.kind[id];
    if (
      kind !== BaseObjectKind.Generator &&
      kind !== BaseObjectKind.StationInventory &&
      kind !== BaseObjectKind.StationVehiclePad
    )
      continue;
    const active = connected && bases.powered[id] === 1 && bases.destroyed[id] === 0;
    if (kind === BaseObjectKind.Generator)
      audio.setGeneratorHum(id, basePositionAt(bases, id), active);
    else audio.setStationHum(id, basePositionAt(bases, id), active);
  }
}

function vehicleEngineActive(world: World, id: number): boolean {
  const v = world.vehicles;
  return v.active[id] === 1 && v.destroyed[id] === 0 && v.spawnTime[id]! <= 0;
}

/** `position[base + i]` for a vehicle's placement row (vehicles are never placed without a
 *  full row, hence the assertions). */
function vehiclePositionAt(store: World['vehicles'], id: number): Vec3 {
  const base = id * 3;
  return {
    x: store.position[base]!,
    y: store.position[base + 1]!,
    z: store.position[base + 2]!,
  };
}

/** The engine loop each kind plays. The asset output ships exactly two vehicle engine
 *  recordings (fx/vehicles/shrike_engine, fx/vehicles/outrider_engine), so the four later
 *  kinds reuse the closest one -- the three flyers the Shrike's turbine, the hover/ground
 *  craft the Wildcat's -- the same way the HUD reuses the two airframe icons. Per-kind
 *  engine recordings are a follow-up. */
const VEHICLE_ENGINE_LOOP: Record<VehicleKind, 'shrike' | 'wildcat'> = {
  [VehicleKind.Shrike]: 'shrike',
  [VehicleKind.Bomber]: 'shrike',
  [VehicleKind.Havoc]: 'shrike',
  [VehicleKind.Wildcat]: 'wildcat',
  [VehicleKind.Tank]: 'wildcat',
  [VehicleKind.MobilePointBase]: 'wildcat',
};

/** The vehicles that should be audible right now, keyed by id with their loop kind: none
 *  when disconnected (#56: the prediction world is a stale shell behind a dead socket) and
 *  no destroyed/spawning row. Split out of updateVehicleEngineAudio to keep that function
 *  under the complexity budget. */
function liveVehicleKinds(world: World, connected: boolean): Map<number, 'shrike' | 'wildcat'> {
  const current = new Map<number, 'shrike' | 'wildcat'>();
  if (!connected) return current;
  const vehicles = world.vehicles;
  for (let id = 0; id < vehicles.count; id++) {
    if (!vehicleEngineActive(world, id)) continue;
    current.set(id, VEHICLE_ENGINE_LOOP[vehicles.kind[id] as VehicleKind]);
  }
  return current;
}

/** Keep original engine loops synchronized, including vehicles removed from snapshots.
 *  #56 lifecycle: destruction (destroyed=1) and snapshot removal both drop a vehicle from
 *  `current`, so the removal pass stops its loop -- and `connected` false (dropped socket)
 *  leaves `current` empty, stopping every engine until a connection returns, since the
 *  prediction world's vehicle rows are a stale shell by then. A kind change (impossible
 *  today -- a wrecked Shrike respawn is a new id -- but cheap to honor) stops the old
 *  loop before the new kind's starts. Exported for a focused unit test. */
export function updateVehicleEngineAudio(
  world: World,
  audio: AudioEngine,
  previous: Map<number, 'shrike' | 'wildcat'>,
  connected = true,
): void {
  const current = liveVehicleKinds(world, connected);
  for (const [id, kind] of previous) {
    if (!current.has(id) || current.get(id) !== kind)
      audio.setVehicleEngine(id, kind, { x: 0, y: 0, z: 0 }, false);
  }
  for (const [id, kind] of current) {
    audio.setVehicleEngine(id, kind, vehiclePositionAt(world.vehicles, id), true);
  }
  previous.clear();
  for (const [id, kind] of current) previous.set(id, kind);
}

/** Issue #56: one per-frame ambient-audio phase. The panner graph needs the listener's own
 *  position/orientation each frame (camera state, not sim state), and every world-derived
 *  loop (hums, engines) must follow the connection -- a dropped socket stops them until
 *  reconnect, per each updater's own comment. Split out of frame for the same complexity
 *  budget reason syncWorldView already was. */
function updateAmbientAudio(
  world: World,
  net: Pick<NetClient, 'connected'> | null,
  camera: THREE.PerspectiveCamera,
  forward: THREE.Vector3,
  up: THREE.Vector3,
  audio: AudioEngine,
  audibleVehicles: Map<number, 'shrike' | 'wildcat'>,
): void {
  camera.getWorldDirection(forward);
  up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  audio.updateListener(camera.position, forward, up);
  const connected = net === null || net.connected;
  updateStationHumAudio(world, audio, connected);
  updateVehicleEngineAudio(world, audio, audibleVehicles, connected);
}
interface StationAudioState {
  id: number | null;
  kind: 'inventory' | 'vehicle';
  position?: Vec3;
}

function stationAudioTarget(
  inventory: { open: boolean; triggerStation: number | null },
  vehicle: { open: boolean; triggerPad: number | null },
): Pick<StationAudioState, 'id' | 'kind'> {
  const inventoryId = inventory.open ? inventory.triggerStation : null;
  return {
    id: inventoryId ?? (vehicle.open ? vehicle.triggerPad : null),
    kind: inventoryId !== null ? 'inventory' : 'vehicle',
  };
}

function updateStationActivationAudio(
  world: World,
  audio: AudioEngine,
  inventory: { open: boolean; triggerStation: number | null },
  vehicle: { open: boolean; triggerPad: number | null },
  previous: StationAudioState,
): void {
  const { id, kind } = stationAudioTarget(inventory, vehicle);
  if (id === previous.id && (id === null || kind === previous.kind)) return;
  if (previous.id !== null && previous.kind === 'vehicle')
    audio.stationDeactivate(previous.position);
  previous.id = id;
  previous.kind = kind;
  if (id === null) return;
  const positions = kind === 'vehicle' ? world.baseObjects.usePosition : world.baseObjects.position;
  previous.position = {
    x: positions[id * 3]!,
    y: positions[id * 3 + 1]!,
    z: positions[id * 3 + 2]!,
  };
  audio.stationActivate(kind, previous.position);
}

export interface RepairBeamFrame {
  world: World;
  playerId: number;
  /** The input this frame's simulation ran with (gameplayInput's product). */
  input: PlayerInput;
  /** Any full-screen UI (station/pad menu, commander map, voice menu) -- opening one stops
   *  the beam even though Input itself would also zero packActive while a menu is up. */
  uiOpen: boolean;
  freeCam: boolean;
}

/** The pack/trigger precondition gate: stepRepairPacks's own preconditions (pack equipped,
 *  alive, trigger held) plus the client-only ones the sim never sees (menus open, free cam).
 *  Both the target query and the active decision below run off this one gate. */
function repairBeamHeld(
  world: World,
  playerId: number,
  input: PlayerInput,
  uiOpen: boolean,
  freeCam: boolean,
): boolean {
  return (
    world.players.hasRepairPack[playerId] === 1 &&
    world.players.alive[playerId] === 1 &&
    input.packActive &&
    !uiOpen &&
    !freeCam
  );
}

/** Issue #51 wiring: one place decides whether the local Repair Pack's beam is live this
 *  frame, then drives the beam mesh, the dedicated audio loop, and the feedback row off
 *  that single decision. The gates mirror stepRepairPacks's own preconditions exactly --
 *  pack equipped, alive, trigger held -- plus the client-only ones the sim never sees
 *  (menus open, free cam) and the shared energy pool the jet loop already gates on (the
 *  same `energy > 0` check updateJetAudio uses), so releasing R, opening any menu, dying,
 *  or draining the pool all stop the beam and its sound on the same frame. The target
 *  itself comes from the sim's own repairBeamTarget query, so the occlusion/range/team/
 *  wreck rules can never drift between what the beam shows and what the server heals.
 *  Exported for a focused unit test; every engine call below is idempotent per frame
 *  (setLoop no-ops a redundant start/stop), so calling this every rendered frame is cheap. */
export function syncRepairBeamView(
  frame: RepairBeamFrame,
  view: RepairBeamView,
  audio: Pick<AudioEngine, 'setRepairBeam'>,
  feedback: RepairBeamFeedback,
): void {
  const { world, playerId, input } = frame;
  const held = repairBeamHeld(world, playerId, input, frame.uiOpen, frame.freeCam);
  const target = held ? repairBeamTarget(world, playerId, input.yaw, input.pitch) : null;
  const energy = world.players.energy[playerId] ?? 0;
  // Same depletion gate the jet loop uses: the pack fires out of the shared armor energy
  // pool, so an empty pool stops the beam even with a valid target still under the crosshair.
  const active = held && energy > 0 && target !== null;
  view.sync(active ? target : null);
  audio.setRepairBeam(playerId, active);
  feedback.textContent = repairBeamStatusText({
    held,
    active,
    energyFraction: energy / armorFor(world, playerId).maxEnergy,
    target,
  });
  feedback.hidden = !held;
}

export async function createApp(container: HTMLElement, options: AppOptions = {}): Promise<App> {
  const assets = await loadKatabatic();
  const terrain = toHeightfield(assets);
  const net = createNetClient(options.serverUrl, terrain);
  const world = net ? net.world : createWorld(terrain, 1);
  // Single-player's only spawn point, computed once and reused both for the initial
  // addPlayer below and for every later respawn (Codex review round 4, finding 1) -- the
  // same source spawnPoint always drew from, not a new choice.
  world.interiors = await loadInteriorColliders(assets);
  const spawnArea = assets.scene.spawns.find((spawn) => spawn.team === 1);
  if (!spawnArea) throw new Error('Katabatic has no team 1 spawn area');
  const [spawnX, spawnY, spawnZ] = spawnArea.position;
  const localSpawn = findSpawnPosition(
    terrain,
    world.interiors,
    { x: spawnX, y: spawnY, z: spawnZ },
    spawnArea.radius,
    0,
  );
  // Bug found by Task 14's e2e capture test: addPlayer defaults to team 0 when no team is
  // given, which never equals a flag's team (1 or 2) in flags.ts's isOwnFlag/tryCapture checks.
  // That let single-player pick up either flag (both looked "enemy") but never capture one
  // (its "own" flag never matched), silently breaking CTF in single-player. spawnPoint already
  // picks the team 1 spawn, so team 1 here is the fix, not a new choice.
  const playerId = net ? 0 : addPlayer(world, localSpawn, 1);
  // Codex round 1, finding 1: base objects/turrets are seeded from the same shared scene
  // asset data for BOTH the single-player and networked paths now, not just single-player --
  // the server's own loadKatabaticWorld (server/world.ts) places its base objects/turrets
  // from this identical array, in this identical order, so a NetClient's ids already line up
  // with the server's before a single snapshot ever arrives. Without this, a networked
  // client's world.baseObjects/world.turrets stayed permanently empty: movement prediction
  // never saw a force field or interior to collide with, stationAt (the loadout menu) never
  // found a station to use, and the commander map (which reads world.baseObjects/turrets
  // directly, not the wire-decoded net.baseObjects/net.turrets rendering already uses) drew
  // nothing at all. netclient.ts's handleSnapshot applies each snapshot's dynamic fields
  // (damage/destroyed/powered/...) onto this same store by id once a connection exists.
  createBaseObjects(
    world,
    assets.scene.baseObjects.map(
      ({ kind, team, position: [x, y, z], usePosition, rotation, scale }) => ({
        kind,
        team,
        position: { x, y, z },
        ...(usePosition && {
          usePosition: { x: usePosition[0], y: usePosition[1], z: usePosition[2] },
        }),
        ...(rotation && {
          rotation: {
            axis: { x: rotation.axis[0], y: rotation.axis[1], z: rotation.axis[2] },
            degrees: rotation.degrees,
          },
        }),
        ...(scale && { scale: { x: scale[0], y: scale[1], z: scale[2] } }),
      }),
    ),
  );
  createTurrets(
    world,
    assets.scene.turrets.map(({ barrel, team, position: [x, y, z] }) => ({
      barrel,
      team,
      position: { x, y, z },
    })),
  );
  // Seeds a real initial powered state from the locally-placed generators above rather than
  // leaving every object at createBaseObjects's own powered=1 creation default -- harmless for
  // the networked path even before a snapshot arrives (the next one overwrites it with the
  // server's authoritative value regardless), and correct immediately for single-player, which
  // has no snapshot to ever correct it.
  stepPower(world);
  // Single-player has no server; seed CTF locally from the same scene data the server would
  // read (Task 7's loadKatabaticWorld does the equivalent for the networked path). Flags stay
  // server-authoritative-only for the networked path (net.flags, read straight off the wire),
  // so this alone stays single-player-only.
  if (!net) {
    createFlags(
      world,
      assets.scene.flagStands.map(({ team, position: [x, y, z] }) => ({
        team,
        position: { x, y, z },
      })),
    );
  }

  const scene = new THREE.Scene();
  addEnvironment(scene, assets);
  scene.add(await createTerrain(assets));
  const sky = scene.getObjectByName('sky');
  if (!sky) throw new Error('addEnvironment did not add the sky');
  // Local prediction resolves interior/force-field collision identically to the server
  // (Task 11) -- without this, a client walking into a wall or a powered force field would
  // predict straight through it until the next snapshot corrected the mispredict.
  const baseObjectView = createBaseObjectView(scene, assets);
  const vehicleView = createVehicleView(
    scene,
    assets,
    (vehicle) => {
      spawnVehicleExplosion(scene, effects, vehicle);
      audio.vehicleExplosion(vehicle);
    },
    baseObjectView.baseObjectMeshes,
  );
  const weaponModel = createWeaponModel();
  // Issue #51: the repair beam's persistent scene object -- created once like the weapon
  // model, moved in place every frame by syncRepairBeamView.
  const repairBeam = createRepairBeamView(scene);

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
  const vehicleBuffers = new Map<number, VehicleBuffer>();
  const fps: FpsWindow = { windowStart: performance.now(), frames: 0 };
  const projectileMeshes = new Map<number, THREE.Mesh>();
  const previousProjectiles = new Map<number, ProjectileSnapshotData>();
  const flagMeshes = new Map<number, THREE.Group>();
  const effects: Effect[] = [];
  const seenEventSeq = { seq: 0 };
  const crosshair = document.createElement('div');
  crosshair.id = 'crosshair';
  document.body.appendChild(crosshair);
  // Issue #51: the repair feedback row -- target/range/energy text under the crosshair,
  // hidden outright whenever the Repair Pack trigger is not held (repairBeamStatusText's
  // own resting-state rule).
  const repairStatus = document.createElement('div');
  repairStatus.id = 'repair-status';
  document.body.appendChild(repairStatus);
  const hud = createHud(document.body, hudSourceFrom(world, playerId, net));
  const interactionPrompt = createInteractionPrompt(document.body);
  const stationMenuState = { open: false, triggerStation: null as number | null };
  const stationMenu: StationMenu = createStationMenu(
    document.body,
    (choice: LoadoutChoice) => {
      if (net) net.sendLoadout(choice.armor, choice.pack, choice.weapons);
      else applyLoadoutSelection(world, playerId, choice.armor, choice.pack, choice.weapons);
      stationMenuState.open = false;
      input.setUiOpen(false);
    },
    () => {
      stationMenuState.open = false;
      input.setUiOpen(false);
    },
  );
  const vehiclePadMenuState = { open: false, triggerPad: null as number | null };
  const vehiclePadMenu: VehiclePadMenu = createVehiclePadMenu(
    document.body,
    (padId: number, kind: VehicleKind) => {
      if (net) net.sendVehicleSpawn(padId, kind);
      else requestVehicleAtPad(world, playerId, padId, kind);
      vehiclePadMenuState.open = false;
      input.setUiOpen(false);
      input.resumeMouseLook();
    },
    () => {
      vehiclePadMenuState.open = false;
      input.setUiOpen(false);
    },
  );
  const commanderMapCanvas = document.createElement('canvas');
  commanderMapCanvas.id = 'commander-map';
  commanderMapCanvas.width = 512;
  commanderMapCanvas.height = 512;
  commanderMapCanvas.hidden = true;
  document.body.appendChild(commanderMapCanvas);
  const orderState: { pending: { x: number; z: number } | null } = { pending: null };
  // A click only stashes a pending world position -- it never sends anything itself. The
  // order is only sent once the player confirms a kind with a digit key (syncCommandOrders,
  // above), matching the loadout menu's own click-then-confirm shape.
  commanderMapCanvas.addEventListener('click', (event: MouseEvent) => {
    if (commanderMapCanvas.hidden) return;
    const ctx = commanderMapCanvas.getContext('2d');
    if (!ctx) return;
    const rect = commanderMapCanvas.getBoundingClientRect();
    const canvasX = ((event.clientX - rect.left) / rect.width) * commanderMapCanvas.width;
    const canvasY = ((event.clientY - rect.top) / rect.height) * commanderMapCanvas.height;
    orderState.pending = canvasToWorld(ctx, assets.scene.missionArea, canvasX, canvasY);
  });
  const voiceMenu = createVoiceMenu(document.body);
  // Issue #56: reused listener-orientation scratch vectors -- two fresh allocations every
  // frame would be waste, and getWorldDirection/applyQuaternion write in place.
  const listenerForward = new THREE.Vector3();
  const listenerUp = new THREE.Vector3();
  // Original game recordings, decoded and cached by the audio engine. Issue #56: positioned
  // cues duck when terrain blocks their straight path to the listener -- the same
  // hasLineOfSight march turrets and repair already use, so audio never disagrees with what
  // the rest of the game treats as visible (camera.position is a live reference; the engine
  // re-reads it per cue).
  const audio = createAudioEngine({
    context: new AudioContext(),
    position: camera.position,
    // Issue #56's occlusion residual: this used to be the terrain march alone, which left a
    // cue firing from inside a bunker to a target outside, or through a powered opposing
    // force field, sounding unobstructed. It is now the same pair the simulation uses
    // everywhere it asks whether two points can see each other -- terrain (`hasLineOfSight`)
    // plus built geometry (`segmentBlockedByInteriors`, the shared test turrets, projectiles
    // and repair targeting all consult, with the force-field rule keyed to the listener's own
    // team since a field is team-passable).
    occlusionAt: (position) =>
      audioOcclusionAt(world, camera.position, position, world.players.team[playerId] ?? 0),
  });
  // Browsers start a fresh AudioContext `suspended` under autoplay restriction and require a
  // real user-gesture handler to resume it -- the same click that already requests pointer
  // lock (Input's own listener on this element) is that gesture. Codex review round 1 of the
  // M7 PR: without this, every synthesized sound silently never plays in a browser that
  // enforces the restriction.
  const resumeAudio = (): void => audio.resume();
  renderer.domElement.addEventListener('click', resumeAudio);
  window.addEventListener('keydown', resumeAudio);
  const footstepState: FootstepState = { timer: 0 };
  const audibleVehicles = new Map<number, 'shrike' | 'wildcat'>();
  const stationAudioState: StationAudioState = { id: null, kind: 'inventory' };
  // Backs the `godMode` accessor below. A plain data property here would just record
  // whatever the debug UI last set, the way it used to, leaving frame() to poll it every
  // tick and react after the fact (Codex review round 4, finding 5) -- the accessor's
  // setter instead applies the single-player toggle immediately, once, right where lil-gui
  // assigns `app.godMode = enabled`.
  let godModeFlag = false;

  let previousMounted = -1;
  const pilotYaw = new PilotYawController();
  const app: App = {
    world,
    playerId,
    net,
    input,
    assets,
    camera,
    scene,
    renderer,
    weaponModel,
    timeScale: 1,
    paused: false,
    stepOnce: false,
    freeCam: false,
    freeCamPosition: new THREE.Vector3(),
    vehicleCameraFirstPerson: true,
    vehicleCameraPos: 0,
    get godMode(): boolean {
      return godModeFlag;
    },
    set godMode(enabled: boolean) {
      godModeFlag = enabled;
      // Networked god mode is server-authoritative: debug.ts's own onChange callback sends
      // the God message via NetClient.setGodMode. Single-player has no server to ask, so
      // this setter applies it directly and proactively to the local sim world instead.
      if (!net) setLocalGodMode(world, playerId, enabled);
    },
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
    debugTeleportToFlag(team: number): void {
      teleportPlayerToFlag(world, playerId, team);
    },
    debugKillGenerator(team: number): void {
      debugKillGenerator(world, team);
    },
    debugRepairGenerator(team: number): void {
      debugRepairGenerator(world, team);
    },
    debugIsStationPowered(team: number): boolean {
      return debugIsStationPowered(world, team);
    },
    debugTeleportToVehiclePad(team: number): void {
      teleportPlayerToVehiclePad(world, playerId, team);
    },
    dispose(): void {
      window.removeEventListener('keydown', resumeAudio);
      renderer.domElement.removeEventListener('click', resumeAudio);
      audio.dispose();
      repairBeam.dispose();
      repairStatus.remove();
      weaponModel.dispose();
      vehicleView.dispose();
      interactionPrompt.dispose();
    },
    frame(dtSeconds: number): void {
      const frameStart = performance.now();
      updateEffects(scene, effects, dtSeconds, camera);
      let steps = advance(acc, dtSeconds, app.paused ? 0 : app.timeScale, FIXED_DT);
      if (app.stepOnce) {
        steps = 1;
        app.stepOnce = false;
      }
      const usePressed = frameUsePressed(app, input);
      previousMounted = syncPilotInput(app, previousMounted, pilotYaw);
      const currentInput = gameplayInput(app, usePressed, pilotYaw);
      const simStart = performance.now();
      if (net) {
        stepNetworked(net, app.stats, currentInput, steps, scene, remoteMeshes, remoteBuffers);
      } else {
        stepSinglePlayer(world, playerId, currentInput, steps, localSpawn, (flagsBefore) => {
          playWeaponFireAudio(world, playerId, audio);
          playVehicleFireAudio(world, audio);
          playFlagStateAudio(audio, flagsBefore, world, playerId);
          for (const event of world.lastFireEvents) {
            if (event.weaponId !== WeaponId.LaserRifle || !event.beamEnd) continue;
            spawnLaserBeams(
              scene,
              effects,
              [
                {
                  type: MessageType.Event,
                  kind: EventKind.LaserFired,
                  a: event.playerId,
                  b: event.hitPlayerId,
                  beam: { from: event.origin, to: event.beamEnd },
                },
              ],
              () => null,
              playerId,
            );
          }
          // #52 (solo): there is no server to broadcast impact events, so drain this tick's
          // authoritative records straight out of the projectile store -- here inside
          // afterStep, per simulated tick exactly like the laser beams above, because
          // lastImpacts is overwritten on every stepProjectiles call and a multi-step frame
          // would otherwise lose every impact but the final tick's.
          spawnProjectileImpacts(scene, effects, world.projectiles.lastImpacts);
          playImpactAudio(audio, world.projectiles.lastImpacts);
        });
      }
      app.stats.simMs = performance.now() - simStart;

      // Task 7 (audio): reacts to the world state this frame's simulation just produced --
      // see each helper's own comment for why weaponFire needs the `steps > 0` guard and the
      // others don't.
      updateFrameAudio({
        steps,
        net,
        world,
        playerId,
        audio,
        freeCam: app.freeCam,
        jetInputActive: currentInput.jet,
        footstep: footstepState,
        dtSeconds,
      });

      syncWorldView(
        world,
        playerId,
        net,
        scene,
        hud,
        effects,
        projectileMeshes,
        previousProjectiles,
        flagMeshes,
        seenEventSeq,
        dtSeconds,
        audio,
      );

      syncBaseAssetsView(
        {
          world,
          playerId,
          net,
          input,
          assets,
          camera,
          hud,
          baseObjectView,
          stationMenu,
          stationMenuState,
          vehicleView,
          vehicleBuffers,
          vehiclePadMenu,
          vehiclePadMenuState,
          commanderMapCanvas,
          orderState,
          voiceMenu,
          audio,
        },
        usePressed,
        // Issue #54: the turret mount's clips, muzzle flash and aim smoothing must advance in
        // simulated seconds. Reuse the weapon-animation gate (0 while paused or after the
        // match ends) and hand the mount an already-scaled delta with timeScale 1, which
        // presentationDelta multiplies out to the same value.
        { dt: weaponAnimationDelta(app, dtSeconds), timeScale: 1 },
      );

      // Issue #51: the beam, its loop and the feedback row follow the state this frame's
      // sync pass just produced -- after syncBaseAssetsView so input.uiOpen already
      // reflects any menu this frame's E-press opened, keeping "menu opens" a same-frame
      // beam stop.
      syncRepairBeamView(
        { world, playerId, input: currentInput, uiOpen: input.uiOpen, freeCam: app.freeCam },
        repairBeam,
        audio,
        repairStatus,
      );
      // Issue #51: the pack's own Activate recording follows the pack toggle, not the beam --
      // a menu opening or a drained pool stops the beam without un-activating the pack, so
      // those gates must not replay it. The engine edge-detects, so this is safe per frame.
      audio.setRepairPack(
        playerId,
        world.players.hasRepairPack[playerId] === 1 &&
          world.players.alive[playerId] === 1 &&
          currentInput.packActive,
      );

      interactionPrompt.update(world, playerId, input.uiOpen || app.freeCam);
      if (app.freeCam) moveFreeCam(app, dtSeconds);
      applyCameraToggle(app, input);
      placeCamera(app, sky, dtSeconds);
      // Issue #56: listener orientation for the panner graph, and every world-derived
      // loop following the connection (see updateAmbientAudio).
      updateAmbientAudio(world, net, camera, listenerForward, listenerUp, audio, audibleVehicles);
      updateStationActivationAudio(
        world,
        audio,
        stationMenuState,
        vehiclePadMenuState,
        stationAudioState,
      );
      renderer.render(scene, camera);
      weaponModel.sync(world, playerId, app.freeCam, weaponAnimationDelta(app, dtSeconds));
      // Issue #56: the Chaingun's own state recordings follow the same simulated state the
      // viewmodel just read, one frame, one source of truth.
      audio.setChaingunState(
        playerId,
        world.players.weaponSlot[playerId] ?? -1,
        world.players.weaponState[playerId] ?? WeaponState.Ready,
      );
      weaponModel.render(renderer, camera.aspect);
      app.stats.frameMs = performance.now() - frameStart;
      updateFps(app, frameStart, fps);
    },
  };
  return app;
}
