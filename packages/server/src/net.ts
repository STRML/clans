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
  applyDamage,
  deactivateProjectile,
  dueForRespawn,
  hitTestFireEvent,
  playerHitbox,
  removePlayer,
  respawnPlayer,
  sampleTerrain,
  serializeActivePlayers,
  setGodMode,
  stepWorld,
  type FireEvent,
  type HitResult,
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
import {
  clearHistory,
  createPositionHistory,
  recordHistory,
  restorePositions,
  rewindOthers,
  type PositionHistory,
} from './lagcomp.js';
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
  packActive: false,
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

function handleMessage(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  now: () => number,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const type = bytes[0];
  if (type === MessageType.Join) handleJoin(world, spawns, clients, now, socket, bytes);
  else if (type === MessageType.Input) handleInput(clients, socket, bytes);
  else if (type === MessageType.Ack) handleAck(clients, now, socket, bytes);
  else if (type === MessageType.God) handleGod(world, clients, socket, bytes);
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
  history: PositionHistory,
  socket: WebSocket,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  dropFlagsCarriedBy(world, entry.session.playerId);
  removePlayer(world, entry.session.playerId);
  // God mode lives on world.players.godMode now (setGodMode), and addPlayer already zeroes
  // that bit for a reused id -- no separate godPlayers Set to clean up here anymore.
  // Codex PR #9 round 2, finding 7: recordHistory only forgets an id once it notices that
  // id is no longer active, on its next call for every currently active player -- an id
  // reused by a new Join before that next tick otherwise still carries the previous
  // occupant's recorded trail, and a hitscan shot at another player that tick could rewind
  // the new occupant onto it for one tick. Clearing it here, synchronously on disconnect,
  // closes that window instead of waiting on a future tick to overwrite it naturally.
  clearHistory(history, entry.session.playerId);
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

/** Clears a respawned id's position history the same way disconnect already does (see
 * `handleClose`'s own comment): without this, a high-latency shooter firing within the
 * history window's ~1 s of a respawn could still rewind the fresh spawn back onto wherever
 * that id's corpse stood before the respawn (Codex PR #9 round 3, P1 finding 2). */
function respawnDuePlayers(world: World, spawns: SceneSpawn[], history: PositionHistory): void {
  // Codex review round 16, finding 3: dead players stay `active` (death only clears `alive`),
  // so teamCount(world, team) reads the same value for every id processed in this same pass --
  // two teammates due on the same tick both computed index `teamCount - 1` and landed on the
  // identical spawn point. Track how many respawns this pass has already placed per team and
  // add that offset, so simultaneous same-team respawns fan out across the team's spawn list
  // instead of stacking on one point.
  const respawnedThisPass = new Map<number, number>();
  for (const id of dueForRespawn(world)) {
    const team = world.players.team[id] ?? 1;
    const alreadyPlaced = respawnedThisPass.get(team) ?? 0;
    // handleJoin picks an initial spawn using the team's count BEFORE that player is added
    // (teamCount is read before addPlayer runs), i.e. a count that never includes the
    // player being placed. dueForRespawn's id is already active (death only clears
    // `alive`, never `active`), so teamCount(world, team) here already counts it -- the
    // -1 restores the same "count of everyone else on the team" convention join uses, so
    // a player's very first respawn picks the same spawn their initial join would have
    // (Codex review round 5, finding 2).
    const [x, y, z] = spawnPointFor(
      world.terrain,
      spawns,
      team,
      teamCount(world, team) - 1 + alreadyPlaced,
    );
    respawnPlayer(world, id, { x, y, z });
    clearHistory(history, id);
    respawnedThisPass.set(team, alreadyPlaced + 1);
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

/** The damage a lag-compensated correction hit deals, computed while the target's position
 * is still substituted with its rewound value (the Laser Rifle's headshot check reads that
 * position's hitbox). Mirrors `resolveHitscan`'s own head-multiplier math for the Laser
 * Rifle; the Chaingun's live `resolveImpact` never applies one, so this doesn't either. */
function correctionDamage(world: World, event: FireEvent, result: HitResult): number {
  const data = WEAPON_DATA[event.weaponId];
  if (data.projectile !== null || result.hitPlayerId < 0) return data.directDamage;
  const hitbox = playerHitbox(world, result.hitPlayerId, LIGHT_ARMOR);
  const multiplier =
    result.hitPoint && result.hitPoint.y >= hitbox.headY ? (data.headMultiplier ?? 1) : 1;
  return data.directDamage * event.energyScale * multiplier;
}

/**
 * The architectural fix (Codex PR #9 round 3, all three P1s): `stepWorld` above this already
 * ran once, completely, against every player's TRUE position -- no rewind, so nothing it
 * touched (energy, ammo, velocity, fall damage, ...) was ever corrupted, and
 * `world.lastFireEvents` already carries the live, non-lag-compensated hit-test result for
 * every same-tick hitscan/tracer shot fired this tick. This function's only job is a narrow,
 * side-effect-free RECHECK of those specific events: for each one the live sim did NOT
 * register a hit on, and whose shooter has meaningful ping, substitute (position only --
 * nothing else) every other active player's position with their recorded value from
 * `rewindTicks` ago, redo just the hit-test via `@clans/sim`'s `hitTestFireEvent`, and
 * restore true positions immediately after. A hit this recheck finds that the live
 * simulation didn't is applied directly via `applyDamage` as a legitimate server-side
 * correction; a hit the live simulation already registered is never revisited or undone --
 * lag compensation is only ever generous to the shooter (P1 finding 3: eligibility here is
 * driven by `world.lastFireEvents`, i.e. a shot with real game effect, never raw
 * `input.fire`, which used to trigger a rewind on every held-trigger tick regardless of
 * reload/ammo/death state).
 *
 * Codex round 4, finding 2: this correction runs entirely after `stepWorld` -- and therefore
 * after that tick's `stepFlags` -- so a kill it produces can never be seen by
 * `dropCarriedFlagsOnDeath`'s own `pendingDeaths` pass, and the *next* tick's `stepPlayers`
 * clears `pendingDeaths` before that next tick's `stepFlags` gets a chance either. A flag
 * carried by a player this correction kills would stay `Carried` by a corpse forever. This
 * calls `dropFlagsCarriedBy` -- the exact same synchronous mechanism `handleClose` already
 * uses for the identical disconnect-timing problem -- immediately once `applyDamage` leaves
 * the target dead.
 */
function applyLagCompensatedHits(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  history: PositionHistory,
): void {
  for (const event of world.lastFireEvents) {
    // Round 4: only recheck a genuine live miss. `resolved` is false when the shot never
    // actually ran its hit-test at all (e.g. the 256-slot projectile store was full), which
    // otherwise looks identical to a real miss (`hitPlayerId === -1`) and would let lag comp
    // apply damage from a "shot" that structurally never existed.
    if (!HITSCAN_WEAPONS.has(event.weaponId) || !event.resolved || event.hitPlayerId !== -1)
      continue;
    // Codex review round 16, finding 2: pingMs is measured snapshot-send to ack-receive, a
    // full round trip -- but what the shooter's screen actually shows is delayed by only the
    // one-way leg (server-to-client), so the rewind amount must be half the RTT, not the whole
    // thing. Rewinding by the full RTT overshoots the shooter's real view by ~2x, moving
    // targets further back than their screen ever showed and both granting hits that were
    // never earned and (via REWIND_CAP_MS) capping out at half the intended reach.
    const pingMs = pingForPlayer(clients, event.playerId) / 2;
    const rewindTicks = Math.round(Math.min(pingMs, REWIND_CAP_MS) / FIXED_TICK_MS);
    if (rewindTicks <= 0) continue;
    const handle = rewindOthers(world, history, [event.playerId], rewindTicks);
    const result = hitTestFireEvent(world, event, FIXED_DT);
    const damage = correctionDamage(world, event, result);
    restorePositions(world, handle);
    if (result.hitPlayerId < 0) continue;
    event.hitPlayerId = result.hitPlayerId;
    event.hitPoint = result.hitPoint;
    applyDamage(world, result.hitPlayerId, damage, event.playerId, LIGHT_ARMOR);
    // Consume the still-flying Tracer this event spawned so it can't score a second,
    // independent hit on a later tick -- see FireEvent.projectileId and
    // deactivateProjectile's own comments (Codex review round 5, finding 1). A no-op for
    // the Laser Rifle, which never spawns a projectile at all (projectileId stays -1).
    deactivateProjectile(world, event.projectileId);
    if (!world.players.alive[result.hitPlayerId]) dropFlagsCarriedBy(world, result.hitPlayerId);
  }
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
      handleClose(options.world, clients, history, socket);
    });
    // A malformed frame at the WebSocket protocol level itself (an invalid raw frame,
    // e.g. an unmasked client frame) fires 'error' on the socket before 'message' ever
    // sees it, and our application-level try/catch above only ever covers decoded
    // messages. With no 'error' listener at all, Node's default is to throw and crash
    // the process; this absorbs it the same way the server-level handler below does.
    socket.on('error', () => {
      clearTimeout(joinTimeout);
      handleClose(options.world, clients, history, socket);
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
    const flagsBefore = snapshotFlags(options.world);

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
      applyLagCompensatedHits(options.world, clients, history);
    }

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
