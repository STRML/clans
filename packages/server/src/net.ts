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

// Snapshots a client may still ack. Older ones fall off; a client that far behind gets a full.
const SENT_HISTORY = 8;

interface ClientEntry {
  socket: WebSocket;
  session: Session;
  sent: SnapshotBaseline[];
}

/** The baseline for the next delta is the snapshot the client last acked, never one merely sent. */
function ackedBaseline(entry: ClientEntry): SnapshotBaseline | null {
  return entry.sent.find((sent) => sent.snapshotId === entry.session.lastAckedSnapshotId) ?? null;
}

function handleJoin(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
): void {
  const team = smallerTeam(world);
  const [x, y, z] = spawnPointFor(spawns, team, teamCount(world, team));
  const playerId = addPlayer(world, { x, y, z }, team);
  clients.set(socket, { socket, session: createSession(playerId, team, Date.now()), sent: [] });
  socket.send(encodeWelcome({ playerId, team, tickMs: FIXED_TICK_MS }));
}

function handleInput(
  clients: Map<WebSocket, ClientEntry>,
  latestInputs: Map<number, PlayerInput>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  for (const sample of applyInputMessage(entry.session, decodeInput(bytes))) {
    latestInputs.set(entry.session.playerId, sample);
  }
}

function handleAck(
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  recordAck(entry.session, decodeAck(bytes).snapshotId, Date.now());
}

function handleMessage(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  latestInputs: Map<number, PlayerInput>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const type = bytes[0];
  if (type === MessageType.Join) handleJoin(world, spawns, clients, socket);
  else if (type === MessageType.Input) handleInput(clients, latestInputs, socket, bytes);
  else if (type === MessageType.Ack) handleAck(clients, socket, bytes);
}

function handleClose(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  latestInputs: Map<number, PlayerInput>,
  socket: WebSocket,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  removePlayer(world, entry.session.playerId);
  latestInputs.delete(entry.session.playerId);
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
    entry.session.lastAppliedSequence,
    players,
    baseline,
  );
  entry.sent.push({ snapshotId: nextSnapshotId, players });
  if (entry.sent.length > SENT_HISTORY) entry.sent.shift();
  entry.socket.send(bytes);
}

export function startNetServer(options: NetServerOptions): NetServer {
  const wss = new WebSocketServer({ port: options.port });
  const ready = new Promise<void>((resolve) => wss.once('listening', resolve));
  const clients = new Map<WebSocket, ClientEntry>();
  const latestInputs = new Map<number, PlayerInput>();
  let nextSnapshotId = 1;

  wss.on('connection', (socket) => {
    socket.on('message', (data) =>
      handleMessage(
        options.world,
        options.spawns,
        clients,
        latestInputs,
        socket,
        new Uint8Array(data as Uint8Array),
      ),
    );
    socket.on('close', () => handleClose(options.world, clients, latestInputs, socket));
  });

  function tick(tickNumber: number): void {
    stepWorld(options.world, latestInputs);
    if (tickNumber % SNAPSHOT_EVERY_N_TICKS !== 0) return;
    const players = serializeActivePlayers(options.world);
    nextSnapshotId += 1;
    for (const entry of clients.values()) sendSnapshot(entry, nextSnapshotId, tickNumber, players);
  }

  return { ready, close: () => wss.close(), tick };
}
