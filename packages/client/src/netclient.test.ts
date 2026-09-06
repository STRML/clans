import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  FIXED_TICK_MS,
  RESPAWN_TICKS,
  WeaponId,
  WeaponState,
  addPlayer,
  ammoIndex,
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
  EventKind,
  MessageType,
  SNAPSHOT_EVERY_N_TICKS,
  WelcomeStatus,
  decodeGod,
  decodeInput,
  emptyExtras,
  encodeEvent,
  encodeSnapshot,
  encodeWelcome,
  type WorldExtras,
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
function makeTransport(uplink: ReturnType<typeof makeLink>): Transport & {
  pump: (incoming: Uint8Array[]) => void;
  setOpen: (open: boolean) => void;
  setConnected: (connected: boolean) => void;
} {
  let handler: ((bytes: Uint8Array) => void) | null = null;
  let open = true;
  let connected = true;
  return {
    send: (bytes) => uplink.send(bytes),
    onMessage: (h) => {
      handler = h;
    },
    close: () => {
      open = false;
    },
    isOpen: () => open,
    // Mirrors WebSocketTransport: CLOSED (open false) is never "connected" regardless of
    // the connected flag, which otherwise distinguishes CONNECTING from OPEN.
    isConnected: () => open && connected,
    setOpen: (value) => {
      open = value;
    },
    setConnected: (value) => {
      connected = value;
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
    const skiInput: PlayerInput = {
      moveX: 0,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      jump: true,
      jet: false,
      fire: false,
      altFire: false,
      slot: 0,
    };
    // Like the real server: step with the newest input received, idle until the first arrives.
    let serverInput: PlayerInput = {
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
          encodeSnapshot(
            nextSnapshotId,
            server.tick,
            lastInputSequence,
            players,
            null,
            emptyExtras(),
          ),
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
      health: 60,
      weaponSlot: 4,
      onGround: 1 as const,
      ski: 0 as const,
    };
    const state1 = { ...base, x: 1, z: 0 };
    const state2 = { ...base, x: 2, z: 0 };
    const state3 = { ...base, x: 3, z: 0 };
    transport.pump([encodeSnapshot(1, 0, 0, [state1], null, emptyExtras())]);
    transport.pump([
      encodeSnapshot(2, 2, 0, [state2], { snapshotId: 1, players: [state1] }, emptyExtras()),
    ]);
    transport.pump([
      encodeSnapshot(3, 4, 0, [state3], { snapshotId: 1, players: [state1] }, emptyExtras()),
    ]);
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

  it('applies the Welcome spawn to the predicted position, not just the respawn point', () => {
    // Codex round 7 (PR #4): the local player is created at (0,0,0) in the constructor,
    // before any Welcome can arrive. handleWelcome only updated players.spawn (used for
    // kill-plane respawn), so the client kept predicting from the map origin instead of
    // the real spawn until the first snapshot happened to reconcile it away.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 13 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    transport.pump([
      encodeWelcome({
        playerId: 0,
        team: 1,
        tickMs: FIXED_TICK_MS,
        status: WelcomeStatus.Ok,
        spawnX: 500,
        spawnY: 10,
        spawnZ: 500,
      }),
    ]);
    expect(Array.from(client.world.players.position.slice(0, 3))).toEqual([500, 10, 500]);
  });

  it('resets velocity and energy on a delayed Welcome, not just position', () => {
    // Codex round 8 (PR #4): tick() mutates velocity/energy/onGround before the handshake
    // completes, but handleWelcome only reset spawn and position. A slow first round trip
    // leaves time for several ticks of local prediction from the (0,0,0) placeholder, so
    // velocity and energy carried that stale prediction straight through the "corrected" state.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 14 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
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
    for (let i = 0; i < 5; i += 1) client.tick(forward);
    expect(client.world.players.velocity[2]).not.toBe(0);

    transport.pump([
      encodeWelcome({
        playerId: 0,
        team: 1,
        tickMs: FIXED_TICK_MS,
        status: WelcomeStatus.Ok,
        spawnX: 500,
        spawnY: 10,
        spawnZ: 500,
      }),
    ]);
    expect(Array.from(client.world.players.velocity.slice(0, 3))).toEqual([0, 0, 0]);
    expect(client.world.players.energy[0]).toBe(60);
  });

  it('caps its input backlog even while the transport stays open but stops receiving snapshots', () => {
    // Codex round 2 (PR #4): isOpen() stays true for a live-but-stalled connection (the
    // socket never closed, the server or network just stopped producing snapshots), so
    // gating growth on isOpen() alone did not bound pendingInputs/inputSentAt in that case.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 11 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const skiInput: PlayerInput = {
      moveX: 0,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      jump: true,
      jet: false,
      fire: false,
      altFire: false,
      slot: 0,
    };
    // Well past the ceiling (4x MAX_REPLAY_TICKS), and well past the existing "40 ticks,
    // then reconcile hard-snaps" scenario this must not disturb.
    for (let i = 0; i < 500; i += 1) client.tick(skiInput);
    const pending = (client as unknown as { pendingInputs: unknown[] }).pendingInputs;
    const sentAt = (client as unknown as { inputSentAt: Map<number, number> }).inputSentAt;
    expect(pending.length).toBe(120);
    expect(sentAt.size).toBeLessThanOrEqual(120);
  });

  it('does not advance the wire sequence while still connecting, only once truly open', () => {
    // Codex round 14 (PR #4): isOpen() is true for both CONNECTING and OPEN, so a slow
    // handshake let tick() advance this.sequence every tick before a single byte had
    // actually been sent. A fresh server session expects a client's first real message
    // near sequence 1; a handshake slow enough to run this past MAX_SEQUENCE_JUMP first
    // (about 5m20s at FIXED_TICK_MS) made every subsequent input rejected forever.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 16 }));
    transport.setConnected(false); // still CONNECTING: isOpen() is true, isConnected() is not
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    const idleInput: PlayerInput = {
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
    for (let i = 0; i < 20_000; i += 1) client.tick(idleInput);
    expect((client as unknown as { sequence: number }).sequence).toBe(0);

    transport.setConnected(true); // the handshake finally completes
    client.tick(idleInput);
    expect((client as unknown as { sequence: number }).sequence).toBe(1);
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
      health: 60,
      weaponSlot: 4,
      onGround: 1 as const,
      ski: 0 as const,
    };
    const delta = encodeSnapshot(
      7,
      3,
      0,
      [state],
      { snapshotId: 6, players: [state] },
      emptyExtras(),
    );
    expect(() => transport.pump([delta])).not.toThrow();
    expect(client.stats.packetLossEstimate).toBeGreaterThan(0);
    expect(() =>
      client.tick({
        moveX: 0,
        moveZ: 1,
        yaw: 0,
        pitch: 0,
        jump: true,
        jet: false,
        fire: false,
        altFire: false,
        slot: 0,
      }),
    ).not.toThrow();
  });

  it('bounds the packet-loss loop instead of freezing on a forged snapshotId gap', () => {
    // Codex round 13 (PR #4): snapshotId is an arbitrary wire u32, and recordLoss ran its
    // loop once per id it judged missing, with no bound. A server reached through the
    // user-selectable ?server= parameter could send ids 1 then 0xffffffff, which the old
    // code would treat as ~4.3 billion missing snapshots and freeze the tab counting them.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 15 }));
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
      health: 60,
      weaponSlot: 4,
      onGround: 1 as const,
      ski: 0 as const,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [state], null, emptyExtras())]);
    expect(() =>
      transport.pump([encodeSnapshot(0xffffffff, 2, 0, [state], null, emptyExtras())]),
    ).not.toThrow();

    const lossWindow = (client as unknown as { lossWindow: number[] }).lossWindow;
    expect(lossWindow.length).toBeLessThanOrEqual(50);
    expect(client.stats.packetLossEstimate).toBeGreaterThan(0.9);
  });

  it('hard-snaps and records a prediction error when the replay backlog exceeds 30 ticks', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 5 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;

    const skiInput: PlayerInput = {
      moveX: 0,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      jump: true,
      jet: false,
      fire: false,
      altFire: false,
      slot: 0,
    };
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
      health: 60,
      weaponSlot: 4,
      onGround: 1 as const,
      ski: 0 as const,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [serverState], null, emptyExtras())]);

    expect(client.stats.predictionErrorM).toBeGreaterThan(0);
    expect(client.world.players.position[0]).toBe(0);
    // Codex round 4 (PR #4): the hard-snap cleared pendingInputs but left every discarded
    // sequence's inputSentAt entry behind -- lastInputSequence was 0, so updatePing's own
    // cleanup never touched them, and no ack for a sequence just thrown away can ever
    // arrive to clean it up otherwise.
    const sentAt = (client as unknown as { inputSentAt: Map<number, number> }).inputSentAt;
    expect(sentAt.size).toBe(0);
  });

  it('stops growing its input backlog once the transport closes', () => {
    // Codex round 1 (PR #4): a closed transport silently drops sends, but tick() kept
    // appending to pendingInputs/inputSentAt regardless, and nothing else ever prunes
    // them once no more snapshots arrive to reconcile against.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 3 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const skiInput: PlayerInput = {
      moveX: 0,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      jump: true,
      jet: false,
      fire: false,
      altFire: false,
      slot: 0,
    };
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
        status: WelcomeStatus.Ok,
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
      health: 60,
      weaponSlot: 4,
      onGround: 0 as const,
      ski: 0 as const,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [serverState], null, emptyExtras())]);
    expect(client.world.players.wasGrounded[0]).toBe(0);
    expect(client.world.players.wasJumpHeld[0]).toBe(0);
  });

  it('exposes projectiles, flags, team scores, and game over from the snapshot extras', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 11 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const extras: WorldExtras = {
      projectiles: [
        { id: 0, type: 0, weaponId: 0, x: 1, y: 2, z: 3, vx: 90, vy: 0, vz: 0, ownerId: 0 },
      ],
      flags: [{ id: 0, team: 1, state: 1, x: 5, y: 0, z: 5, carrierId: 0, returnInS: -1 }],
      teamScores: [100, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 1200.5,
      gameOverReason: 0,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [], null, extras)]);
    expect(client.projectiles).toEqual(extras.projectiles);
    expect(client.flags).toEqual(extras.flags);
    expect(client.teamScores).toEqual([100, 0]);
    expect(client.gameOver).toBe(false);
    expect(client.timeRemainingS).toBeCloseTo(1200.5, 1);
    expect(client.gameOverReason).toBe(0);
  });

  it('mirrors gameOver/winnerTeam/gameOverReason onto world so stepWorld freezes prediction', () => {
    // Codex review round 2 (PR #9), finding 3: round 1 added an early-return freeze guard
    // to stepWorld that checks world.gameOver, but the snapshot handler only ever updated
    // this NetClient's own gameOver/winnerTeam/gameOverReason fields, never the world's --
    // tick() keeps calling stepWorld(this.world, ...) every frame regardless, so the
    // client's local world never learned the match had ended and kept predicting movement,
    // weapon timers, ammo, and unacknowledged-input replay after the server had frozen.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 21 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const extras: WorldExtras = {
      projectiles: [],
      flags: [],
      teamScores: [3, 1],
      gameOver: true,
      winnerTeam: 1,
      timeRemainingS: 0,
      gameOverReason: 1,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [], null, extras)]);

    expect(client.gameOver).toBe(true);
    expect(client.world.gameOver).toBe(true);
    expect(client.world.winnerTeam).toBe(1);
    expect(client.world.gameOverReason).toBe(1);

    const beforeX = client.world.players.position[0] ?? 0;
    client.tick({
      moveX: 0,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      jump: false,
      jet: false,
      fire: false,
      altFire: false,
      slot: 0,
    });
    expect(client.world.players.position[0] ?? 0).toBe(beforeX);
  });

  it('does not replay a pending input past a game-over snapshot (Codex review round 3, residual of finding 3)', () => {
    // Round 2 mirrored gameOver onto world.gameOver so stepWorld's freeze guard could
    // engage, but within handleSnapshot that assignment ran AFTER reconcile() had
    // already replayed any pending (unacknowledged) local inputs. The very first
    // game-over snapshot therefore still let one extra tick of local prediction run
    // against a world that had not yet been told the match ended.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 31 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;

    const forwardInput: PlayerInput = {
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
    // Leave this input unacknowledged: the snapshot below names lastInputSequence 0,
    // so reconcile() will still find it pending and eligible for replay.
    client.tick(forwardInput);
    expect(client.world.players.position[2] ?? 0).toBeGreaterThan(0);

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
      health: 60,
      weaponSlot: 4,
      onGround: 1 as const,
      ski: 0 as const,
    };
    const extras: WorldExtras = {
      projectiles: [],
      flags: [],
      teamScores: [3, 1],
      gameOver: true,
      winnerTeam: 1,
      timeRemainingS: 0,
      gameOverReason: 1,
    };
    transport.pump([encodeSnapshot(1, 1, 0, [serverState], null, extras)]);

    // reconcile() sets position/tick to the server's authoritative (0,0,0)/1. The freeze
    // guard must already be active by the time reconcile() replays the pending
    // forwardInput, so no extra tick of movement or tick advance is layered on top.
    expect(client.world.players.position[0]).toBe(0);
    expect(client.world.players.position[2]).toBe(0);
    expect(client.world.tick).toBe(1);
  });

  it('reads localHealth off the reconciled snapshot for the local player', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 12 }));
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
      health: 0.4,
      weaponSlot: 0,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [state], null, emptyExtras())]);
    expect(client.localHealth).toBeCloseTo(0.4);
  });

  it('collects incoming Event messages into a bounded rolling history', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 13 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    transport.pump([encodeEvent({ kind: EventKind.PlayerKilled, a: 1, b: 2 })]);
    expect(client.recentEvents).toEqual([
      { type: MessageType.Event, kind: EventKind.PlayerKilled, a: 1, b: 2, seq: 1 },
    ]);
  });

  it('tags each event with a never-reused, ever-increasing sequence number', () => {
    // Codex review round 1, finding 14 (PR #9): a consumer tracking "new since last
    // frame" by array index into this rolling buffer breaks once the buffer's own
    // eviction (past its 100-event cap) shifts everything down. seq is assigned once, at
    // receipt, and never reused, so it survives eviction where an index cannot.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 17 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    for (let i = 0; i < 105; i += 1) {
      transport.pump([encodeEvent({ kind: EventKind.PlayerKilled, a: 0, b: i })]);
    }
    expect(client.recentEvents).toHaveLength(100);
    const seqs = client.recentEvents.map((event) => event.seq);
    expect(seqs[0]).toBe(6); // the first 5 (seq 1..5) were evicted past the 100-event cap
    expect(seqs.at(-1)).toBe(105);
    expect(new Set(seqs).size).toBe(100); // every retained seq is unique
  });

  it('rejects a VersionMismatch Welcome instead of joining as if it had succeeded', () => {
    // Codex review round 1, finding 13 (PR #9): the handler ignored welcome.status
    // entirely and always assigned playerId/team, so a version-mismatch rejection from
    // the server still left the client reporting a live playerId and sending input until
    // the server eventually timed it out.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 18 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    transport.pump([
      encodeWelcome({
        playerId: 5,
        team: 1,
        tickMs: FIXED_TICK_MS,
        status: WelcomeStatus.VersionMismatch,
        spawnX: 500,
        spawnY: 10,
        spawnZ: 500,
      }),
    ]);
    expect(client.playerId).toBe(-1);
    expect(client.team).toBe(0);
    // Failed joins are surfaced through the same mechanism callers already watch
    // (transport.isOpen(), via the `connected` getter) rather than a parallel channel.
    expect(client.connected).toBe(false);
  });

  it('accepts an Ok Welcome exactly as before', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 19 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    transport.pump([
      encodeWelcome({
        playerId: 3,
        team: 2,
        tickMs: FIXED_TICK_MS,
        status: WelcomeStatus.Ok,
        spawnX: 100,
        spawnY: 5,
        spawnZ: 100,
      }),
    ]);
    expect(client.playerId).toBe(3);
    expect(client.team).toBe(2);
    expect(client.connected).toBe(true);
  });

  it('resets ammo, grenades, and weapon state on a locally-observed respawn transition', () => {
    // Codex review round 1, finding 1 (PR #9): ammo/grenades/weaponSlot/weaponState/
    // weaponTimer are not on the wire snapshot, so a real server-side respawn (a fresh
    // 15 discs) never reached this client's own prediction state -- it kept predicting
    // dry-fire from whatever ammo it had at the moment of death.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 20 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;

    // Spend every disc and grenade before dying, as the repro describes.
    client.world.players.ammo[ammoIndex(0, WeaponId.Spinfusor)] = 0;
    client.world.players.weaponSlot[0] = WeaponId.Spinfusor;
    client.world.players.grenades[0] = 0;

    const dead = {
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
      health: 0,
      weaponSlot: WeaponId.Spinfusor,
      onGround: 1 as const,
      ski: 0 as const,
    };
    transport.pump([encodeSnapshot(1, 10, 0, [dead], null, emptyExtras())]);
    expect(client.world.players.alive[0]).toBe(0);
    // Ammo/grenades must not be touched by death alone -- only a later respawn resets them.
    expect(client.world.players.ammo[ammoIndex(0, WeaponId.Spinfusor)]).toBe(0);

    const respawned = { ...dead, health: 60, weaponSlot: WeaponId.Blaster };
    transport.pump([encodeSnapshot(2, 20, 0, [respawned], null, emptyExtras())]);

    expect(client.world.players.alive[0]).toBe(1);
    expect(client.world.players.ammo[ammoIndex(0, WeaponId.Spinfusor)]).toBe(15);
    expect(client.world.players.ammo[ammoIndex(0, WeaponId.Chaingun)]).toBe(100);
    expect(client.world.players.grenades[0]).toBe(5);
    expect(client.world.players.weaponSlot[0]).toBe(WeaponId.Blaster);
    expect(client.world.players.weaponState[0]).toBe(WeaponState.Ready);
    expect(client.world.players.weaponTimer[0]).toBe(0);
    expect(client.world.players.respawnAt[0]).toBe(-1);
  });

  it('sets a local respawnAt on death so the HUD countdown does not read stale/zero time', () => {
    // Codex review round 1, finding 1 (PR #9): respawnAt is not on the wire snapshot and
    // the local world never runs a real death for a remotely-inflicted kill, so hud.ts's
    // countdown read whatever stale value was already there (often 0), showing "0s" for
    // the entire respawn wait instead of a real countdown.
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 21 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const alive = {
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
      health: 60,
      weaponSlot: 4,
      onGround: 1 as const,
      ski: 0 as const,
    };
    const dead = { ...alive, health: 0 };
    transport.pump([encodeSnapshot(1, 10, 0, [dead], null, emptyExtras())]);
    expect(client.world.players.respawnAt[0]).toBe(10 + RESPAWN_TICKS);
  });

  it('sends a God message when setGodMode is called', () => {
    clock.ms = 0;
    const link = makeLink({ value: 14 });
    const sent: Uint8Array[] = [];
    const rawSend = link.send.bind(link);
    link.send = (bytes) => {
      sent.push(bytes);
      rawSend(bytes);
    };
    const transport = makeTransport(link);
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.setGodMode(true);
    const god = sent.find((bytes) => bytes[0] === MessageType.God);
    expect(god && decodeGod(god)).toEqual({ type: MessageType.God, enabled: true });
  });
});
