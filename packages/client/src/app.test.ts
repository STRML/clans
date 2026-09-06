import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyDamage,
  createFlags,
  createWorld,
  FIXED_DT,
  GameOverReason,
  LIGHT_ARMOR,
  RESPAWN_TICKS,
  type Heightfield,
  type PlayerInput,
  type PlayerSnapshotData,
} from '@clans/sim';
import { EventKind, MessageType } from '@clans/protocol';
import {
  drainNewEvents,
  hudSourceFrom,
  positionOfPlayer,
  setLocalGodMode,
  stepSinglePlayer,
  teleportPlayerToFlag,
  updateRemotes,
} from './app.js';
import { flagsFromWorld } from './flag-view.js';
import { RemoteBuffer } from './remote.js';
import type { NetClient, RemoteSnapshot, TimestampedEvent } from './netclient.js';

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

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

const snapshot: PlayerSnapshotData = {
  id: 1,
  team: 1,
  x: 10,
  y: 0,
  z: 5,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  energy: 60,
  health: 60,
  weaponSlot: 4,
  onGround: 1,
  ski: 0,
};

describe('updateRemotes', () => {
  it('timestamps a pushed remote sample with the caller clock, not the server tick counter', () => {
    // Codex round 1 (PR #4): samples were timestamped with remoteTick * FIXED_TICK_MS
    // (the server's own tick counter, on a clock that starts whenever the server process
    // did) but RemoteBuffer.positionAt is later queried with the client's performance.now().
    // Those are unrelated epochs; a remote player either extrapolated forever or stuck to
    // a stale sample because renderTime never bracketed a sample timestamped that way.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const activeNet: Pick<NetClient, 'remoteSnapshots' | 'connected'> = {
      remoteSnapshots: [{ tick: 500, players: new Map([[1, snapshot]]) }],
      connected: true,
    };
    const nowMs = 123456; // an arbitrary performance.now() reading

    updateRemotes(activeNet, scene, meshes, buffers, nowMs);

    const buffer = buffers.get(1);
    expect(buffer).toBeDefined();
    const samples = (buffer as unknown as { samples: Array<{ atMs: number }> }).samples;
    expect(samples[0]?.atMs).toBe(nowMs);
  });

  it('clears every remote buffer once the connection is no longer active, so pruning disposes their meshes', () => {
    // Codex round 2 (PR #4): remotePlayers only changes when a snapshot arrives, and
    // nothing else cleared it on disconnect, so a plain socket close left every remote
    // mesh (and the GPU resources behind it) stranded until the page tore down.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const fakeNet: { remoteSnapshots: NetClient['remoteSnapshots']; connected: boolean } = {
      remoteSnapshots: [{ tick: 1, players: new Map([[1, snapshot]]) }],
      connected: true,
    };
    updateRemotes(fakeNet, scene, meshes, buffers, 0);
    expect(buffers.has(1)).toBe(true);
    expect(scene.children).toHaveLength(1);

    fakeNet.connected = false;
    updateRemotes(fakeNet, scene, meshes, buffers, 100);

    expect(buffers.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  });

  it('drains every queued snapshot from a single render call, not just the latest', () => {
    // Codex round 10 (PR #4): a snapshot replaces remotePlayers wholesale the instant it
    // decodes, and updateRemotes only ever read the current value once per render call.
    // A frame stall (or simply more than one snapshot landing before the next paint) left
    // only the newest snapshot's position reachable; the earlier one was gone before
    // anything read it, so RemoteBuffer's interpolation history silently lost it and the
    // remote snapped instead of smoothing through the gap.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const remoteSnapshots: RemoteSnapshot[] = [
      { tick: 10, players: new Map([[1, { ...snapshot, x: 10 }]]) },
      { tick: 20, players: new Map([[1, { ...snapshot, x: 20 }]]) },
    ];
    const activeNet: Pick<NetClient, 'remoteSnapshots' | 'connected'> = {
      remoteSnapshots,
      connected: true,
    };

    updateRemotes(activeNet, scene, meshes, buffers, 0);

    expect(remoteSnapshots).toHaveLength(0); // the queue is drained, not just peeked
    const samples = (
      buffers.get(1) as unknown as { samples: Array<{ atMs: number; data: { x: number } }> }
    ).samples;
    expect(samples.map((sample) => sample.data.x)).toEqual([10, 20]);
    // Codex round 11 (PR #4): stamping every drained snapshot with the same nowMs stored
    // both positions at an identical timestamp, so RemoteBuffer's interpolate() (which
    // treats equal timestamps as a single sample) still jumped straight to the newest
    // instead of ever bracketing between them.
    expect(samples[0]?.atMs).not.toBe(samples[1]?.atMs);
  });
});

describe('teleportPlayerToFlag', () => {
  it('moves the player to the given team flag current position', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: 1, y: 2, z: 3 } },
      { team: 2, position: { x: 4, y: 5, z: 6 } },
    ]);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });

    teleportPlayerToFlag(world, id, 2);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([4, 5, 6]);
  });

  it('reads the flag current position, not its stand, after it has moved', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 1, y: 2, z: 3 } }]);
    world.flags.position.set([9, 8, 7], 0); // flag 0 was picked up and dragged elsewhere
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });

    teleportPlayerToFlag(world, id, 1);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([9, 8, 7]);
  });

  it('is a no-op when no flag belongs to the requested team', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 1, y: 2, z: 3 } }]);
    const id = addPlayer(world, { x: 5, y: 5, z: 5 });

    teleportPlayerToFlag(world, id, 2);

    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([5, 5, 5]);
  });
});

describe('stepSinglePlayer (Codex review round 4, finding 1)', () => {
  it('respawns a dead single-player once the timer elapses, instead of leaving them dead forever', () => {
    // Codex review round 4, finding 1 (PR #9): single-player has no server, and nothing else
    // called dueForRespawn/respawnPlayer the way packages/server/src/net.ts's own tick loop
    // does, so a single-player death never respawned even though the 5 s timer expired.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);

    const spawn = { x: 5, y: 0, z: 5 };
    stepSinglePlayer(world, id, IDLE_INPUT, RESPAWN_TICKS + 1, spawn);

    expect(world.players.alive[id]).toBe(1);
    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).toEqual([5, 0, 5]);
  });

  it('leaves a player dead until their own respawn timer actually elapses', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);

    stepSinglePlayer(world, id, IDLE_INPUT, 1, { x: 5, y: 0, z: 5 });

    expect(world.players.alive[id]).toBe(0);
  });

  it('does not respawn a player once the match ends on the same step their respawn timer expires (Codex review round 5, finding 3)', () => {
    // Codex review round 5, finding 3 (PR #9): stepWorld can flip world.gameOver to true
    // DURING the very call that also makes a dead player's respawn timer due (the time
    // limit landing on the exact same tick as their respawn), and this loop's respawn
    // handling used to run unconditionally regardless of that -- the same class of bug
    // already fixed server-side in packages/server/src/net.ts's runOneTick (round 4,
    // finding 6). Without the guard, the match ends but the respawn logic still revives
    // the player into the now-frozen match.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
    expect(world.players.respawnAt[id]).toBe(RESPAWN_TICKS);

    // Force the time limit to land on the exact tick the respawn timer also expires.
    world.timeLimitTicks = RESPAWN_TICKS;

    const spawn = { x: 5, y: 0, z: 5 };
    stepSinglePlayer(world, id, IDLE_INPUT, RESPAWN_TICKS, spawn);

    expect(world.gameOver).toBe(true);
    expect(world.players.alive[id]).toBe(0);
    expect([...world.players.position.slice(id * 3, id * 3 + 3)]).not.toEqual([5, 0, 5]);
  });
});

describe('setLocalGodMode (Codex review round 4, finding 5)', () => {
  it('sets the sim godMode flag directly', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);

    setLocalGodMode(world, id, true);
    expect(world.players.godMode[id]).toBe(1);

    setLocalGodMode(world, id, false);
    expect(world.players.godMode[id]).toBe(0);
  });

  it('is proactive: a lethal hit taken while it is on cannot drop a carried flag', () => {
    // Codex review round 4, finding 5 (PR #9): the old app.ts ran stepWorld first and only
    // afterward reactively zeroed damage and revived the player. stepWorld runs stepPlayers
    // -> stepWeapons -> stepProjectiles -> stepFlags in one synchronous pass, so a lethal hit
    // that reached applyDamage had already dropped a carried flag (stepFlags reacting to the
    // death recorded in world.pendingDeaths) before any post-hoc revive could undo it.
    // Calling setLocalGodMode up front, before the hit and the step that follows it, mirrors
    // the proactive fix: applyDamage no-ops before stepFlags ever sees a death.
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 100, y: 0, z: 0 } },
    ]);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    // Touch and carry team 2's flag.
    stepSinglePlayer(world, attacker, IDLE_INPUT, 1, { x: 100, y: 0, z: 0 });
    expect(world.flags.carrierId[1]).toBe(attacker);

    setLocalGodMode(world, attacker, true);
    applyDamage(world, attacker, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR); // would otherwise be lethal
    stepSinglePlayer(world, attacker, IDLE_INPUT, 1, { x: 100, y: 0, z: 0 });

    expect(world.players.alive[attacker]).toBe(1);
    expect(world.players.damage[attacker]).toBe(0);
    expect(world.flags.carrierId[1]).toBe(attacker); // never dropped
  });
});

describe('positionOfPlayer', () => {
  it('returns null when there is no net client (single-player has no remote roster)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    expect(positionOfPlayer(world, null, id)).toBeNull();
  });

  it('reads the local player from world state, not the remote roster', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    const net: Pick<NetClient, 'playerId' | 'remotePlayers'> = {
      playerId: id,
      remotePlayers: new Map(),
    };
    expect(positionOfPlayer(world, net, id)).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('reads a remote player from the net client roster', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const remote: PlayerSnapshotData = {
      id: 7,
      team: 2,
      x: 10,
      y: 11,
      z: 12,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      energy: 0,
      health: 0,
      weaponSlot: 0,
      onGround: 0,
      ski: 0,
    };
    const net: Pick<NetClient, 'playerId' | 'remotePlayers'> = {
      playerId: localId,
      remotePlayers: new Map([[7, remote]]),
    };
    expect(positionOfPlayer(world, net, 7)).toEqual({ x: 10, y: 11, z: 12 });
  });

  it('returns null for an id absent from both the local slot and the remote roster', () => {
    const world = createWorld(flat, 1);
    const localId = addPlayer(world, { x: 0, y: 0, z: 0 });
    const net: Pick<NetClient, 'playerId' | 'remotePlayers'> = {
      playerId: localId,
      remotePlayers: new Map(),
    };
    expect(positionOfPlayer(world, net, 99)).toBeNull();
  });
});

describe('hudSourceFrom', () => {
  it('derives single-player HUD state straight from the sim world when there is no net client', () => {
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 1, y: 2, z: 3 } }]);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.teamScores[1] = 2;
    world.teamScores[2] = 1;
    world.tick = 10;

    const source = hudSourceFrom(world, id, null);

    expect(source.teamScores).toEqual([2, 1]);
    expect(source.flags).toEqual(flagsFromWorld(world));
    expect(source.gameOver).toBe(world.gameOver);
    expect(source.winnerTeam).toBe(world.winnerTeam);
    expect(source.gameOverReason).toBe(world.gameOverReason);
    expect(source.recentEvents).toEqual([]);
    expect(source.timeRemainingS).toBeCloseTo((world.timeLimitTicks - world.tick) * FIXED_DT);
    // Single-player has no separate network identity: the sim's own player id is the real one.
    expect(source.networkPlayerId).toBe(id);
  });

  it('takes CTF and clock state from the net client when one is connected', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    const net: Pick<
      NetClient,
      | 'playerId'
      | 'teamScores'
      | 'flags'
      | 'gameOver'
      | 'winnerTeam'
      | 'timeRemainingS'
      | 'gameOverReason'
      | 'recentEvents'
    > = {
      playerId: 31,
      teamScores: [3, 4],
      flags: [],
      gameOver: true,
      winnerTeam: 2,
      timeRemainingS: 42,
      gameOverReason: GameOverReason.TimeLimit,
      recentEvents: [],
    };

    const source = hudSourceFrom(world, id, net);

    expect(source.teamScores).toBe(net.teamScores);
    expect(source.gameOver).toBe(true);
    expect(source.winnerTeam).toBe(2);
    expect(source.timeRemainingS).toBe(42);
    expect(source.gameOverReason).toBe(GameOverReason.TimeLimit);
    // Codex review round 5, finding 4 (PR #9): `playerId` (id, the local prediction slot)
    // must stay the world.players index, but the HUD's carrier-id comparison needs the
    // server-assigned id -- net.playerId -- which is very likely NOT 0 on a bot-filled dev
    // server. Both differ here (id is the world's own addPlayer id, 0; net.playerId is 31)
    // to prove hudSourceFrom does not conflate them.
    expect(source.playerId).toBe(id);
    expect(source.networkPlayerId).toBe(31);
  });
});

describe('drainNewEvents', () => {
  const event = (seq: number): TimestampedEvent => ({
    type: MessageType.Event,
    kind: EventKind.PlayerKilled,
    a: 0,
    b: seq,
    seq,
  });

  it('keeps returning newly arrived events after the rolling buffer evicts old ones', () => {
    // Codex review round 1, finding 14 (PR #9): netclient.ts's recentEvents evicts its
    // oldest entry past its own cap, so tracking "new since last frame" via a slice(index)
    // into that same mutating array desyncs forever once eviction starts -- the index no
    // longer lines up with any live position, and every later event silently stops
    // rendering. A seq-based cursor is immune, since seq is assigned once at receipt and
    // never reused or shifted by eviction.
    const cursor = { seq: 0 };
    // A rolling buffer capped at 3, standing in for netclient's real 100-event cap --
    // the property under test does not depend on the cap's size.
    let buffer: TimestampedEvent[] = [event(1), event(2), event(3), event(4), event(5)].slice(-3);

    const firstDrain = drainNewEvents(buffer, cursor);
    expect(firstDrain.map((e) => e.seq)).toEqual([3, 4, 5]);

    buffer = [...buffer, event(6), event(7)].slice(-3);
    const secondDrain = drainNewEvents(buffer, cursor);
    expect(secondDrain.map((e) => e.seq)).toEqual([6, 7]);
  });

  it('returns nothing new when no event has arrived since the last drain', () => {
    const cursor = { seq: 0 };
    const buffer = [event(1), event(2)];
    drainNewEvents(buffer, cursor);
    expect(drainNewEvents(buffer, cursor)).toEqual([]);
  });

  it('returns every event on the first drain when the cursor starts at zero', () => {
    const cursor = { seq: 0 };
    const buffer = [event(1), event(2), event(3)];
    expect(drainNewEvents(buffer, cursor).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
