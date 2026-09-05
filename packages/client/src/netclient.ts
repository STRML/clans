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
  decodeSnapshot,
  decodeWelcome,
  encodeAck,
  encodeInput,
  encodeJoin,
} from '@clans/protocol';
import type { SnapshotBaseline } from '@clans/protocol';
import type { Transport } from './transport.js';

const MAX_REPLAY_TICKS = 30;
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
  private lastSnapshot: SnapshotBaseline | null = null;
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

  tick(input: PlayerInput): void {
    this.sequence += 1;
    this.pendingInputs.push({ sequence: this.sequence, input });
    stepWorld(this.world, new Map([[LOCAL_SLOT, input]]));
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
    if (type === MessageType.Welcome) this.handleWelcome(bytes);
    else if (type === MessageType.Snapshot) this.handleSnapshot(bytes);
  }

  private handleWelcome(bytes: Uint8Array): void {
    const welcome = decodeWelcome(bytes);
    this.playerId = welcome.playerId;
    this.team = welcome.team;
  }

  private handleSnapshot(bytes: Uint8Array): void {
    this.recordBytes(bytes.byteLength);
    let decoded;
    try {
      decoded = decodeSnapshot(bytes, this.lastSnapshot);
    } catch {
      // A delta against a baseline we never received. Count it as loss and do not ack;
      // the server's 1 s fallback then sends a full snapshot.
      this.pushLoss(0);
      return;
    }
    this.recordLoss(decoded.snapshotId);
    this.updatePing(decoded.lastInputSequence);
    this.lastSnapshot = { snapshotId: decoded.snapshotId, players: decoded.players };
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
    this.world.tick = serverTick;
    this.pendingInputs = this.pendingInputs.filter(
      (pending) => pending.sequence > lastInputSequence,
    );
    if (this.pendingInputs.length > MAX_REPLAY_TICKS) {
      this.stats.predictionErrorM = Math.hypot(
        beforeX - (this.world.players.position[0] ?? 0),
        beforeZ - (this.world.players.position[2] ?? 0),
      );
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
