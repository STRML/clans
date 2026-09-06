import net from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPlayer,
  createFlags,
  createWorld,
  FlagState,
  LIGHT_ARMOR,
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
  packActive: false,
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
            packActive: false,
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
      packActive: false,
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
      packActive: false,
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
      packActive: false,
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
      packActive: false,
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
    const lagServer = startNetServer({ world, spawns, port: TEST_PORT + 8, now: () => clock });
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
    const lagServer = startNetServer({ world, spawns, port: TEST_PORT + 9, now: () => clock });
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
    const lagServer = startNetServer({ world, spawns, port: TEST_PORT + 10, now: () => clock });
    await lagServer.ready;
    // Chaingun speed is 425 m/s at a 32 ms tick, so one tick of travel covers 13.6 m.
    const targetA = addPlayer(world, { x: 0, y: 0, z: 8 }, 2); // inside the first 0-13.6 m segment
    const targetB = addPlayer(world, { x: 0, y: 0, z: 20 }, 2); // inside the second 13.6-27.2 m segment

    const shooter = await connect(TEST_PORT + 10);
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
    world.players.respawnAt[deadId] = 0;
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
});
