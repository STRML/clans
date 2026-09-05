import {
  addPlayer,
  createWorld,
  deserializePlayer,
  stepWorld,
  type Heightfield,
  type PlayerInput,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import {
  MessageType,
  SNAPSHOT_HISTORY_DEPTH,
  decodeSnapshot,
  decodeWelcome,
  encodeAck,
  encodeInput,
  encodeJoin,
  peekSnapshotHeader,
} from '@clans/protocol';
import type { SnapshotBaseline } from '@clans/protocol';
import type { Transport } from './transport.js';

const MAX_REPLAY_TICKS = 30;
// A generous ceiling on the backlog itself, well above MAX_REPLAY_TICKS: reconcile
// already hard-snaps and clears the backlog once it exceeds MAX_REPLAY_TICKS, so this
// only guards the case a snapshot never arrives to trigger that at all (a live-but-
// stalled connection). It must stay above any realistic brief-stall backlog or it would
// start silently dropping inputs reconcile's own, error-reporting hard-snap would
// otherwise have handled.
const MAX_PENDING_INPUTS = MAX_REPLAY_TICKS * 4;
const LOSS_WINDOW = 50;
const BYTES_WINDOW_MS = 1000;
const LOCAL_SLOT = 0;

interface PendingInput {
  sequence: number;
  input: PlayerInput;
}
export interface NetClientStats {
  ping: number;
  bytesPerSecond: number;
  packetLossEstimate: number;
  predictionErrorM: number;
  entityCount: number;
}
export interface NetClientOptions {
  now?: () => number;
}

export class NetClient {
  readonly world: World;
  playerId = -1;
  team = 0;
  remotePlayers = new Map<number, PlayerSnapshotData>();
  remoteTick = 0;
  stats: NetClientStats = {
    ping: 0,
    bytesPerSecond: 0,
    packetLossEstimate: 0,
    predictionErrorM: 0,
    entityCount: 1,
  };

  private readonly now: () => number;
  private sequence = 0;
  private pendingInputs: PendingInput[] = [];
  // The server deltas against the client's last ACKED snapshot, which can trail the
  // newest one it sent while an ack is in flight or lost. Keeping only the newest
  // decoded snapshot meant a lost ack made every following delta undecodable until the
  // 1 s full-snapshot fallback; a bounded history lets a delta name any recent baseline.
  private readonly snapshotHistory: SnapshotBaseline[] = [];
  private previousSnapshotId = 0;
  private readonly lossWindow: number[] = [];
  private readonly bytesWindow: Array<{ at: number; bytes: number }> = [];
  private readonly inputSentAt = new Map<number, number>();

  constructor(
    private readonly transport: Transport,
    terrain: Heightfield,
    options: NetClientOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.world = createWorld(terrain, 1, 1);
    addPlayer(this.world, { x: 0, y: 0, z: 0 });
    transport.onMessage((bytes) => this.handleMessage(bytes));
    transport.send(encodeJoin());
  }

  /** False once the transport has closed (or failed to open); never reopens. */
  get connected(): boolean {
    return this.transport.isOpen();
  }

  tick(input: PlayerInput): void {
    stepWorld(this.world, new Map([[LOCAL_SLOT, input]]));
    // Once the transport is closed it never delivers another snapshot to reconcile
    // against or prune these on, so tracking more of them here would only grow forever.
    // Local prediction keeps running (the stepWorld above); there is just nothing left
    // to replay it against.
    if (!this.transport.isOpen()) return;
    this.sequence += 1;
    this.pendingInputs.push({ sequence: this.sequence, input });
    // A live but stalled connection (socket still OPEN, server or network just stopped
    // producing snapshots) never trims this via reconcile either, since reconcile only
    // runs when a snapshot arrives. Cap it unconditionally so a stall that never ends
    // cannot grow this forever.
    if (this.pendingInputs.length > MAX_PENDING_INPUTS) {
      const dropped = this.pendingInputs.shift();
      if (dropped) this.inputSentAt.delete(dropped.sequence);
    }
    const samples: [PlayerInput, PlayerInput, PlayerInput] = [
      input,
      this.pendingInputs.at(-2)?.input ?? input,
      this.pendingInputs.at(-3)?.input ?? input,
    ];
    this.inputSentAt.set(this.sequence, this.now());
    this.transport.send(encodeInput({ sequence: this.sequence, samples }));
  }

  private handleMessage(bytes: Uint8Array): void {
    const type = bytes[0];
    try {
      // handleSnapshot already has its own inner try/catch for the loss-accounting it
      // does on a bad frame; this one exists for handleWelcome (and any other message
      // this dispatch grows), which has no such fallback and let a truncated or
      // non-finite-spawn Welcome throw straight out of the transport's message handler.
      if (type === MessageType.Welcome) this.handleWelcome(bytes);
      else if (type === MessageType.Snapshot) this.handleSnapshot(bytes);
    } catch {
      // Malformed frame: drop it. There is nothing to ack or reconcile against.
    }
  }

  private handleWelcome(bytes: Uint8Array): void {
    const welcome = decodeWelcome(bytes);
    this.playerId = welcome.playerId;
    this.team = welcome.team;
    // Without the real spawn, a client that mispredicts falling below the kill plane
    // before its first snapshot arrives resets to the local world's default (0,0,0)
    // instead of the mission spawn the server would reset it to.
    this.world.players.spawn.set([welcome.spawnX, welcome.spawnY, welcome.spawnZ], LOCAL_SLOT * 3);
    // The local player is created at (0,0,0) in the constructor, before any Welcome can
    // arrive. Without also applying the spawn to position here, the client renders and
    // predicts from the map origin instead of the real spawn until the first snapshot
    // reconciles it away, which is visible whenever that snapshot is delayed.
    this.world.players.position.set(
      [welcome.spawnX, welcome.spawnY, welcome.spawnZ],
      LOCAL_SLOT * 3,
    );
  }

  private pushSnapshotHistory(entry: SnapshotBaseline): void {
    this.snapshotHistory.push(entry);
    if (this.snapshotHistory.length > SNAPSHOT_HISTORY_DEPTH) this.snapshotHistory.shift();
  }

  private handleSnapshot(bytes: Uint8Array): void {
    this.recordBytes(bytes.byteLength);
    let decoded;
    try {
      // peekSnapshotHeader reads the same fixed-size header decodeSnapshot does, so a
      // frame too short to hold one throws here just as readily as inside decodeSnapshot
      // itself; it has to share this same try/catch rather than run ahead of it.
      const header = peekSnapshotHeader(bytes);
      const baseline = header.isDelta
        ? (this.snapshotHistory.find((entry) => entry.snapshotId === header.baselineId) ?? null)
        : null;
      decoded = decodeSnapshot(bytes, baseline);
    } catch {
      // A malformed frame, or a delta against a baseline outside our history (older than
      // SNAPSHOT_HISTORY_DEPTH sends ago, or one we never received at all). Count it as
      // loss and do not ack; the server's 1 s fallback then sends a full snapshot.
      this.pushLoss(0);
      return;
    }
    this.recordLoss(decoded.snapshotId);
    this.updatePing(decoded.lastInputSequence);
    this.pushSnapshotHistory({ snapshotId: decoded.snapshotId, players: decoded.players });
    this.transport.send(encodeAck({ snapshotId: decoded.snapshotId }));

    const self = decoded.players.find((player) => player.id === this.playerId);
    if (self) this.reconcile(self, decoded.tick, decoded.lastInputSequence);

    this.remotePlayers = new Map(
      decoded.players
        .filter((player) => player.id !== this.playerId)
        .map((player) => [player.id, player]),
    );
    this.remoteTick = decoded.tick;
    this.stats.entityCount = decoded.players.length;
  }

  private reconcile(
    serverState: PlayerSnapshotData,
    serverTick: number,
    lastInputSequence: number,
  ): void {
    const beforeX = this.world.players.position[0] ?? 0;
    const beforeZ = this.world.players.position[2] ?? 0;
    deserializePlayer(this.world, { ...serverState, id: LOCAL_SLOT });
    // The wire snapshot has no wasJumpHeld field, and deserializePlayer does not touch
    // spawn/wasGrounded/wasJumpHeld at all, so without this the replay below starts from
    // this client's own stale pre-reconcile jump-edge state rather than the server's.
    // onGround is on the wire; wasJumpHeld is not, so treat the jump key as freshly
    // pressed rather than trust a held-jump state the server never confirmed.
    this.world.players.wasGrounded[LOCAL_SLOT] = serverState.onGround;
    this.world.players.wasJumpHeld[LOCAL_SLOT] = 0;
    this.world.tick = serverTick;
    this.pendingInputs = this.pendingInputs.filter(
      (pending) => pending.sequence > lastInputSequence,
    );
    if (this.pendingInputs.length > MAX_REPLAY_TICKS) {
      this.stats.predictionErrorM = Math.hypot(
        beforeX - (this.world.players.position[0] ?? 0),
        beforeZ - (this.world.players.position[2] ?? 0),
      );
      // These sequences are all > lastInputSequence, so updatePing's own cleanup loop
      // never touched them; discarding the backlog without also dropping their
      // inputSentAt entries here left them there forever, since no ack for a sequence
      // that was just thrown away can ever arrive to clean it up.
      for (const pending of this.pendingInputs) this.inputSentAt.delete(pending.sequence);
      this.pendingInputs = [];
      return;
    }
    this.stats.predictionErrorM = 0;
    for (const pending of this.pendingInputs)
      stepWorld(this.world, new Map([[LOCAL_SLOT, pending.input]]));
  }

  private recordLoss(snapshotId: number): void {
    if (this.previousSnapshotId !== 0) {
      const gap = Math.max(0, snapshotId - this.previousSnapshotId - 1);
      for (let i = 0; i < gap; i += 1) this.pushLoss(0);
      this.pushLoss(1);
    }
    this.previousSnapshotId = snapshotId;
  }
  private pushLoss(sample: number): void {
    this.lossWindow.push(sample);
    if (this.lossWindow.length > LOSS_WINDOW) this.lossWindow.shift();
    const received = this.lossWindow.reduce((sum, value) => sum + value, 0);
    this.stats.packetLossEstimate = 1 - received / this.lossWindow.length;
  }

  private updatePing(lastInputSequence: number): void {
    const sentAt = this.inputSentAt.get(lastInputSequence);
    if (sentAt !== undefined) this.stats.ping = this.now() - sentAt;
    for (const sequence of this.inputSentAt.keys()) {
      if (sequence <= lastInputSequence) this.inputSentAt.delete(sequence);
    }
  }

  private recordBytes(byteLength: number): void {
    const now = this.now();
    this.bytesWindow.push({ at: now, bytes: byteLength });
    while (
      this.bytesWindow.length > 0 &&
      now - (this.bytesWindow[0]?.at ?? now) > BYTES_WINDOW_MS
    ) {
      this.bytesWindow.shift();
    }
    this.stats.bytesPerSecond = this.bytesWindow.reduce((sum, entry) => sum + entry.bytes, 0);
  }
}
