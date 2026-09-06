import net from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPlayer,
  createFlags,
  createWorld,
  FlagState,
  type Heightfield,
  type PlayerInput,
  type World,
} from '@clans/sim';
import {
  decodeEvent,
  decodeSnapshot,
  decodeWelcome,
  encodeAck,
  encodeInput,
  encodeJoin,
  EventKind,
  MessageType,
  type NetInputSample,
} from '@clans/protocol';
import { startNetServer, type NetServer } from './net.js';
import type { SceneSpawn } from './world.js';

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
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startNetServer', () => {
  let server: NetServer;
  let world: World;

  beforeEach(async () => {
    world = createWorld(terrain, 1, 8);
    server = startNetServer({ world, spawns, port: TEST_PORT });
    await server.ready;
  });
  afterEach(() => server.close());

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
    const busy = startNetServer({ world: createWorld(terrain, 1, 4), spawns, port: TEST_PORT });
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
    const shutdownServer = startNetServer({ world: shutdownWorld, spawns, port });
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
    const fullServer = startNetServer({ world: fullWorld, spawns, port });
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
    };
    // Walk the target across the shot line for a few ticks (recorded into lag-comp history),
    // then jump it far away right before the shot — the laggy shooter's screen still shows
    // it in the old spot.
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], targetId * 3);
      lagServer.tick(3 + step);
    }
    world.players.position.set([500, 0, 500], targetId * 3);

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

    const fire: NetInputSample = { ...idle, slot: 4, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // fires with the target rewound ~150ms back onto the shot line

    expect(world.players.damage[targetId]).toBeGreaterThan(0);
    shooter.close();
    lagServer.close();
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
    };
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], targetId * 3);
      lagServer.tick(3 + step);
    }
    world.players.position.set([500, 0, 500], targetId * 3);

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
    const flagServer = startNetServer({ world, spawns, port: TEST_PORT + 6, now: () => clock });
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
    expect(events.some((event) => event.kind === EventKind.LaserFired)).toBe(true);
    client.close();
  });
});
