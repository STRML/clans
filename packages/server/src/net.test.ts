import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type Heightfield, type PlayerInput, type World } from '@clans/sim';
import {
  decodeSnapshot,
  decodeWelcome,
  encodeAck,
  encodeInput,
  encodeJoin,
  MessageType,
} from '@clans/protocol';
import { startNetServer, type NetServer } from './net.js';
import type { SceneSpawn } from './world.js';

const idleSample: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };

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
          { moveX: Number.NaN, moveZ: 1, yaw: 0, jump: false, jet: false },
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

    // First message: nothing to catch up from yet, only the newest sample applies.
    client.send(encodeInput({ sequence: 1, samples: [idleSample, idleSample, idleSample] }));
    await wait(10);
    server.tick(2);

    // Second message covers ticks 2 and 3: samples are [newest=tick3, tick2, tick1(unused)].
    const forward: PlayerInput = { moveX: 0, moveZ: 1, yaw: 0, jump: false, jet: false };
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
});
