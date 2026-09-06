import { WebSocketServer, type WebSocket } from 'ws';
import {
  FIXED_DT,
  FIXED_TICK_MS,
  FlagState,
  LIGHT_ARMOR,
  RETURN_TICKS,
  WEAPON_DATA,
  WeaponId,
  addPlayer,
  dueForRespawn,
  playerHitbox,
  raySphereDistance,
  removePlayer,
  respawnPlayer,
  sampleTerrain,
  serializeActivePlayers,
  stepWorld,
  type FireEvent,
  type PlayerInput,
  type World,
} from '@clans/sim';
import {
  EventKind,
  MessageType,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY_N_TICKS,
  SNAPSHOT_HISTORY_DEPTH,
  WelcomeStatus,
  decodeAck,
  decodeGod,
  decodeInput,
  decodeJoin,
  encodeEvent,
  encodeSnapshot,
  encodeWelcome,
  type EventMessage,
  type FlagSnapshotData,
  type ProjectileSnapshotData,
  type SnapshotBaseline,
  type WorldExtras,
} from '@clans/protocol';
import { isClientOverloaded } from './backpressure-policy.js';
import { createPositionHistory, recordHistory, restorePositions, rewindOthers } from './lagcomp.js';
import { applyInputMessage, createSession, recordAck, type Session } from './session.js';
import { needsFullSnapshot } from './snapshot-policy.js';
import { smallerTeam, spawnPointFor, teamCount, type SceneSpawn } from './world.js';

export interface NetServerOptions {
  world: World;
  spawns: SceneSpawn[];
  port: number;
  /** How long an accepted socket may stay unjoined before it is closed. */
  joinTimeoutMs?: number;
  /** Clock used for ping/ack timing. Defaults to `Date.now`; tests inject a fake clock. */
  now?: () => number;
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
interface SentSnapshot extends SnapshotBaseline {
  sentAt: number;
}
interface ClientEntry {
  socket: WebSocket;
  session: Session;
  sent: SentSnapshot[];
  /**
   * Input samples not yet applied to a simulation tick, oldest first. A single Input
   * message can carry catch-up samples for more than one missed tick (the redundant
   * samples exist for exactly this); queueing them here and draining one per tick
   * spreads them across the ticks they were meant for instead of the newest sample
   * overwriting the others before stepWorld ever sees them.
   */
  pendingInputs: QueuedInput[];
  lastInput: PlayerInput;
  /** Round-trip time to this client, in ms, from its most recent ack. Drives lag comp. */
  pingMs: number;
}
interface FlagSnapshotForDiff {
  state: number;
  carrierId: number;
}

/** The baseline for the next delta is the snapshot the client last acked, never one merely sent. */
function ackedBaseline(entry: ClientEntry): SnapshotBaseline | null {
  return entry.sent.find((sent) => sent.snapshotId === entry.session.lastAckedSnapshotId) ?? null;
}

// A connection that completes the WebSocket upgrade but never sends Join stayed open
// indefinitely before this: only the peer's own 'close' removed it, so a client (or
// script) that connects and goes silent could exhaust sockets and memory one at a time.
const DEFAULT_JOIN_TIMEOUT_MS = 10_000;
const IDLE_INPUT: PlayerInput = {
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
// Bounds a client's catch-up queue. Each Input message contributes at most 3 samples and
// a duplicate/reordered sequence is dropped in applyInputMessage, so this only guards the
// pathological case of a client that keeps sending while the server falls behind ticking.
// Codex round 9 (PR #4): this previously reused SNAPSHOT_HISTORY_DEPTH (8), an unrelated
// constant (a delta-snapshot baseline window) that happened to have a plausible-looking
// value. applyInputMessage advances session.lastAppliedSequence the moment a message is
// parsed, regardless of queue capacity, so once more than 8 messages arrived before a
// tick drained any of them, the oldest queued samples were evicted here and permanently
// lost: already marked "applied" but never simulated, and unrecoverable by any later
// message's redundant catch-up window (that only ever covers the most recent 2 ticks).
// A burst this size is ordinary during a tick-loop stall, not just adversarial traffic.
const MAX_PENDING_INPUTS = 128;
const REWIND_CAP_MS = 200; // Spec: lag compensation is capped at 200 ms.
const HITSCAN_WEAPONS = new Set<WeaponId>([WeaponId.Chaingun, WeaponId.LaserRifle]);

function handleJoin(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  now: () => number,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  // A second Join on a socket that already joined must not spawn a second player: that
  // player would never be removed (handleClose only knows the latest session per socket)
  // and would sit there forever, eventually exhausting world capacity.
  if (clients.has(socket)) return;
  const join = decodeJoin(bytes);
  if (join.version !== PROTOCOL_VERSION) {
    socket.send(
      encodeWelcome({
        playerId: 0,
        team: 0,
        tickMs: FIXED_TICK_MS,
        status: WelcomeStatus.VersionMismatch,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
      }),
    );
    return;
  }
  const team = smallerTeam(world);
  const [x, y, z] = spawnPointFor(world.terrain, spawns, team, teamCount(world, team));
  let playerId: number;
  try {
    playerId = addPlayer(world, { x, y, z }, team);
  } catch {
    // A full world's addPlayer throws before this socket is registered or welcomed.
    // handleMessage's outer try/catch would otherwise swallow that silently, leaving the
    // socket open with the client waiting forever for a Welcome that will never come.
    // Closing it tells the client the join was rejected instead of hanging.
    socket.close();
    return;
  }
  clients.set(socket, {
    socket,
    session: createSession(playerId, team, now()),
    sent: [],
    pendingInputs: [],
    lastInput: IDLE_INPUT,
    pingMs: 0,
  });
  socket.send(
    encodeWelcome({
      playerId,
      team,
      tickMs: FIXED_TICK_MS,
      status: WelcomeStatus.Ok,
      spawnX: x,
      spawnY: y,
      spawnZ: z,
    }),
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
  now: () => number,
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
  const sent = entry.sent.find((candidate) => candidate.snapshotId === snapshotId);
  if (!sent) return;
  recordAck(entry.session, snapshotId, now());
  entry.pingMs = now() - sent.sentAt;
}

function handleGod(
  clients: Map<WebSocket, ClientEntry>,
  godPlayers: Set<number>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  if (decodeGod(bytes).enabled) godPlayers.add(entry.session.playerId);
  else godPlayers.delete(entry.session.playerId);
}

function handleMessage(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  godPlayers: Set<number>,
  now: () => number,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const type = bytes[0];
  if (type === MessageType.Join) handleJoin(world, spawns, clients, now, socket, bytes);
  else if (type === MessageType.Input) handleInput(clients, socket, bytes);
  else if (type === MessageType.Ack) handleAck(clients, now, socket, bytes);
  else if (type === MessageType.God) handleGod(clients, godPlayers, socket, bytes);
}

/**
 * Drops every flag `playerId` is carrying at their last known position, the same terminal
 * state a real death leaves a flag in (flags.ts's dropFlag, not exported). This deliberately
 * does not reuse `world.pendingDeaths`: movement.ts's stepPlayers clears that array at the
 * very start of every stepWorld call, before stepFlags ever runs, so a disconnect -- which
 * fires from a WebSocket 'close' event between ticks, never inside stepWorld -- would have
 * its pendingDeaths entry wiped out before the next tick's stepFlags could see it. Dropping
 * the flag here, synchronously, needs no sim change and cannot land on the wrong tick.
 */
function dropFlagsCarriedBy(world: World, playerId: number): void {
  const base = playerId * 3;
  const x = world.players.position[base] ?? 0;
  const z = world.players.position[base + 2] ?? 0;
  const y = sampleTerrain(world.terrain, x, z).height;
  for (let flagId = 0; flagId < world.flags.state.length; flagId += 1) {
    if (world.flags.carrierId[flagId] !== playerId) continue;
    world.flags.state[flagId] = FlagState.Dropped;
    world.flags.position.set([x, y, z], flagId * 3);
    world.flags.carrierId[flagId] = -1;
    world.flags.returnAt[flagId] = world.tick + RETURN_TICKS;
  }
}

function handleClose(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  godPlayers: Set<number>,
  socket: WebSocket,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  dropFlagsCarriedBy(world, entry.session.playerId);
  removePlayer(world, entry.session.playerId);
  godPlayers.delete(entry.session.playerId);
  clients.delete(socket);
}

function sendSnapshot(
  entry: ClientEntry,
  nextSnapshotId: number,
  tickNumber: number,
  players: ReturnType<typeof serializeActivePlayers>,
  extras: WorldExtras,
  now: () => number,
): void {
  const useFull = needsFullSnapshot(
    entry.session.lastAckedSnapshotId,
    entry.session.lastAckedAt,
    now(),
  );
  const baseline = useFull ? null : ackedBaseline(entry);
  const bytes = encodeSnapshot(
    nextSnapshotId,
    tickNumber,
    entry.session.lastSimulatedSequence,
    players,
    baseline,
    extras,
  );
  entry.sent.push({ snapshotId: nextSnapshotId, players, sentAt: now() });
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

function snapshotProjectile(world: World, id: number): ProjectileSnapshotData {
  const base = id * 3;
  return {
    id,
    type: world.projectiles.type[id] ?? 0,
    weaponId: world.projectiles.weaponId[id] ?? 0,
    x: world.projectiles.position[base] ?? 0,
    y: world.projectiles.position[base + 1] ?? 0,
    z: world.projectiles.position[base + 2] ?? 0,
    vx: world.projectiles.velocity[base] ?? 0,
    vy: world.projectiles.velocity[base + 1] ?? 0,
    vz: world.projectiles.velocity[base + 2] ?? 0,
    ownerId: world.projectiles.ownerId[id] ?? -1,
  };
}

function snapshotActiveProjectiles(world: World): ProjectileSnapshotData[] {
  const projectiles: ProjectileSnapshotData[] = [];
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (world.projectiles.active[id]) projectiles.push(snapshotProjectile(world, id));
  }
  return projectiles;
}

function snapshotWorldFlag(world: World, id: number): FlagSnapshotData {
  const base = id * 3;
  const returnAt = world.flags.returnAt[id] ?? -1;
  return {
    id,
    team: world.flags.team[id] ?? 0,
    state: world.flags.state[id] ?? 0,
    x: world.flags.position[base] ?? 0,
    y: world.flags.position[base + 1] ?? 0,
    z: world.flags.position[base + 2] ?? 0,
    carrierId: world.flags.carrierId[id] ?? -1,
    returnInS: returnAt < 0 ? -1 : (returnAt - world.tick) * FIXED_DT,
  };
}

function snapshotWorldFlags(world: World): FlagSnapshotData[] {
  const flags: FlagSnapshotData[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) flags.push(snapshotWorldFlag(world, id));
  return flags;
}

function buildExtras(world: World): WorldExtras {
  return {
    projectiles: snapshotActiveProjectiles(world),
    flags: snapshotWorldFlags(world),
    teamScores: [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0],
    gameOver: world.gameOver,
    winnerTeam: world.winnerTeam,
    timeRemainingS: Math.max(0, (world.timeLimitTicks - world.tick) * FIXED_DT),
    gameOverReason: world.gameOverReason,
  };
}

function respawnDuePlayers(world: World, spawns: SceneSpawn[]): void {
  for (const id of dueForRespawn(world)) {
    const team = world.players.team[id] ?? 1;
    const [x, y, z] = spawnPointFor(world.terrain, spawns, team, teamCount(world, team));
    respawnPlayer(world, id, { x, y, z });
  }
}

/** God-mode wire mechanism (ours, see the plan's numbers table): zero damage and revive after
 * `stepWorld` runs, rather than threading a flag through the deterministic sim. */
function applyGodMode(world: World, godPlayers: Set<number>): void {
  for (const id of godPlayers) {
    if (!world.players.active[id]) continue;
    world.players.damage[id] = 0;
    if (!world.players.alive[id]) {
      world.players.alive[id] = 1;
      world.players.respawnAt[id] = -1;
    }
  }
}

function hitscanShooters(world: World, inputs: ReadonlyMap<number, PlayerInput>): number[] {
  const shooters: number[] = [];
  for (const [playerId, input] of inputs) {
    if (!input.fire || !world.players.active[playerId]) continue;
    if (HITSCAN_WEAPONS.has(world.players.weaponSlot[playerId] as WeaponId))
      shooters.push(playerId);
  }
  return shooters;
}

/** One global rewind-ms for the whole tick (ours — see the plan's numbers table), not a
 * per-shooter-per-target rewind: the max ping among this tick's hitscan/tracer shooters. */
function rewindMsForShooters(clients: Map<WebSocket, ClientEntry>, shooterIds: number[]): number {
  let maxPing = 0;
  for (const entry of clients.values()) {
    if (shooterIds.includes(entry.session.playerId)) maxPing = Math.max(maxPing, entry.pingMs);
  }
  return Math.min(maxPing, REWIND_CAP_MS);
}

function killEvents(world: World): EventMessage[] {
  return world.pendingDeaths.map(({ id, attackerId }) => ({
    type: MessageType.Event as const,
    kind: EventKind.PlayerKilled,
    a: attackerId,
    b: id,
  }));
}

/** Redoes the Laser Rifle's own nearest-hit search (Task 3's `resolveHitscan`) purely to
 * report a target id on the wire; the authoritative damage already landed inside `stepWorld`. */
function findLaserHit(world: World, event: FireEvent): number {
  const data = WEAPON_DATA[WeaponId.LaserRifle];
  let nearestId = -1;
  let nearestDistance = Infinity;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (
      !world.players.active[playerId] ||
      !world.players.alive[playerId] ||
      playerId === event.playerId
    )
      continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(event.origin, event.direction, hitbox);
    if (distance !== null && distance <= (data.maxRange ?? 0) && distance < nearestDistance) {
      nearestId = playerId;
      nearestDistance = distance;
    }
  }
  return nearestId;
}

function laserEvents(world: World): EventMessage[] {
  return world.pendingFireEvents
    .filter((event) => event.weaponId === WeaponId.LaserRifle && !event.isAltFire)
    .map((event) => ({
      type: MessageType.Event as const,
      kind: EventKind.LaserFired,
      a: event.playerId,
      b: findLaserHit(world, event),
    }));
}

function snapshotFlags(world: World): FlagSnapshotForDiff[] {
  const out: FlagSnapshotForDiff[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) {
    out.push({ state: world.flags.state[id] ?? 0, carrierId: world.flags.carrierId[id] ?? -1 });
  }
  return out;
}

/** Diffs flag state around `stepWorld` rather than adding a pending-events array to `flags.ts`
 * (Task 4 stays untouched): a touch is carrierId -1 -> set, a capture is state Carried -> Home
 * (a timer return or an own-flag return both pass through Dropped first, never Carried). */
function touchEvent(
  flagId: number,
  previous: FlagSnapshotForDiff,
  carrierId: number,
): EventMessage | null {
  if (previous.carrierId !== -1 || carrierId === -1) return null;
  return { type: MessageType.Event, kind: EventKind.FlagTouched, a: carrierId, b: flagId };
}

function captureEvent(
  world: World,
  flagId: number,
  previous: FlagSnapshotForDiff,
  state: number,
): EventMessage | null {
  if (previous.state !== FlagState.Carried || state !== FlagState.Home) return null;
  const capturingTeam = (world.flags.team[flagId] ?? 0) === 1 ? 2 : 1;
  return {
    type: MessageType.Event,
    kind: EventKind.FlagCaptured,
    a: capturingTeam,
    b: previous.carrierId,
  };
}

/** Both event kinds this flag transitioned through this tick, if any. */
function eventsForFlag(
  world: World,
  flagId: number,
  previous: FlagSnapshotForDiff,
): EventMessage[] {
  const carrierId = world.flags.carrierId[flagId] ?? -1;
  const state = world.flags.state[flagId] ?? 0;
  const events = [
    touchEvent(flagId, previous, carrierId),
    captureEvent(world, flagId, previous, state),
  ];
  return events.filter((event): event is EventMessage => event !== null);
}

function flagEvents(world: World, before: FlagSnapshotForDiff[]): EventMessage[] {
  const events: EventMessage[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const previous = before[id];
    if (previous) events.push(...eventsForFlag(world, id, previous));
  }
  return events;
}

function broadcastEvent(clients: Map<WebSocket, ClientEntry>, event: EventMessage): void {
  const bytes = encodeEvent(event);
  for (const entry of clients.values()) entry.socket.send(bytes);
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
  const godPlayers = new Set<number>();
  const history = createPositionHistory();
  const now = options.now ?? (() => Date.now());
  let nextSnapshotId = 1;
  const joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;

  wss.on('connection', (socket) => {
    // clients.has(socket) is only ever set once handleJoin succeeds, so this is a plain
    // "did this socket ever join" check regardless of what fires first.
    const joinTimeout = setTimeout(() => {
      if (!clients.has(socket)) socket.close();
    }, joinTimeoutMs);
    socket.on('message', (data) => {
      try {
        handleMessage(
          options.world,
          options.spawns,
          clients,
          godPlayers,
          now,
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
    socket.on('close', () => {
      clearTimeout(joinTimeout);
      handleClose(options.world, clients, godPlayers, socket);
    });
    // A malformed frame at the WebSocket protocol level itself (an invalid raw frame,
    // e.g. an unmasked client frame) fires 'error' on the socket before 'message' ever
    // sees it, and our application-level try/catch above only ever covers decoded
    // messages. With no 'error' listener at all, Node's default is to throw and crash
    // the process; this absorbs it the same way the server-level handler below does.
    socket.on('error', () => {
      clearTimeout(joinTimeout);
      handleClose(options.world, clients, godPlayers, socket);
    });
  });

  function sendAllSnapshots(): void {
    const players = serializeActivePlayers(options.world);
    const extras = buildExtras(options.world);
    nextSnapshotId += 1;
    for (const entry of clients.values()) {
      // Codex round 14 (PR #4): sending unconditionally let a slow or unresponsive
      // client's outgoing backlog grow forever, since nothing here ever checked it.
      // Closing an overloaded client instead of queuing yet another write onto its pile
      // bounds server memory to a handful of connected clients' worth, not one client's
      // worth of every snapshot it never read.
      //
      // Codex round 16 (PR #4): socket.close() is a graceful close -- it waits for the
      // handshake and ws defers destruction to a 30 s timer, so the player stayed a
      // simulated, broadcast "ghost" other clients could see for up to 30 s after it was
      // supposedly disconnected. An overloaded client's own backpressure means it cannot
      // even receive a close frame reliably anyway, so there is nothing a graceful close
      // buys here; terminate() drops the connection immediately.
      if (isClientOverloaded(entry.socket.bufferedAmount)) {
        entry.socket.terminate();
        continue;
      }
      // Report options.world.tick (the value stepWorld just produced), not the loop's own
      // tickNumber argument (the pre-step value): see issue #6.
      sendSnapshot(entry, nextSnapshotId, options.world.tick, players, extras, now);
    }
  }

  function runOneTick(inputs: Map<number, PlayerInput>): void {
    recordHistory(history, options.world);
    const shooters = hitscanShooters(options.world, inputs);
    const rewindTicks =
      shooters.length > 0 ? Math.round(rewindMsForShooters(clients, shooters) / FIXED_TICK_MS) : 0;
    const rewindHandle =
      rewindTicks > 0 ? rewindOthers(options.world, history, shooters, rewindTicks) : null;
    const flagsBefore = snapshotFlags(options.world);

    stepWorld(options.world, inputs);
    if (rewindHandle) restorePositions(options.world, rewindHandle);
    respawnDuePlayers(options.world, options.spawns);
    applyGodMode(options.world, godPlayers);

    for (const event of killEvents(options.world)) broadcastEvent(clients, event);
    for (const event of flagEvents(options.world, flagsBefore)) broadcastEvent(clients, event);
    for (const event of laserEvents(options.world)) broadcastEvent(clients, event);
  }

  // Game over freezes the sim: no more stepWorld, no more respawns or events, but snapshots
  // keep going out on the normal cadence so every client sees the frozen final state.
  function tick(tickNumber: number): void {
    const inputs = collectTickInputs(clients);
    if (!options.world.gameOver) runOneTick(inputs);
    if (tickNumber % SNAPSHOT_EVERY_N_TICKS !== 0) return;
    sendAllSnapshots();
  }

  function close(): void {
    // wss.close() alone stops accepting new connections; it does not touch sockets
    // already connected. `clients` only holds sockets that have sent a Join, so closing
    // just those still left an accepted-but-not-yet-joined socket open; wss.clients is
    // the WebSocket server's own ground truth for every currently connected socket,
    // joined or not.
    for (const socket of wss.clients) socket.close();
    wss.close();
  }

  return { ready, close, tick };
}
