import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createWorld,
  deserializePlayer,
  hashWorld,
  removePlayer,
  serializeActivePlayers,
  type Heightfield,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import { bytesOf, createWriter, writeU16, writeU32, writeU8 } from './codec.js';
import { MAX_SNAPSHOT_PLAYERS, MessageType } from './messages.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function applyTo(target: World, tick: number, players: PlayerSnapshotData[]): void {
  target.tick = tick;
  for (const player of players) deserializePlayer(target, player);
}

describe('snapshot codec', () => {
  it('round-trips a full snapshot and reproduces the world hash', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 1, y: 2, z: 3 }, 1);
    addPlayer(source, { x: 4, y: 5, z: 6 }, 2);
    source.tick = 10;
    const players = serializeActivePlayers(source);
    const bytes = encodeSnapshot(1, source.tick, 0, players, null);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.baselineId).toBe(0);
    const target = createWorld(terrain, 1);
    applyTo(target, decoded.tick, decoded.players);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('applies a delta against a known baseline and reproduces the state', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(source, { x: 10, y: 0, z: 0 }, 2);
    source.tick = 1;
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null);

    source.players.position[a * 3] = 5;
    const c = addPlayer(source, { x: 20, y: 0, z: 0 }, 1);
    source.tick = 2;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, source.tick, 0, nextPlayers, {
      snapshotId: 1,
      players: baselinePlayers,
    });

    const decodedBaseline = decodeSnapshot(baselineBytes, null);
    const decoded = decodeSnapshot(deltaBytes, { snapshotId: 1, players: decodedBaseline.players });
    expect(decoded.baselineId).toBe(1);
    const target = createWorld(terrain, 1);
    applyTo(target, decoded.tick, decoded.players);
    expect(hashWorld(target)).toBe(hashWorld(source));
    expect(decoded.players.find((p) => p.id === c)?.x).toBe(20);
  });

  it('marks a removed player and drops it from the reconstructed state', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const b = addPlayer(source, { x: 1, y: 0, z: 0 }, 2);
    const baselinePlayers = serializeActivePlayers(source);
    removePlayer(source, b);
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 5, 0, nextPlayers, {
      snapshotId: 1,
      players: baselinePlayers,
    });
    const decoded = decodeSnapshot(deltaBytes, { snapshotId: 1, players: baselinePlayers });
    expect(decoded.removedIds).toEqual([b]);
    expect(decoded.players.map((p) => p.id)).toEqual([a]);
  });

  it('throws when a delta arrives for a baseline the caller does not have', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const players = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 1, 0, players, { snapshotId: 1, players });
    expect(() => decodeSnapshot(deltaBytes, null)).toThrow(RangeError);
  });

  it('rejects a full snapshot carrying a non-finite transform value', () => {
    // Codex round 2 (PR #4): snapshot floats were accepted with no finiteness check and
    // written straight into prediction state, so a NaN x from a corrupted or adversarial
    // server response would poison the local simulation permanently.
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const players = serializeActivePlayers(source);
    const poisoned = players.map((p) => ({ ...p, x: Number.NaN }));
    const bytes = encodeSnapshot(1, 0, 0, poisoned, null);
    expect(() => decodeSnapshot(bytes, null)).toThrow(RangeError);
  });

  it('rejects a delta carrying a non-finite changed value', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, 0, 0, baselinePlayers, null);
    // dirtyMask compares with `> EPSILON`, which NaN always fails, so a NaN x alone would
    // never mark the transform dirty and the field would just never make it into a delta.
    // Change y for real too, which does mark it dirty and gets the whole transform block
    // -- x included -- written, the way a real corrupted value reaching the wire would.
    source.players.position[a * 3] = Number.NaN;
    source.players.position[a * 3 + 1] = 5;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 1, 0, nextPlayers, {
      snapshotId: 1,
      players: baselinePlayers,
    });
    const decodedBaseline = decodeSnapshot(baselineBytes, null);
    expect(() =>
      decodeSnapshot(deltaBytes, { snapshotId: 1, players: decodedBaseline.players }),
    ).toThrow(RangeError);
  });

  it('rejects a full snapshot whose declared player count exceeds the plausible maximum', () => {
    // Codex round 3 (PR #4): the count is a raw wire u16 with no semantic limit, so a
    // corrupted or adversarial packet declaring 65535 players would decode all of them --
    // the client then allocates one mesh per player, freezing or exhausting it.
    const cursor = createWriter(20);
    writeU8(cursor, MessageType.Snapshot);
    writeU32(cursor, 1); // snapshotId
    writeU32(cursor, 0); // baselineId
    writeU32(cursor, 0); // tick
    writeU32(cursor, 0); // lastInputSequence
    writeU8(cursor, 0); // flags: full, not delta
    writeU16(cursor, MAX_SNAPSHOT_PLAYERS + 1); // declared count, no player data follows
    expect(() => decodeSnapshot(bytesOf(cursor), null)).toThrow(RangeError);
  });

  it('rejects a delta whose reconstructed roster exceeds the maximum, even when addedCount alone does not', () => {
    // Codex round 4 (PR #4): addedCount was capped, but the baseline plus that capped
    // batch of additions can still push the *reconstructed* roster over the limit -- a
    // baseline near the cap, then another capped-size batch of additions on every
    // following delta, would grow the client's roster toward the same tens-of-thousands
    // of players and meshes the single-message count check was meant to prevent.
    const source = createWorld(terrain, 1, MAX_SNAPSHOT_PLAYERS + 10);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    for (let i = 0; i < MAX_SNAPSHOT_PLAYERS; i += 1) addPlayer(source, { x: i, y: 0, z: 0 }, 1);
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 1, 0, nextPlayers, {
      snapshotId: 1,
      players: baselinePlayers,
    });
    expect(() => decodeSnapshot(deltaBytes, { snapshotId: 1, players: baselinePlayers })).toThrow(
      RangeError,
    );
  });
});
