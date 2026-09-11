import net from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPlayer,
  BaseObjectKind,
  buildInteriorCollider,
  createBaseObjects,
  createFlags,
  createWorld,
  FIXED_DT,
  FlagState,
  LIGHT_ARMOR,
  ProjectileImpactReason,
  ProjectileType,
  spawnVehicleAtPad,
  stepPower,
  VehicleKind,
  WeaponId,
  WeaponState,
  type Heightfield,
  type PlayerInput,
  type World,
} from '@clans/sim';
import {
  decodeEvent,
  decodeSnapshot,
  decodeWelcome,
  encodeAck,
  encodeCommandOrder,
  encodeInput,
  encodeJoin,
  encodeLoadout,
  encodeVehicleSpawn,
  encodeVoiceBind,
  EventKind,
  MessageType,
  OrderKind,
  PROTOCOL_VERSION,
  VOICE_LINE_COUNT,
  WelcomeStatus,
  type NetInputSample,
} from '@clans/protocol';
import { buildWaypointGraph } from '@clans/bots';
import { createBotManager, TARGET_TEAM_SIZE, type BotManager } from './bots.js';
import { buildExtras, flagEvents, startNetServer, type NetServer } from './net.js';
import { DISTANT_PLAYER_UPDATE_EVERY } from './snapshot-policy.js';
import { createOrderBoard, currentOrder } from './orders.js';
import { teamCount, type SceneSpawn } from './world.js';

/** A bot manager with zero budget: every net.ts test in this file that doesn't care
 *  about bots gets one of these, so rebalanceTeams (called from handleJoin/handleClose)
 *  is a true no-op -- no bot ever added or removed -- without coupling every test's own
 *  world/spawns fixture to bots.ts. Bot-aware behavior itself is tested in bots.test.ts,
 *  and net.ts's own dedicated bot-wiring tests below. */
function emptyBotManager(): BotManager {
  return {
    botIds: new Set(),
    runtimes: new Map(),
    graph: buildWaypointGraph([]),
    maxBots: 0,
    teamSize: TARGET_TEAM_SIZE,
    nextSeed: 0,
  };
}

const idleSample: PlayerInput = {
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

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const spawns: SceneSpawn[] = [
  { name: null, team: 1, position: [0, 0, 0], radius: 5 },
  { name: null, team: 2, position: [1, 0, 1], radius: 5 },
];
const TEST_PORT = 17722;

function receive(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) =>
    socket.once('message', (data) => resolve(new Uint8Array(data as Uint8Array))),
  );
}
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    socket.once('open', () => resolve(socket));
  });
}

describe('flagEvents', () => {
  it('broadcasts authoritative drop and capture transitions alongside flag pickup', () => {
    const world = createWorld(terrain, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 0 } },
    ]);

    world.flags.state[1] = FlagState.Carried;
    world.flags.carrierId[1] = 4;
    expect(
      flagEvents(world, [
        { state: FlagState.Home, carrierId: -1 },
        { state: FlagState.Home, carrierId: -1 },
      ]),
    ).toEqual([{ type: MessageType.Event, kind: EventKind.FlagTouched, a: 4, b: 1 }]);

    world.flags.state[1] = FlagState.Dropped;
    world.flags.carrierId[1] = -1;
    expect(
      flagEvents(world, [
        { state: FlagState.Home, carrierId: -1 },
        { state: FlagState.Carried, carrierId: 4 },
      ]),
    ).toEqual([{ type: MessageType.Event, kind: EventKind.FlagDropped, a: 4, b: 1 }]);

    world.flags.state[1] = FlagState.Home;
    expect(
      flagEvents(world, [
        { state: FlagState.Home, carrierId: -1 },
        { state: FlagState.Carried, carrierId: 4 },
      ]),
    ).toEqual([{ type: MessageType.Event, kind: EventKind.FlagCaptured, a: 1, b: 4 }]);
  });
});
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startNetServer', () => {
  let server: NetServer;
  let world: World;

  beforeEach(async () => {
    world = createWorld(terrain, 1, 8);
    server = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT,
    });
    await server.ready;
  });
  afterEach(() => server.close());

  it('closes a rejected join immediately when the spawn area has no ground', async () => {
    world.terrain = { ...world.terrain, emptySquares: new Set([0]) };
    const client = await connect(TEST_PORT);
    const closed = new Promise<boolean>((resolve) => client.once('close', () => resolve(true)));
    client.send(encodeJoin());
    expect(await Promise.race([closed, wait(250).then(() => false)])).toBe(true);
    expect(world.players.count).toBe(0);
  });

  it('welcomes a joining client with a player id and a team', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.type).toBe(MessageType.Welcome);
    expect([1, 2]).toContain(welcome.team);
    client.close();
  });

  it('sends a full snapshot first, then a delta once the client has acked', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const firstPromise = receive(client);
    server.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    expect(first.baselineId).toBe(0);

    client.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(10);
    const secondPromise = receive(client);
    server.tick(4);
    const second = decodeSnapshot(await secondPromise, {
      snapshotId: first.snapshotId,
      players: first.players,
    });
    expect(second.baselineId).toBe(first.snapshotId);
    client.close();
  });

  it('never deltas against a snapshot the client did not ack', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const firstPromise = receive(client);
    server.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    client.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(10);

    // Snapshot two is "lost": the client never acks it.
    const secondPromise = receive(client);
    server.tick(4);
    await secondPromise;

    const thirdPromise = receive(client);
    server.tick(6);
    const third = decodeSnapshot(await thirdPromise, {
      snapshotId: first.snapshotId,
      players: first.players,
    });
    expect(third.baselineId).toBe(first.snapshotId);
    client.close();
  });

  it('gives a mid-match joiner a full snapshot and the smaller team', async () => {
    const early = await connect(TEST_PORT);
    const earlyWelcomePromise = receive(early);
    early.send(encodeJoin());
    const earlyWelcome = decodeWelcome(await earlyWelcomePromise);
    const earlyFirst = receive(early);
    server.tick(2);
    await earlyFirst;

    const late = await connect(TEST_PORT);
    const lateWelcomePromise = receive(late);
    late.send(encodeJoin());
    const lateWelcome = decodeWelcome(await lateWelcomePromise);
    expect(lateWelcome.team).not.toBe(earlyWelcome.team);

    const snapshotPromise = receive(late);
    server.tick(4);
    const snapshot = decodeSnapshot(await snapshotPromise, null);
    expect(snapshot.baselineId).toBe(0);
    expect(snapshot.players).toHaveLength(2);
    early.close();
    late.close();
  });

  it('ignores a duplicate Join on an already-joined socket instead of leaking a second player slot', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;
    client.send(encodeJoin()); // duplicate: must be ignored, not spawn a second player

    await wait(10);
    const snapshotPromise = receive(client);
    server.tick(2);
    const snapshot = decodeSnapshot(await snapshotPromise, null);
    expect(snapshot.players).toHaveLength(1);
    client.close();
  });

  it('survives a malformed frame instead of crashing the shared tick loop', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    // Too short to hold the fixed Input payload the codec expects.
    client.send(Uint8Array.of(MessageType.Input));
    await wait(10);

    // The server must still be alive and answering normally afterward.
    const snapshotPromise = receive(client);
    server.tick(2);
    const snapshot = decodeSnapshot(await snapshotPromise, null);
    expect(snapshot.players).toHaveLength(1);
    client.close();
  });

  it('drops a non-finite input sample instead of poisoning the authoritative player state', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);

    client.send(
      encodeInput({
        sequence: 1,
        samples: [
          {
            moveX: Number.NaN,
            moveZ: 1,
            yaw: 0,
            pitch: 0,
            jump: false,
            jet: false,
            fire: false,
            altFire: false,
            slot: 0,
            packActive: false,
            use: false,
          },
          idleSample,
          idleSample,
        ],
      }),
    );
    await wait(10);
    server.tick(2);
    const base = welcome.playerId * 3;
    expect(Number.isFinite(world.players.position[base])).toBe(true);
    expect(Number.isFinite(world.players.velocity[base])).toBe(true);
  });

  it('applies each queued redundant sample to its own tick instead of the newest overwriting the rest', async () => {
    // Codex round 1 (PR #4): handleInput wrote every sample an Input message resolved to
    // into the same map entry, so a message that caught up 2 missed ticks left only its
    // newest sample surviving before either tick ran. The middle sample (a forward run)
    // must show up as its own tick's velocity, not get overwritten before any tick sees it.
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    const base = welcome.playerId * 3;

    // spawnPointFor raises a spawn 0.1 m above the sampled terrain (see server/world.ts),
    // so the player starts just barely airborne and classify() won't grant run steering
    // until gravity closes that gap and a tick lands exactly on the ground. Nobody is
    // listening for these snapshots, so ticking idle here doesn't disturb the sequence
    // catch-up this test actually exercises below.
    for (let i = 0; i < 3; i += 1) server.tick(100 + i);

    // First message: nothing to catch up from yet, only the newest sample applies.
    client.send(encodeInput({ sequence: 1, samples: [idleSample, idleSample, idleSample] }));
    await wait(10);
    server.tick(2);

    // Second message covers ticks 2 and 3: samples are [newest=tick3, tick2, tick1(unused)].
    const forward: PlayerInput = {
      moveX: 0,
      moveZ: 1,
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
    client.send(encodeInput({ sequence: 3, samples: [idleSample, forward, idleSample] }));
    await wait(10);
    server.tick(4); // dequeues the forward sample queued for this tick
    const afterForward = world.players.velocity[base + 2] ?? 0;
    server.tick(6); // dequeues the idle sample queued for the next tick
    const afterIdle = world.players.velocity[base + 2] ?? 0;

    expect(afterForward).toBeGreaterThan(0);
    expect(afterIdle).toBeLessThan(afterForward);
    client.close();
  });

  it('keeps every queued sample through a burst larger than the old backlog cap of eight', async () => {
    // Codex round 9 (PR #4): MAX_PENDING_INPUTS reused SNAPSHOT_HISTORY_DEPTH (8), an
    // unrelated constant. A burst of more than 8 Input messages arriving before a single
    // tick drained any of them evicted the oldest queued samples here, even though
    // applyInputMessage had already advanced session.lastAppliedSequence past them:
    // marked "applied" but never simulated, and unrecoverable by any later message's
    // redundant catch-up window (which only ever covers the 2 most recent ticks).
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    const base = welcome.playerId * 3;

    // Settle onto the ground first (see the note two tests up) so a forward sample
    // actually produces velocity once it is finally simulated.
    for (let i = 0; i < 3; i += 1) server.tick(200 + i);

    // 12 messages, each advancing the sequence by exactly one, arrive before any tick
    // drains the queue: a burst comfortably larger than the old cap of 8.
    const forward: PlayerInput = {
      moveX: 0,
      moveZ: 1,
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
    client.send(encodeInput({ sequence: 1, samples: [forward, idleSample, idleSample] }));
    for (let sequence = 2; sequence <= 12; sequence += 1) {
      client.send(encodeInput({ sequence, samples: [idleSample, idleSample, idleSample] }));
    }
    await wait(20);

    server.tick(210); // dequeues the oldest queued sample: sequence 1's forward input
    expect(world.players.velocity[base + 2] ?? 0).toBeGreaterThan(0);
    client.close();
  });

  it('ignores a forged ack for a snapshot the server never sent, instead of permanently forcing full snapshots', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const firstPromise = receive(client);
    server.tick(2);
    const first = decodeSnapshot(await firstPromise, null);

    // A forged ack for an id the server never sent must not become the acked baseline.
    client.send(encodeAck({ snapshotId: 0xffffffff }));
    await wait(10);
    client.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(10);

    const secondPromise = receive(client);
    server.tick(4);
    const second = decodeSnapshot(await secondPromise, {
      snapshotId: first.snapshotId,
      players: first.players,
    });
    expect(second.baselineId).toBe(first.snapshotId);
    client.close();
  });

  it('reports lastInputSequence as what was simulated, not merely queued', async () => {
    // Codex round 2 (PR #4): applyInputMessage advances the session's sequence the
    // instant a message is parsed, but a message that queues 2 samples only gets one of
    // them simulated per tick. Reporting the parse-time sequence in a snapshot tells the
    // client an input was applied a tick before it actually was, so the client drops it
    // from replay early and permanently diverges from the server by that one input.
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeInput({ sequence: 1, samples: [idleSample, idleSample, idleSample] }));
    await wait(10);
    server.tick(2); // simulates sequence 1

    // Queues sequence 2 and 3; only sequence 2 will be simulated by the very next tick.
    const forward: PlayerInput = {
      moveX: 0,
      moveZ: 1,
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
    client.send(encodeInput({ sequence: 3, samples: [idleSample, forward, idleSample] }));
    await wait(10);

    const snapshotPromise = receive(client);
    server.tick(4); // simulates only sequence 2; sequence 3 is still queued
    const snapshot = decodeSnapshot(await snapshotPromise, null);
    expect(snapshot.lastInputSequence).toBe(2);
    client.close();
  });

  it("reports the post-step world tick in a snapshot, not the loop's pre-step tick argument", async () => {
    // Issue #6: stepWorld increments world.tick as its last action, but sendSnapshot was
    // passed the tick loop's own tickNumber parameter (the pre-step value) instead of
    // options.world.tick. hashWorld mixes world.tick into its hash for desync detection,
    // so a client that restores its tick from the snapshot ends up permanently offset by
    // one from the server, even though the simulated state itself is identical.
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const firstPromise = receive(client);
    server.tick(0);
    const first = decodeSnapshot(await firstPromise, null);
    expect(first.tick).toBe(world.tick);
    client.close();
  });

  it('drops a carried flag on disconnect instead of leaving it stuck on the removed player forever', async () => {
    // Codex PR #9 review, finding 2 (P1): handleClose removed the disconnecting player
    // but never dropped any flag they were carrying. Flag drops only ever ran off
    // world.pendingDeaths (stepFlags's dropCarriedFlagsOnDeath), and a disconnect never
    // populated it, so the flag stayed Carried forever, attached to a player id that no
    // longer existed, with no return timer running -- permanently stuck for the match.
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 8 } },
    ]);
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    const carrierId = welcome.playerId;
    const enemyFlagId = welcome.team === 1 ? 1 : 0;

    world.players.position.set([5, 0, 5], carrierId * 3);
    world.flags.state[enemyFlagId] = FlagState.Carried;
    world.flags.carrierId[enemyFlagId] = carrierId;
    world.flags.returnAt[enemyFlagId] = -1;

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.close();
    await closed;
    await wait(20);

    expect(world.players.active[carrierId]).toBe(0);
    expect(world.flags.state[enemyFlagId]).not.toBe(FlagState.Carried);
    expect(world.flags.carrierId[enemyFlagId]).toBe(-1);
    expect(world.flags.returnAt[enemyFlagId]).toBeGreaterThanOrEqual(world.tick);
  });

  it('rejects a bind failure through `ready` instead of hanging or crashing unhandled', async () => {
    const busy = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: createWorld(terrain, 1, 4),
      spawns,
      port: TEST_PORT,
    });
    await expect(busy.ready).rejects.toThrow();
    busy.close();
  });

  it('survives a malformed raw WebSocket frame instead of an unhandled socket error crashing the server', async () => {
    // Codex round 3 (PR #4): an invalid frame at the WebSocket protocol level itself (an
    // unmasked client-to-server frame) fires 'error' on the socket before 'message' ever
    // sees it. With no per-socket 'error' listener, ws's default is to throw, which
    // crashes the process -- a class the application-level try/catch around handleMessage
    // never covers, since it only wraps decoded application messages.
    const raw = net.createConnection(TEST_PORT, '127.0.0.1');
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    // The canonical RFC 6455 example key, so ws's handshake validation accepts it.
    raw.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${String(TEST_PORT)}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise<void>((resolve) => raw.once('data', () => resolve()));
    raw.write(Buffer.from([0x82, 0x01, 0xff])); // unmasked frame from a client: invalid
    await wait(50);
    raw.destroy();

    // The server must still be alive and able to serve a normal client afterward.
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await expect(welcomePromise).resolves.toBeDefined();
    client.close();
  });

  it('closes connected clients and frees their player slots on shutdown', async () => {
    // Codex round 4 (PR #4): close() only called wss.close(), which stops accepting new
    // connections but leaves sockets already connected alone. A client stayed OPEN and
    // its player slot stayed active until it happened to disconnect on its own, which
    // can hang a caller waiting for a clean shutdown.
    const port = TEST_PORT + 1;
    const shutdownWorld = createWorld(terrain, 1, 8);
    const shutdownServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: shutdownWorld,
      spawns,
      port,
    });
    await shutdownServer.ready;

    const client = await connect(port);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;
    expect(shutdownWorld.players.count).toBe(1);

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    shutdownServer.close();
    await closed;
    await wait(20);
    expect(shutdownWorld.players.active[0]).toBe(0);
  });

  it('closes an accepted socket that never sent Join, not just joined ones', async () => {
    // Codex round 5 (PR #4): `clients` is only populated inside handleJoin, so closing
    // just clients.values() left an accepted-but-unjoined socket open indefinitely.
    const port = TEST_PORT + 2;
    const unjoinedServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: createWorld(terrain, 1, 8),
      spawns,
      port,
    });
    await unjoinedServer.ready;

    const client = await connect(port); // connects, but never sends Join
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    unjoinedServer.close();
    await expect(closed).resolves.toBeUndefined();
  });

  it('closes the socket instead of hanging when a Join arrives at a full world', async () => {
    // Codex round 7 (PR #4): addPlayer throws RangeError once world capacity is
    // exhausted, before handleJoin registers the socket in `clients` or sends a Welcome.
    // handleMessage's outer try/catch swallowed that silently, so the socket stayed open
    // forever with the client waiting for a Welcome that would never arrive.
    const port = TEST_PORT + 3;
    const fullWorld = createWorld(terrain, 1, 1);
    const fullServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: fullWorld,
      spawns,
      port,
    });
    await fullServer.ready;

    const first = await connect(port);
    const firstWelcome = receive(first);
    first.send(encodeJoin());
    await firstWelcome;
    expect(fullWorld.players.count).toBe(1);

    const second = await connect(port);
    const closed = new Promise<void>((resolve) => second.once('close', () => resolve()));
    second.send(encodeJoin());
    await expect(closed).resolves.toBeUndefined();

    first.close();
    fullServer.close();
  });

  it('closes a socket that never sends Join once the join timeout elapses', async () => {
    // Codex round 8 (PR #4): an accepted socket that never sent Join stayed open
    // indefinitely; only the peer's own close removed anything. Repeating this can
    // exhaust sockets and memory one connection at a time.
    const port = TEST_PORT + 4;
    const timeoutServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: createWorld(terrain, 1, 8),
      spawns,
      port,
      joinTimeoutMs: 20,
    });
    await timeoutServer.ready;

    const client = await connect(port); // connects, but never sends Join
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await expect(closed).resolves.toBeUndefined();
    timeoutServer.close();
  });

  it('does not close a socket that joined before its join timeout elapses', async () => {
    const port = TEST_PORT + 5;
    const timeoutServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: createWorld(terrain, 1, 8),
      spawns,
      port,
      joinTimeoutMs: 20,
    });
    await timeoutServer.ready;

    const client = await connect(port);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;
    await wait(60); // well past the join timeout

    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
    timeoutServer.close();
  });

  it("a fired disc drops a bot target's health (headless disc-kill test)", async () => {
    const targetId = addPlayer(world, { x: 0, y: 0, z: 20 }, 2);
    const shooter = await connect(TEST_PORT);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    const fire: NetInputSample = {
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      pitch: 0,
      jump: false,
      jet: false,
      fire: true,
      altFire: false,
      slot: 1,
      packActive: false,
      use: false,
    };
    shooter.send(encodeInput({ sequence: 1, samples: [fire, fire, fire] }));
    await wait(20);
    for (let tickNumber = 2; tickNumber < 30; tickNumber += 1) server.tick(tickNumber);

    expect(world.players.damage[targetId]).toBeGreaterThan(0);
    shooter.close();
  });

  it('lag compensation: a 150ms-ping shooter still hits a target that has since moved away', async () => {
    let clock = 0;
    const lagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 1,
      now: () => clock,
    });
    await lagServer.ready;
    const targetId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    const shooter = await connect(TEST_PORT + 1);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    // Establish a 150ms ping: send a snapshot, ack it 150ms of server-clock time later.
    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    // Walk the target across the shot line for a few ticks (recorded into lag-comp history),
    // then jump it far away right before the shot — the laggy shooter's screen still shows
    // it in the old spot. Codex review round 16, finding 2: the rewind amount is half the
    // measured round-trip time (one-way latency), not the whole RTT, so the "still on the
    // line" history sample the rewind needs to reach must sit within that shorter window —
    // moved here to right before the firing tick itself, rather than several ticks earlier.
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], targetId * 3);
      lagServer.tick(3 + step);
    }

    // Slot 4 is the Laser Rifle: the sim's only true same-tick hitscan (WEAPON_DATA's
    // projectile: null resolves inside the same stepWorld call). The Chaingun (slot 2) is
    // also in HITSCAN_WEAPONS for rewind purposes, but it fires a Tracer projectile, and
    // projectiles.ts's stepProjectiles has a documented one-tick spawn latency: a shot
    // fired this tick isn't moved or collision-checked until the *next* stepProjectiles
    // call, by which point restorePositions has already undone this tick's rewind. Net.ts
    // cannot paper over that without calling stepProjectiles directly, which the plan's
    // Global Constraints forbid (stepWorld is sim's only public entry point) — so this test
    // exercises the rewind/restore mechanism with the weapon that actually resolves within
    // the tick it fires.
    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    lagServer.tick(20); // applies the Laser Rifle slot switch only, still Ready, no shot yet
    world.players.position.set([500, 0, 500], targetId * 3); // jumps away right before firing

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // fires with the target rewound ~75ms (half the 150ms RTT) back onto the shot line

    expect(world.players.damage[targetId]).toBeGreaterThan(0);
    shooter.close();
    lagServer.close();
  });

  it('lag compensation: an intact generator between shooter and target stops the rewound laser (issue #21)', async () => {
    // The mirror of the 150ms-ping test above, with one difference: an intact generator
    // stands directly on the shot line. The rewound recheck must find the target back on
    // the line AND the generator in front of it, and the structure -- the nearer
    // obstruction (its hit-sphere entry sits at z=2.5, the target's at ~7.6) -- wins: no
    // correction damage may be applied for a shot that could never have reached the
    // target. Muzzle height is 1.6 (MUZZLE_HEIGHT), so a generator sphere centered at
    // that height sits squarely on the ray; power is irrelevant to structure occlusion
    // (only destroyed matters), so the generator needs no team-2 power setup here.
    let clock = 0;
    const lagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 29,
      now: () => clock,
    });
    await lagServer.ready;
    const targetId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 1.6, z: 4 } },
    ]);
    const shooter = await connect(TEST_PORT + 29);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    // Establish a 150ms ping: send a snapshot, ack it 150ms of server-clock time later.
    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], targetId * 3);
      lagServer.tick(3 + step);
    }

    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    lagServer.tick(20); // applies the Laser Rifle slot switch only, still Ready, no shot yet
    world.players.position.set([500, 0, 500], targetId * 3); // jumps away right before firing

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // fires with the target rewound back onto the line -- behind the generator

    expect(world.players.damage[targetId]).toBe(0);
    shooter.close();
    lagServer.close();
  });

  it('updates a player 500 m away only every 4th snapshot while never reading as removed (#5)', async () => {
    const farWorld = createWorld(terrain, 1, 8);
    const farServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: farWorld,
      spawns,
      port: TEST_PORT + 30,
      now: () => 0,
    });
    await farServer.ready;
    const client = await connect(TEST_PORT + 30);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;
    const farId = addPlayer(farWorld, { x: 500, y: 0, z: 500 }, 2);

    const promise = receive(client);
    farServer.tick(2);
    let decoded = decodeSnapshot(await promise, null);
    expect(decoded.players.find((player) => player.id === farId)?.x).toBe(500);
    const baseline = { snapshotId: decoded.snapshotId, players: decoded.players };
    client.send(encodeAck({ snapshotId: decoded.snapshotId }));
    await wait(10);
    // Wire snapshot ids start at 2 and the sparse phase is keyed off them, so derive the
    // expectations from the id each decoded snapshot carries: sparse ticks re-send the
    // last update's stale copy (diffing clean against the baseline -- omission is what the
    // delta encoder reads as removal), update ticks carry the moved position.
    let staleX = 500;
    let moves = 0;
    for (let n = 2; n <= 4; n += 1) {
      moves += 1;
      farWorld.players.position[farId * 3] = (farWorld.players.position[farId * 3] ?? 0) + 1;
      const loopPromise = receive(client);
      farServer.tick(2 * n);
      decoded = decodeSnapshot(await loopPromise, baseline);
      const far = decoded.players.find((player) => player.id === farId);
      expect(far, 'distant player persists in every snapshot').toBeDefined();
      const updateDue = decoded.snapshotId % DISTANT_PLAYER_UPDATE_EVERY === 0;
      expect(far?.x).toBe(updateDue ? 500 + moves : staleX);
      if (updateDue) staleX = 500 + moves;
    }
    client.close();
    farServer.close();
  });

  it('never sends a far hidden interior base object until the viewer comes within the radius (#5)', async () => {
    const hiddenWorld = createWorld(terrain, 1, 8);
    // A building footprint at (500,500) with a generator inside it and a force field just
    // outside -- the force field is the one base object meant to be seen from far away.
    hiddenWorld.interiors.push(
      buildInteriorCollider(
        {
          positions: new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, -5, 5, 0, 5, -5, 0, 5]),
        },
        {
          position: { x: 500, y: 0, z: 500 },
          rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        },
      ),
    );
    createBaseObjects(hiddenWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 500, y: 0, z: 500 } },
      { kind: BaseObjectKind.ForceField, team: 1, position: { x: 520, y: 0, z: 500 } },
    ]);
    const hiddenServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: hiddenWorld,
      spawns,
      port: TEST_PORT + 31,
    });
    await hiddenServer.ready;
    const client = await connect(TEST_PORT + 31);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);

    const promise = receive(client);
    hiddenServer.tick(2); // full snapshot (nothing acked yet)
    const decoded = decodeSnapshot(await promise, null);
    expect(decoded.baseObjects.map((object) => object.id)).toEqual([1]);

    // Walk the viewer into the base: the hidden generator enters the relevance set.
    hiddenWorld.players.position.set([490, 0, 490], welcome.playerId * 3);
    const nearPromise = receive(client);
    hiddenServer.tick(4);
    const nearDecoded = decodeSnapshot(await nearPromise, null); // still unacked -> full
    expect(nearDecoded.baseObjects.map((object) => object.id)).toEqual([0, 1]);
    client.close();
    hiddenServer.close();
  });

  it("rejects a live hit the shooter's rewound view never showed, instead of crediting it (issue #10)", async () => {
    // The mirror image of the 150 ms test above: there, the target left the line after the
    // shooter's view and lag comp granted the hit. Here the target steps ONTO the line only
    // by server processing time -- the shooter's screen never showed them there -- and the
    // validation must take the live hit back away, not just grant extra ones.
    let clock = 0;
    const unfairServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 32,
      now: () => clock,
    });
    await unfairServer.ready;
    const targetId = addPlayer(world, { x: 30, y: 0, z: 8 }, 2);
    const shooter = await connect(TEST_PORT + 32);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    // Establish a 150 ms ping (snapshot acked 150 ms of server-clock time later).
    const firstPromise = receive(shooter);
    unfairServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    // History: the target stands 30 m OFF the shot line (+z from the origin) for every tick
    // the shooter's half-RTT (75 ms) rewound view can reach, including the slot-switch tick.
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([30, 0, 8], targetId * 3);
      unfairServer.tick(3 + step);
    }
    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idleSample, slot: 4 },
          { ...idleSample, slot: 4 },
          { ...idleSample, slot: 4 },
        ],
      }),
    );
    await wait(20);
    unfairServer.tick(20); // applies the Laser Rifle slot switch only, still no shot

    // NOW the target appears on the line in server-truth, and the shot fires.
    world.players.position.set([0, 0, 8], targetId * 3);
    const fire: NetInputSample = { ...idleSample, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    unfairServer.tick(21);

    // The live simulation scored the hit (the target really is on the ray server-side);
    // the rewound recheck -- which is what the shooter's own view shows -- misses, so the
    // damage is reverted, the target lives, and the broadcast reshapes into the miss.
    expect(world.players.damage[targetId] ?? 0).toBe(0);
    expect(world.players.alive[targetId]).toBe(1);
    const event = decodeEvent(await receive(shooter));
    expect(event.kind).toBe(EventKind.LaserFired);
    expect(event.b).toBe(-1);
    shooter.close();
    unfairServer.close();
  });

  it('un-kills a victim a view-contradicted live hit killed, restoring flag, score and life (issue #10)', async () => {
    // Same unfair setup, but the victim is one sliver below lethal damage and carrying the
    // enemy flag: the live hit killed them inside stepWorld (death bookkeeping, flag drop,
    // kill score all committed), and the rejection has to reverse every piece of it.
    let clock = 0;
    const flagWorld = createWorld(terrain, 1, 8);
    createFlags(flagWorld, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 0 } },
    ]);
    const unfairServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: flagWorld,
      spawns,
      port: TEST_PORT + 33,
      now: () => clock,
    });
    await unfairServer.ready;
    const targetId = addPlayer(flagWorld, { x: 30, y: 0, z: 8 }, 2);
    flagWorld.players.damage[targetId] = LIGHT_ARMOR.maxDamage - 0.01;
    flagWorld.flags.state[1] = FlagState.Carried;
    flagWorld.flags.carrierId[1] = targetId;
    const shooter = await connect(TEST_PORT + 33);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    flagWorld.players.position.set([0, 0, 0], welcome.playerId * 3);

    const firstPromise = receive(shooter);
    unfairServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);
    for (let step = 0; step < 5; step += 1) {
      flagWorld.players.position.set([30, 0, 8], targetId * 3);
      unfairServer.tick(3 + step);
    }
    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idleSample, slot: 4 },
          { ...idleSample, slot: 4 },
          { ...idleSample, slot: 4 },
        ],
      }),
    );
    await wait(20);
    unfairServer.tick(20);
    flagWorld.players.position.set([0, 0, 8], targetId * 3);
    const fire: NetInputSample = { ...idleSample, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    unfairServer.tick(21);

    // Alive again at their pre-tick health (the undo floors at the pre-tick damage level so
    // a clamped killing blow cannot leave the victim healthier than they started), the flag
    // back in their hands before any client ever saw it drop, no kill credited, and no
    // PlayerKilled event on the wire -- the only event this tick produces is the reshaped
    // LaserFired miss.
    expect(flagWorld.players.alive[targetId]).toBe(1);
    expect(flagWorld.players.damage[targetId]).toBe(LIGHT_ARMOR.maxDamage - 0.01);
    expect(flagWorld.players.score[welcome.playerId] ?? 0).toBe(0);
    expect(flagWorld.flags.state[1]).toBe(FlagState.Carried);
    expect(flagWorld.flags.carrierId[1]).toBe(targetId);
    expect(flagWorld.pendingDeaths).toHaveLength(0);
    const event = decodeEvent(await receive(shooter));
    expect(event.kind).toBe(EventKind.LaserFired);
    expect(event.b).toBe(-1);
    shooter.close();
    unfairServer.close();
  });

  it("honors a live hit the shooter's rewound view confirms, applying it exactly once (issue #10)", async () => {
    // Regression guard for the validation itself: when the rewound view reproduces the live
    // hit on the same target, nothing is rejected and nothing is re-applied -- exactly one
    // laser shot's damage, as before issue #10's fix existed.
    let clock = 0;
    const fairServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 34,
      now: () => clock,
    });
    await fairServer.ready;
    const targetId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    const shooter = await connect(TEST_PORT + 34);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    const firstPromise = receive(shooter);
    fairServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);
    for (let step = 0; step < 6; step += 1) {
      world.players.position.set([0, 0, 8], targetId * 3);
      fairServer.tick(3 + step);
    }
    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idleSample, slot: 4 },
          { ...idleSample, slot: 4 },
          { ...idleSample, slot: 4 },
        ],
      }),
    );
    await wait(20);
    fairServer.tick(20);
    const fire: NetInputSample = { ...idleSample, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    fairServer.tick(21);

    // One laser shot on this fixture: 0.4 direct × 1.3 head multiplier (the horizontal ray
    // meets the hit sphere in its top band). Exactly once -- never rejected, never re-applied.
    expect(world.players.damage[targetId]).toBeCloseTo(0.52, 5);
    expect(world.players.alive[targetId]).toBe(1);
    shooter.close();
    fairServer.close();
  });

  it('does not keep rewinding or re-hitting a target merely because fire is held through reload (Codex PR #9 round 3, P1 finding 3)', async () => {
    // Eligibility for the lag-comp recheck now comes from world.lastFireEvents -- an
    // actual same-tick hitscan/tracer shot -- not raw input.fire and weapon slot. The old
    // hitscanShooters checked only those two, so a held trigger rewound (and could
    // re-correct damage onto) every other player on every tick the button stayed down,
    // including the ~1 s the Laser Rifle spends in Firing/Reload where tryFireWeapon's own
    // Ready/NoAmmo gate refuses to produce a second shot at all.
    let clock = 0;
    const lagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 7,
      now: () => clock,
    });
    await lagServer.ready;
    const targetId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    const shooter = await connect(TEST_PORT + 7);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], targetId * 3);
      lagServer.tick(3 + step);
    }

    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    lagServer.tick(20); // slot switch only, still Ready, no shot yet
    // Codex review round 16, finding 2: the rewind amount is half the measured RTT (one-way
    // latency), so the jump-away must happen right before firing, not several ticks earlier.
    world.players.position.set([500, 0, 500], targetId * 3);

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // fires: the one legitimate, lag-compensated hit lands
    const damageAfterFirstShot = world.players.damage[targetId];
    expect(damageAfterFirstShot).toBeGreaterThan(0);

    // Keep holding the trigger through the Laser Rifle's ~1 s Firing+Reload cycle (fireTime
    // 0.5 s + reloadTime 0.5 s, ~31 ticks): tryFireWeapon never runs again until the weapon
    // is back to Ready, so world.lastFireEvents stays empty on every one of these ticks and
    // the target -- still far from the shot line -- must take no further damage.
    for (let tick = 22; tick < 30; tick += 1) {
      shooter.send(encodeInput({ sequence: tick, samples: [fire, fire, fire] }));
      lagServer.tick(tick);
    }
    await wait(20);

    expect(world.players.damage[targetId]).toBe(damageAfterFirstShot);
    shooter.close();
    lagServer.close();
  });

  it('resyncs a carried flag to its true position after a lag-comp rewind (Codex PR #9 round 2, finding 2)', async () => {
    // stepFlags already syncs a carried flag's rendered position to its carrier's CURRENT
    // player position every tick, but during the rewind window that "current" position is
    // the carrier's historical (rewound) one, not their true one. restorePositions only
    // fixes player positions back up afterward -- without also re-syncing the flag, a
    // stale, rewound flag position survives into that tick's outgoing snapshot.
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 8 } },
    ]);
    let clock = 0;
    const flagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 6,
      now: () => clock,
    });
    await flagServer.ready;
    const carrierId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    world.flags.carrierId[0] = carrierId; // team 1's flag, carried by a team-2 player
    world.flags.state[0] = FlagState.Carried;
    world.flags.returnAt[0] = -1;

    const shooter = await connect(TEST_PORT + 6);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    // Establish a 150ms ping so the coming shot triggers a rewind.
    const firstPromise = receive(shooter);
    flagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    // The carrier holds the shot line for a few ticks, recorded into lag-comp history...
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], carrierId * 3);
      flagServer.tick(3 + step);
    }
    // ...then moves far away right before the shot resolves: its true current position.
    world.players.position.set([500, 0, 500], carrierId * 3);

    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    flagServer.tick(20); // slot switch only, no shot yet

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    flagServer.tick(21); // fires: the carrier is rewound for hit resolution, then restored

    // The flag must reflect the carrier's true, restored position, not the rewound one
    // stepFlags synced it to mid-tick, before restorePositions undid the rewind.
    expect(world.flags.position[0]).toBeCloseTo(500);
    expect(world.flags.position[2]).toBeCloseTo(500);
    shooter.close();
    flagServer.close();
  });

  it('broadcasts a LaserFired event for a shot resolved this tick (Codex PR #9 round 2, finding 5)', async () => {
    // Round 1 added world.lastFireEvents specifically so server code could still read a
    // tick's fire events after stepProjectiles clears pendingFireEvents, but net.ts's
    // laserEvents was never switched over: it kept reading pendingFireEvents, which is
    // always empty by the time net.ts looks at it, so a landed Laser Rifle shot never
    // produced a LaserFired broadcast.
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const messages: Uint8Array[] = [];
    client.on('message', (data) => messages.push(new Uint8Array(data as Uint8Array)));

    const idle: NetInputSample = {
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
    client.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    server.tick(2); // applies the Laser Rifle slot switch only, still Ready, no shot yet

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    client.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    server.tick(3); // fires: must broadcast a LaserFired event this same tick
    await wait(20); // the broadcast is delivered over the socket asynchronously

    const events = messages
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes));
    const laser = events.find((event) => event.kind === EventKind.LaserFired);
    expect(laser?.beam).toBeDefined();
    expect(laser?.beam?.to).not.toEqual(laser?.beam?.from);
    client.close();
  });

  // #52 tests fire through REAL inputs -- stepWeapons clears world.pendingFireEvents on
  // every stepWorld call, so the sim tests' direct-push trick cannot work through server.tick.
  const fireInput = (slot: number, overrides: Partial<NetInputSample> = {}): NetInputSample => ({
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    jump: false,
    jet: false,
    fire: false,
    altFire: false,
    slot,
    packActive: false,
    use: false,
    ...overrides,
  });

  it('broadcasts exactly one ProjectileImpact event carrying the authoritative record (#52)', async () => {
    // #52: the impact must reach the client as a full record -- position, weapon, reason,
    // sequence -- exactly once, not inferred from a projectile vanishing from a snapshot.
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    await wait(10);

    const messages: Uint8Array[] = [];
    client.on('message', (data) => messages.push(new Uint8Array(data as Uint8Array)));
    const targetId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);
    client.send(
      encodeInput({
        sequence: 1,
        samples: [
          fireInput(1, { fire: true }),
          fireInput(1, { fire: true }),
          fireInput(1, { fire: true }),
        ],
      }),
    );
    await wait(20);
    for (let tick = 1; tick < 30; tick += 1) {
      // Keep the target planted on the shot line against gravity, the same convention the
      // lag-compensation tests below use.
      world.players.position.set([0, 0, 8], targetId * 3);
      server.tick(tick);
    }
    await wait(20);

    const impacts = messages
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes))
      .filter((event) => event.kind === EventKind.ProjectileImpact);
    expect(impacts).toHaveLength(1);
    const impact = impacts[0]?.impact;
    expect(impact).toMatchObject({
      weaponId: WeaponId.Spinfusor,
      type: ProjectileType.Linear,
      reason: ProjectileImpactReason.Direct,
      seq: 1,
    });
    // The record's position is the sim's contact point beside the planted target -- a stale
    // "last seen" position would be metres back along the shot line.
    expect(Math.hypot(impact?.x ?? 99, (impact?.z ?? 99) - 8)).toBeLessThan(2);
    // The damage path is untouched: a direct disc hit hurts the target it hit.
    expect(world.players.damage[targetId] ?? 0).toBeGreaterThan(0);
    client.close();
  });

  it('delivers an impact that happens entirely between snapshots (#52)', async () => {
    // A disc fired straight down whose impact lands on an ODD tick: no snapshot is sent on
    // odd ticks at all, so the old disappearance-diff presentation could never have shown
    // anything for this shot -- the impact event must carry it instead (issue #52).
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    await wait(10);
    const shooter = welcome.playerId;

    const messages: Uint8Array[] = [];
    client.on('message', (data) => messages.push(new Uint8Array(data as Uint8Array)));

    // Keep the shooter pinned where the downward shot is over open ground.
    world.players.position.set([0, 0, 0], shooter * 3);

    // Message cadence mirrors the proven LaserFired test above, shifted one tick: the slot
    // switch rides its own message and is applied by tick 3, the fire message is applied by
    // tick 4 -- an EVEN tick, so the spawn snapshot goes out -- and the disc first
    // integrates on tick 5, an ODD tick where no snapshot is sent at all. That impact tick
    // is exactly what the old disappearance-diff presentation could never represent (#52).
    client.send(encodeInput({ sequence: 1, samples: [fireInput(1), fireInput(1), fireInput(1)] }));
    await wait(20);
    server.tick(3); // odd: applies the Spinfusor slot switch, sends no snapshot
    client.send(
      encodeInput({
        sequence: 2,
        samples: [
          fireInput(1, { fire: true, pitch: -Math.PI / 2 }),
          fireInput(1, { fire: true, pitch: -Math.PI / 2 }),
          fireInput(1, { fire: true, pitch: -Math.PI / 2 }),
        ],
      }),
    );
    await wait(20);
    server.tick(4); // even: fires the disc straight down; the spawn snapshot goes out
    await wait(20);
    messages.length = 0; // only care about what the odd tick delivers

    server.tick(5); // odd: the disc crosses the terrain; NO snapshot is sent this tick
    await wait(20);

    expect(messages.some((bytes) => bytes[0] === MessageType.Snapshot)).toBe(false);
    const impacts = messages
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes))
      .filter((event) => event.kind === EventKind.ProjectileImpact);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.impact?.reason).toBe(ProjectileImpactReason.World);
    expect(impacts[0]?.impact?.weaponId).toBe(WeaponId.Spinfusor);
    client.close();
  });

  it('drops a flag when a lag-compensated correction kills its carrier (Codex round 4, finding 2)', async () => {
    // applyLagCompensatedHits runs after stepWorld has already returned -- and therefore
    // after this tick's stepFlags already ran -- so a kill it produces can never be seen by
    // dropCarriedFlagsOnDeath's pendingDeaths pass, and the *next* tick's stepPlayers clears
    // pendingDeaths before that next tick's stepFlags gets a chance either. Without net.ts
    // dropping the flag itself, right here, synchronously, it stays Carried by a corpse forever.
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 8 } },
    ]);
    let clock = 0;
    const lagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 8,
      now: () => clock,
    });
    await lagServer.ready;
    const carrierId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    world.flags.carrierId[0] = carrierId; // team 1's flag, carried by a team-2 player
    world.flags.state[0] = FlagState.Carried;
    world.flags.returnAt[0] = -1;

    const shooter = await connect(TEST_PORT + 8);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    // Establish a 150ms ping so the coming shot triggers a rewind.
    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    // The carrier holds the shot line for a few ticks (recorded into lag-comp history), then
    // jumps far away right before the shot resolves: the laggy shooter's screen still shows
    // it in the old spot, so the live hit-test misses and only the recheck can land the hit.
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], carrierId * 3);
      lagServer.tick(3 + step);
    }
    // Just under lethal: the recheck's one Laser Rifle hit is what finishes them off.
    world.players.damage[carrierId] = LIGHT_ARMOR.maxDamage - 0.01;

    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    lagServer.tick(20); // slot switch only, still Ready, no shot yet
    // Codex review round 16, finding 2: the rewind amount is half the measured RTT (one-way
    // latency), so the jump-away must happen right before firing, not several ticks earlier.
    world.players.position.set([500, 0, 500], carrierId * 3);

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // fires: the lag-compensated correction is the lethal hit

    expect(world.players.alive[carrierId]).toBe(0);
    expect(world.flags.state[0]).toBe(FlagState.Dropped);
    expect(world.flags.carrierId[0]).toBe(-1);
    shooter.close();
    lagServer.close();
  });

  it('never applies a lag-compensated hit for a Chaingun shot that never actually spawned (Codex round 4, finding 3)', async () => {
    // With the projectile store full, spawnStored returns null and the shot's hit-test never
    // runs -- FireEvent.hitPlayerId stays at its default -1, indistinguishable from a genuine
    // live miss unless applyLagCompensatedHits also checks the new `resolved` flag. Put the
    // target directly in the shot's line so an unconditional recheck WOULD have hit them.
    let clock = 0;
    const lagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 9,
      now: () => clock,
    });
    await lagServer.ready;
    // allocate() only checks count/freeIds, not which slots are actually marked active --
    // exhaust just those two fields so the store looks full without any phantom projectiles
    // actually existing for stepProjectiles to process.
    world.projectiles.count = world.projectiles.active.length;
    world.projectiles.freeIds = [];

    const target = addPlayer(world, { x: 0, y: 0, z: 10 }, 2);

    const shooter = await connect(TEST_PORT + 9);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150; // establishes a 150ms ping so a real hit would be rewind-eligible
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 2 },
          { ...idle, slot: 2 },
          { ...idle, slot: 2 },
        ],
      }),
    );
    await wait(20);
    lagServer.tick(20); // slot switch to Chaingun only

    const fire: NetInputSample = { ...idle, slot: 2, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // fires into a full projectile store: never resolves, never a "shot"

    expect(world.players.damage[target]).toBe(0);
    shooter.close();
    lagServer.close();
  });

  it('consumes the lag-comp-corrected Chaingun tracer so it cannot score a second hit later (Codex review round 5, finding 1)', async () => {
    // The live, same-tick tracer step inside stepWorld tests against TRUE positions and
    // misses both targets here: targetA has since moved away, and targetB sits beyond the
    // first tick's travel distance. applyLagCompensatedHits then reruns that exact same
    // first-tick segment against targetA's REWOUND position, finds a hit, and applies
    // damage directly via applyDamage -- entirely outside projectiles.ts's own
    // resolveImpact path. Without also consuming the tracer there, it stays active and
    // keeps traveling: the very next tick's ordinary stepProjectiles pass carries it
    // straight into targetB's true (never-rewound) position, landing a second, independent
    // hit for the one shot that fired.
    let clock = 0;
    const lagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world,
      spawns,
      port: TEST_PORT + 10,
      now: () => clock,
    });
    await lagServer.ready;
    // Chaingun speed is 425 m/s at a 32 ms tick, so one tick of travel covers 13.6 m.
    const targetA = addPlayer(world, { x: 0, y: 0, z: 8 }, 2); // inside the first 0-13.6 m segment
    const targetB = addPlayer(world, { x: 0, y: 0, z: 20 }, 2); // inside the second 13.6-27.2 m segment

    const shooter = await connect(TEST_PORT + 10);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    const lagMessages: Uint8Array[] = [];
    shooter.on('message', (data) => lagMessages.push(new Uint8Array(data as Uint8Array)));

    // Establish a 150ms ping: send a snapshot, ack it 150ms of server-clock time later.
    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    // Walk targetA across the shot line for a few ticks (recorded into lag-comp history),
    // then jump it far away right before the shot -- the laggy shooter's screen still shows
    // it in the old spot. targetB never moves, so rewinding it (it's not excluded either)
    // only ever substitutes its own unchanged true position -- it plays no part in the
    // correction itself, only in the live hit-test on the tick after.
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], targetA * 3);
      lagServer.tick(3 + step);
    }

    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 2 },
          { ...idle, slot: 2 },
          { ...idle, slot: 2 },
        ],
      }),
    );
    await wait(20);
    lagServer.tick(20); // slot switch to Chaingun only, still Ready, no shot yet
    // Isolate lag compensation from spin-up: the next tick completes the wind-up.
    world.players.weaponState[welcome.playerId] = WeaponState.SpinUp;
    world.players.weaponTimer[welcome.playerId] = FIXED_DT;
    // Codex review round 16, finding 2: the rewind amount is half the measured RTT (one-way
    // latency), so the jump-away must happen right before firing, not several ticks earlier.
    world.players.position.set([500, 0, 500], targetA * 3);

    const fire: NetInputSample = { ...idle, slot: 2, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // live miss, then the lag-comp correction lands on targetA

    expect(world.players.damage[targetA]).toBeGreaterThan(0);
    expect(world.players.damage[targetB]).toBe(0); // not reached by the tracer's first segment

    lagServer.tick(22); // the tracer would travel its second 13.6 m here if still alive

    expect(world.players.damage[targetB]).toBe(0); // consumed: no second hit

    // #52: the corrected hit ALSO produces the authoritative Direct impact record -- the
    // correction consumes the tracer with the rewound contact point, so the client renders
    // the corrected hit exactly like a live one, once.
    await wait(20);
    const impacts = lagMessages
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes))
      .filter((event) => event.kind === EventKind.ProjectileImpact);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.impact).toMatchObject({
      weaponId: WeaponId.Chaingun,
      type: ProjectileType.Tracer,
      reason: ProjectileImpactReason.Direct,
    });
    shooter.close();
    lagServer.close();
  });

  it('does not respawn a due player on the tick the match ends (Codex round 4, finding 6)', () => {
    // stepWorld freezes the sim once world.gameOver is true, but that flag can flip to true
    // partway through the very stepWorld call that sets it (here, the time limit landing on
    // this tick) -- and runOneTick's own respawn handling ran unconditionally afterward,
    // unguarded by the gameOver state stepWorld had just produced. A respawn timer due on
    // the exact tick the match ends therefore still fired the player back into a supposedly
    // frozen game.
    const deadId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.alive[deadId] = 0;
    world.players.respawnAt[deadId] = 0; // already due
    // Makes checkTimeLimit fire on this tick's stepWorld call: it compares world.tick + 1
    // (pre-increment) against timeLimitTicks, so this is the earliest value that trips it.
    world.timeLimitTicks = world.tick + 1;

    server.tick(1);

    expect(world.gameOver).toBe(true);
    expect(world.players.alive[deadId]).toBe(0);
  });

  it('respawn picks a spawn using the same team-count convention as initial join (Codex review round 5, finding 2)', async () => {
    // handleJoin computes the spawn index from teamCount BEFORE addPlayer runs, so a lone
    // joiner is always counted as "0 others already on the team" and lands on spawn index
    // 0. dueForRespawn's id stays active while dead (death only clears `alive`, never
    // `active`), so without the same -1 correction, respawnDuePlayers counts that same
    // player as already present on their own team and picks spawn index 1 instead --
    // landing a lone player's very first respawn on a DIFFERENT spawn than their own
    // initial join chose, even though the team's population never actually changed.
    const twoSpawnsPerTeam: SceneSpawn[] = [
      { name: null, team: 1, position: [0, 0, 0], radius: 5 },
      { name: null, team: 1, position: [40, 0, 40], radius: 5 },
      { name: null, team: 2, position: [1, 0, 1], radius: 5 },
      { name: null, team: 2, position: [41, 0, 41], radius: 5 },
    ];
    const spawnWorld = createWorld(terrain, 1, 8);
    const spawnServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: spawnWorld,
      spawns: twoSpawnsPerTeam,
      port: TEST_PORT + 11,
    });
    await spawnServer.ready;

    const client = await connect(TEST_PORT + 11);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.team).toBe(1); // the sole joiner: team 1 is always the (tied) smaller team
    expect(welcome.spawnX).toBeCloseTo(0); // team 1's spawn index 0
    expect(welcome.spawnZ).toBeCloseTo(0);

    spawnWorld.players.alive[welcome.playerId] = 0;
    spawnWorld.players.respawnAt[welcome.playerId] = 0; // already due
    spawnServer.tick(1);

    const base = welcome.playerId * 3;
    expect(spawnWorld.players.position[base]).toBeCloseTo(welcome.spawnX);
    expect(spawnWorld.players.position[base + 2]).toBeCloseTo(welcome.spawnZ);

    client.close();
    spawnServer.close();
  });

  it('does not damage a player whose respawn becomes due on the same tick a laggy shooter fires at their spawn point (Codex review round 6, P2)', async () => {
    // runOneTick respawns due players BEFORE applyLagCompensatedHits runs, in the same tick,
    // and respawning clears the respawned id's position history immediately (see
    // clearHistory's and respawnDuePlayers' own comments). If a laggy shooter's shot resolves
    // as a live miss this same tick -- the target was still dead when stepWorld ran -- the
    // lag-comp recheck that follows must not find the freshly-respawned player standing at
    // their spawn point and treat that as though it were where they had been all along.
    const respawnSpawns: SceneSpawn[] = [
      { name: null, team: 1, position: [0, 0, 0], radius: 5 },
      { name: null, team: 2, position: [0, 0, 8], radius: 5 }, // the exact line the shooter aims down
    ];
    let clock = 0;
    const respawnWorld = createWorld(terrain, 1, 8);
    const lagServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: respawnWorld,
      spawns: respawnSpawns,
      port: TEST_PORT + 12,
      now: () => clock,
    });
    await lagServer.ready;

    const shooter = await connect(TEST_PORT + 12);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    respawnWorld.players.position.set([0, 0, 0], welcome.playerId * 3);

    // The eventual target: alive and sitting on the shot line at first, so a few ticks of
    // real history get recorded for it -- matching the review's exact repro (history
    // existed, then got cleared by this tick's respawn) rather than "never had any history".
    const targetId = addPlayer(respawnWorld, { x: 0, y: 0, z: 8 }, 2);

    // Establish a 150ms ping: send a snapshot, ack it 150ms of server-clock time later.
    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    for (let step = 0; step < 5; step += 1) {
      respawnWorld.players.position.set([0, 0, 8], targetId * 3);
      lagServer.tick(3 + step);
    }

    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    lagServer.tick(20); // slot switch to the Laser Rifle only, still Ready, no shot yet

    // The target dies right before the shot resolves, with its respawn already due: on the
    // very next tick, respawnDuePlayers respawns it back to [0, 0, 8] -- the same spot the
    // shooter is aiming down -- and clears its history in the same call, before
    // applyLagCompensatedHits ever runs this tick.
    respawnWorld.players.alive[targetId] = 0;
    respawnWorld.players.respawnAt[targetId] = 0;

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // live sim finds no target (dead); same tick it respawns, then rechecks

    expect(respawnWorld.players.alive[targetId]).toBe(1); // actually respawned
    expect(respawnWorld.players.damage[targetId]).toBe(0); // but the correction must not hit it

    shooter.close();
    lagServer.close();
  });

  it('rewinds by half the measured round-trip time, not the full RTT (Codex review round 16, finding 2)', async () => {
    // pingMs is measured snapshot-send to ack-receive -- a full round trip -- but what the
    // shooter's own screen showed at the moment they fired is delayed by only the one-way
    // (server-to-client) leg, roughly half of that. Rewinding by the whole RTT looks twice as
    // far into the past as the shooter's real view justifies.
    //
    // Each server.tick() call is exactly one simulation step; recordHistory runs at the START
    // of that step, so the Nth tick() call (1-indexed) records history tagged with the
    // pre-increment tick value (N-1). This test makes 8 tick() calls total, keeping the
    // target on the shot line for calls 1-4 (history ticks 0-3) and off the line from call 5
    // onward (history ticks 4-7). By the firing call (the 8th), world.tick is 8: an un-halved
    // 150ms ping rewinds 5 ticks, landing on tick 3 (on the line -- a false hit); a correctly
    // halved 75ms rewinds 2 ticks, landing on tick 6 (already moved away -- a correct miss).
    const rttSpawns: SceneSpawn[] = [
      { name: null, team: 1, position: [0, 0, 0], radius: 5 },
      { name: null, team: 2, position: [0, 0, 8], radius: 5 },
    ];
    let clock = 0;
    const rttWorld = createWorld(terrain, 1, 8);
    const rttServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: rttWorld,
      spawns: rttSpawns,
      port: TEST_PORT + 13,
      now: () => clock,
    });
    await rttServer.ready;
    const targetId = addPlayer(rttWorld, { x: 0, y: 0, z: 8 }, 2); // on the shot line by default

    const shooter = await connect(TEST_PORT + 13);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    rttWorld.players.position.set([0, 0, 0], welcome.playerId * 3);

    // Call 1: establish a 150ms measured RTT (send a snapshot, ack it 150ms later).
    // Records history@0 = on the line (the target's default position).
    const firstPromise = receive(shooter);
    rttServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
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
    rttServer.tick(3); // call 2: history@1 = on the line
    rttServer.tick(4); // call 3: history@2 = on the line
    rttServer.tick(5); // call 4: history@3 = on the line
    rttWorld.players.position.set([500, 0, 500], targetId * 3); // moves away
    rttServer.tick(6); // call 5: history@4 = moved away
    rttServer.tick(7); // call 6: history@5 = moved away

    shooter.send(
      encodeInput({
        sequence: 1,
        samples: [
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
          { ...idle, slot: 4 },
        ],
      }),
    );
    await wait(20);
    rttServer.tick(20); // call 7: history@6 = moved away; applies the Laser Rifle slot switch

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    rttServer.tick(21); // call 8: fires -- live miss; the halved-rewind recheck must also miss

    expect(rttWorld.players.damage[targetId]).toBe(0);
    shooter.close();
    rttServer.close();
  });

  it('assigns simultaneous same-team respawns to different spawn points (Codex review round 16, finding 3)', () => {
    // Death only clears `alive`, never `active` -- a dead player still counts in
    // teamCount(world, team) for the rest of this tick's loop. Two teammates due for
    // respawn on the same tick both computed the same `teamCount(world, team) - 1` index
    // before this fix, landing on the identical spawn point instead of fanning out across
    // the team's spawn list.
    const twoSpawnsPerTeam: SceneSpawn[] = [
      { name: null, team: 1, position: [0, 0, 0], radius: 5 },
      { name: null, team: 1, position: [40, 0, 40], radius: 5 },
    ];
    const collideWorld = createWorld(terrain, 1, 8);
    const a = addPlayer(collideWorld, { x: 0, y: 0, z: 0 }, 1);
    const b = addPlayer(collideWorld, { x: 40, y: 0, z: 40 }, 1);
    for (const id of [a, b]) {
      collideWorld.players.alive[id] = 0;
      collideWorld.players.respawnAt[id] = 0; // both due on the same tick
    }
    const collideServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: collideWorld,
      spawns: twoSpawnsPerTeam,
      port: TEST_PORT + 14,
    });
    const baseA = a * 3;
    const baseB = b * 3;
    collideServer.tick(1);
    const posA: [number, number] = [
      collideWorld.players.position[baseA] ?? 0,
      collideWorld.players.position[baseA + 2] ?? 0,
    ];
    const posB: [number, number] = [
      collideWorld.players.position[baseB] ?? 0,
      collideWorld.players.position[baseB + 2] ?? 0,
    ];
    expect(posA).not.toEqual(posB);
    collideServer.close();
  });

  it('a Loadout message applies the requested armor and repair pack when the player is at a powered station', async () => {
    // Arrange a world with one team-1 station within STATION_USE_RADIUS of the join spawn,
    // powered by a living generator -- mirroring baseObjects.test.ts's own fixture shape.
    const loadoutWorld = createWorld(terrain, 1, 8);
    createBaseObjects(loadoutWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(loadoutWorld);
    const loadoutSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 0, 0], radius: 5 }];
    const loadoutServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: loadoutWorld,
      spawns: loadoutSpawns,
      port: TEST_PORT + 15,
    });
    await loadoutServer.ready;
    const client = await connect(TEST_PORT + 15);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeLoadout({ armor: 2, pack: 1, weapons: 0 }));
    await wait(10);
    loadoutServer.tick(1);
    expect(loadoutWorld.players.armor[0]).toBe(2);
    expect(loadoutWorld.players.hasRepairPack[0]).toBe(1);
    client.close();
    loadoutServer.close();
  });

  it('a Loadout message selects an energy pack and carried weapons when the player is at a powered station (#55)', async () => {
    // Same fixture as the repair-pack test above; the new pack/weapons fields ride the same
    // Loadout message -- the energy pack replaces the repair pack (mutually exclusive), and
    // the weapons bitmask re-arms exactly the slots whose bits are set.
    const loadoutWorld = createWorld(terrain, 1, 8);
    createBaseObjects(loadoutWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(loadoutWorld);
    const loadoutSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 0, 0], radius: 5 }];
    const loadoutServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: loadoutWorld,
      spawns: loadoutSpawns,
      port: TEST_PORT + 16,
    });
    await loadoutServer.ready;
    const client = await connect(TEST_PORT + 16);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeLoadout({ armor: 2, pack: 2, weapons: 0b00111 }));
    await wait(10);
    loadoutServer.tick(1);
    expect(loadoutWorld.players.armor[0]).toBe(2);
    expect(loadoutWorld.players.hasEnergyPack[0]).toBe(1);
    expect(loadoutWorld.players.hasRepairPack[0]).toBe(0);
    client.close();
    loadoutServer.close();
  });

  it('buildExtras includes baseObjects and turrets', () => {
    const extrasWorld = createWorld(terrain, 1, 8);
    createBaseObjects(extrasWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(extrasWorld);
    const extras = buildExtras(extrasWorld);
    expect(extras.baseObjects).toHaveLength(1);
    expect(extras.baseObjects[0]?.powered).toBe(1);
  });

  it('buildExtras includes vehicles', () => {
    const extrasWorld = createWorld(terrain, 1, 8);
    createBaseObjects(extrasWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(extrasWorld);
    spawnVehicleAtPad(extrasWorld, 1, VehicleKind.Wildcat);
    const extras = buildExtras(extrasWorld);
    expect(extras.vehicles).toHaveLength(1);
    expect(extras.vehicles[0]?.kind).toBe(VehicleKind.Wildcat);
  });

  it('a VehicleSpawn message from a player near its powered control station spawns a vehicle', async () => {
    const vehicleWorld = createWorld(terrain, 1, 8);
    createBaseObjects(vehicleWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      {
        kind: BaseObjectKind.StationVehiclePad,
        team: 1,
        position: { x: 20, y: 0, z: 0 },
        usePosition: { x: 1, y: 0, z: 0 },
      },
    ]);
    stepPower(vehicleWorld);
    const vehicleSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 0, 0], radius: 5 }];
    const vehicleServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: vehicleWorld,
      spawns: vehicleSpawns,
      port: TEST_PORT + 16,
    });
    await vehicleServer.ready;
    const client = await connect(TEST_PORT + 16);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeVehicleSpawn({ padId: 1, kind: VehicleKind.Shrike }));
    await wait(10);
    vehicleServer.tick(1);
    expect(vehicleWorld.vehicles.count).toBe(1);
    expect(vehicleWorld.vehicles.active[0]).toBe(1);
    expect(vehicleWorld.vehicles.kind[0]).toBe(VehicleKind.Shrike);
    client.close();
    vehicleServer.close();
  });

  it('a VehicleSpawn message from a player too far from the named pad is silently ignored', async () => {
    const vehicleWorld = createWorld(terrain, 1, 8);
    createBaseObjects(vehicleWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 500, y: 0, z: 0 } },
    ]);
    stepPower(vehicleWorld);
    const farSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [0, 0, 0], radius: 5 }];
    const vehicleServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: vehicleWorld,
      spawns: farSpawns,
      port: TEST_PORT + 17,
    });
    await vehicleServer.ready;
    const client = await connect(TEST_PORT + 17);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeVehicleSpawn({ padId: 1, kind: VehicleKind.Shrike }));
    await wait(10);
    vehicleServer.tick(1);
    expect(vehicleWorld.vehicles.count).toBe(0);
    client.close();
    vehicleServer.close();
  });

  it('a VehicleSpawn message for an enemy team pad is rejected (Codex review round 2, finding 2)', async () => {
    // Before this fix, the only check was proximity -- no check that the pad belongs to
    // the sender's own team. spawnVehicleAtPad creates the vehicle under the PAD's team
    // (never the sender's), and unconditionally destroys whatever the pad already hosts
    // BEFORE the cap check -- so standing within range of an enemy pad let any connected
    // client destroy or replace that enemy team's vehicle for free.
    const vehicleWorld = createWorld(terrain, 1, 8);
    createBaseObjects(vehicleWorld, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 2, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(vehicleWorld);
    // The connecting player spawns on team 1, right next to team 2's own pad.
    const vehicleSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 0, 0], radius: 5 }];
    const vehicleServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: vehicleWorld,
      spawns: vehicleSpawns,
      port: TEST_PORT + 18,
    });
    await vehicleServer.ready;
    const client = await connect(TEST_PORT + 18);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeVehicleSpawn({ padId: 1, kind: VehicleKind.Shrike }));
    await wait(10);
    vehicleServer.tick(1);
    expect(vehicleWorld.vehicles.count).toBe(0);
    client.close();
    vehicleServer.close();
  });

  it('a VehicleSpawn message from a dead player is rejected (Codex review round 2, finding 2)', async () => {
    const vehicleWorld = createWorld(terrain, 1, 8);
    createBaseObjects(vehicleWorld, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(vehicleWorld);
    const vehicleSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 0, 0], radius: 5 }];
    const vehicleServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: vehicleWorld,
      spawns: vehicleSpawns,
      port: TEST_PORT + 19,
    });
    await vehicleServer.ready;
    const client = await connect(TEST_PORT + 19);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;
    vehicleWorld.players.alive[0] = 0; // the first joiner is always allocated id 0

    client.send(encodeVehicleSpawn({ padId: 1, kind: VehicleKind.Shrike }));
    await wait(10);
    vehicleServer.tick(1);
    expect(vehicleWorld.vehicles.count).toBe(0);
    client.close();
    vehicleServer.close();
  });

  it("a bot's own PlayerInput reaches stepWorld every tick, with no socket at all (Task 9)", async () => {
    const botWorld = createWorld(terrain, 1, 8);
    createFlags(botWorld, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 8 } },
    ]);
    const botSpawns: SceneSpawn[] = [
      { name: null, team: 1, position: [0, 0, 0], radius: 5 },
      { name: null, team: 2, position: [8, 0, 8], radius: 5 },
    ];
    const manager = createBotManager(
      botWorld,
      botSpawns,
      [
        { position: { x: 0, y: 0, z: 0 }, label: 'homeFlag' },
        { position: { x: 8, y: 0, z: 8 }, label: 'enemyFlag' },
      ],
      2,
    );
    const [botId] = manager.botIds;
    const before: [number, number, number] = [
      botWorld.players.position[(botId as number) * 3] ?? 0,
      botWorld.players.position[(botId as number) * 3 + 1] ?? 0,
      botWorld.players.position[(botId as number) * 3 + 2] ?? 0,
    ];
    const botServer = startNetServer({
      botManager: manager,
      board: createOrderBoard(),
      world: botWorld,
      spawns: botSpawns,
      port: TEST_PORT + 20,
    });
    await botServer.ready;
    for (let tick = 1; tick <= 20; tick += 1) botServer.tick(tick);
    const after: [number, number, number] = [
      botWorld.players.position[(botId as number) * 3] ?? 0,
      botWorld.players.position[(botId as number) * 3 + 1] ?? 0,
      botWorld.players.position[(botId as number) * 3 + 2] ?? 0,
    ];
    expect(after).not.toEqual(before);
    botServer.close();
  });

  it('a human joining a team already at TARGET_TEAM_SIZE bots leaves exactly one fewer bot on that team (failure matrix row 12)', async () => {
    const rebalanceWorld = createWorld(terrain, 1, 64);
    createFlags(rebalanceWorld, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 8 } },
    ]);
    const rebalanceSpawns: SceneSpawn[] = [
      { name: null, team: 1, position: [0, 0, 0], radius: 5 },
      { name: null, team: 2, position: [8, 0, 8], radius: 5 },
    ];
    const manager = createBotManager(rebalanceWorld, rebalanceSpawns, [], TARGET_TEAM_SIZE * 2);
    expect(teamCount(rebalanceWorld, 1)).toBe(TARGET_TEAM_SIZE);
    const botCountBefore = manager.botIds.size;
    const rebalanceServer = startNetServer({
      botManager: manager,
      board: createOrderBoard(),
      world: rebalanceWorld,
      spawns: rebalanceSpawns,
      port: TEST_PORT + 21,
    });
    await rebalanceServer.ready;
    const client = await connect(TEST_PORT + 21);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.team).toBe(1); // smallerTeam picks team 1 on a tie before this join
    expect(teamCount(rebalanceWorld, 1)).toBe(TARGET_TEAM_SIZE); // one bot removed, human added
    expect(manager.botIds.size).toBe(botCountBefore - 1);
    client.close();
    rebalanceServer.close();
  });

  it('refuses a join with a team-full Welcome once both teams are full of humans with bots disabled (issue #31)', async () => {
    // The #31 repro: with `--bots 0` (emptyBotManager) rebalanceTeams had nothing to
    // remove, yet handleJoin accepted every join unconditionally, so team 1 hit 17
    // humans on the 33rd join. The 32 incumbents are direct addPlayer calls (32 real
    // socket joins would only slow this test) -- handleJoin reads the same
    // world.players counts either way.
    const capWorld = createWorld(terrain, 1, 64);
    for (let i = 0; i < TARGET_TEAM_SIZE; i += 1) {
      addPlayer(capWorld, { x: 0, y: 0, z: 0 }, 1);
      addPlayer(capWorld, { x: 1, y: 0, z: 1 }, 2);
    }
    const capServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: capWorld,
      spawns,
      port: TEST_PORT + 35,
    });
    await capServer.ready;
    const client = await connect(TEST_PORT + 35);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    // A refused join reaches the client as a response, not a hang: the same Welcome
    // shape as VersionMismatch, whose non-Ok status this repo's client already treats as
    // a failed join and surfaces by closing its transport (netclient.ts handleWelcome).
    expect(welcome.status).toBe(WelcomeStatus.TeamFull);
    expect(welcome.playerId).toBe(0);
    expect(capWorld.players.count).toBe(TARGET_TEAM_SIZE * 2); // nothing was added
    client.close();
    capServer.close();
  });

  it('places a join on the alternate team, shedding its bot, when the preferred team is full of humans (issue #31)', async () => {
    // Team 1: 16 humans, botless -- smallerTeam's pick (tie goes to team 1) has nothing
    // to shed. Team 2: 15 humans plus the manager's single backfilled bot, so
    // exactly-at-cap team 2 takes the joiner by giving that bot up (row 12's mechanic)
    // instead of refusing.
    const altWorld = createWorld(terrain, 1, 64);
    for (let i = 0; i < TARGET_TEAM_SIZE; i += 1) addPlayer(altWorld, { x: 0, y: 0, z: 0 }, 1);
    for (let i = 0; i < TARGET_TEAM_SIZE - 1; i += 1) addPlayer(altWorld, { x: 1, y: 0, z: 1 }, 2);
    const manager = createBotManager(altWorld, spawns, [], 1);
    expect(teamCount(altWorld, 2)).toBe(TARGET_TEAM_SIZE); // the single bot backfilled team 2
    const altServer = startNetServer({
      botManager: manager,
      board: createOrderBoard(),
      world: altWorld,
      spawns,
      port: TEST_PORT + 36,
    });
    await altServer.ready;
    const client = await connect(TEST_PORT + 36);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.status).toBe(WelcomeStatus.Ok);
    expect(welcome.team).toBe(2);
    // Bot removed, human added: both teams sit back at the cap.
    expect(teamCount(altWorld, 1)).toBe(TARGET_TEAM_SIZE);
    expect(teamCount(altWorld, 2)).toBe(TARGET_TEAM_SIZE);
    expect(manager.botIds.size).toBe(0);
    client.close();
    altServer.close();
  });

  it('refuses a join once both teams sit at the raised 24-seat cap with bots disabled (issue #31 at --team-size 24)', async () => {
    // Same #31 refusal as the 16-cap case above, one cap value up: the join gate reads
    // the manager's own cap, so a 24-seat match refuses on the 49th human exactly as a
    // 16-seat match refuses on the 33rd -- no separate code path, no protocol change.
    const wideCapWorld = createWorld(terrain, 1, 64);
    for (let i = 0; i < 24; i += 1) {
      addPlayer(wideCapWorld, { x: 0, y: 0, z: 0 }, 1);
      addPlayer(wideCapWorld, { x: 1, y: 0, z: 1 }, 2);
    }
    const wideCapServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: wideCapWorld,
      spawns,
      port: TEST_PORT + 37,
    });
    await wideCapServer.ready;
    const client = await connect(TEST_PORT + 37);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.status).toBe(WelcomeStatus.TeamFull);
    expect(welcome.playerId).toBe(0);
    expect(wideCapWorld.players.count).toBe(48); // nothing was added
    client.close();
    wideCapServer.close();
  });

  it('admits a human to a team exactly at the raised 24-seat cap by shedding its bot (issue #31 at --team-size 24)', async () => {
    // --team-size 24 and --bots 1: team 1 gets 24 humans, team 2 gets 23 humans plus the
    // manager's single backfilled bot. The joiner's preferred pick (tie goes to team 1)
    // has no bot to shed, so handleJoin takes joinableTeam's alternate-team offer and
    // team 2 gives its bot up -- the row-12 mechanic at the raised cap.
    const wideJoinWorld = createWorld(terrain, 1, 64);
    for (let i = 0; i < 24; i += 1) addPlayer(wideJoinWorld, { x: 0, y: 0, z: 0 }, 1);
    for (let i = 0; i < 23; i += 1) addPlayer(wideJoinWorld, { x: 1, y: 0, z: 1 }, 2);
    const manager = createBotManager(wideJoinWorld, spawns, [], 1, 24);
    expect(teamCount(wideJoinWorld, 2)).toBe(24); // the single bot backfilled team 2
    const wideJoinServer = startNetServer({
      botManager: manager,
      board: createOrderBoard(),
      world: wideJoinWorld,
      spawns,
      port: TEST_PORT + 38,
    });
    await wideJoinServer.ready;
    const client = await connect(TEST_PORT + 38);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.status).toBe(WelcomeStatus.Ok);
    expect(welcome.team).toBe(2);
    expect(teamCount(wideJoinWorld, 1)).toBe(24);
    expect(teamCount(wideJoinWorld, 2)).toBe(24);
    expect(manager.botIds.size).toBe(0);
    client.close();
    wideJoinServer.close();
  });

  it('stops stepping bots once gameOver freezes the match (Codex review round 1, P2)', async () => {
    const frozenWorld = createWorld(terrain, 1, 8);
    createFlags(frozenWorld, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 8, y: 0, z: 8 } },
    ]);
    const frozenSpawns: SceneSpawn[] = [
      { name: null, team: 1, position: [0, 0, 0], radius: 5 },
      { name: null, team: 2, position: [8, 0, 8], radius: 5 },
    ];
    const manager = createBotManager(
      frozenWorld,
      frozenSpawns,
      [
        { position: { x: 0, y: 0, z: 0 }, label: 'homeFlag' },
        { position: { x: 8, y: 0, z: 8 }, label: 'enemyFlag' },
      ],
      2,
    );
    const [botId] = manager.botIds;
    frozenWorld.gameOver = true;
    const before: [number, number, number] = [
      frozenWorld.players.position[(botId as number) * 3] ?? 0,
      frozenWorld.players.position[(botId as number) * 3 + 1] ?? 0,
      frozenWorld.players.position[(botId as number) * 3 + 2] ?? 0,
    ];
    const frozenServer = startNetServer({
      botManager: manager,
      board: createOrderBoard(),
      world: frozenWorld,
      spawns: frozenSpawns,
      port: TEST_PORT + 22,
    });
    await frozenServer.ready;
    for (let tick = 1; tick <= 20; tick += 1) frozenServer.tick(tick);
    const after: [number, number, number] = [
      frozenWorld.players.position[(botId as number) * 3] ?? 0,
      frozenWorld.players.position[(botId as number) * 3 + 1] ?? 0,
      frozenWorld.players.position[(botId as number) * 3 + 2] ?? 0,
    ];
    expect(after).toEqual(before);
    frozenServer.close();
  });

  it("a CommandOrder message issues an order for the sender's own team, and never affects the other team (row 19)", async () => {
    const orderWorld = createWorld(terrain, 1, 8);
    const orderSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [0, 0, 0], radius: 5 }];
    const board = createOrderBoard();
    const orderServer = startNetServer({
      botManager: emptyBotManager(),
      board,
      world: orderWorld,
      spawns: orderSpawns,
      port: TEST_PORT + 23,
    });
    await orderServer.ready;
    const client = await connect(TEST_PORT + 23);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeCommandOrder({ kind: OrderKind.Attack, x: 12, z: -3 }));
    await wait(10);
    orderServer.tick(1);
    const order = currentOrder(board, 1, orderWorld.tick);
    expect(order?.kind).toBe(OrderKind.Attack);
    expect(order?.x).toBeCloseTo(12);
    expect(order?.z).toBeCloseTo(-3);
    expect(currentOrder(board, 2, orderWorld.tick)).toBeNull();
    client.close();
    orderServer.close();
  });

  it('a second VoiceBind within the cooldown window produces no broadcast Event; a third sent after the cooldown does (row 22)', async () => {
    const voiceWorld = createWorld(terrain, 1, 8);
    const voiceSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [0, 0, 0], radius: 5 }];
    const voiceServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: voiceWorld,
      spawns: voiceSpawns,
      port: TEST_PORT + 24,
    });
    await voiceServer.ready;
    const client = await connect(TEST_PORT + 24);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const events: Uint8Array[] = [];
    client.on('message', (data) => events.push(new Uint8Array(data as Uint8Array)));

    client.send(encodeVoiceBind({ lineId: 1 }));
    await wait(10);
    voiceServer.tick(1);
    client.send(encodeVoiceBind({ lineId: 2 }));
    await wait(10);
    voiceServer.tick(2);
    const voiceBindEvents = events
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes))
      .filter((e) => e.kind === EventKind.VoiceBindPlayed);
    expect(voiceBindEvents).toHaveLength(1);

    for (let tick = 3; tick <= 35; tick += 1) voiceServer.tick(tick);
    client.send(encodeVoiceBind({ lineId: 3 }));
    await wait(10);
    voiceServer.tick(36);
    const afterCooldown = events
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes))
      .filter((e) => e.kind === EventKind.VoiceBindPlayed);
    expect(afterCooldown).toHaveLength(2);
    client.close();
    voiceServer.close();
  });

  it('a VoiceBind naming an out-of-range lineId produces no broadcast Event (row 23)', async () => {
    const voiceWorld = createWorld(terrain, 1, 8);
    const voiceSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [0, 0, 0], radius: 5 }];
    const voiceServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: voiceWorld,
      spawns: voiceSpawns,
      port: TEST_PORT + 25,
    });
    await voiceServer.ready;
    const client = await connect(TEST_PORT + 25);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const events: Uint8Array[] = [];
    client.on('message', (data) => events.push(new Uint8Array(data as Uint8Array)));

    client.send(encodeVoiceBind({ lineId: VOICE_LINE_COUNT }));
    await wait(10);
    voiceServer.tick(1);
    const voiceBindEvents = events
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes))
      .filter((e) => e.kind === EventKind.VoiceBindPlayed);
    expect(voiceBindEvents).toHaveLength(0);
    client.close();
    voiceServer.close();
  });

  it('a stale-version Join gets rejected with VersionMismatch, not silently accepted (Codex review round 1 of the M7 PR)', async () => {
    // M7 adds a trailing WorldExtras.orders block a stale (pre-M7) client's own decoder has
    // no idea to read -- PROTOCOL_VERSION bumped 3 -> 4 specifically so this handshake check
    // catches that instead of a stale client desyncing or crashing on its first snapshot.
    const versionWorld = createWorld(terrain, 1, 8);
    const versionSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [0, 0, 0], radius: 5 }];
    const versionServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: versionWorld,
      spawns: versionSpawns,
      port: TEST_PORT + 28,
    });
    await versionServer.ready;
    const client = await connect(TEST_PORT + 28);
    const welcomePromise = receive(client);
    client.send(new Uint8Array([MessageType.Join, PROTOCOL_VERSION - 1]));
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.status).toBe(WelcomeStatus.VersionMismatch);
    client.close();
    versionServer.close();
  });

  it('a CommandOrder naming an out-of-range kind, or a non-finite x/z, issues no order (Codex review round 1 of the M7 PR)', async () => {
    const orderWorld = createWorld(terrain, 1, 8);
    const orderSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [0, 0, 0], radius: 5 }];
    const board = createOrderBoard();
    const orderServer = startNetServer({
      botManager: emptyBotManager(),
      board,
      world: orderWorld,
      spawns: orderSpawns,
      port: TEST_PORT + 26,
    });
    await orderServer.ready;
    const client = await connect(TEST_PORT + 26);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    client.send(encodeCommandOrder({ kind: 99 as OrderKind, x: 0, z: 0 }));
    client.send(encodeCommandOrder({ kind: OrderKind.Attack, x: Number.NaN, z: 0 }));
    client.send(encodeCommandOrder({ kind: OrderKind.Attack, x: 0, z: Number.POSITIVE_INFINITY }));
    await wait(10);
    orderServer.tick(1);
    expect(currentOrder(board, 1, orderWorld.tick)).toBeNull();
    client.close();
    orderServer.close();
  });

  it("a reused player id does not inherit a previous occupant's VoiceBind cooldown after disconnect (Codex review round 1 of the M7 PR)", async () => {
    const voiceWorld = createWorld(terrain, 1, 8);
    const voiceSpawns: SceneSpawn[] = [{ name: null, team: 1, position: [0, 0, 0], radius: 5 }];
    const voiceServer = startNetServer({
      botManager: emptyBotManager(),
      board: createOrderBoard(),
      world: voiceWorld,
      spawns: voiceSpawns,
      port: TEST_PORT + 27,
    });
    await voiceServer.ready;

    const first = await connect(TEST_PORT + 27);
    const firstWelcome = receive(first);
    first.send(encodeJoin());
    await firstWelcome;
    first.send(encodeVoiceBind({ lineId: 0 }));
    await wait(10);
    voiceServer.tick(1);
    first.close();
    await wait(10);
    voiceServer.tick(2); // handleClose runs synchronously on the close event, before this tick.

    // Single-player-slot world (capacity 1): the second connection's Join is guaranteed to
    // reuse playerId 0, the same id the first connection just held and used its own voice
    // bind cooldown on.
    const second = await connect(TEST_PORT + 27);
    const secondWelcome = receive(second);
    second.send(encodeJoin());
    await secondWelcome;
    const events: Uint8Array[] = [];
    second.on('message', (data) => events.push(new Uint8Array(data as Uint8Array)));
    second.send(encodeVoiceBind({ lineId: 1 }));
    await wait(10);
    voiceServer.tick(3);
    const voiceBindEvents = events
      .filter((bytes) => bytes[0] === MessageType.Event)
      .map((bytes) => decodeEvent(bytes))
      .filter((e) => e.kind === EventKind.VoiceBindPlayed);
    expect(voiceBindEvents).toHaveLength(1);
    second.close();
    voiceServer.close();
  });
});
