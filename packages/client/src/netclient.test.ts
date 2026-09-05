import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  FIXED_TICK_MS,
  addPlayer,
  createWorld,
  nextRandom,
  serializeActivePlayers,
  stepWorld,
  type Heightfield,
  type PlayerInput,
  type RandomState,
  type World,
} from '@clans/sim';
import {
  MessageType,
  SNAPSHOT_EVERY_N_TICKS,
  decodeInput,
  encodeSnapshot,
  encodeWelcome,
} from '@clans/protocol';
import { NetClient } from './netclient.js';
import type { Transport } from './transport.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const clock = { ms: 0 };
const LATENCY_MS = 150;
const LOSS_CHANCE = 0.05;

function makeLink(random: RandomState) {
  let pending: Array<{ atMs: number; bytes: Uint8Array }> = [];
  return {
    send(bytes: Uint8Array): void {
      if (nextRandom(random) < LOSS_CHANCE) return;
      pending.push({ atMs: clock.ms + LATENCY_MS, bytes });
    },
    drain(): Uint8Array[] {
      const ready = pending.filter((item) => item.atMs <= clock.ms);
      pending = pending.filter((item) => item.atMs > clock.ms);
      return ready.map((item) => item.bytes);
    },
  };
}
function makeTransport(
  uplink: ReturnType<typeof makeLink>,
): Transport & { pump: (incoming: Uint8Array[]) => void; setOpen: (open: boolean) => void } {
  let handler: ((bytes: Uint8Array) => void) | null = null;
  let open = true;
  return {
    send: (bytes) => uplink.send(bytes),
    onMessage: (h) => {
      handler = h;
    },
    close: () => {
      open = false;
    },
    isOpen: () => open,
    setOpen: (value) => {
      open = value;
    },
    pump: (incoming) => {
      for (const bytes of incoming) handler?.(bytes);
    },
  };
}

type Positions = Map<number, [number, number]>;

/** Largest client/server gap over the sequences both sides recorded after `settled`. */
function worstDistance(clientAt: Positions, serverAt: Positions, settled: number) {
  let compared = 0;
  let worst = 0;
  for (const [sequence, [sx, sz]] of serverAt) {
    const client = clientAt.get(sequence);
    if (sequence <= settled || !client) continue;
    compared += 1;
    worst = Math.max(worst, Math.hypot(client[0] - sx, client[1] - sz));
  }
  return { compared, worst };
}

describe('NetClient', () => {
  it('keeps prediction within 0.5 m of the server after a 3 s ski run at 150ms latency, 5% loss', () => {
    clock.ms = 0;
    const clientToServer = makeLink({ value: 1 });
    const serverToClient = makeLink({ value: 2 });
    const transport = makeTransport(clientToServer);
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0; // this test skips the join handshake and assigns the id directly

    const server = createWorld(terrain, 1, 4);
    addPlayer(server, { x: 500, y: 0, z: 500 }, 1);
    let nextSnapshotId = 1;
    let lastInputSequence = 0;
    const skiInput: PlayerInput = { moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false };
    // Like the real server: step with the newest input received, idle until the first arrives.
    let serverInput: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };
    const totalTicks = Math.ceil(3 / FIXED_DT);
    // Prediction is judged at equal input sequence: the client's position right after it
    // applied input n must match the server's position right after it applied input n.
    // Comparing the client's present to the server's present would measure latency, not error.
    const clientAt = new Map<number, [number, number]>();
    const serverAt = new Map<number, [number, number]>();
    const positionOf = (world: World): [number, number] => [
      world.players.position[0] ?? 0,
      world.players.position[2] ?? 0,
    ];

    // Run 3 s of client ticks, then let the last inputs reach the server.
    const drainTicks = Math.ceil((LATENCY_MS * 2) / FIXED_TICK_MS);
    for (let tick = 0; tick < totalTicks + drainTicks; tick += 1) {
      clock.ms += FIXED_TICK_MS;
      let arrived = 0;
      for (const bytes of clientToServer.drain()) {
        if (bytes[0] !== MessageType.Input) continue;
        const message = decodeInput(bytes);
        if (message.sequence > lastInputSequence) {
          lastInputSequence = message.sequence;
          serverInput = message.samples[0];
          arrived = message.sequence;
        }
      }
      stepWorld(server, new Map([[0, serverInput]]));
      if (arrived > 0) serverAt.set(arrived, positionOf(server));
      if (tick % SNAPSHOT_EVERY_N_TICKS === 0) {
        const players = serializeActivePlayers(server);
        serverToClient.send(
          encodeSnapshot(nextSnapshotId, server.tick, lastInputSequence, players, null),
        );
        nextSnapshotId += 1;
      }
      transport.pump(serverToClient.drain());
      if (tick < totalTicks) {
        client.tick(skiInput);
        clientAt.set(tick + 1, positionOf(client.world));
      }
    }

    // The client spawns at the origin and only learns its server position from the first
    // snapshot, so skip the sequences before two snapshot round trips have happened.
    const settled = Math.ceil((LATENCY_MS * 4) / FIXED_TICK_MS);
    const { compared, worst } = worstDistance(clientAt, serverAt, settled);
    expect(compared).toBeGreaterThan(50);
    expect(worst).toBeLessThan(0.5);
  });

  it('decodes a delta baselined on an older snapshot still in its history (a lost ack)', () => {
    // Codex round 1 (PR #4): the client kept only the newest decoded snapshot as its
    // baseline candidate. Repro from the finding: full 1 arrives, delta 2 arrives and its
    // ack is lost, then delta 3 arrives baselined on 1 (the server never learned the
    // client had moved past it). The old code rejected 3 until the 1 s full fallback.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 8 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const base = {
      id: 0,
      team: 1,
      y: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      energy: 60,
      onGround: 1 as const,
      ski: 0 as const,
    };
    const state1 = { ...base, x: 1, z: 0 };
    const state2 = { ...base, x: 2, z: 0 };
    const state3 = { ...base, x: 3, z: 0 };
    transport.pump([encodeSnapshot(1, 0, 0, [state1], null)]);
    transport.pump([encodeSnapshot(2, 2, 0, [state2], { snapshotId: 1, players: [state1] })]);
    transport.pump([encodeSnapshot(3, 4, 0, [state3], { snapshotId: 1, players: [state1] })]);
    expect(client.stats.packetLossEstimate).toBe(0);
    expect(client.world.players.position[0]).toBe(3);
  });

  it('survives a Snapshot frame too short to hold a header instead of throwing out of the handler', () => {
    // Codex round 2 (PR #4): peekSnapshotHeader ran before the try/catch that wraps
    // decodeSnapshot, so a malformed frame it couldn't even peek threw straight out of
    // the transport's message handler instead of being counted as a dropped packet.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 10 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    expect(() => transport.pump([Uint8Array.of(MessageType.Snapshot)])).not.toThrow();
    expect(client.stats.packetLossEstimate).toBeGreaterThan(0);
  });

  it('survives a Welcome frame too short to hold its fields instead of throwing out of the handler', () => {
    // Codex round 3 (PR #4): handleMessage dispatched to handleWelcome with no catch of
    // its own, so a truncated Welcome (or one carrying a non-finite spawn, per
    // handshake.ts's new check) threw a RangeError straight out of the transport's
    // message handler instead of being dropped like any other malformed frame.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 12 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    expect(() => transport.pump([Uint8Array.of(MessageType.Welcome)])).not.toThrow();
    expect(client.playerId).toBe(-1);
  });

  it('caps its input backlog even while the transport stays open but stops receiving snapshots', () => {
    // Codex round 2 (PR #4): isOpen() stays true for a live-but-stalled connection (the
    // socket never closed, the server or network just stopped producing snapshots), so
    // gating growth on isOpen() alone did not bound pendingInputs/inputSentAt in that case.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 11 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const skiInput: PlayerInput = { moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false };
    // Well past the ceiling (4x MAX_REPLAY_TICKS), and well past the existing "40 ticks,
    // then reconcile hard-snaps" scenario this must not disturb.
    for (let i = 0; i < 500; i += 1) client.tick(skiInput);
    const pending = (client as unknown as { pendingInputs: unknown[] }).pendingInputs;
    const sentAt = (client as unknown as { inputSentAt: Map<number, number> }).inputSentAt;
    expect(pending.length).toBe(120);
    expect(sentAt.size).toBeLessThanOrEqual(120);
  });

  it('drops a delta whose baseline it never received and keeps running', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 9 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const state = {
      id: 0,
      team: 1,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      energy: 60,
      onGround: 1 as const,
      ski: 0 as const,
    };
    const delta = encodeSnapshot(7, 3, 0, [state], { snapshotId: 6, players: [state] });
    expect(() => transport.pump([delta])).not.toThrow();
    expect(client.stats.packetLossEstimate).toBeGreaterThan(0);
    expect(() => client.tick({ moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false })).not.toThrow();
  });

  it('hard-snaps and records a prediction error when the replay backlog exceeds 30 ticks', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 5 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;

    const skiInput: PlayerInput = { moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false };
    for (let tick = 0; tick < 40; tick += 1) {
      clock.ms += FIXED_TICK_MS;
      client.tick(skiInput);
    }
    expect(client.stats.predictionErrorM).toBe(0);

    const serverState = {
      id: 0,
      team: 1,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      energy: 60,
      onGround: 1 as const,
      ski: 0 as const,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [serverState], null)]);

    expect(client.stats.predictionErrorM).toBeGreaterThan(0);
    expect(client.world.players.position[0]).toBe(0);
  });

  it('stops growing its input backlog once the transport closes', () => {
    // Codex round 1 (PR #4): a closed transport silently drops sends, but tick() kept
    // appending to pendingInputs/inputSentAt regardless, and nothing else ever prunes
    // them once no more snapshots arrive to reconcile against.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 3 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const skiInput: PlayerInput = { moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false };
    for (let i = 0; i < 5; i += 1) client.tick(skiInput);
    const pending = (client as unknown as { pendingInputs: unknown[] }).pendingInputs;
    expect(pending.length).toBe(5);

    transport.setOpen(false);
    for (let i = 0; i < 200; i += 1) client.tick(skiInput);
    expect(pending.length).toBe(5);
    // Local prediction still runs even though nothing is tracked for reconciliation.
    expect(client.world.players.position[2] ?? 0).toBeGreaterThan(0);
  });

  it('applies the real mission spawn from Welcome instead of defaulting to the world origin', () => {
    // Codex round 1 (PR #4): deserializePlayer never touches spawn, and the local world
    // is built with spawn (0,0,0) before Welcome arrives. A client that fell below the
    // kill plane before its first snapshot reset to the origin, not the mission spawn
    // the server would place it at.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 7 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    transport.pump([
      encodeWelcome({
        playerId: 2,
        team: 1,
        tickMs: FIXED_TICK_MS,
        spawnX: 500,
        spawnY: 10,
        spawnZ: 500,
      }),
    ]);
    expect(client.playerId).toBe(2);
    expect([...client.world.players.spawn.slice(0, 3)]).toEqual([500, 10, 500]);
  });

  it('syncs wasGrounded from the server snapshot during reconciliation', () => {
    // Codex round 1 (PR #4): deserializePlayer does not touch wasGrounded/wasJumpHeld,
    // so a reconcile replayed pending inputs against this client's own stale pre-reconcile
    // jump-edge state instead of the server's.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 6 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    client.world.players.wasGrounded[0] = 1;
    client.world.players.wasJumpHeld[0] = 1;
    const serverState = {
      id: 0,
      team: 1,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      energy: 60,
      onGround: 0 as const,
      ski: 0 as const,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [serverState], null)]);
    expect(client.world.players.wasGrounded[0]).toBe(0);
    expect(client.world.players.wasJumpHeld[0]).toBe(0);
  });
});
