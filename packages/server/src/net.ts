import { WebSocketServer, type WebSocket } from 'ws';
import {
  FIXED_DT,
  FIXED_TICK_MS,
  FlagState,
  LIGHT_ARMOR,
  WEAPON_DATA,
  WeaponId,
  addPlayer,
  applyDamage,
  applyLoadoutSelection,
  armorFor,
  deactivateProjectile,
  dueForRespawn,
  hitTestFireEvent,
  playerHitbox,
  removePlayer,
  respawnPlayer,
  resyncCarriedFlagPositions,
  serializeActivePlayers,
  serializeActiveVehicles,
  setGodMode,
  requestVehicleAtPad,
  stepWorld,
  VEHICLE_PAD_USE_RADIUS,
  type ArmorData,
  type FireEvent,
  type HitResult,
  type PlayerInput,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import {
  EventKind,
  MessageType,
  OrderKind,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY_N_TICKS,
  SNAPSHOT_HISTORY_DEPTH,
  VOICE_LINE_COUNT,
  WelcomeStatus,
  decodeAck,
  decodeCommandOrder,
  decodeGod,
  decodeInput,
  decodeJoin,
  decodeLoadout,
  decodeVehicleSpawn,
  decodeVoiceBind,
  encodeEvent,
  encodeSnapshot,
  encodeWelcome,
  type BaseObjectSnapshotData,
  type EventMessage,
  type FlagSnapshotData,
  type ProjectileSnapshotData,
  type SnapshotBaseline,
  type TurretSnapshotData,
  type WorldExtras,
} from '@clans/protocol';
import { isClientOverloaded } from './backpressure-policy.js';
import {
  clearHistory,
  createPositionHistory,
  recordHistory,
  restorePositions,
  rewindOthers,
  type PositionHistory,
} from './lagcomp.js';
import { currentOrder, issueOrder, type OrderBoard } from './orders.js';
import { applyInputMessage, createSession, recordAck, type Session } from './session.js';
import {
  createRelevanceCache,
  needsFullSnapshot,
  relevantSnapshotForViewer,
  type BaseObjectPlacement,
  type InteriorFootprint,
  type RelevanceCache,
} from './snapshot-policy.js';
import { joinableTeam, rebalanceTeams, stepBotManager, type BotManager } from './bots.js';
import {
  activePlayerPositions,
  dropFlagsCarriedBy,
  respawnSpawnIndex,
  spawnPointFor,
  teamCount,
  type SceneSpawn,
} from './world.js';

export interface NetServerOptions {
  world: World;
  spawns: SceneSpawn[];
  /** Owns bot ids, per-bot runtime memory, and rebalancing toward the manager's own
   *  per-team cap (`teamSize`, TARGET_TEAM_SIZE unless createBotManager was raised with
   *  cli.ts's `--team-size`). A server always has one, even at `--bots 0` (an empty-budget
   *  manager that's a no-op everywhere it's called) -- this milestone does not support
   *  running with none at all. */
  botManager: BotManager;
  /** One active order per team, TTL-expired -- runtime memory, never part of World/hashWorld
   *  (mirrors BotManager's own runtime-memory convention, M6 Global Constraints). */
  board: OrderBoard;
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
  /** Per-client sparse-entity memory for the #5 relevance policy -- the last data actually
   *  sent for each distant player, so a player between its low-rate updates is re-sent
   *  stale (diffing clean, persisting client-side) instead of being read as removed. */
  relevance: RelevanceCache;
}
export interface FlagSnapshotForDiff {
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
  packActive: false,
  use: false,
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
  botManager: BotManager,
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
  // Issue #31: a human join is capped, not unconditional. joinableTeam prefers
  // smallerTeam's own pick, falls back to the alternate team, and returns null only when
  // neither team can take a human -- both at/over the manager's per-team cap (`teamSize`,
  // 16 by default, 24 for a `--team-size 24` match) with no bot left for rebalanceTeams to
  // shed. Previously smallerTeam alone chose the team and the join was accepted
  // unconditionally, so with `--bots 0` a 33rd human pushed a full team to 17 and
  // rebalanceTeams had no bot to remove to bring it back down.
  const team = joinableTeam(world, botManager);
  if (team === null) {
    // Refused with the same Welcome shape as VersionMismatch (playerId 0, team 0, zero
    // spawn): a refused join must reach the client as a response, not as a silent hang
    // (the socket stays open exactly like the VersionMismatch path; this repo's client
    // closes it on receipt of any non-Ok status).
    socket.send(
      encodeWelcome({
        playerId: 0,
        team: 0,
        tickMs: FIXED_TICK_MS,
        status: WelcomeStatus.TeamFull,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
      }),
    );
    return;
  }
  let x: number, y: number, z: number;
  let playerId: number;
  try {
    [x, y, z] = spawnPointFor(
      world.terrain,
      spawns,
      team,
      teamCount(world, team),
      world.interiors,
      activePlayerPositions(world),
    );
    playerId = addPlayer(world, { x, y, z }, team);
  } catch {
    // A full world or unusable spawn area can reject a join before registration.
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
    relevance: createRelevanceCache(),
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
  // The joining human's team/id are already committed to world.players above, so
  // rebalanceTeams sees an accurate count and, if that team is already at the manager's
  // per-team cap, removes exactly one bot on it before this join would push it over
  // (failure matrix row 12) -- never the other way around.
  rebalanceTeams(botManager, world, spawns);
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

/** Toggles a player's invulnerability directly at the sim level, once per God message,
 * rather than the reactive per-tick approach it replaces (a server-side Set the tick loop
 * re-applied to every player in it, zeroing damage back to full AFTER stepWorld had already
 * run -- see `applyDamage`'s godMode guard in `@clans/sim` for why that was too late to stop
 * a flag drop or score event, and `setGodMode`'s own comment for why the sim itself never
 * flips this bit on its own). Codex PR #9 round 3: dead weight now that `setGodMode` exists. */
function handleGod(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  setGodMode(world, entry.session.playerId, decodeGod(bytes).enabled);
}

/** A refused request (failure matrix row 4: not at a powered station, or not in range) is
 *  silently a no-op, exactly like an out-of-turn God message already is -- the client's own
 *  menu already only lets a request happen while `stationAt` says it can, so a refusal here
 *  means the world changed between the click and the message arriving, not a client bug. */
function handleLoadout(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  // #55: the loadout message now carries the full station selection -- armor, the chosen
  // pack, and the carried-weapons bitmask -- not just armor + repair pack. decodeLoadout
  // already rejects an out-of-range pack and masks the weapons byte; applyLoadoutSelection
  // re-checks station presence/power server-side and sanitizes the mask against the armor,
  // silently returning false on a refused request (same failure-matrix row 4 convention).
  const { armor, pack, weapons } = decodeLoadout(bytes);
  applyLoadoutSelection(world, entry.session.playerId, armor, pack, weapons);
}

/** A refused request (unpowered pad, team already at its pad-derived cap, bad pad id, or the
 *  sender too far from the named pad) is silently a no-op, matching handleLoadout's own
 *  convention above: the client's pad menu (Task 13) already only offers a choice while
 *  standing in a powered pad's use radius, so a legitimate client rarely sends a doomed
 *  request in the first place -- see the M5 plan's Task 12 notes. `spawnVehicleAtPad` itself
 *  already re-checks power/cap at call time (never trusts an earlier "in range" result), so
 *  this handler's own job is only the proximity check spawnVehicleAtPad has no player
 *  position to make on its own. */
function positionAt(arr: Float64Array, base: number): [number, number, number] {
  return [arr[base] ?? 0, arr[base + 1] ?? 0, arr[base + 2] ?? 0];
}

function handleVehicleSpawn(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  const { padId, kind } = decodeVehicleSpawn(bytes);
  if (padId < 0 || padId >= world.baseObjects.count) return;
  const playerId = entry.session.playerId;
  // Codex review round 2 (this PR), finding 2 (P1): the only check here was proximity --
  // no check that the sender is alive, and no check that the pad belongs to the sender's
  // own team. spawnVehicleAtPad creates the vehicle under the PAD's team
  // (padSpawnTeam(world, padId)), and destroys whatever the pad already hosts BEFORE the
  // cap check unconditionally (vehicles.ts's own documented Task 1 behavior) -- so a raw
  // VehicleSpawn message sent while merely standing within VEHICLE_PAD_USE_RADIUS of an
  // ENEMY pad let any connected client destroy or replace that enemy team's vehicle for
  // free, and a dead player's still-open connection could do the same before respawning.
  if (!world.players.active[playerId] || !world.players.alive[playerId]) return;
  if (world.baseObjects.team[padId] !== world.players.team[playerId]) return;
  const [px, py, pz] = positionAt(world.players.position, playerId * 3);
  const [bx, by, bz] = positionAt(world.baseObjects.usePosition, padId * 3);
  if (Math.hypot(px - bx, py - by, pz - bz) > VEHICLE_PAD_USE_RADIUS) return;
  requestVehicleAtPad(world, playerId, padId, kind);
}

const ORDER_KINDS = new Set<number>([OrderKind.Attack, OrderKind.Defend, OrderKind.Repair]);

/** Reads the sender's own team from world.players.team, never a wire-supplied one -- the
 *  CommandOrderMessage shape carries no team field at all, so a client can only ever issue
 *  an order for its own team (failure matrix row 19). Matches handleLoadout's own convention:
 *  a stale click after the world changed is silently a no-op, not an error.
 *
 *  Codex review round 1 of the M7 PR: `decodeCommandOrder` reads a raw wire byte into `kind`
 *  and two raw f32s into `x`/`z` with no bounds or finiteness check -- a modified or buggy
 *  client could send an out-of-range kind or NaN/Infinity coordinates, which `issueOrder`
 *  would store and `stepBots`' goal selection would steer bots toward, propagating NaN into
 *  movement/position and then into every other client's snapshot (the same "never trust the
 *  client alone" rule `handleVoiceBind`'s own bounds check already applies to `lineId`). Both
 *  violations are silently dropped, matching `handleVoiceBind`'s own convention. */
function handleCommandOrder(
  world: World,
  board: OrderBoard,
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  const { kind, x, z } = decodeCommandOrder(bytes);
  if (!ORDER_KINDS.has(kind) || !Number.isFinite(x) || !Number.isFinite(z)) return;
  const team = world.players.team[entry.session.playerId] ?? 0;
  issueOrder(board, team, kind, x, z, world.tick);
}

export const VOICE_BIND_COOLDOWN_TICKS = 32; // Ours -- see M7 plan's "ours" numbers table.
const lastVoiceBindAtTick = new Map<number, number>();

/** Bounds-checks lineId against VOICE_LINE_COUNT (row 23) and enforces a per-player cooldown
 *  server-side (row 22) -- a modified client could otherwise bypass either check, so neither
 *  is trusted from the client alone. Both violations are silently dropped, matching
 *  handleLoadout's "no such thing as a client bug here" convention: never a disconnect. */
function handleVoiceBind(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  const { lineId } = decodeVoiceBind(bytes);
  if (lineId < 0 || lineId >= VOICE_LINE_COUNT) return;
  const playerId = entry.session.playerId;
  const last = lastVoiceBindAtTick.get(playerId) ?? -Infinity;
  if (world.tick - last < VOICE_BIND_COOLDOWN_TICKS) return;
  lastVoiceBindAtTick.set(playerId, world.tick);
  broadcastEvent(clients, {
    type: MessageType.Event,
    kind: EventKind.VoiceBindPlayed,
    a: playerId,
    b: lineId,
  });
}

function handleMessage(
  world: World,
  spawns: SceneSpawn[],
  botManager: BotManager,
  board: OrderBoard,
  clients: Map<WebSocket, ClientEntry>,
  now: () => number,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const type = bytes[0];
  if (type === MessageType.Join) handleJoin(world, spawns, botManager, clients, now, socket, bytes);
  else if (type === MessageType.Input) handleInput(clients, socket, bytes);
  else if (type === MessageType.Ack) handleAck(clients, now, socket, bytes);
  else if (type === MessageType.God) handleGod(world, clients, socket, bytes);
  else if (type === MessageType.Loadout) handleLoadout(world, clients, socket, bytes);
  else if (type === MessageType.VehicleSpawn) handleVehicleSpawn(world, clients, socket, bytes);
  else if (type === MessageType.CommandOrder)
    handleCommandOrder(world, board, clients, socket, bytes);
  else if (type === MessageType.VoiceBind) handleVoiceBind(world, clients, socket, bytes);
}

function handleClose(
  world: World,
  spawns: SceneSpawn[],
  botManager: BotManager,
  clients: Map<WebSocket, ClientEntry>,
  history: PositionHistory,
  socket: WebSocket,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  dropFlagsCarriedBy(world, entry.session.playerId);
  removePlayer(world, entry.session.playerId);
  // removePlayer has already run above, so rebalanceTeams sees an accurate post-leave
  // count and backfills at most one bot on this team if budget remains (failure matrix
  // row 13) -- never double-counting the departing id.
  rebalanceTeams(botManager, world, spawns);
  // God mode lives on world.players.godMode now (setGodMode), and addPlayer already zeroes
  // that bit for a reused id -- no separate godPlayers Set to clean up here anymore.
  // Codex PR #9 round 2, finding 7: recordHistory only forgets an id once it notices that
  // id is no longer active, on its next call for every currently active player -- an id
  // reused by a new Join before that next tick otherwise still carries the previous
  // occupant's recorded trail, and a hitscan shot at another player that tick could rewind
  // the new occupant onto it for one tick. Clearing it here, synchronously on disconnect,
  // closes that window instead of waiting on a future tick to overwrite it naturally.
  clearHistory(history, entry.session.playerId);
  // Codex review round 1 of the M7 PR: lastVoiceBindAtTick is keyed by numeric player id and
  // was never cleared here, unlike every other per-player table this function already clears
  // -- a reused id (the same disconnect/rejoin churn clearHistory's own comment describes)
  // inherited a stale cooldown deadline from whoever held that id before, silently dropping
  // the new occupant's first otherwise-valid voice bind.
  lastVoiceBindAtTick.delete(entry.session.playerId);
  clients.delete(socket);
}

/**
 * `full` is the needsFullSnapshot verdict for THIS client, computed by the caller: the
 * relevance policy needs the same bit to decide whether distant players go out fresh
 * (a resync always carries current state) or on the sparse cadence.
 */
function sendSnapshot(
  entry: ClientEntry,
  nextSnapshotId: number,
  tickNumber: number,
  full: boolean,
  players: PlayerSnapshotData[],
  extras: WorldExtras,
  now: () => number,
): void {
  const baseline = full ? null : ackedBaseline(entry);
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

/** The per-base-object placement facts the #5 relevance policy needs but the wire format
 * doesn't carry: BaseObjectSnapshotData is id/damage/destroyed/powered/energy only, so the
 * "hidden interior item far away" test runs against these positions (read once per send
 * from world.baseObjects, never per client). */
function baseObjectPlacementsFor(world: World): BaseObjectPlacement[] {
  const placements: BaseObjectPlacement[] = [];
  for (let id = 0; id < world.baseObjects.count; id += 1) {
    placements.push({
      id,
      x: world.baseObjects.position[id * 3] ?? 0,
      z: world.baseObjects.position[id * 3 + 2] ?? 0,
      kind: world.baseObjects.kind[id] ?? 0,
    });
  }
  return placements;
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

// Pulls the `?? fallback` branches for a projectile's scalar fields out of
// snapshotProjectile itself, which otherwise trips the complexity lint's cap -- adding
// `armed` (round 15, PR #9, finding 2) was the field that tipped it over.
function projectileNum(arr: Float64Array | Uint8Array | Int16Array, i: number): number {
  return arr[i] ?? 0;
}

function snapshotProjectile(world: World, id: number): ProjectileSnapshotData {
  const p = world.projectiles;
  const base = id * 3;
  return {
    id,
    type: projectileNum(p.type, id),
    weaponId: projectileNum(p.weaponId, id),
    x: projectileNum(p.position, base),
    y: projectileNum(p.position, base + 1),
    z: projectileNum(p.position, base + 2),
    vx: projectileNum(p.velocity, base),
    vy: projectileNum(p.velocity, base + 1),
    vz: projectileNum(p.velocity, base + 2),
    ownerId: p.ownerId[id] ?? -1,
    // Codex review round 15 (PR #9), finding 2: armed was hashed (hash.ts's mixProjectiles)
    // but never wired onto the snapshot. expiresAtTick deliberately stays off the wire -- see
    // ProjectileSnapshotData's doc comment (protocol/snapshot.ts).
    armed: projectileNum(p.armed, id),
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

function snapshotBaseObject(world: World, id: number): BaseObjectSnapshotData {
  const store = world.baseObjects;
  return {
    id,
    damage: store.damage[id] ?? 0,
    destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
    powered: (store.powered[id] ? 1 : 0) as 0 | 1,
    // Protocol 9 (#14): the shield pool applyBaseObjectDamage spends before health. Sent
    // unconditionally, like the turret sibling below -- an omitted field would decode as the
    // reader's default and read as a full shield bar on every client.
    energy: store.energy[id] ?? 0,
  };
}
function snapshotBaseObjects(world: World): BaseObjectSnapshotData[] {
  const out: BaseObjectSnapshotData[] = [];
  for (let id = 0; id < world.baseObjects.count; id += 1) out.push(snapshotBaseObject(world, id));
  return out;
}
function snapshotTurret(world: World, id: number): TurretSnapshotData {
  const store = world.turrets;
  return {
    id,
    damage: store.damage[id] ?? 0,
    destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
    powered: (store.powered[id] ? 1 : 0) as 0 | 1,
    targetId: store.targetId[id] ?? -1,
    targetKind: store.targetKind[id] ?? 0,
    state: store.state[id] ?? 0,
    energy: store.energy[id] ?? 0,
  };
}
function snapshotTurrets(world: World): TurretSnapshotData[] {
  const out: TurretSnapshotData[] = [];
  for (let id = 0; id < world.turrets.count; id += 1) out.push(snapshotTurret(world, id));
  return out;
}

/** `botManager` is optional here (unlike `NetServerOptions.botManager`, required) purely
 *  so every existing direct caller of this exported function -- net.test.ts builds
 *  `WorldExtras` fixtures against a bare `World` with no bot manager in play at all --
 *  keeps working unchanged; the real snapshot path (sendAllSnapshots below) always
 *  passes one. Debug-overlay data only (Task 12): playerId + BotState, one entry per
 *  currently-active bot, bounds-checked against MAX_SNAPSHOT_BOTS the same as every
 *  other extras array. */
export function buildExtras(
  world: World,
  botManager?: BotManager,
  board?: OrderBoard,
): WorldExtras {
  return {
    projectiles: snapshotActiveProjectiles(world),
    flags: snapshotWorldFlags(world),
    baseObjects: snapshotBaseObjects(world),
    turrets: snapshotTurrets(world),
    // Reuses @clans/sim's own serializeActiveVehicles rather than a hand-rolled per-field
    // builder like the base-object/turret ones above -- VehicleSnapshotData's shape is
    // already the sim type, not a separately duplicated protocol-side shape (see snapshot.ts's
    // WorldExtras.vehicles).
    vehicles: serializeActiveVehicles(world),
    teamScores: [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0],
    gameOver: world.gameOver,
    winnerTeam: world.winnerTeam,
    timeRemainingS: Math.max(0, (world.timeLimitTicks - world.tick) * FIXED_DT),
    gameOverReason: world.gameOverReason,
    bots: botManager
      ? [...botManager.runtimes.values()]
          .filter((runtime) => world.players.active[runtime.playerId])
          .map((runtime) => ({ playerId: runtime.playerId, state: runtime.state }))
      : [],
    orders: board ? ordersForSnapshot(board, world) : [],
  };
}

function ordersForSnapshot(board: OrderBoard, world: World): WorldExtras['orders'] {
  const orders: WorldExtras['orders'] = [];
  for (const team of [1, 2] as const) {
    const order = currentOrder(board, team, world.tick);
    if (!order) continue;
    orders.push({
      team: order.team,
      kind: order.kind,
      x: order.x,
      z: order.z,
      expiresInS: (order.expiresAtTick - world.tick) * FIXED_DT,
    });
  }
  return orders;
}

/** Clears a respawned id's position history the same way disconnect already does (see
 * `handleClose`'s own comment): without this, a high-latency shooter firing within the
 * history window's ~1 s of a respawn could still rewind the fresh spawn back onto wherever
 * that id's corpse stood before the respawn (Codex PR #9 round 3, P1 finding 2). */
function respawnDuePlayers(world: World, spawns: SceneSpawn[], history: PositionHistory): void {
  // Codex review round 16, finding 3: dead players stay `active` (death only clears `alive`),
  // so teamCount(world, team) reads the same value for every id processed in this same pass,
  // and on a full 24-seat team that value is the seat cap itself -- 23 % <spheres> pinned
  // every respawn wave to one fixed sphere at one fixed golden angle. world.ts's
  // respawnSpawnIndex derives the slot from the player's own seat plus their own respawn
  // count instead: simultaneous teammates keep distinct seats, and each wave advances one
  // slot (flipping sphere parity), so consecutive waves land on different positions. The
  // occupied list keeps a fresh spawn from landing inside whoever is already standing there.
  for (const id of dueForRespawn(world)) {
    const team = world.players.team[id] ?? 1;
    const [x, y, z] = spawnPointFor(
      world.terrain,
      spawns,
      team,
      respawnSpawnIndex(world, id),
      world.interiors,
      activePlayerPositions(world, id),
    );
    respawnPlayer(world, id, { x, y, z });
    clearHistory(history, id);
  }
}

function killEvents(world: World): EventMessage[] {
  return world.pendingDeaths.map(({ id, attackerId }) => ({
    type: MessageType.Event as const,
    kind: EventKind.PlayerKilled,
    a: attackerId,
    b: id,
  }));
}

function laserEvents(world: World): EventMessage[] {
  // Codex PR #9 round 2, finding 5: projectiles.ts's stepProjectiles clears
  // pendingFireEvents before stepWorld returns and copies it into lastFireEvents
  // specifically so server code can still read this tick's fire events afterward.
  // Reading pendingFireEvents here always saw an already-emptied array, so a Laser
  // Rifle shot was simulated (the damage landed) but its LaserFired event never
  // reached any client -- a shot with a hit and no muzzle flash or beam on the wire.
  //
  // Codex PR #9 round 3: `b` now reads world.lastFireEvents' own hitPlayerId directly --
  // the SAME authoritative hit-test that applied the damage (and, when it ran, the same
  // lag-compensated correction below) -- instead of net.ts redoing an imperfect copy of
  // that search (the deleted `findLaserHit`) that ignored terrain and ran after the fact.
  return world.lastFireEvents
    .filter((event) => event.weaponId === WeaponId.LaserRifle && !event.isAltFire)
    .map((event) => ({
      type: MessageType.Event as const,
      kind: EventKind.LaserFired,
      a: event.playerId,
      b: event.hitPlayerId,
      beam: { from: event.origin, to: event.hitPoint ?? event.beamEnd ?? event.origin },
    }));
}

/** This tick's authoritative projectile impacts (#52) as broadcastable events. The records
 *  live in world.projectiles.lastImpacts, which stepProjectiles overwrites every call -- the
 *  same one-tick-only shape killEvents' pendingDeaths and laserEvents' lastFireEvents already
 *  broadcast from -- so each impact is sent to every client exactly once, on the tick it
 *  happened, whether or not this tick also sends a snapshot: a shot that lives and dies
 *  entirely between two snapshots still reaches every client. applyLagCompensatedHits may
 *  append a corrected Direct record AFTER stepWorld, which is why this reads lastImpacts
 *  here, last of the event drains, rather than inside stepWorld. */
function impactEvents(world: World): EventMessage[] {
  return world.projectiles.lastImpacts.map((impact) => ({
    type: MessageType.Event as const,
    kind: EventKind.ProjectileImpact,
    a: impact.reason,
    b: -1,
    impact,
  }));
}

/** This tick's ping for `playerId`, or 0 if they're not currently connected (a shot credited
 * to an id whose socket just closed gets no lag compensation, same as any other unconnected
 * id). Linear over `clients` rather than a dedicated by-id index: a tick has at most a
 * handful of hitscan/tracer shooters to look up, never every connected client. */
function pingForPlayer(clients: Map<WebSocket, ClientEntry>, playerId: number): number {
  for (const entry of clients.values()) {
    if (entry.session.playerId === playerId) return entry.pingMs;
  }
  return 0;
}

/** The damage a lag-compensated hit deals, computed while the target's position is still
 * substituted with its rewound value (the Laser Rifle's headshot check reads that position's
 * hitbox). Mirrors `resolveHitscan`'s own head-multiplier math for the Laser Rifle; the
 * Chaingun's live `resolveImpact` never applies one, so this doesn't either. `armor` feeds
 * only the hitbox geometry: corrections standardize on LIGHT_ARMOR (the historical behavior
 * every existing correction test pins), while the issue #10 undo passes the victim's real
 * armor so the reverted amount is EXACTLY what `resolveHitscan` applied live. */
function correctionDamage(
  world: World,
  event: FireEvent,
  result: HitResult,
  armor: ArmorData = LIGHT_ARMOR,
): number {
  const data = WEAPON_DATA[event.weaponId];
  if (data.projectile !== null || result.hitPlayerId < 0) return data.directDamage;
  const hitbox = playerHitbox(world, result.hitPlayerId, armor);
  const multiplier =
    result.hitPoint && result.hitPoint.y >= hitbox.headY ? (data.headMultiplier ?? 1) : 1;
  return data.directDamage * event.energyScale * multiplier;
}

/** The pre-stepWorld damage/respawnAt snapshot runOneTick captures for the issue #10
 * live-hit rejection: the smallest state an un-kill has to restore without re-simulating. */
interface PreTickPlayerState {
  damage: Float64Array;
  respawnAt: Float64Array;
}

/**
 * The architectural fix (Codex PR #9 round 3, all three P1s): `stepWorld` above this already
 * ran once, completely, against every player's TRUE position -- no rewind, so nothing it
 * touched (energy, ammo, velocity, fall damage, ...) was ever corrupted, and
 * `world.lastFireEvents` already carries the live, non-lag-compensated hit-test result for
 * every same-tick hitscan/tracer shot fired this tick. For each such event whose shooter has
 * meaningful ping, this substitutes (position only -- nothing else) every other active
 * player's position with their recorded value from `rewindTicks` ago, redoes just the
 * hit-test via `@clans/sim`'s `hitTestFireEvent`, and restores true positions immediately
 * after -- a narrow, side-effect-free recheck, never a substitution before or during
 * `stepWorld` (eligibility is driven by `world.lastFireEvents`, i.e. a shot with real game
 * effect, never raw `input.fire`, which used to trigger a rewind on every held-trigger tick
 * regardless of reload/ammo/death state -- P1 finding 3).
 *
 * Issue #10: that recheck is no longer one-sided. The rewound result is the shooter's own
 * view of the shot, and it now arbitrates LIVE hits too, not just misses:
 *
 * - a live miss the rewound view turns into a hit is granted (the historical correction
 *   path, unchanged below);
 * - a live hit the rewound view reproduces on the same target is honored untouched;
 * - a live hit the rewound view does NOT reproduce -- the target walked onto the ray only
 *   by server processing time, somewhere the shooter's screen never showed them -- is
 *   rejected: `rejectLiveHit` removes exactly the damage that hit applied (un-killing the
 *   victim if it was the killing blow), and the event is reshaped into the miss the
 *   shooter's view actually shows, so every downstream consumer (LaserFired's target and
 *   beam endpoint, kill broadcasts) sees the honest result.
 *
 * A hit the recheck retargets to a different player applies the correction path to the new
 * target on top of the rejection -- the same generosity rule the miss path always had.
 * The rejection never re-runs or rewinds the world itself: earlier designs that substituted
 * positions before `stepWorld` corrupted everything else the tick simulated (Codex PR #9
 * round 3, P1 finding 1), so this stays a post-hoc, position-only recheck whose only
 * side effects are the deliberate bookkeeping reversals in `rejectLiveHit`.
 *
 * Codex round 4, finding 2: the correction path runs entirely after `stepWorld` -- and
 * therefore after that tick's `stepFlags` -- so a kill it produces can never be seen by
 * `dropCarriedFlagsOnDeath`'s own `pendingDeaths` pass. It calls `dropFlagsCarriedBy` --
 * the exact synchronous mechanism `handleClose` uses for the identical disconnect-timing
 * problem -- immediately once `applyDamage` leaves the target dead. A REJECTED live hit has
 * the opposite timing: its victim died (if at all) inside `stepWorld`, so the flag drop and
 * death bookkeeping already happened there, and `unkillPlayer` reverses each piece.
 */
function applyLagCompensatedHits(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  history: PositionHistory,
  flagsBefore: FlagSnapshotForDiff[],
  preTick: PreTickPlayerState,
): void {
  for (const event of world.lastFireEvents) {
    // Round 4: only recheck a shot that actually ran its hit-test. `resolved` is false when
    // the shot never did (e.g. the 256-slot projectile store was full), which otherwise
    // looks identical to a real miss (`hitPlayerId === -1`) and would let lag comp apply
    // damage from a "shot" that structurally never existed.
    if (!HITSCAN_WEAPONS.has(event.weaponId) || !event.resolved) continue;
    // Codex review round 16, finding 2: pingMs is measured snapshot-send to ack-receive, a
    // full round trip -- but what the shooter's screen actually shows is delayed by only the
    // one-way leg (server-to-client), so the rewind amount must be half the RTT, not the whole
    // thing. Rewinding by the full RTT overshoots the shooter's real view by ~2x, moving
    // targets further back than their screen ever showed and both granting hits that were
    // never earned and (via REWIND_CAP_MS) capping out at half the intended reach. A shooter
    // with no measurable ping has no view/server gap to compensate in either direction, so
    // their live result stands unvalidated -- exactly the pre-#10 behavior for misses too.
    const pingMs = pingForPlayer(clients, event.playerId) / 2;
    const rewindTicks = Math.round(Math.min(pingMs, REWIND_CAP_MS) / FIXED_TICK_MS);
    if (rewindTicks <= 0) continue;
    const handle = rewindOthers(world, history, [event.playerId], rewindTicks);
    const result = hitTestFireEvent(world, event, FIXED_DT);
    restorePositions(world, handle);
    if (event.hitPlayerId !== -1) {
      // Issue #10: a live hit stands only if the shooter's own rewound view reproduces it
      // on the same target. Anything else -- the view misses, or shows a DIFFERENT player
      // on the ray -- is rejected first; a different-view target then falls through to the
      // correction path below and receives the hit the shooter's screen actually earned.
      if (result.hitPlayerId === event.hitPlayerId) continue;
      rejectLiveHit(world, event, preTick, flagsBefore);
    }
    if (result.hitPlayerId < 0) continue;
    event.hitPlayerId = result.hitPlayerId;
    event.hitPoint = result.hitPoint;
    const damage = correctionDamage(world, event, result);
    applyDamage(world, result.hitPlayerId, damage, event.playerId, LIGHT_ARMOR);
    // Consume the still-flying Tracer this event spawned so it can't score a second,
    // independent hit on a later tick -- see FireEvent.projectileId and
    // deactivateProjectile's own comments (Codex review round 5, finding 1). A no-op for
    // the Laser Rifle, which never spawns a projectile at all (projectileId stays -1), and
    // for a REJECTED live Chaingun hit, whose tracer already resolved and freed itself live
    // inside stepWorld. That live resolution also left an authoritative Direct impact record
    // at the true contact point (#52); it stands -- the tracer really did strike the target
    // at server-time truth, only the credit is reversed -- and recordImpact's exactly-once
    // shape is never touched here.
    deactivateProjectile(world, event.projectileId, result.hitPoint);
    if (!world.players.alive[result.hitPlayerId]) dropFlagsCarriedBy(world, result.hitPlayerId);
  }
}

/**
 * Reverses one live hit the shooter's rewound view contradicted (issue #10): subtracts the
 * exact damage the live hit applied, and, when that hit was what killed the victim, un-kills
 * them (see `unkillPlayer`). The event itself is reshaped into a miss so the later event
 * drains (`laserEvents`' target/beam endpoint) broadcast what the shooter's view showed.
 */
function rejectLiveHit(
  world: World,
  event: FireEvent,
  preTick: PreTickPlayerState,
  flagsBefore: FlagSnapshotForDiff[],
): void {
  const victimId = event.hitPlayerId;
  // The exact amount the live path applied, recomputed from the same inputs
  // `resolveHitscan`/`resolveImpact` used (the recorded hitPoint carries the live
  // head-shot decision; the victim's real armor reproduces their live hitbox) -- read
  // before the event is overwritten below. applyDamage is purely additive while the
  // target lives, so subtracting the same amount is an exact undo; the maxDamage clamp
  // only ever engages on the killing blow, which is the one case `unkillPlayer` handles.
  const amount = correctionDamage(
    world,
    event,
    { hitPlayerId: victimId, hitPoint: event.hitPoint },
    armorFor(world, victimId),
  );
  event.hitPlayerId = -1;
  event.hitPoint = null;
  const players = world.players;
  // Subtracting the requested amount is exact while the target lives (applyDamage is
  // purely additive below maxDamage); on the killing blow the maxDamage clamp applied less
  // than was requested, so the subtraction is floored at the pre-tick level -- the victim
  // comes back exactly as healthy as they started the tick, never healthier.
  players.damage[victimId] = Math.max(
    preTick.damage[victimId] ?? 0,
    Math.max(0, (players.damage[victimId] ?? 0) - amount),
  );
  if (players.alive[victimId]) return;
  // Still dead even without this hit's damage: legitimate damage this tick killed them,
  // and reversing the unfair shot must not resurrect them out of a fair death.
  if ((players.damage[victimId] ?? 0) >= armorFor(world, victimId).maxDamage) return;
  unkillPlayer(world, victimId, preTick, flagsBefore);
}

/** Reverses the death bookkeeping a rejected live hit caused: alive/respawnAt restored to
 * their pre-tick values, the victim's pendingDeaths entry (and the kill score it credited)
 * removed before the tick's event drain can broadcast it, and a carried flag the death
 * dropped this same tick returned to the resurrected carrier. */
function unkillPlayer(
  world: World,
  victimId: number,
  preTick: PreTickPlayerState,
  flagsBefore: FlagSnapshotForDiff[],
): void {
  const players = world.players;
  players.alive[victimId] = 1;
  players.respawnAt[victimId] = preTick.respawnAt[victimId] ?? 0;
  // Exactly one entry per death exists here (applyDamage stops counting once `alive` is
  // 0), and removing it before runOneTick's killEvents drain means no PlayerKilled event
  // ever reaches a client for a hit that -- from the shooter's own view -- never landed.
  world.pendingDeaths = world.pendingDeaths.filter(({ id, attackerId }) => {
    if (id !== victimId) return true;
    // Exact inverse of damage.ts's scoreForDeath for this entry.
    if (attackerId >= 0) {
      const sameTeam = players.team[attackerId] === players.team[victimId];
      const delta = attackerId === victimId ? -10 : sameTeam ? -10 : 10;
      players.score[attackerId] = (players.score[attackerId] ?? 0) - delta;
    }
    return false;
  });
  restoreCarriedFlagDroppedByDeath(world, victimId, flagsBefore);
}

/** Returns the flag the victim was carrying into this tick (per `flagsBefore`) if the death
 * dropped it and nobody has picked it up in the same tick -- a dropped flag sitting at the
 * death spot goes back to `Carried` by the resurrected carrier, and a flag an enemy already
 * grabbed stays grabbed (the grab was real; only the death is reversed). */
function restoreCarriedFlagDroppedByDeath(
  world: World,
  victimId: number,
  flagsBefore: FlagSnapshotForDiff[],
): void {
  let restored = false;
  for (let flagId = 0; flagId < world.flags.state.length; flagId += 1) {
    if (flagsBefore[flagId]?.carrierId !== victimId) continue;
    if ((world.flags.state[flagId] ?? 0) !== FlagState.Dropped) continue;
    if ((world.flags.carrierId[flagId] ?? -1) !== -1) continue;
    world.flags.state[flagId] = FlagState.Carried;
    world.flags.carrierId[flagId] = victimId;
    restored = true;
  }
  // Carried flag positions are synced from their carrier inside stepFlags; the reversal
  // above happens after that pass, so the restored flag needs one explicit re-sync or it
  // would render at the death spot while `Carried`.
  if (restored) resyncCarriedFlagPositions(world);
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

function dropEvent(
  flagId: number,
  previous: FlagSnapshotForDiff,
  state: number,
): EventMessage | null {
  if (previous.state !== FlagState.Carried || state !== FlagState.Dropped) return null;
  return { type: MessageType.Event, kind: EventKind.FlagDropped, a: previous.carrierId, b: flagId };
}

function returnEvent(
  flagId: number,
  previous: FlagSnapshotForDiff,
  state: number,
): EventMessage | null {
  if (previous.state !== FlagState.Dropped || state !== FlagState.Home) return null;
  // A player-caused return has no carrier transition; -1 distinguishes a timer return.
  return { type: MessageType.Event, kind: EventKind.FlagReturned, a: -1, b: flagId };
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
    dropEvent(flagId, previous, state),
    returnEvent(flagId, previous, state),
  ];
  return events.filter((event): event is EventMessage => event !== null);
}

export function flagEvents(world: World, before: FlagSnapshotForDiff[]): EventMessage[] {
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
          options.botManager,
          options.board,
          clients,
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
      handleClose(options.world, options.spawns, options.botManager, clients, history, socket);
    });
    // A malformed frame at the WebSocket protocol level itself (an invalid raw frame,
    // e.g. an unmasked client frame) fires 'error' on the socket before 'message' ever
    // sees it, and our application-level try/catch above only ever covers decoded
    // messages. With no 'error' listener at all, Node's default is to throw and crash
    // the process; this absorbs it the same way the server-level handler below does.
    socket.on('error', () => {
      clearTimeout(joinTimeout);
      handleClose(options.world, options.spawns, options.botManager, clients, history, socket);
    });
  });

  function sendAllSnapshots(): void {
    const players = serializeActivePlayers(options.world);
    const extras = buildExtras(options.world, options.botManager, options.board);
    // Relevance inputs shared by every client this send (issue #5): interior footprints and
    // base-object placements come from the same world state the snapshot was built from,
    // so the per-client views below can never disagree about what exists.
    const interiors: InteriorFootprint[] = options.world.interiors.map(
      (instance) => instance.bounds,
    );
    const baseObjectPositions = baseObjectPlacementsFor(options.world);
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
      const full = needsFullSnapshot(
        entry.session.lastAckedSnapshotId,
        entry.session.lastAckedAt,
        now(),
      );
      // Issue #5: the per-client relevance view replaces the old one-roster-fits-all send.
      // sendSnapshot stores THIS view as the client's next delta baseline, so the stale
      // distant-player copies the sparse cadence re-sends diff clean against what the
      // client actually acked.
      const view = relevantSnapshotForViewer({
        snapshotId: nextSnapshotId,
        full,
        viewerId: entry.session.playerId,
        players,
        extras,
        interiors,
        baseObjectPositions,
        cache: entry.relevance,
      });
      // Report options.world.tick (the value stepWorld just produced), not the loop's own
      // tickNumber argument (the pre-step value): see issue #6.
      sendSnapshot(entry, nextSnapshotId, options.world.tick, full, view.players, view.extras, now);
    }
  }

  function runOneTick(inputs: Map<number, PlayerInput>): void {
    recordHistory(history, options.world);
    const flagsBefore = snapshotFlags(options.world);
    // Per-player pre-tick damage/respawnAt, for the issue #10 live-hit validation below:
    // reverting exactly the damage one live hit applied needs the damage level the target
    // had BEFORE stepWorld ran, captured without rewinding or re-stepping anything.
    const preTick = {
      damage: Float64Array.from(options.world.players.damage),
      respawnAt: Float64Array.from(options.world.players.respawnAt),
    };

    // stepWorld always runs against every player's TRUE position now -- see
    // applyLagCompensatedHits's own comment for why. Its own hit-test result on
    // world.lastFireEvents is therefore already fully correct and uncorrupted; lag
    // compensation is a narrow recheck layered on AFTER, never a substitution before.
    stepWorld(options.world, inputs);
    // Codex round 4, finding 6: stepWorld can flip world.gameOver to true partway through
    // THIS call (a capture or the time limit landing on this exact tick), and the `tick`
    // function's own gameOver gate below was only checked before this call started, using
    // the stale pre-tick value. Without re-checking here, both of these post-stepWorld
    // operations kept running for one tick after the match froze: a respawn timer due on
    // the game-ending tick still respawned its player into a supposedly-frozen match, and a
    // lag-comp correction could still land a hit on it. Once gameOver is true, stepWorld's
    // own guard means neither of these ever has fresh sim state to react to again anyway.
    if (!options.world.gameOver) {
      respawnDuePlayers(options.world, options.spawns, history);
      applyLagCompensatedHits(options.world, clients, history, flagsBefore, preTick);
    }

    for (const event of killEvents(options.world)) broadcastEvent(clients, event);
    for (const event of flagEvents(options.world, flagsBefore)) broadcastEvent(clients, event);
    for (const event of laserEvents(options.world)) broadcastEvent(clients, event);
    for (const event of impactEvents(options.world)) broadcastEvent(clients, event);
  }

  // Game over freezes the sim: no more stepWorld, no more respawns or events, but snapshots
  // keep going out on the normal cadence so every client sees the frozen final state.
  function tick(tickNumber: number): void {
    const inputs = collectTickInputs(clients);
    // Codex review round 1, finding (P2): stepBotManager used to run every tick
    // unconditionally, even after gameOver froze the match -- 32 bots kept paying full
    // perception/pathing cost for a match nobody could act in, and maybeHeal's direct
    // applyLoadoutSelection call could still mutate a "frozen" player's armor/energy/ammo.
    // Gated behind the same guard runOneTick already uses, matching how the rest of the
    // tick loop treats gameOver as a hard stop, not just a stop on the sim step.
    if (!options.world.gameOver) {
      // A bot id is never also a socket-bound player id (a human never joins as an id a
      // bot already occupies -- handleJoin's own addPlayer always allocates a fresh id),
      // so the two maps' key sets never overlap and this merge order doesn't matter.
      for (const [botId, input] of stepBotManager(
        options.botManager,
        options.world,
        options.board,
      )) {
        inputs.set(botId, input);
      }
      runOneTick(inputs);
    }
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
