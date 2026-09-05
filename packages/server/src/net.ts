import { WebSocketServer, type WebSocket } from 'ws';
import {
  FIXED_TICK_MS,
  addPlayer,
  removePlayer,
  serializeActivePlayers,
  stepWorld,
  type PlayerInput,
  type World,
} from '@clans/sim';
import {
  MessageType,
  decodeAck,
  decodeInput,
  encodeSnapshot,
  encodeWelcome,
  SNAPSHOT_EVERY_N_TICKS,
  SNAPSHOT_HISTORY_DEPTH,
  type SnapshotBaseline,
} from '@clans/protocol';
import { applyInputMessage, createSession, recordAck, type Session } from './session.js';
import { needsFullSnapshot } from './snapshot-policy.js';
import { smallerTeam, spawnPointFor, teamCount, type SceneSpawn } from './world.js';

export interface NetServerOptions {
  world: World;
  spawns: SceneSpawn[];
  port: number;
}
export interface NetServer {
  ready: Promise<void>;
  close(): void;
  tick(tickNumber: number): void;
}

interface QueuedInput {
  sequence: number;
  input: PlayerInput;
}
interface ClientEntry {
  socket: WebSocket;
  session: Session;
  sent: SnapshotBaseline[];
  /**
   * Input samples not yet applied to a simulation tick, oldest first. A single Input
   * message can carry catch-up samples for more than one missed tick (the redundant
   * samples exist for exactly this); queueing them here and draining one per tick
   * spreads them across the ticks they were meant for instead of the newest sample
   * overwriting the others before stepWorld ever sees them.
   */
  pendingInputs: QueuedInput[];
  lastInput: PlayerInput;
}

/** The baseline for the next delta is the snapshot the client last acked, never one merely sent. */
function ackedBaseline(entry: ClientEntry): SnapshotBaseline | null {
  return entry.sent.find((sent) => sent.snapshotId === entry.session.lastAckedSnapshotId) ?? null;
}

const IDLE_INPUT: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };
// Bounds a client's catch-up queue. Each Input message contributes at most 3 samples and
// a duplicate/reordered sequence is dropped in applyInputMessage, so this only guards the
// pathological case of a client that keeps sending while the server falls behind ticking.
const MAX_PENDING_INPUTS = SNAPSHOT_HISTORY_DEPTH;

function handleJoin(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
): void {
  // A second Join on a socket that already joined must not spawn a second player: that
  // player would never be removed (handleClose only knows the latest session per socket)
  // and would sit there forever, eventually exhausting world capacity.
  if (clients.has(socket)) return;
  const team = smallerTeam(world);
  const [x, y, z] = spawnPointFor(spawns, team, teamCount(world, team));
  const playerId = addPlayer(world, { x, y, z }, team);
  clients.set(socket, {
    socket,
    session: createSession(playerId, team, Date.now()),
    sent: [],
    pendingInputs: [],
    lastInput: IDLE_INPUT,
  });
  socket.send(
    encodeWelcome({ playerId, team, tickMs: FIXED_TICK_MS, spawnX: x, spawnY: y, spawnZ: z }),
  );
}

function handleInput(
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  const message = decodeInput(bytes);
  const samples = applyInputMessage(entry.session, message);
  // applyInputMessage returns samples oldest-first for the consecutive sequences ending
  // at message.sequence, so the oldest returned sample is this many back from it.
  const startSequence = message.sequence - samples.length + 1;
  samples.forEach((input, index) => {
    entry.pendingInputs.push({ sequence: startSequence + index, input });
    if (entry.pendingInputs.length > MAX_PENDING_INPUTS) entry.pendingInputs.shift();
  });
}

function handleAck(
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  const { snapshotId } = decodeAck(bytes);
  // A fabricated or stale-but-"newer-looking" ack for an id the server never sent must
  // not move the acked baseline: recordAck's monotonic check alone lets any larger id
  // through, and an id with no matching sent snapshot makes every future delta baseline
  // lookup fail, permanently forcing full snapshots.
  if (!entry.sent.some((sent) => sent.snapshotId === snapshotId)) return;
  recordAck(entry.session, snapshotId, Date.now());
}

function handleMessage(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const type = bytes[0];
  if (type === MessageType.Join) handleJoin(world, spawns, clients, socket);
  else if (type === MessageType.Input) handleInput(clients, socket, bytes);
  else if (type === MessageType.Ack) handleAck(clients, socket, bytes);
}

function handleClose(world: World, clients: Map<WebSocket, ClientEntry>, socket: WebSocket): void {
  const entry = clients.get(socket);
  if (!entry) return;
  removePlayer(world, entry.session.playerId);
  clients.delete(socket);
}

function sendSnapshot(
  entry: ClientEntry,
  nextSnapshotId: number,
  tickNumber: number,
  players: ReturnType<typeof serializeActivePlayers>,
): void {
  const useFull = needsFullSnapshot(
    entry.session.lastAckedSnapshotId,
    entry.session.lastAckedAt,
    Date.now(),
  );
  const baseline = useFull ? null : ackedBaseline(entry);
  const bytes = encodeSnapshot(
    nextSnapshotId,
    tickNumber,
    entry.session.lastSimulatedSequence,
    players,
    baseline,
  );
  entry.sent.push({ snapshotId: nextSnapshotId, players });
  if (entry.sent.length > SNAPSHOT_HISTORY_DEPTH) entry.sent.shift();
  entry.socket.send(bytes);
}

/** One input per connected player for this tick: the next queued sample, or a hold of the last. */
function collectTickInputs(clients: Map<WebSocket, ClientEntry>): Map<number, PlayerInput> {
  const inputs = new Map<number, PlayerInput>();
  for (const entry of clients.values()) {
    const queued = entry.pendingInputs.shift();
    // Only a queued sample actually being simulated this tick advances
    // lastSimulatedSequence; holding the last input again does not, since nothing new
    // was applied and a snapshot reporting a later sequence than what actually ran
    // would make the client drop inputs it still needs to replay.
    if (queued) {
      entry.lastInput = queued.input;
      entry.session.lastSimulatedSequence = queued.sequence;
    }
    inputs.set(entry.session.playerId, entry.lastInput);
  }
  return inputs;
}

export function startNetServer(options: NetServerOptions): NetServer {
  const wss = new WebSocketServer({ port: options.port });
  // A bind failure (e.g. the port is already in use) must reject `ready`, not leave the
  // caller awaiting it forever: an EventEmitter's 'error' with no listener at all throws
  // synchronously and crashes the process with no context. The once-listener below wins
  // that race and turns it into a normal rejection; the permanent one after it catches
  // any later error (once the server is already up) so 'error' is never unhandled again.
  const ready = new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('error', (error) => {
    console.error('[clans-server] websocket server error:', error);
  });
  const clients = new Map<WebSocket, ClientEntry>();
  let nextSnapshotId = 1;

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      try {
        handleMessage(
          options.world,
          options.spawns,
          clients,
          socket,
          new Uint8Array(data as Uint8Array),
        );
      } catch {
        // A malformed or adversarial frame (wrong length, unknown fields, a non-finite
        // input axis) must not crash the tick loop shared by every connected client.
        // Dropping it is safe: inputs hold the client's last good sample, acks are
        // idempotent, and a bad Join simply never gets a Welcome.
      }
    });
    socket.on('close', () => handleClose(options.world, clients, socket));
  });

  function tick(tickNumber: number): void {
    stepWorld(options.world, collectTickInputs(clients));
    if (tickNumber % SNAPSHOT_EVERY_N_TICKS !== 0) return;
    const players = serializeActivePlayers(options.world);
    nextSnapshotId += 1;
    for (const entry of clients.values()) sendSnapshot(entry, nextSnapshotId, tickNumber, players);
  }

  return { ready, close: () => wss.close(), tick };
}
