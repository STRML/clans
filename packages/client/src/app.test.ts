import * as THREE from 'three';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  addPlayer,
  ArmorId,
  applyBaseObjectDamage,
  applyDamage,
  applyLoadoutSelection,
  BaseObjectKind,
  createBaseObjects,
  createFlags,
  createWorld,
  FIXED_DT,
  FlagState,
  GameOverReason,
  LIGHT_ARMOR,
  PackId,
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  ammoIndex,
  RESPAWN_TICKS,
  stepPower,
  VehicleKind,
  type Heightfield,
  type PlayerInput,
  type PlayerSnapshotData,
  type ProjectileImpact,
  type VehicleSnapshotData,
  type World,
} from '@clans/sim';
import {
  EventKind,
  MessageType,
  type FlagSnapshotData,
  type ProjectileSnapshotData,
} from '@clans/protocol';
import type { AudioEngine } from './audio.js';
import {
  commanderMapPlayers,
  debugIsStationPowered,
  debugKillGenerator,
  debugRepairGenerator,
  drainNewEvents,
  hudSourceFrom,
  PilotYawController,
  playImpactAudio,
  playFlagStateAudio,
  positionOfPlayer,
  setLocalGodMode,
  snapshotFlagAudioState,
  stepSinglePlayer,
  syncRepairBeamView,
  syncWorldView,
  teleportPlayerToFlag,
  teleportPlayerToVehiclePad,
  updateFootstepAudio,
  updateMovementAudio,
  updateRemotes,
  updateStationHumAudio,
  updateVehicleBuffers,
  updateVehicleEngineAudio,
  vehicleRenderData,
  type RepairBeamFrame,
} from './app.js';
import { flagsFromWorld } from './flag-view.js';
import { RemoteBuffer } from './remote.js';
import { VehicleBuffer } from './vehicle-view.js';
import { spawnProjectileImpacts, type Effect } from './weapons-view.js';
import type {
  NetClient,
  RemoteSnapshot,
  RemoteVehicleSnapshot,
  TimestampedEvent,
} from './netclient.js';
import { carriedWeaponSlots, describeHud } from './hud.js';
import { speakVoiceLine } from './voicebinds.js';

// speakVoiceLine ultimately starts a recorded audio clip in the browser --
// mocked here so syncWorldView's own event-drain wiring is observable without a DOM.
vi.mock('./voicebinds.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voicebinds.js')>();
  return { ...actual, speakVoiceLine: vi.fn() };
});

function vehicleData(overrides: Partial<VehicleSnapshotData> = {}): VehicleSnapshotData {
  return {
    id: 1,
    kind: VehicleKind.Shrike,
    team: 1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    angVelYaw: 0,
    angVelPitch: 0,
    angVelRoll: 0,
    energy: 0,
    damage: 0,
    destroyed: 0,
    driverId: -1,
    padId: -1,
    weaponTimer: 0,
    onGround: 0,
    wasJumpHeld: 0,
    ...overrides,
  };
}

const IDLE_INPUT: PlayerInput = {
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

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('PilotYawController', () => {
  it('keeps sustained large mouse turns on their requested side of the vehicle', () => {
    const left = new PilotYawController();
    left.reset(0);
    let leftTarget = left.constrain(4, 0);
    expect(leftTarget).toBeGreaterThan(0);
    leftTarget = left.constrain(leftTarget + 4, 0.2);
    expect(leftTarget).toBeGreaterThan(0.2);

    const right = new PilotYawController();
    right.reset(0);
    let rightTarget = right.constrain(-4, 0);
    expect(rightTarget).toBeLessThan(0);
    rightTarget = right.constrain(rightTarget - 4, -0.2);
    expect(rightTarget).toBeLessThan(-0.2);
  });

  it('preserves a nearby requested heading while the vehicle crosses the ±pi seam', () => {
    const pilot = new PilotYawController();
    pilot.reset(Math.PI - 0.1);
    const target = Math.PI + 0.1;
    expect(pilot.constrain(target, Math.PI - 0.1)).toBeCloseTo(target);
    // This is the same vehicle heading after its wrapped simulation yaw crosses +pi to -pi.
    expect(pilot.constrain(target, -Math.PI + 0.05)).toBeCloseTo(target);
  });
});

const snapshot: PlayerSnapshotData = {
  id: 1,
  team: 1,
  x: 10,
  y: 0,
  z: 5,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  energy: 60,
  health: 60,
  weaponSlot: 4,
  onGround: 1,
  ski: 0,
  respawnSeq: 0,
  discAmmo: 15,
  chaingunAmmo: 100,
  mortarAmmo: 0,
  grenades: 5,
  weaponState: 1,
  weaponTimer: 0,
  spunUp: 0,
  grenadeCooldown: 0,
  score: 0,
  godMode: 0 as const,
  wasJumpHeld: 0 as const,
  armor: 0,
  hasRepairPack: 0 as const,
  hasEnergyPack: 0 as const,
  carriedWeapons: 0,
};

describe('commanderMapPlayers (Codex round 2 review of PR #11)', () => {
  it('merges net.remotePlayers into the roster -- world.players alone never has them', () => {
    // NetClient's own prediction world only ever holds the local player (netclient.ts's
    // createWorld(terrain, 1, 1) -- capacity 1); every remote player's position lives
    // entirely in net.remotePlayers, decoded off the wire. Before this fix, the commander
    // map's player scan read world.players alone, so a networked client's map never showed
    // a single enemy or teammate other than the local player.
    const world = createWorld(flat, 1);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1); // the local player, id 0
    const remote: Pick<NetClient, 'remotePlayers'> = {
      remotePlayers: new Map([[1, { ...snapshot, id: 1, team: 2, x: 42, z: 7 }]]),
    };
    const players = commanderMapPlayers(world, remote);
    expect(players).toHaveLength(2);
    const remotePlayer = players.find((p) => p.id === 1);
    expect(remotePlayer).toMatchObject({ team: 2, x: 42, z: 7, alive: true });
  });

  it('a dead remote (health <= 0) is not reported alive', () => {
    const world = createWorld(flat, 1);
    const remote: Pick<NetClient, 'remotePlayers'> = {
      remotePlayers: new Map([[1, { ...snapshot, id: 1, health: 0 }]]),
    };
    const players = commanderMapPlayers(world, remote);
    expect(players.find((p) => p.id === 1)?.alive).toBe(false);
  });

  it('single-player (no net) reads only world.players', () => {
    const world = createWorld(flat, 1);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(commanderMapPlayers(world, null)).toHaveLength(1);
  });
});

describe('updateRemotes', () => {
  it('timestamps a pushed remote sample with the caller clock, not the server tick counter', () => {
    // Codex round 1 (PR #4): samples were timestamped with remoteTick * FIXED_TICK_MS
    // (the server's own tick counter, on a clock that starts whenever the server process
    // did) but RemoteBuffer.positionAt is later queried with the client's performance.now().
    // Those are unrelated epochs; a remote player either extrapolated forever or stuck to
    // a stale sample because renderTime never bracketed a sample timestamped that way.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const activeNet: Pick<NetClient, 'remoteSnapshots' | 'connected'> = {
      remoteSnapshots: [{ tick: 500, players: new Map([[1, snapshot]]) }],
      connected: true,
    };
    const nowMs = 123456; // an arbitrary performance.now() reading

    updateRemotes(activeNet, scene, meshes, buffers, nowMs);

    const buffer = buffers.get(1);
    expect(buffer).toBeDefined();
    const samples = (buffer as unknown as { samples: Array<{ atMs: number }> }).samples;
    expect(samples[0]?.atMs).toBe(nowMs);
  });

  it('clears every remote buffer once the connection is no longer active, so pruning disposes their meshes', () => {
    // Codex round 2 (PR #4): remotePlayers only changes when a snapshot arrives, and
    // nothing else cleared it on disconnect, so a plain socket close left every remote
    // mesh (and the GPU resources behind it) stranded until the page tore down.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const fakeNet: { remoteSnapshots: NetClient['remoteSnapshots']; connected: boolean } = {
      remoteSnapshots: [{ tick: 1, players: new Map([[1, snapshot]]) }],
      connected: true,
    };
    updateRemotes(fakeNet, scene, meshes, buffers, 0);
    expect(buffers.has(1)).toBe(true);
    expect(scene.children).toHaveLength(1);

    fakeNet.connected = false;
    updateRemotes(fakeNet, scene, meshes, buffers, 100);

    expect(buffers.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  });

  it('drains every queued snapshot from a single render call, not just the latest', () => {
    // Codex round 10 (PR #4): a snapshot replaces remotePlayers wholesale the instant it
    // decodes, and updateRemotes only ever read the current value once per render call.
    // A frame stall (or simply more than one snapshot landing before the next paint) left
    // only the newest snapshot's position reachable; the earlier one was gone before
    // anything read it, so RemoteBuffer's interpolation history silently lost it and the
    // remote snapped instead of smoothing through the gap.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const remoteSnapshots: RemoteSnapshot[] = [
      { tick: 10, players: new Map([[1, { ...snapshot, x: 10 }]]) },
      { tick: 20, players: new Map([[1, { ...snapshot, x: 20 }]]) },
    ];
    const activeNet: Pick<NetClient, 'remoteSnapshots' | 'connected'> = {
      remoteSnapshots,
      connected: true,
    };

    updateRemotes(activeNet, scene, meshes, buffers, 0);

    expect(remoteSnapshots).toHaveLength(0); // the queue is drained, not just peeked
    const samples = (
      buffers.get(1) as unknown as { samples: Array<{ atMs: number; data: { x: number } }> }
    ).samples;
    expect(samples.map((sample) => sample.data.x)).toEqual([10, 20]);
    // Codex round 11 (PR #4): stamping every drained snapshot with the same nowMs stored
    // both positions at an identical timestamp, so RemoteBuffer's interpolate() (which
    // treats equal timestamps as a single sample) still jumped straight to the newest
    // instead of ever bracketing between them.
    expect(samples[0]?.atMs).not.toBe(samples[1]?.atMs);
  });
});

// Codex review round 1 (this PR), finding 9: the vehicle sibling of updateRemotes just
// above -- same disconnect-clears and drain-every-queued-snapshot behavior, applied to
// RemoteVehicleSnapshot/VehicleBuffer instead of RemoteSnapshot/RemoteBuffer.
describe('updateVehicleBuffers', () => {
  it('clears every vehicle buffer once the connection is no longer active', () => {
    const buffers = new Map<number, VehicleBuffer>();
    const fakeNet: { vehicleSnapshots: RemoteVehicleSnapshot[]; connected: boolean } = {
      vehicleSnapshots: [{ tick: 1, vehicles: [vehicleData({ id: 1 })] }],
      connected: true,
    };
    updateVehicleBuffers(fakeNet, buffers, 0);
    expect(buffers.has(1)).toBe(true);

    fakeNet.connected = false;
    updateVehicleBuffers(fakeNet, buffers, 100);
    expect(buffers.size).toBe(0);
  });

  it('drains every queued vehicle snapshot from a single call, not just the latest', () => {
    const buffers = new Map<number, VehicleBuffer>();
    const vehicleSnapshots: RemoteVehicleSnapshot[] = [
      { tick: 10, vehicles: [vehicleData({ id: 1, x: 10 })] },
      { tick: 20, vehicles: [vehicleData({ id: 1, x: 20 })] },
    ];
    const activeNet: Pick<NetClient, 'vehicleSnapshots' | 'connected'> = {
      vehicleSnapshots,
      connected: true,
    };

    updateVehicleBuffers(activeNet, buffers, 0);

    expect(vehicleSnapshots).toHaveLength(0); // the queue is drained, not just peeked
    const samples = (
      buffers.get(1) as unknown as { samples: Array<{ atMs: number; data: { x: number } }> }
    ).samples;
    expect(samples.map((sample) => sample.data.x)).toEqual([10, 20]);
    expect(samples[0]?.atMs).not.toBe(samples[1]?.atMs);
  });

  it('drops a buffer for an id the most recent snapshot no longer reports', () => {
    const buffers = new Map<number, VehicleBuffer>();
    const activeNet: Pick<NetClient, 'vehicleSnapshots' | 'connected'> = {
      vehicleSnapshots: [{ tick: 1, vehicles: [vehicleData({ id: 1 })] }],
      connected: true,
    };
    updateVehicleBuffers(activeNet, buffers, 0);
    expect(buffers.has(1)).toBe(true);

    activeNet.vehicleSnapshots.push({ tick: 2, vehicles: [] }); // vehicle 1 destroyed/despawned
    updateVehicleBuffers(activeNet, buffers, 100);
    expect(buffers.has(1)).toBe(false);
  });
});

describe('vehicleRenderData', () => {
  it('single-player (no net) reads world.vehicles directly, no buffering', () => {
    const world = createWorld(flat, 1);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const buffers = new Map<number, VehicleBuffer>();
    const out = vehicleRenderData({ world, playerId, net: null, vehicleBuffers: buffers });
    expect(out.map((v) => v.id)).toEqual([0]);
  });

  it('draws the locally-mounted vehicle live off world.vehicles, not the (stale) interpolation buffer', () => {
    // Codex review round 1 (this PR), finding 9: placeVehicleCamera already chases
    // world.vehicles' own live, zero-latency prediction. Feeding the SAME vehicle's mesh
    // through the 100 ms-behind interpolation buffer instead would make the mesh the
    // camera is chasing visibly lag behind where the camera itself already is.
    const world = createWorld(flat, 1);
    world.vehicles.active[7] = 1;
    world.vehicles.count = 8;
    world.vehicles.kind[7] = VehicleKind.Wildcat;
    world.vehicles.position.set([42, 0, 0], 7 * 3); // the LIVE, locally-predicted position
    const playerId = addPlayer(world, { x: 42, y: 0, z: 0 }, 1);
    world.players.mountedVehicleId[playerId] = 7;

    const buffers = new Map<number, VehicleBuffer>([[7, new VehicleBuffer()]]);
    // A stale buffered sample from before the local prediction above ran -- must NOT win.
    buffers.get(7)?.push(0, vehicleData({ id: 7, x: -999 }));

    const fakeNet: Pick<NetClient, 'connected' | 'vehicleSnapshots'> = {
      connected: true,
      vehicleSnapshots: [],
    };
    const out = vehicleRenderData({ world, playerId, net: fakeNet, vehicleBuffers: buffers });
    expect(out).toHaveLength(1);
    expect(out[0]?.x).toBe(42);
  });
});

describe('syncWorldView (Codex review round 6, finding P2)', () => {
  it("stops rendering a disconnected net client's last-known projectile and flag meshes instead of leaving them live forever", () => {
    // Codex review round 6, finding P2 (PR #9): NetClient never clears `projectiles`/`flags`
    // once the socket disconnects -- they still hold whatever the last snapshot decoded --
    // and syncWorldView used to read them off `net` unconditionally, regardless of connection
    // state. weapons-view.ts's/flag-view.ts's own mesh-pruning only removes a mesh whose id is
    // no longer in the *current* list, so with that list never changing after a disconnect,
    // a projectile or flag present at the moment of disconnect stayed in the scene forever.
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const scene = new THREE.Scene();
    const projectileMeshes = new Map<number, THREE.Mesh>();
    const previousProjectiles = new Map<number, ProjectileSnapshotData>();
    const flagMeshes = new Map<number, THREE.Group>();
    const effects: Effect[] = [];
    const seenEventSeq = { seq: 0 };
    const hud = { update: () => {} };
    const projectile: ProjectileSnapshotData = {
      id: 1,
      type: 0,
      weaponId: 0,
      x: 0,
      y: 1,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      ownerId: 0,
      armed: 1,
    };
    const flag: FlagSnapshotData = {
      id: 0,
      team: 1,
      state: 0,
      x: 0,
      y: 0,
      z: 0,
      carrierId: -1,
      returnInS: -1,
    };
    // `connected` is a read-only getter on the real NetClient (it derives from the
    // transport), so this is spelled as an explicit inline type rather than
    // `Pick<NetClient, ...>` -- same as the fakeNet in the updateRemotes test above -- to
    // keep it a plain, mutable boolean field this test can flip.
    const fakeNet: Pick<
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
    > & { connected: boolean } = {
      playerId: localId,
      team: 1,
      remotePlayers: new Map(),
      projectiles: [projectile],
      flags: [flag],
      teamScores: [0, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 0,
      gameOverReason: 0,
      recentEvents: [],
      connected: true,
    };

    syncWorldView(
      world,
      localId,
      fakeNet,
      scene,
      hud,
      effects,
      projectileMeshes,
      previousProjectiles,
      flagMeshes,
      seenEventSeq,
      1 / 60,
    );
    expect(projectileMeshes.size).toBe(1);
    expect(flagMeshes.size).toBe(1);

    // The socket drops; NetClient still holds the same last-decoded projectiles/flags.
    fakeNet.connected = false;
    syncWorldView(
      world,
      localId,
      fakeNet,
      scene,
      hud,
      effects,
      projectileMeshes,
      previousProjectiles,
      flagMeshes,
      seenEventSeq,
      1 / 60,
    );

    expect(projectileMeshes.size).toBe(0);
    expect(flagMeshes.size).toBe(0);
  });

  it('speaks a VoiceBindPlayed event for every client, including the one whose own action it was', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const scene = new THREE.Scene();
    const hud = { update: () => {} };
    const voiceEvent: TimestampedEvent = {
      type: MessageType.Event,
      seq: 1,
      kind: EventKind.VoiceBindPlayed,
      a: localId, // the speaker is the local player itself -- still gets spoken back.
      b: 4,
    };
    const fakeNet: Pick<
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
    > & { connected: boolean } = {
      playerId: localId,
      team: 1,
      remotePlayers: new Map(),
      projectiles: [],
      flags: [],
      teamScores: [0, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 0,
      gameOverReason: 0,
      recentEvents: [voiceEvent],
      connected: true,
    };

    const audio = { voice: vi.fn() } as unknown as import('./audio.js').AudioEngine;
    syncWorldView(
      world,
      localId,
      fakeNet,
      scene,
      hud,
      [],
      new Map(),
      new Map(),
      new Map(),
      { seq: 0 },
      1 / 60,
      audio,
    );

    expect(speakVoiceLine).toHaveBeenCalledWith(4, audio);
  });

  it('plays each network flag event once from the event stream', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const scene = new THREE.Scene();
    const hud = { update: vi.fn() };
    const fakeNet: Pick<
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
    > & { connected: boolean } = {
      playerId: localId,
      team: 1,
      remotePlayers: new Map(),
      projectiles: [],
      flags: [
        { id: 1, team: 1, state: FlagState.Home, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 },
      ],
      teamScores: [0, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 0,
      gameOverReason: 0,
      recentEvents: [
        { type: MessageType.Event, kind: EventKind.FlagTouched, a: localId, b: 1, seq: 1 },
        { type: MessageType.Event, kind: EventKind.FlagDropped, a: localId, b: 1, seq: 2 },
        { type: MessageType.Event, kind: EventKind.FlagCaptured, a: 1, b: localId, seq: 3 },
        { type: MessageType.Event, kind: EventKind.FlagCaptured, a: 2, b: localId, seq: 4 },
      ],
      connected: true,
    };
    const audio = {
      flagTouch: vi.fn(),
      flagDrop: vi.fn(),
      flagCapture: vi.fn(),
      flagReturn: vi.fn(),
      voice: vi.fn(),
    } as unknown as import('./audio.js').AudioEngine;
    const cursor = { seq: 0 };

    syncWorldView(
      world,
      localId,
      fakeNet,
      scene,
      hud,
      [],
      new Map(),
      new Map(),
      new Map(),
      cursor,
      1 / 60,
      audio,
    );
    syncWorldView(
      world,
      localId,
      fakeNet,
      scene,
      hud,
      [],
      new Map(),
      new Map(),
      new Map(),
      cursor,
      1 / 60,
      audio,
    );

    expect(audio.flagTouch).toHaveBeenCalledWith(true);
    expect(audio.flagDrop).toHaveBeenCalledTimes(1);
    expect(audio.flagCapture).toHaveBeenNthCalledWith(1, false);
    expect(audio.flagCapture).toHaveBeenNthCalledWith(2, true);
  });

  it('renders each networked impact exactly once, agreeing with the solo record path (#52)', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const scene = new THREE.Scene();
    const hud = { update: () => {} };
    const effects: Effect[] = [];
    const impact: ProjectileImpact = {
      x: 3,
      y: 1,
      z: 4,
      weaponId: WeaponId.Spinfusor,
      type: ProjectileType.Linear,
      reason: ProjectileImpactReason.Direct,
      seq: 1,
    };
    const fakeNet: Pick<
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
    > & { connected: boolean } = {
      playerId: localId,
      team: 1,
      remotePlayers: new Map(),
      projectiles: [],
      flags: [],
      teamScores: [0, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 0,
      gameOverReason: 0,
      recentEvents: [
        { type: MessageType.Event, kind: EventKind.ProjectileImpact, a: 0, b: -1, impact, seq: 1 },
      ],
      connected: true,
    };

    // Networked: the record arrives once in the event stream; a second drain over the same
    // rolling buffer (the usual frame loop) must not duplicate the effect.
    const cursor = { seq: 0 };
    syncWorldView(
      world,
      localId,
      fakeNet,
      scene,
      hud,
      effects,
      new Map(),
      new Map(),
      new Map(),
      cursor,
      1 / 60,
    );
    syncWorldView(
      world,
      localId,
      fakeNet,
      scene,
      hud,
      effects,
      new Map(),
      new Map(),
      new Map(),
      cursor,
      1 / 60,
    );

    // Solo: the same record drained straight from the sim's store renders identically.
    const soloEffects: Effect[] = [];
    const soloScene = new THREE.Scene();
    spawnProjectileImpacts(soloScene, soloEffects, [impact]);
    expect(soloEffects).toHaveLength(1);
    expect(soloEffects[0]?.mesh.position.x).toBe(effects[0]?.mesh.position.x);
    expect(soloEffects[0]?.mesh.position.z).toBe(effects[0]?.mesh.position.z);
  });
});

describe('playFlagStateAudio', () => {
  it('plays pickup, drop, and capture changes per solo simulation tick', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    const audio = {
      flagTouch: vi.fn(),
      flagDrop: vi.fn(),
      flagCapture: vi.fn(),
      flagReturn: vi.fn(),
    } as unknown as import('./audio.js').AudioEngine;

    let before = snapshotFlagAudioState(world);
    world.flags.state[1] = FlagState.Carried;
    world.flags.carrierId[1] = 3;
    playFlagStateAudio(audio, before, world);

    before = snapshotFlagAudioState(world);
    world.flags.state[1] = FlagState.Dropped;
    world.flags.carrierId[1] = -1;
    playFlagStateAudio(audio, before, world);

    before = snapshotFlagAudioState(world);
    world.flags.state[1] = FlagState.Carried;
    world.flags.carrierId[1] = 3;
    playFlagStateAudio(audio, before, world);
    before = snapshotFlagAudioState(world);
    world.flags.state[1] = FlagState.Home;
    world.flags.carrierId[1] = -1;
    playFlagStateAudio(audio, before, world);

    expect(audio.flagTouch).toHaveBeenNthCalledWith(1, false);
    expect(audio.flagTouch).toHaveBeenNthCalledWith(2, false);
    expect(audio.flagDrop).toHaveBeenCalledTimes(1);
    expect(audio.flagCapture).toHaveBeenCalledWith(false);
  });
});

describe('teleportPlayerToFlag', () => {
  it('moves the player to the given team flag current position', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: 1, y: 2, z: 3 } },
      { team: 2, position: { x: 4, y: 5, z: 6 } },
    ]);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });

    teleportPlayerToFlag(world, id, 2);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([4, 5, 6]);
  });

  it('reads the flag current position, not its stand, after it has moved', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 1, y: 2, z: 3 } }]);
    world.flags.position.set([9, 8, 7], 0); // flag 0 was picked up and dragged elsewhere
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });

    teleportPlayerToFlag(world, id, 1);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([9, 8, 7]);
  });

  it('is a no-op when no flag belongs to the requested team', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 1, y: 2, z: 3 } }]);
    const id = addPlayer(world, { x: 5, y: 5, z: 5 });

    teleportPlayerToFlag(world, id, 2);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([5, 5, 5]);
  });
});

describe('teleportPlayerToVehiclePad', () => {
  it("moves the player to the given team's vehicle pad position", () => {
    const world = createWorld(flat, 1, 8);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 1, y: 2, z: 3 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 2, position: { x: 4, y: 5, z: 6 } },
    ]);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });

    teleportPlayerToVehiclePad(world, id, 2);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([4, 5, 6]);
  });

  it('is a no-op when no vehicle pad belongs to the requested team', () => {
    const world = createWorld(flat, 1, 8);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 1, y: 2, z: 3 } },
    ]);
    const id = addPlayer(world, { x: 5, y: 5, z: 5 });

    teleportPlayerToVehiclePad(world, id, 2);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([5, 5, 5]);
  });
});

describe('debugKillGenerator / debugRepairGenerator', () => {
  it("debugKillGenerator destroys both of a team's generators; debugRepairGenerator revives one", () => {
    const world = createWorld(flat, 1, 8);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
    ]);
    stepPower(world);
    debugKillGenerator(world, 1);
    expect(world.baseObjects.powered[2]).toBe(0);
    debugRepairGenerator(world, 1);
    expect(world.baseObjects.powered[2]).toBe(1);
  });

  it("debugIsStationPowered reflects the team station's current powered bit", () => {
    const world = createWorld(flat, 1, 8);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    expect(debugIsStationPowered(world, 1)).toBe(true);
    debugKillGenerator(world, 1);
    expect(debugIsStationPowered(world, 1)).toBe(false);
  });
});

describe('stepSinglePlayer (Codex review round 4, finding 1)', () => {
  it('respawns a dead single-player once the timer elapses, instead of leaving them dead forever', () => {
    // Codex review round 4, finding 1 (PR #9): single-player has no server, and nothing else
    // called dueForRespawn/respawnPlayer the way packages/server/src/net.ts's own tick loop
    // does, so a single-player death never respawned even though the 5 s timer expired.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);

    const spawn = { x: 5, y: 0, z: 5 };
    stepSinglePlayer(world, id, IDLE_INPUT, RESPAWN_TICKS + 1, spawn);

    expect(world.players.alive[id]).toBe(1);
    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([5, 0, 5]);
  });

  it('leaves a player dead until their own respawn timer actually elapses', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);

    stepSinglePlayer(world, id, IDLE_INPUT, 1, { x: 5, y: 0, z: 5 });

    expect(world.players.alive[id]).toBe(0);
  });

  it('does not respawn a player once the match ends on the same step their respawn timer expires (Codex review round 5, finding 3)', () => {
    // Codex review round 5, finding 3 (PR #9): stepWorld can flip world.gameOver to true
    // DURING the very call that also makes a dead player's respawn timer due (the time
    // limit landing on the exact same tick as their respawn), and this loop's respawn
    // handling used to run unconditionally regardless of that -- the same class of bug
    // already fixed server-side in packages/server/src/net.ts's runOneTick (round 4,
    // finding 6). Without the guard, the match ends but the respawn logic still revives
    // the player into the now-frozen match.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
    expect(world.players.respawnAt[id]).toBe(RESPAWN_TICKS);

    // Force the time limit to land on the exact tick the respawn timer also expires.
    world.timeLimitTicks = RESPAWN_TICKS;

    const spawn = { x: 5, y: 0, z: 5 };
    stepSinglePlayer(world, id, IDLE_INPUT, RESPAWN_TICKS, spawn);

    expect(world.gameOver).toBe(true);
    expect(world.players.alive[id]).toBe(0);
    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).not.toEqual([5, 0, 5]);
  });
});

describe('setLocalGodMode (Codex review round 4, finding 5)', () => {
  it('sets the sim godMode flag directly', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);

    setLocalGodMode(world, id, true);
    expect(world.players.godMode[id]).toBe(1);

    setLocalGodMode(world, id, false);
    expect(world.players.godMode[id]).toBe(0);
  });

  it('is proactive: a lethal hit taken while it is on cannot drop a carried flag', () => {
    // Codex review round 4, finding 5 (PR #9): the old app.ts ran stepWorld first and only
    // afterward reactively zeroed damage and revived the player. stepWorld runs stepPlayers
    // -> stepWeapons -> stepProjectiles -> stepFlags in one synchronous pass, so a lethal hit
    // that reached applyDamage had already dropped a carried flag (stepFlags reacting to the
    // death recorded in world.pendingDeaths) before any post-hoc revive could undo it.
    // Calling setLocalGodMode up front, before the hit and the step that follows it, mirrors
    // the proactive fix: applyDamage no-ops before stepFlags ever sees a death.
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 100, y: 0, z: 0 } },
    ]);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    // Touch and carry team 2's flag.
    stepSinglePlayer(world, attacker, IDLE_INPUT, 1, { x: 100, y: 0, z: 0 });
    expect(world.flags.carrierId[1]).toBe(attacker);

    setLocalGodMode(world, attacker, true);
    applyDamage(world, attacker, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR); // would otherwise be lethal
    stepSinglePlayer(world, attacker, IDLE_INPUT, 1, { x: 100, y: 0, z: 0 });

    expect(world.players.alive[attacker]).toBe(1);
    expect(world.players.damage[attacker]).toBe(0);
    expect(world.flags.carrierId[1]).toBe(attacker); // never dropped
  });
});

describe('positionOfPlayer', () => {
  it('returns null when there is no net client (single-player has no remote roster)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    expect(positionOfPlayer(world, null, id)).toBeNull();
  });

  it('reads the local player from world state, not the remote roster', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    const net: Pick<NetClient, 'playerId' | 'remotePlayers'> = {
      playerId: id,
      remotePlayers: new Map(),
    };
    expect(positionOfPlayer(world, net, id)).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('reads a remote player from the net client roster', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const remote: PlayerSnapshotData = {
      id: 7,
      team: 2,
      x: 10,
      y: 11,
      z: 12,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      energy: 0,
      health: 0,
      weaponSlot: 0,
      onGround: 0,
      ski: 0,
      respawnSeq: 0,
      discAmmo: 0,
      chaingunAmmo: 0,
      mortarAmmo: 0,
      grenades: 0,
      weaponState: 1,
      weaponTimer: 0,
      spunUp: 0,
      grenadeCooldown: 0,
      score: 0,
      godMode: 0 as const,
      wasJumpHeld: 0 as const,
      armor: 0,
      hasRepairPack: 0 as const,
      hasEnergyPack: 0 as const,
      carriedWeapons: 0,
    };
    const net: Pick<NetClient, 'playerId' | 'remotePlayers'> = {
      playerId: localId,
      remotePlayers: new Map([[7, remote]]),
    };
    expect(positionOfPlayer(world, net, 7)).toEqual({ x: 10, y: 11, z: 12 });
  });

  it('returns null for an id absent from both the local slot and the remote roster', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const net: Pick<NetClient, 'playerId' | 'remotePlayers'> = {
      playerId: localId,
      remotePlayers: new Map(),
    };
    expect(positionOfPlayer(world, net, 99)).toBeNull();
  });
});

describe('hudSourceFrom', () => {
  it('derives single-player HUD state straight from the sim world when there is no net client', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 1, y: 2, z: 3 } }]);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.teamScores[1] = 2;
    world.teamScores[2] = 1;
    world.tick = 10;

    const source = hudSourceFrom(world, id, null);

    expect(source.teamScores).toEqual([2, 1]);
    expect(source.flags).toEqual(flagsFromWorld(world));
    expect(source.gameOver).toBe(world.gameOver);
    expect(source.winnerTeam).toBe(world.winnerTeam);
    expect(source.gameOverReason).toBe(world.gameOverReason);
    expect(source.recentEvents).toEqual([]);
    expect(source.timeRemainingS).toBeCloseTo((world.timeLimitTicks - world.tick) * FIXED_DT);
    // Single-player has no separate network identity: the sim's own player id is the real one.
    expect(source.networkPlayerId).toBe(id);
  });

  it('takes CTF and clock state from the net client when one is connected', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    const net: Pick<
      NetClient,
      | 'playerId'
      | 'teamScores'
      | 'flags'
      | 'gameOver'
      | 'winnerTeam'
      | 'timeRemainingS'
      | 'gameOverReason'
      | 'recentEvents'
    > = {
      playerId: 31,
      teamScores: [3, 4],
      flags: [],
      gameOver: true,
      winnerTeam: 2,
      timeRemainingS: 42,
      gameOverReason: GameOverReason.TimeLimit,
      recentEvents: [],
    };

    const source = hudSourceFrom(world, id, net);

    expect(source.teamScores).toBe(net.teamScores);
    expect(source.gameOver).toBe(true);
    expect(source.winnerTeam).toBe(2);
    expect(source.timeRemainingS).toBe(42);
    expect(source.gameOverReason).toBe(GameOverReason.TimeLimit);
    // Codex review round 5, finding 4 (PR #9): `playerId` (id, the local prediction slot)
    // must stay the world.players index, but the HUD's carrier-id comparison needs the
    // server-assigned id -- net.playerId -- which is very likely NOT 0 on a bot-filled dev
    // server. Both differ here (id is the world's own addPlayer id, 0; net.playerId is 31)
    // to prove hudSourceFrom does not conflate them.
    expect(source.playerId).toBe(id);
    expect(source.networkPlayerId).toBe(31);
  });
});

describe('drainNewEvents', () => {
  const event = (seq: number): TimestampedEvent => ({
    type: MessageType.Event,
    kind: EventKind.PlayerKilled,
    a: 0,
    b: seq,
    seq,
  });

  it('keeps returning newly arrived events after the rolling buffer evicts old ones', () => {
    // Codex review round 1, finding 14 (PR #9): netclient.ts's recentEvents evicts its
    // oldest entry past its own cap, so tracking "new since last frame" via a slice(index)
    // into that same mutating array desyncs forever once eviction starts -- the index no
    // longer lines up with any live position, and every later event silently stops
    // rendering. A seq-based cursor is immune, since seq is assigned once at receipt and
    // never reused or shifted by eviction.
    const cursor = { seq: 0 };
    // A rolling buffer capped at 3, standing in for netclient's real 100-event cap --
    // the property under test does not depend on the cap's size.
    let buffer: TimestampedEvent[] = [event(1), event(2), event(3), event(4), event(5)].slice(-3);

    const firstDrain = drainNewEvents(buffer, cursor);
    expect(firstDrain.map((e) => e.seq)).toEqual([3, 4, 5]);

    buffer = [...buffer, event(6), event(7)].slice(-3);
    const secondDrain = drainNewEvents(buffer, cursor);
    expect(secondDrain.map((e) => e.seq)).toEqual([6, 7]);
  });

  it('returns nothing new when no event has arrived since the last drain', () => {
    const cursor = { seq: 0 };
    const buffer = [event(1), event(2)];
    drainNewEvents(buffer, cursor);
    expect(drainNewEvents(buffer, cursor)).toEqual([]);
  });

  it('returns every event on the first drain when the cursor starts at zero', () => {
    const cursor = { seq: 0 };
    const buffer = [event(1), event(2), event(3)];
    expect(drainNewEvents(buffer, cursor).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

// Issue #51: every listed beam stop reason flips the view, the audio loop, and the feedback
// row off on the same frame -- driven through the app's own wiring function, so the gates
// here are the gates the game actually runs.
describe('syncRepairBeamView', () => {
  const aimingAt = (from: { x: number; z: number }, to: { x: number; z: number }): number =>
    Math.atan2(to.x - from.x, to.z - from.z);

  function wallAcrossX(height: number): Heightfield {
    const size = 11;
    const heights = new Uint16Array(size * size);
    for (let row = 0; row < size; row += 1) heights[row * size + 5] = height;
    return {
      gridSize: size,
      squareSize: 2,
      originX: -10,
      originY: 0,
      originZ: 0,
      heightScale: 1,
      heights,
    };
  }

  interface Harness {
    world: World;
    healer: number;
    hurt: number;
    view: { sync: Mock; dispose: Mock };
    audio: { setRepairBeam: Mock };
    feedback: { textContent: string; hidden: boolean };
  }

  /** One damaged teammate 5 m ahead of the healer, both holding the Repair Pack setup. */
  function harness(terrain: Heightfield = flat): Harness {
    const world = createWorld(terrain, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    return {
      world,
      healer,
      hurt,
      view: { sync: vi.fn(), dispose: vi.fn() },
      audio: { setRepairBeam: vi.fn() },
      feedback: { textContent: '', hidden: true },
    };
  }

  function frame(
    h: Harness,
    packActive: boolean,
    overrides: Partial<{ uiOpen: boolean; freeCam: boolean }> = {},
  ): RepairBeamFrame {
    return {
      world: h.world,
      playerId: h.healer,
      input: { ...IDLE_INPUT, packActive, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) },
      uiOpen: overrides.uiOpen ?? false,
      freeCam: overrides.freeCam ?? false,
    };
  }

  it('starts the beam, its audio loop, and the feedback row on a valid target', () => {
    const h = harness();
    syncRepairBeamView(frame(h, true), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenCalledWith(expect.objectContaining({ kind: 'player' }));
    expect(h.audio.setRepairBeam).toHaveBeenCalledWith(h.healer, true);
    expect(h.feedback.hidden).toBe(false);
    expect(h.feedback.textContent).toContain('REPAIRING Player');
    expect(h.feedback.textContent).toContain('ENERGY');
  });

  it('stops on release', () => {
    const h = harness();
    syncRepairBeamView(frame(h, true), h.view, h.audio, h.feedback);
    syncRepairBeamView(frame(h, false), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenLastCalledWith(null);
    expect(h.audio.setRepairBeam).toHaveBeenLastCalledWith(h.healer, false);
    expect(h.feedback.hidden).toBe(true);
    expect(h.feedback.textContent).toBe('');
  });

  it('stops when a menu opens', () => {
    const h = harness();
    syncRepairBeamView(frame(h, true, { uiOpen: true }), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenLastCalledWith(null);
    expect(h.audio.setRepairBeam).toHaveBeenLastCalledWith(h.healer, false);
  });

  it('stops in free cam', () => {
    const h = harness();
    syncRepairBeamView(frame(h, true, { freeCam: true }), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenLastCalledWith(null);
    expect(h.audio.setRepairBeam).toHaveBeenLastCalledWith(h.healer, false);
  });

  it('stops on death', () => {
    const h = harness();
    h.world.players.alive[h.healer] = 0;
    syncRepairBeamView(frame(h, true), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenLastCalledWith(null);
    expect(h.audio.setRepairBeam).toHaveBeenLastCalledWith(h.healer, false);
  });

  it('stops when the shared energy pool is depleted, naming the depletion', () => {
    const h = harness();
    h.world.players.energy[h.healer] = 0;
    syncRepairBeamView(frame(h, true), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenLastCalledWith(null);
    expect(h.audio.setRepairBeam).toHaveBeenLastCalledWith(h.healer, false);
    expect(h.feedback.textContent).toContain('ENERGY DEPLETED');
  });

  it('stops when the target leaves the 10 m beam range', () => {
    const h = harness();
    h.world.players.position[h.hurt * 3] = 11;
    syncRepairBeamView(frame(h, true), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenLastCalledWith(null);
    expect(h.audio.setRepairBeam).toHaveBeenLastCalledWith(h.healer, false);
    expect(h.feedback.textContent).toContain('NO TARGET');
  });

  it('stops when terrain occludes the beam', () => {
    const world = createWorld(wallAcrossX(10), 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 4, y: 1, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 2.5);
    const healer = addPlayer(world, { x: -4, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    const view = { sync: vi.fn(), dispose: vi.fn() };
    const audio = { setRepairBeam: vi.fn() };
    const feedback = { textContent: '', hidden: true };
    // Healer at -4 so the beam segment actually crosses the wall column at x=0; base
    // candidates enforce line of sight (repair.test.ts pins the same rule sim-side).
    syncRepairBeamView(
      {
        world,
        playerId: healer,
        input: { ...IDLE_INPUT, packActive: true, yaw: aimingAt({ x: -4, z: 0 }, { x: 4, z: 0 }) },
        uiOpen: false,
        freeCam: false,
      },
      view,
      audio,
      feedback,
    );
    expect(view.sync).toHaveBeenLastCalledWith(null);
    expect(audio.setRepairBeam).toHaveBeenLastCalledWith(healer, false);
  });

  it('never starts without the Repair Pack, even with the trigger held', () => {
    const h = harness();
    h.world.players.hasRepairPack[h.healer] = 0;
    syncRepairBeamView(frame(h, true), h.view, h.audio, h.feedback);
    expect(h.view.sync).toHaveBeenLastCalledWith(null);
    expect(h.audio.setRepairBeam).toHaveBeenLastCalledWith(h.healer, false);
    expect(h.feedback.hidden).toBe(true);
  });
});

describe('station loadout round trip (#55): request -> sim state -> HUD', () => {
  function stationHarness(): { world: World; player: number } {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    return { world, player };
  }

  it('an Energy Pack + narrowed weapons request lands in the sim and reads back on the HUD', () => {
    // Single-player path: app.ts's station menu Confirm calls applyLoadoutSelection
    // directly (no wire); hudSourceFrom is the same HUD feed the frame loop consumes.
    const { world, player } = stationHarness();
    const applied = applyLoadoutSelection(
      world,
      player,
      ArmorId.Light,
      PackId.Energy,
      (1 << WeaponId.Spinfusor) | (1 << WeaponId.Blaster),
    );
    expect(applied).toBe(true);
    expect(world.players.hasEnergyPack[player]).toBe(1);
    expect(world.players.hasRepairPack[player]).toBe(0);

    const rows = Object.fromEntries(
      describeHud(hudSourceFrom(world, player, null)).map((row) => [row.id, row.text]),
    );
    expect(rows['hud-pack']).toBe('Energy Pack');
    // The rack narrows to exactly the carried set.
    expect(carriedWeaponSlots(world, player)).toBe(
      (1 << WeaponId.Spinfusor) | (1 << WeaponId.Blaster),
    );
    // An uncarried weapon cannot fire: dry ammo, and the Laser Rifle is gone from the
    // legacy everyone-gets-infinite-ammo table.
    expect(world.players.ammo[ammoIndex(player, WeaponId.LaserRifle)]).toBe(0);
  });

  it('a Repair Pack request replaces the Energy Pack and the HUD row follows', () => {
    const { world, player } = stationHarness();
    applyLoadoutSelection(world, player, ArmorId.Heavy, PackId.Energy, 0);
    applyLoadoutSelection(world, player, ArmorId.Heavy, PackId.Repair, 0);
    expect(world.players.hasEnergyPack[player]).toBe(0);
    expect(world.players.hasRepairPack[player]).toBe(1);
    const rows = Object.fromEntries(
      describeHud(hudSourceFrom(world, player, null)).map((row) => [row.id, row.text]),
    );
    expect(rows['hud-pack']).toBe('Repair Pack');
  });
});

describe('playImpactAudio (#52 residual)', () => {
  const record = (seq: number): ProjectileImpact => ({
    x: 3,
    y: 1,
    z: 4,
    weaponId: WeaponId.Spinfusor,
    type: ProjectileType.Linear,
    reason: ProjectileImpactReason.Direct,
    seq,
  });

  it('plays one projectileImpact cue per record, in arrival order', () => {
    const projectileImpact = vi.fn();
    const audio = { projectileImpact } as unknown as AudioEngine;
    playImpactAudio(audio, [record(1), record(2)]);
    expect(projectileImpact).toHaveBeenCalledTimes(2);
    expect(projectileImpact).toHaveBeenNthCalledWith(1, record(1));
    expect(projectileImpact).toHaveBeenNthCalledWith(2, record(2));
  });

  it('is a safe no-op without an engine', () => {
    expect(() => playImpactAudio(undefined, [record(1)])).not.toThrow();
  });
});

/** Fresh per call so no test shares a frozen record object by accident. */
function recordOf(seq: number): ProjectileImpact {
  return {
    x: 3,
    y: 1,
    z: 4,
    weaponId: WeaponId.Spinfusor,
    type: ProjectileType.Linear,
    reason: ProjectileImpactReason.Direct,
    seq,
  };
}

describe('networked impact audio (#52 residual)', () => {
  it('cues each impact record exactly once and never on the disappearance of its projectile', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const projectile: ProjectileSnapshotData = {
      id: 7,
      type: ProjectileType.Linear,
      weaponId: WeaponId.Spinfusor,
      x: 3,
      y: 1,
      z: 4,
      vx: 0,
      vy: 0,
      vz: -1,
      ownerId: localId,
      armed: 1,
    };
    const impact = recordOf(1);
    const setProjectileSound = vi.fn();
    const projectileImpact = vi.fn();
    const audio = { setProjectileSound, projectileImpact } as unknown as AudioEngine;
    const fakeNet: Pick<
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
    > & { connected: boolean } = {
      playerId: localId,
      team: 1,
      remotePlayers: new Map(),
      projectiles: [projectile],
      flags: [],
      teamScores: [0, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 0,
      gameOverReason: 0,
      recentEvents: [
        { type: MessageType.Event, kind: EventKind.ProjectileImpact, a: 0, b: -1, impact, seq: 1 },
      ],
      connected: true,
    };
    // The cursor, scene, and previousProjectiles map persist across frames like the real
    // app's -- the disappearance diff reads exactly that map, so a fresh-per-frame one
    // would never see the shot vanish.
    const cursor = { seq: 0 };
    const previousProjectiles = new Map<number, ProjectileSnapshotData>();
    const frame = () =>
      syncWorldView(
        world,
        localId,
        fakeNet,
        new THREE.Scene(),
        { update: () => {} },
        [],
        new Map(),
        previousProjectiles,
        new Map(),
        cursor,
        1 / 60,
        audio,
      );

    // Frame 1: the shot is live and its impact record arrives the same frame (a fast
    // close-range hit: born, struck, freed between snapshots).
    frame();
    expect(projectileImpact).toHaveBeenCalledTimes(1);
    expect(projectileImpact).toHaveBeenCalledWith(impact);
    // Frame 2: the same rolling event buffer (drained dry) and the shot now gone from the
    // snapshot list. The old disappearance path fired a SECOND impact cue here; the travel
    // loop must stop, but no cue may play.
    fakeNet.projectiles = [];
    frame();
    expect(projectileImpact).toHaveBeenCalledTimes(1);
    expect(setProjectileSound).toHaveBeenCalledWith(
      7,
      WeaponId.Spinfusor,
      ProjectileType.Linear,
      projectile,
      false,
    );
  });

  it('stops the travel loop when the socket drops while a shot is still live', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const projectile: ProjectileSnapshotData = {
      id: 9,
      type: ProjectileType.Grenade,
      weaponId: WeaponId.Mortar,
      x: 1,
      y: 2,
      z: 3,
      vx: 0,
      vy: 0,
      vz: -1,
      ownerId: -1,
      armed: 0,
    };
    const setProjectileSound = vi.fn();
    const projectileImpact = vi.fn();
    const audio = { setProjectileSound, projectileImpact } as unknown as AudioEngine;
    const fakeNet: Pick<
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
    > & { connected: boolean } = {
      playerId: localId,
      team: 1,
      remotePlayers: new Map(),
      projectiles: [projectile],
      flags: [],
      teamScores: [0, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 0,
      gameOverReason: 0,
      recentEvents: [],
      connected: true,
    };
    const previousProjectiles = new Map<number, ProjectileSnapshotData>();
    const cursor = { seq: 0 };
    const frame = () =>
      syncWorldView(
        world,
        localId,
        fakeNet,
        new THREE.Scene(),
        { update: () => {} },
        [],
        new Map(),
        previousProjectiles,
        new Map(),
        cursor,
        1 / 60,
        audio,
      );
    frame();
    expect(setProjectileSound).toHaveBeenCalledWith(
      9,
      WeaponId.Mortar,
      ProjectileType.Grenade,
      projectile,
      true,
    );
    // The socket drops: the last snapshot's shots are a stale shell, so the travel loop
    // stops (and no impact cue fires -- nothing struck anything).
    fakeNet.connected = false;
    frame();
    expect(setProjectileSound).toHaveBeenLastCalledWith(
      9,
      WeaponId.Mortar,
      ProjectileType.Grenade,
      projectile,
      false,
    );
    expect(projectileImpact).not.toHaveBeenCalled();
  });
});

describe('movement audio lifecycle (#56)', () => {
  function movementHarness() {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.alive[id] = 1;
    world.players.energy[id] = 50;
    const setJetting = vi.fn();
    const setSkiing = vi.fn();
    const footstep = vi.fn();
    const audio = { setJetting, setSkiing, footstep } as unknown as AudioEngine;
    return { world, id, setJetting, setSkiing, footstep, audio };
  }

  it('runs the jet loop while the input is held', () => {
    const h = movementHarness();
    updateMovementAudio(h.world, h.id, h.audio, true, { timer: 0 }, 1 / 60);
    expect(h.setJetting).toHaveBeenCalledWith(h.id, true, expect.any(Number));
  });

  it('stops the jet loop when the jet input releases', () => {
    const h = movementHarness();
    updateMovementAudio(h.world, h.id, h.audio, true, { timer: 0 }, 1 / 60);
    updateMovementAudio(h.world, h.id, h.audio, false, { timer: 0 }, 1 / 60);
    expect(h.setJetting).toHaveBeenLastCalledWith(h.id, false, expect.any(Number));
  });

  it('stops the jet and ski loops and resets the footstep cadence on death', () => {
    const h = movementHarness();
    updateMovementAudio(h.world, h.id, h.audio, true, { timer: 0.3 }, 1 / 60);
    h.world.players.alive[h.id] = 0;
    updateMovementAudio(h.world, h.id, h.audio, true, { timer: 0.3 }, 1 / 60);
    expect(h.setJetting).toHaveBeenLastCalledWith(h.id, false, 0);
    expect(h.setSkiing).toHaveBeenLastCalledWith(h.id, false, 0);
    expect(h.footstep).not.toHaveBeenCalled();
  });

  it('carries the player armor on the footstep cue for the variant table', () => {
    const h = movementHarness();
    h.world.players.onGround[h.id] = 1;
    h.world.players.armor[h.id] = ArmorId.Medium;
    h.world.players.velocity[h.id * 3] = 5;
    updateFootstepAudio(h.world, h.id, h.audio, false, 5, { timer: 0.34 }, 0.02);
    expect(h.footstep).toHaveBeenCalledTimes(1);
    expect(h.footstep).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, { armor: ArmorId.Medium });
  });
});

describe('world-derived loop lifecycle (#56): disconnect, power loss, destruction', () => {
  function humHarness() {
    const world = createWorld(flat, 1, 8);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 4, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 8, y: 0, z: 0 } },
    ]);
    const setGeneratorHum = vi.fn();
    const setStationHum = vi.fn();
    const audio = { setGeneratorHum, setStationHum } as unknown as AudioEngine;
    return { world, setGeneratorHum, setStationHum, audio };
  }

  it('keeps hums sounding while connected and powered', () => {
    const h = humHarness();
    updateStationHumAudio(h.world, h.audio, true);
    expect(h.setGeneratorHum).toHaveBeenCalledWith(0, { x: 4, y: 0, z: 0 }, true);
    expect(h.setStationHum).toHaveBeenCalledWith(1, { x: 8, y: 0, z: 0 }, true);
  });

  it('stops every hum loop when the client disconnects', () => {
    const h = humHarness();
    updateStationHumAudio(h.world, h.audio, true);
    updateStationHumAudio(h.world, h.audio, false);
    expect(h.setGeneratorHum).toHaveBeenLastCalledWith(0, { x: 4, y: 0, z: 0 }, false);
    expect(h.setStationHum).toHaveBeenLastCalledWith(1, { x: 8, y: 0, z: 0 }, false);
  });

  it('stops a generator hum on power loss while still connected', () => {
    const h = humHarness();
    h.world.baseObjects.powered[0] = 0;
    updateStationHumAudio(h.world, h.audio, true);
    expect(h.setGeneratorHum).toHaveBeenLastCalledWith(0, { x: 4, y: 0, z: 0 }, false);
    // The station, powered by its own intact generator, keeps singing.
    expect(h.setStationHum).toHaveBeenLastCalledWith(1, { x: 8, y: 0, z: 0 }, true);
  });

  function vehicleHarness() {
    const world = createWorld(flat, 1, 8);
    world.vehicles.count = 1;
    world.vehicles.active[0] = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.spawnTime[0] = 0;
    world.vehicles.position.set([10, 20, 30], 0);
    const setVehicleEngine = vi.fn();
    const audio = { setVehicleEngine } as unknown as AudioEngine;
    return { world, setVehicleEngine, audio };
  }

  it('keeps a live vehicle engine running while connected', () => {
    const h = vehicleHarness();
    updateVehicleEngineAudio(h.world, h.audio, new Map(), true);
    expect(h.setVehicleEngine).toHaveBeenCalledWith(0, 'shrike', { x: 10, y: 20, z: 30 }, true);
  });

  it('stops a vehicle engine loop when its vehicle is destroyed', () => {
    const h = vehicleHarness();
    h.world.vehicles.destroyed[0] = 1;
    const previous = new Map([[0, 'shrike' as const]]);
    updateVehicleEngineAudio(h.world, h.audio, previous, true);
    expect(h.setVehicleEngine).toHaveBeenCalledWith(0, 'shrike', { x: 0, y: 0, z: 0 }, false);
    expect(previous.size).toBe(0);
  });

  it('stops every vehicle engine loop when the client disconnects', () => {
    const h = vehicleHarness();
    const previous = new Map([[0, 'shrike' as const]]);
    updateVehicleEngineAudio(h.world, h.audio, previous, false);
    expect(h.setVehicleEngine).toHaveBeenCalledWith(0, 'shrike', { x: 0, y: 0, z: 0 }, false);
    expect(previous.size).toBe(0);
  });
});
