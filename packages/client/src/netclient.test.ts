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
} from '@clans/sim';
import { MessageType, SNAPSHOT_EVERY_N_TICKS, decodeInput, encodeSnapshot } from '@clans/protocol';
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
): Transport & { pump: (incoming: Uint8Array[]) => void } {
  let handler: ((bytes: Uint8Array) => void) | null = null;
  return {
    send: (bytes) => uplink.send(bytes),
    onMessage: (h) => {
      handler = h;
    },
    close: () => {},
    pump: (incoming) => {
      for (const bytes of incoming) handler?.(bytes);
    },
  };
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
    const totalTicks = Math.ceil(3 / FIXED_DT);

    for (let tick = 0; tick < totalTicks; tick += 1) {
      clock.ms += FIXED_TICK_MS;
      for (const bytes of clientToServer.drain()) {
        if (bytes[0] === MessageType.Input) lastInputSequence = decodeInput(bytes).sequence;
      }
      stepWorld(server, new Map([[0, skiInput]]));
      if (tick % SNAPSHOT_EVERY_N_TICKS === 0) {
        const players = serializeActivePlayers(server);
        serverToClient.send(
          encodeSnapshot(nextSnapshotId, server.tick, lastInputSequence, players, null),
        );
        nextSnapshotId += 1;
      }
      transport.pump(serverToClient.drain());
      client.tick(skiInput);
    }

    const serverX = server.players.position[0] ?? 0;
    const serverZ = server.players.position[2] ?? 0;
    const clientX = client.world.players.position[0] ?? 0;
    const clientZ = client.world.players.position[2] ?? 0;
    expect(Math.hypot(clientX - serverX, clientZ - serverZ)).toBeLessThan(0.5);
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
});
