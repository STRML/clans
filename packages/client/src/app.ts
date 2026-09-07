import * as THREE from 'three';
import {
  applyBaseObjectDamage,
  applyLoadoutRequest,
  BASE_OBJECT_DATA,
  BaseObjectKind,
  FIXED_DT,
  FIXED_TICK_MS,
  addPlayer,
  createBaseObjects,
  createFlags,
  createTurrets,
  createWorld,
  dueForRespawn,
  respawnPlayer,
  sampleTerrain,
  setGodMode,
  stepPower,
  stepWorld,
  type ArmorId,
  type Heightfield,
  type PlayerInput,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import type {
  BaseObjectSnapshotData,
  ProjectileSnapshotData,
  TurretSnapshotData,
} from '@clans/protocol';
import { loadKatabatic, type KatabaticAssets } from './assets.js';
import {
  baseObjectsFromWorld,
  createBaseObjectView,
  raycastAimedStructure,
  turretsFromWorld,
} from './base-object-view.js';
import {
  drawCommanderMap,
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
import { NetClient, type RemoteSnapshot, type TimestampedEvent } from './netclient.js';
import { RemoteBuffer, syncRemoteMeshes } from './remote.js';
import { createStationMenu, stationMenuVisible, type StationMenu } from './stationMenu.js';
import { addEnvironment, createTerrain } from './terrain.js';
import { WebSocketTransport } from './transport.js';
import {
  projectilesFromWorld,
  spawnExplosionsForExpired,
  spawnLaserBeams,
  syncProjectileMeshes,
  updateEffects,
  type Effect,
} from './weapons-view.js';

// Light armor is 2.3 m tall; the camera sits just below the top of the bounding box.
const EYE_HEIGHT = 2.0;
const FREE_CAM_SPEED = 40;
const FREE_CAM_FAST = 4;
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
  godMode: boolean;
  stats: AppStats;
  frame(dtSeconds: number): void;
  debugTeleportToFlag(team: number): void;
  debugKillGenerator(team: number): void;
  debugRepairGenerator(team: number): void;
  debugIsStationPowered(team: number): boolean;
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
): void {
  const inputs = new Map<number, PlayerInput>([[playerId, input]]);
  for (let step = 0; step < steps; step += 1) {
    stepWorld(world, inputs);
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
  stationMenuState: { open: boolean };
  commanderMapCanvas: HTMLCanvasElement;
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
  const sensedIds = sensedEnemyIds(players, localTeam, circles);
  drawCommanderMap(ctx, state.assets, state.world, players, localTeam, sensedIds);
}

/** Syncs base-object/turret meshes, the station menu, the commander map, and the HUD's
 *  aimedStructure row -- everything Tasks 11-13 added -- to the latest sim or net state.
 *  Pulled out of `frame` for the same reason `syncWorldView` already is: keeping `frame`'s
 *  own branching under this repo's complexity budget. */
function syncBaseAssetsView(state: BaseAssetsViewState): void {
  const { world, playerId, net, input } = state;
  const connected = net ? net.connected : true;
  const baseObjectData: BaseObjectSnapshotData[] =
    net && connected ? net.baseObjects : baseObjectsFromWorld(world);
  const turretData: TurretSnapshotData[] = net && connected ? net.turrets : turretsFromWorld(world);
  state.baseObjectView.sync(baseObjectData, turretData);

  if (input.usePressedThisFrame()) state.stationMenuState.open = !state.stationMenuState.open;
  state.stationMenuState.open = stationMenuVisible(world, playerId, state.stationMenuState.open);
  if (state.stationMenuState.open) state.stationMenu.show();
  else state.stationMenu.hide();

  if (input.commandCirclePressedThisFrame()) {
    state.commanderMapCanvas.hidden = !state.commanderMapCanvas.hidden;
  }
  if (!state.commanderMapCanvas.hidden) drawCommanderMapForTeam(state);

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
export function syncWorldView(
  world: World,
  playerId: number,
  net: Pick<
    NetClient,
    | 'playerId'
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
): void {
  const connected = net ? net.connected : true;
  const projectiles = net ? (connected ? net.projectiles : []) : projectilesFromWorld(world);
  spawnExplosionsForExpired(scene, effects, previousProjectiles, projectiles);
  syncProjectileMeshes(scene, projectileMeshes, projectiles);
  previousProjectiles.clear();
  for (const projectile of projectiles) previousProjectiles.set(projectile.id, projectile);

  syncFlagMeshes(scene, flagMeshes, net ? (connected ? net.flags : []) : flagsFromWorld(world));

  const allEvents: TimestampedEvent[] = net ? net.recentEvents : [];
  const newEvents = drainNewEvents(allEvents, seenEventSeq);
  spawnLaserBeams(scene, effects, newEvents, (id) => positionOfPlayer(world, net, id));
  updateEffects(scene, effects, dtSeconds);

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

/** Revives exactly one of the team's generators (real T2 has no in-mission generator
 *  rebuild either -- this is a debug-only capability, not a Repair Pack simulation; Repair
 *  Pack correctly refuses to revive a destroyed generator, see repair.test.ts's failure
 *  matrix row 15 case). */
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

export async function createApp(container: HTMLElement, options: AppOptions = {}): Promise<App> {
  const assets = await loadKatabatic();
  const terrain = toHeightfield(assets);
  const net = createNetClient(options.serverUrl, terrain);
  const world = net ? net.world : createWorld(terrain, 1);
  // Single-player's only spawn point, computed once and reused both for the initial
  // addPlayer below and for every later respawn (Codex review round 4, finding 1) -- the
  // same source spawnPoint always drew from, not a new choice.
  const localSpawn = spawnPoint(assets, terrain);
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
    assets.scene.baseObjects.map(({ kind, team, position: [x, y, z], rotation, scale }) => ({
      kind,
      team,
      position: { x, y, z },
      ...(rotation && {
        rotation: {
          axis: { x: rotation.axis[0], y: rotation.axis[1], z: rotation.axis[2] },
          degrees: rotation.degrees,
        },
      }),
      ...(scale && { scale: { x: scale[0], y: scale[1], z: scale[2] } }),
    })),
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
  world.interiors = await loadInteriorColliders(assets);
  const baseObjectView = createBaseObjectView(scene, assets);

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
  const projectileMeshes = new Map<number, THREE.Mesh>();
  const previousProjectiles = new Map<number, ProjectileSnapshotData>();
  const flagMeshes = new Map<number, THREE.Group>();
  const effects: Effect[] = [];
  const seenEventSeq = { seq: 0 };
  const hud = createHud(document.body, hudSourceFrom(world, playerId, net));
  const stationMenuState = { open: false };
  const stationMenu: StationMenu = createStationMenu(
    document.body,
    (armor: ArmorId, repairPack) => {
      if (net) net.sendLoadout(armor, repairPack);
      else applyLoadoutRequest(world, playerId, armor, repairPack);
    },
  );
  const commanderMapCanvas = document.createElement('canvas');
  commanderMapCanvas.id = 'commander-map';
  commanderMapCanvas.width = 512;
  commanderMapCanvas.height = 512;
  commanderMapCanvas.hidden = true;
  document.body.appendChild(commanderMapCanvas);
  // Backs the `godMode` accessor below. A plain data property here would just record
  // whatever the debug UI last set, the way it used to, leaving frame() to poll it every
  // tick and react after the fact (Codex review round 4, finding 5) -- the accessor's
  // setter instead applies the single-player toggle immediately, once, right where lil-gui
  // assigns `app.godMode = enabled`.
  let godModeFlag = false;

  const app: App = {
    world,
    playerId,
    net,
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
    frame(dtSeconds: number): void {
      const frameStart = performance.now();
      let steps = advance(acc, dtSeconds, app.paused ? 0 : app.timeScale, FIXED_DT);
      if (app.stepOnce) {
        steps = 1;
        app.stepOnce = false;
      }
      const currentInput = app.freeCam
        ? { ...IDLE, yaw: input.yaw, pitch: input.pitch }
        : input.snapshot();
      const simStart = performance.now();
      if (net) {
        stepNetworked(net, app.stats, currentInput, steps, scene, remoteMeshes, remoteBuffers);
      } else {
        stepSinglePlayer(world, playerId, currentInput, steps, localSpawn);
      }
      app.stats.simMs = performance.now() - simStart;

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
      );

      syncBaseAssetsView({
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
        commanderMapCanvas,
      });

      if (app.freeCam) moveFreeCam(app, dtSeconds);
      placeCamera(app, sky);
      renderer.render(scene, camera);
      app.stats.frameMs = performance.now() - frameStart;
      updateFps(app, frameStart, fps);
    },
  };
  return app;
}
