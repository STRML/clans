import {
  addPlayer,
  createProjectileStore,
  createWorld,
  deserializePlayer,
  FIXED_DT,
  LIGHT_ARMOR,
  resetLoadout,
  resetPlayerToSpawn,
  RESPAWN_TICKS,
  setGodMode as setSimGodMode,
  stepWorld,
  type ArmorId,
  type Heightfield,
  type PlayerInput,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import {
  MessageType,
  SNAPSHOT_HISTORY_DEPTH,
  WelcomeStatus,
  decodeEvent,
  decodeSnapshot,
  decodeWelcome,
  encodeAck,
  encodeGod,
  encodeInput,
  encodeJoin,
  encodeLoadout,
  peekSnapshotHeader,
  type BaseObjectSnapshotData,
  type EventMessage,
  type FlagSnapshotData,
  type ProjectileSnapshotData,
  type TurretSnapshotData,
} from '@clans/protocol';
import type { SnapshotBaseline } from '@clans/protocol';
import type { Transport } from './transport.js';

const EVENT_HISTORY = 100;

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
// Bounds the interpolation queue below in case a caller ever stops draining it. Under
// normal operation it holds at most a couple of entries: render frames (~60/s) happen far
// more often than snapshots (every SNAPSHOT_EVERY_N_TICKS ticks), so the render loop
// drains this well before it could grow.
const MAX_REMOTE_SNAPSHOT_QUEUE = 16;

interface PendingInput {
  sequence: number;
  input: PlayerInput;
}
export interface RemoteSnapshot {
  tick: number;
  players: Map<number, PlayerSnapshotData>;
}
/**
 * An Event message tagged with a receipt-order sequence number. recentEvents is a rolling
 * buffer that evicts its oldest entry past EVENT_HISTORY, so a consumer tracking "what's
 * new since last frame" by array index breaks forever once eviction starts shifting
 * everything down. seq is assigned once, at receipt, is never reused, and survives
 * eviction, so "new" is `seq > lastSeenSeq` rather than a position in the live array.
 */
export interface TimestampedEvent extends EventMessage {
  seq: number;
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
  /**
   * Every remote-player snapshot since the last drain, oldest first. Codex round 10
   * (PR #4): remotePlayers is replaced wholesale each time a snapshot decodes, so if more
   * than one arrived within a single render frame (a frame stall, or simply more than one
   * landing before the next paint), only the newest survived to reach RemoteBuffer's
   * interpolation history -- the earlier one's position was gone before anything read it,
   * so a remote snapped instead of smoothing through it. A consumer must splice this
   * queue empty on every drain, not just read the latest entry.
   */
  remoteSnapshots: RemoteSnapshot[] = [];
  projectiles: ProjectileSnapshotData[] = [];
  flags: FlagSnapshotData[] = [];
  baseObjects: BaseObjectSnapshotData[] = [];
  turrets: TurretSnapshotData[] = [];
  teamScores: [number, number] = [0, 0];
  gameOver = false;
  winnerTeam = 0;
  timeRemainingS = 0;
  gameOverReason = 0;
  localHealth = LIGHT_ARMOR.maxDamage;
  recentEvents: TimestampedEvent[] = [];
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
  // Codex review round 7 (PR #9): what syncRespawnState below detects a respawn against.
  // These track what the last SNAPSHOT reported for the local player, not the client's own
  // locally-predicted alive/health -- local prediction can skip an intermediate "dead"
  // snapshot entirely (dropped, coalesced, or just never delivered under the delta/full
  // cadence) and stay "alive" throughout even though the server legitimately killed and
  // respawned the player, so a comparison against prediction never sees the transition. A
  // comparison against these two only ever moves on data actually received from the wire,
  // so a skipped snapshot in between cannot hide the edge from it. Initialized to match the
  // just-spawned state applied by the constructor/Welcome handler (alive, and no previous
  // health to have risen above yet), so the very first real snapshot cannot itself read as
  // a spurious respawn.
  private lastSnapshotAlive = true;
  private lastSnapshotHealth = Number.POSITIVE_INFINITY;
  // Codex review round 8 (PR #9): what syncRespawnState compares respawnSeq against. Same
  // "only ever moves on data actually received from the wire" contract as the two fields
  // above. Initialized to 0 to match a freshly-joined player's sim-side respawnSeq (addPlayer
  // always starts it at 0), so the very first real snapshot cannot itself read as a spurious
  // respawn.
  private lastSnapshotRespawnSeq = 0;
  private readonly lossWindow: number[] = [];
  private readonly bytesWindow: Array<{ at: number; bytes: number }> = [];
  private readonly inputSentAt = new Map<number, number>();
  // Never reset, independent of recentEvents' own eviction: the counter, not the array
  // position, is what a consumer's "new since last frame" cursor has to survive on.
  private eventSequence = 0;

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
    //
    // Codex round 14 (PR #4): isOpen() is also true while still CONNECTING, so a slow
    // handshake let this advance the wire sequence number every tick before a single byte
    // had actually been sent. A fresh server session expects a client's first real message
    // near sequence 1; a handshake slow enough to run this past MAX_SEQUENCE_JUMP first
    // (about 5m20s at FIXED_TICK_MS) made every subsequent input rejected forever. Gating
    // on isConnected() instead means the sequence only starts counting once real
    // communication begins, however long the handshake took to get there.
    if (!this.transport.isConnected()) return;
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

  /**
   * Codex review round 14 (PR #9), finding 2: this used to only send the God message and
   * rely on the next snapshot's godMode field to reach local prediction -- except (per
   * finding 1, same round) godMode wasn't even on the wire yet, so nothing ever applied the
   * toggle to this.world. applyDamage's invulnerability check runs against LOCAL prediction
   * every tick (movement.ts/damage.ts), so a networked player who enabled god mode and then
   * fell below the kill plane still predicted their own death locally, even though the
   * server (which did receive the God message) kept the real player alive -- a jarring
   * misprediction corrected only on the next snapshot. Mirrors app.ts's single-player
   * toggle handler (round 4, finding 5): apply the change to the local world immediately,
   * proactively, the same tick the player toggles it, rather than waiting on a round trip.
   * Once finding 1's wire fix lands, the godMode field reconcile() applies from every
   * snapshot also acts as a redundant authoritative correction, the same layered pattern
   * round 8's respawnSeq fix established.
   */
  setGodMode(enabled: boolean): void {
    setSimGodMode(this.world, LOCAL_SLOT, enabled);
    this.transport.send(encodeGod({ enabled }));
  }

  /** Mirrors setGodMode's own shape: send-only, no local prediction of the loadout itself --
   *  a station visit's own applyLoadoutRequest result reaches this client back through the
   *  next snapshot, the same way every other player's own authoritative state does. */
  sendLoadout(armor: ArmorId, repairPack: boolean): void {
    this.transport.send(encodeLoadout({ armor, repairPack }));
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
      else if (type === MessageType.Event) this.handleEvent(bytes);
    } catch {
      // Malformed frame: drop it. There is nothing to ack or reconcile against.
    }
  }

  private handleEvent(bytes: Uint8Array): void {
    this.eventSequence += 1;
    this.recentEvents.push({ ...decodeEvent(bytes), seq: this.eventSequence });
    if (this.recentEvents.length > EVENT_HISTORY) this.recentEvents.shift();
  }

  private handleWelcome(bytes: Uint8Array): void {
    const welcome = decodeWelcome(bytes);
    // A VersionMismatch (or any future non-Ok status) Welcome still names a playerId/team,
    // but they are not this client's -- the server is refusing the join, not granting it.
    // Treat it as a failed join through the same mechanism callers already watch
    // (transport.isOpen(), surfaced via the `connected` getter) rather than inventing a
    // parallel error channel: leave playerId/team unassigned and close the connection.
    if (welcome.status !== WelcomeStatus.Ok) {
      this.transport.close();
      return;
    }
    this.playerId = welcome.playerId;
    this.team = welcome.team;
    // The local player is created at (0,0,0) in the constructor, before any Welcome can
    // arrive, and a delayed Welcome (a slow first round trip) leaves time for local
    // prediction to run several ticks from that placeholder: moving velocity, drained
    // energy, mid-jump/ski flags. resetPlayerToSpawn is the same fresh-player reset
    // addPlayer uses, so the client ends up in exactly the state a real spawn produces,
    // not just corrected position with everything else still stale.
    resetPlayerToSpawn(this.world, LOCAL_SLOT, {
      x: welcome.spawnX,
      y: welcome.spawnY,
      z: welcome.spawnZ,
    });
    // Codex review round 4, finding 8 (PR #9): tick() runs local prediction every frame
    // regardless of whether this handshake has completed, so firing before Welcome arrives
    // both spends predicted ammo and spawns predicted projectiles the server never
    // authorized -- it did not even know about this player yet. resetPlayerToSpawn above
    // does not touch the weapon loadout or the projectile store, so without this a pre-join
    // shot left the HUD showing spent ammo and stale projectiles still flying after the
    // player actually joined. resetLoadout is the same reset a real respawn uses (round 1's
    // syncRespawnState fix below already relies on it); the projectile store has no partial
    // reset of its own, so it is replaced wholesale the same way createWorld builds a fresh
    // one.
    resetLoadout(this.world, LOCAL_SLOT, LIGHT_ARMOR);
    this.world.projectiles = createProjectileStore();
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

    // Codex review round 2 (PR #9), finding 3: stepWorld's freeze guard reads
    // world.gameOver, not this NetClient field. tick() calls stepWorld(this.world, ...)
    // every frame regardless of the fields below, so without mirroring the snapshot onto
    // the world object itself, this client's local world never learns the match ended and
    // keeps predicting movement/weapon timers/ammo and replaying unacknowledged inputs
    // after the server has already frozen.
    //
    // Codex review round 3 (PR #9), residual of the above: this assignment must also
    // happen before reconcile() below, not after. reconcile() replays any pending
    // (unacknowledged) local inputs via stepWorld to catch prediction up to the server's
    // authoritative state, and stepWorld's freeze guard only engages once world.gameOver
    // is true. Setting it after reconcile() let the very first game-over snapshot's replay
    // run against a world that did not yet know the match had ended, advancing local
    // prediction one extra tick past the true end state.
    this.gameOver = decoded.gameOver;
    this.winnerTeam = decoded.winnerTeam;
    this.timeRemainingS = decoded.timeRemainingS;
    this.gameOverReason = decoded.gameOverReason;
    this.world.gameOver = decoded.gameOver;
    this.world.winnerTeam = decoded.winnerTeam;
    this.world.gameOverReason = decoded.gameOverReason;
    // Codex review round 13 (PR #9), finding P2: createFlags (packages/sim/src/flags.ts)
    // takes a configurable timeLimitTicks, so a server can run with a non-default match
    // length. This client's local world was created with the sim's DEFAULT
    // timeLimitTicks, so local prediction's checkTimeLimit (packages/sim/src/flags.ts)
    // compared against the wrong limit and could call the match over before the server
    // did. There is no wire field for the raw tick count, and none is needed: the server
    // derives timeRemainingS from timeLimitTicks as
    // `(timeLimitTicks - tick) * FIXED_DT` (packages/server/src/net.ts, buildExtras), so
    // the inverse below re-derives timeLimitTicks from data already on the wire. decoded.tick
    // is the same world.tick the server used for that calculation (reconcile() below hasn't
    // yet advanced this.world.tick to it), so this stays consistent with the server's rounding
    // and tick reference point. Running this every snapshot self-heals local prediction to
    // whatever limit the server is actually configured with.
    this.world.timeLimitTicks = decoded.tick + Math.round(decoded.timeRemainingS / FIXED_DT);

    const self = decoded.players.find((player) => player.id === this.playerId);
    if (self) {
      this.reconcile(self, decoded.tick, decoded.lastInputSequence);
      this.localHealth = self.health;
    }

    this.remotePlayers = new Map(
      decoded.players
        .filter((player) => player.id !== this.playerId)
        .map((player) => [player.id, player]),
    );
    this.projectiles = decoded.projectiles;
    this.flags = decoded.flags;
    this.baseObjects = decoded.baseObjects;
    this.turrets = decoded.turrets;
    this.teamScores = decoded.teamScores;
    this.remoteTick = decoded.tick;
    this.remoteSnapshots.push({ tick: decoded.tick, players: this.remotePlayers });
    if (this.remoteSnapshots.length > MAX_REMOTE_SNAPSHOT_QUEUE) this.remoteSnapshots.shift();
    this.stats.entityCount = decoded.players.length;
  }

  private reconcile(
    serverState: PlayerSnapshotData,
    serverTick: number,
    lastInputSequence: number,
  ): void {
    const beforeX = this.world.players.position[0] ?? 0;
    const beforeZ = this.world.players.position[2] ?? 0;
    // Codex review round 10 (PR #9), finding 1: deserializePlayer now also writes the wire's
    // discAmmo/chaingunAmmo/mortarAmmo/grenades onto this player, unconditionally, every
    // snapshot -- not just on the respawn transition syncRespawnState detects below. Ammo is
    // predicted locally (weapons.ts's stepWeapons) same as position, but unlike a respawn,
    // ordinary prediction drift from a lost or server-evicted input has no other signal to
    // correct it: nothing here ever detects "an input never landed." Applying the
    // authoritative value on every snapshot means that drift self-heals within one round trip
    // instead of persisting until the player's next death/respawn.
    // deserializePlayer does not touch spawn/wasGrounded at all, and wasGrounded has no wire
    // field of its own, so it still needs an onGround-based proxy (round 1's original fix,
    // PR #4) -- but round 15 (PR #9, finding 1) changed WHICH onGround it proxies from.
    // movement.ts's writeState records wasGrounded[tick] as ctx.grounded, computed from the
    // player's position at the START of that tick -- i.e. wasGrounded[tick] equals
    // onGround[tick - 1] under normal local ticking. The old proxy used serverState.onGround,
    // this SAME snapshot tick's own outcome, which is off by one tick and only happens to
    // match at that tick when grounded state didn't change -- wrong exactly at a landing or
    // lift-off tick, which a continuously-held jump (skiing/bunny-hopping) hits constantly.
    // Capturing this client's own pre-reconcile onGround here (its most recent locally-ticked
    // value, i.e. onGround as of the tick just before this one) reproduces the correct
    // one-tick lag without needing a new wire field. This was exposed, not created, by wiring
    // wasJumpHeld below: with wasJumpHeld hardcoded to 0, jumpEdge's `!wasJumpHeld` half was
    // always true regardless of wasGrounded, masking this proxy's off-by-one-tick error;
    // fixing wasJumpHeld alone (leaving the old serverState.onGround proxy) let jumpEdge's
    // `!wasGrounded` half decide instead, and it decided wrong at every hop landing --
    // regressing "keeps prediction within 0.5 m ... during a 3 s ski run" to ~2.7 m of
    // error. jumpEdge reads both flags together, so both had to be fixed together.
    const previousOnGround = this.world.players.onGround[LOCAL_SLOT] ?? 0;
    deserializePlayer(this.world, { ...serverState, id: LOCAL_SLOT });
    this.world.players.wasGrounded[LOCAL_SLOT] = previousOnGround;
    this.world.players.wasJumpHeld[LOCAL_SLOT] = serverState.wasJumpHeld;
    this.world.tick = serverTick;
    this.syncRespawnState(serverState.health, serverState.respawnSeq);
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

  /**
   * Codex review round 1, finding 1 (PR #9): ammo, grenades, weapon timers, and respawnAt
   * are not on the wire snapshot, so a real server-side respawn (full ammo again) never
   * reached this client's own prediction state or the HUD -- it kept dry-firing on
   * whatever ammo it had at the moment of death, and the HUD countdown read a `respawnAt`
   * that was never set locally in the first place. Detect the transition from data that
   * *is* on the wire (the health/alive edge deserializePlayer just wrote) and mirror what
   * a real respawn does: reset the loadout on the dead-to-alive edge with the same
   * `resetLoadout` the server's own respawnPlayer wrapper uses (not hand-rolled defaults),
   * and stamp a local respawnAt on the alive-to-dead edge so hud.ts's countdown has
   * something real to count down from instead of reading 0 forever.
   *
   * Codex review round 7 (PR #9): the original version of this detected the transition by
   * diffing the CLIENT's own locally-predicted alive state (world.players.alive before this
   * snapshot applied) against the just-decoded one. That is fragile to any skipped
   * intermediate snapshot -- if local prediction never actually applied a "dead" snapshot
   * (dropped, coalesced, or simply not delivered given the delta/full cadence), it stayed
   * "alive" throughout even though the server legitimately killed and respawned the player,
   * so the dead-to-alive edge never fired and the loadout kept its stale, consumed ammo.
   * `reportedHealth` is the just-decoded snapshot's own health field, and `wasAlive`/
   * `wasHealth` below are what the PREVIOUS snapshot reported (tracked on this NetClient,
   * not read back off local prediction) -- both only ever move on data actually received
   * from the wire, so a respawn is caught even when the client never saw the player go
   * through a "dead" snapshot at all: `respawnPlayer` fully resets damage to 0 on every
   * respawn and health only otherwise falls while alive (no regen in this sim), so any
   * health increase over what the previous snapshot reported is itself proof a respawn
   * happened, with or without an observed dead edge in between.
   *
   * Codex review round 8 (PR #9): round 7's fix still has one gap neither signal above can
   * close. If the last snapshot this client actually received showed the player alive at
   * FULL health, and the player then died and fully respawned entirely BETWEEN two received
   * snapshots (the dead tick's snapshot skipped/dropped/coalesced, same failure mode as
   * round 7, but this time landing between two full-health readings), the next snapshot
   * ALSO reports full health and alive -- identical to the previous one. `isAlive` never
   * flips (both snapshots say alive) and `reportedHealth > wasHealth` never fires (both say
   * the same full health), so from health/alive data alone this is genuinely
   * indistinguishable from "nothing happened." `respawnSeq` (protocol/snapshot.ts, wired
   * from sim/types.ts's PlayerStore.respawnSeq) is the fix: an explicit counter
   * damage.ts's respawnPlayer increments on every respawn and nothing else ever touches, so
   * ANY change from what the previous snapshot reported -- compared with `!==`, not `>`,
   * since the wire truncates it to a single byte and can wrap -- is unambiguous proof a
   * respawn happened, independent of what health/alive say. It is authoritative; the
   * health/alive check stays alongside it as a redundant safety net, not a replacement.
   */
  private syncRespawnState(reportedHealth: number, reportedRespawnSeq: number): void {
    const isAlive = reportedHealth > 0;
    const wasAlive = this.lastSnapshotAlive;
    const wasHealth = this.lastSnapshotHealth;
    const respawnSeqChanged = reportedRespawnSeq !== this.lastSnapshotRespawnSeq;
    const respawned = respawnSeqChanged || (isAlive && (!wasAlive || reportedHealth > wasHealth));
    if (respawned) {
      resetLoadout(this.world, LOCAL_SLOT, LIGHT_ARMOR);
      this.world.players.respawnAt[LOCAL_SLOT] = -1;
      // Codex review round 5, finding 2 (PR #9): the wire snapshot carries only the
      // respawned position, not a separate spawn-point field (that would be new protocol
      // work). deserializePlayer above already wrote that position onto players.position
      // for this dead-to-alive edge, but never touches players.spawn -- so without this,
      // players.spawn stays at whatever it was set to when this client first joined.
      // Kept in sync so any local consumer of "where would this player currently respawn"
      // sees the actual respawn point rather than the original join spawn. (Historically
      // this fed movement.ts's kill-plane fallback directly; review round 9 replaced that
      // bespoke reset with the standard applyDamage/respawnPlayer death cycle, so
      // movement.ts itself no longer reads players.spawn -- see damage.ts's respawnPlayer.)
      this.world.players.spawn.set(
        [
          this.world.players.position[LOCAL_SLOT * 3] ?? 0,
          this.world.players.position[LOCAL_SLOT * 3 + 1] ?? 0,
          this.world.players.position[LOCAL_SLOT * 3 + 2] ?? 0,
        ],
        LOCAL_SLOT * 3,
      );
    } else if (wasAlive && !isAlive) {
      this.world.players.respawnAt[LOCAL_SLOT] = this.world.tick + RESPAWN_TICKS;
    }
    this.lastSnapshotAlive = isAlive;
    this.lastSnapshotHealth = reportedHealth;
    this.lastSnapshotRespawnSeq = reportedRespawnSeq;
  }

  private recordLoss(snapshotId: number): void {
    if (this.previousSnapshotId !== 0) {
      // Codex round 13 (PR #4): snapshotId is an arbitrary wire u32, and this ran the
      // loop once per missing id with no bound. A server reached through the
      // user-selectable ?server= parameter (malicious or just badly behaved) could send
      // ids 1 then 0xffffffff and freeze the tab for roughly 4.3 billion iterations.
      // pushLoss only keeps LOSS_WINDOW samples, so any gap at or beyond that already
      // saturates packetLossEstimate at 1 -- looping further adds nothing observable.
      const gap = Math.min(Math.max(0, snapshotId - this.previousSnapshotId - 1), LOSS_WINDOW);
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
