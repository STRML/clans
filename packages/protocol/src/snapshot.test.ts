import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createFlags,
  createWorld,
  deserializePlayer,
  GameOverReason,
  hashWorld,
  removePlayer,
  serializeActivePlayers,
  type Heightfield,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import { bytesOf, createWriter, writeU16, writeU32, writeU8 } from './codec.js';
import { MAX_SNAPSHOT_PLAYERS, MessageType } from './messages.js';
import {
  decodeSnapshot,
  emptyExtras,
  encodeSnapshot,
  type DecodedSnapshot,
  type FlagSnapshotData,
  type ProjectileSnapshotData,
  type WorldExtras,
} from './snapshot.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const stands = [
  { team: 1, position: { x: 0, y: 0, z: 0 } },
  { team: 2, position: { x: 10, y: 0, z: 0 } },
];

function applyTo(target: World, tick: number, players: PlayerSnapshotData[]): void {
  target.tick = tick;
  for (const player of players) deserializePlayer(target, player);
}

/** Everything `applyTo` doesn't cover: the CTF slice of `WorldExtras`, applied onto a target
 * world that already called `createFlags` (so its `FlagStore` is sized to receive it). */
function applyExtras(target: World, decoded: DecodedSnapshot): void {
  for (const flag of decoded.flags) {
    target.flags.state[flag.id] = flag.state;
    target.flags.carrierId[flag.id] = flag.carrierId;
    target.flags.position.set([flag.x, flag.y, flag.z], flag.id * 3);
  }
  target.teamScores[1] = decoded.teamScores[0];
  target.teamScores[2] = decoded.teamScores[1];
  target.gameOver = decoded.gameOver;
  target.winnerTeam = decoded.winnerTeam;
  target.gameOverReason = decoded.gameOverReason;
}

describe('snapshot codec', () => {
  it('round-trips a full snapshot and reproduces the world hash', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 1, y: 2, z: 3 }, 1);
    addPlayer(source, { x: 4, y: 5, z: 6 }, 2);
    source.tick = 10;
    const players = serializeActivePlayers(source);
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.baselineId).toBe(0);
    const target = createWorld(terrain, 1);
    applyTo(target, decoded.tick, decoded.players);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('round-trips CTF state and reproduces the full-state world hash (projectiles, flags, scores, match clock)', () => {
    const source = createWorld(terrain, 1);
    createFlags(source, stands);
    source.teamScores[1] = 300;
    source.teamScores[2] = 100;
    source.gameOver = true;
    source.winnerTeam = 1;
    source.gameOverReason = GameOverReason.CaptureLimit;
    source.tick = 50;
    const players = serializeActivePlayers(source);
    const extras: WorldExtras = {
      projectiles: [],
      flags: [
        { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 },
        { id: 1, team: 2, state: 0, x: 10, y: 0, z: 0, carrierId: -1, returnInS: -1 },
      ],
      teamScores: [300, 100],
      gameOver: true,
      winnerTeam: 1,
      timeRemainingS: 0,
      gameOverReason: GameOverReason.CaptureLimit,
    };
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, extras);
    const decoded = decodeSnapshot(bytes, null);

    const target = createWorld(terrain, 1);
    createFlags(target, stands); // sizes target.flags to receive applyExtras below
    applyTo(target, decoded.tick, decoded.players);
    applyExtras(target, decoded);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('applies a delta against a known baseline and reproduces the state', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(source, { x: 10, y: 0, z: 0 }, 2);
    source.tick = 1;
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());

    source.players.position[a * 3] = 5;
    const c = addPlayer(source, { x: 20, y: 0, z: 0 }, 1);
    source.tick = 2;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );

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
    const deltaBytes = encodeSnapshot(
      2,
      5,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, { snapshotId: 1, players: baselinePlayers });
    expect(decoded.removedIds).toEqual([b]);
    expect(decoded.players.map((p) => p.id)).toEqual([a]);
  });

  it('throws when a delta arrives for a baseline the caller does not have', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const players = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 1, 0, players, { snapshotId: 1, players }, emptyExtras());
    expect(() => decodeSnapshot(deltaBytes, null)).toThrow(RangeError);
  });

  it('round-trips projectiles, flags, team scores, and game over', () => {
    const projectiles: ProjectileSnapshotData[] = [
      { id: 3, type: 0, weaponId: 0, x: 1, y: 2, z: 3, vx: 90, vy: 0, vz: 0, ownerId: 0 },
    ];
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 },
      { id: 1, team: 2, state: 1, x: 5, y: 0, z: 5, carrierId: 2, returnInS: -1 },
    ];
    const bytes = encodeSnapshot(1, 0, 0, [], null, {
      projectiles,
      flags,
      teamScores: [100, 200],
      gameOver: true,
      winnerTeam: 1,
      timeRemainingS: 723.4,
      gameOverReason: 0,
    });
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.projectiles).toEqual(projectiles);
    expect(decoded.flags).toEqual(flags);
    expect(decoded.teamScores).toEqual([100, 200]);
    expect(decoded.gameOver).toBe(true);
    expect(decoded.winnerTeam).toBe(1);
    expect(decoded.timeRemainingS).toBeCloseTo(723.4, 1);
    expect(decoded.gameOverReason).toBe(0);
  });

  it('rejects a full snapshot carrying a non-finite transform value', () => {
    // Codex round 2 (PR #4): snapshot floats were accepted with no finiteness check and
    // written straight into prediction state, so a NaN x from a corrupted or adversarial
    // server response would poison the local simulation permanently.
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const players = serializeActivePlayers(source);
    const poisoned = players.map((p) => ({ ...p, x: Number.NaN }));
    const bytes = encodeSnapshot(1, 0, 0, poisoned, null, emptyExtras());
    expect(() => decodeSnapshot(bytes, null)).toThrow(RangeError);
  });

  it('rejects a full snapshot carrying a non-finite health value', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const players = serializeActivePlayers(source);
    const poisoned = players.map((p) => ({ ...p, health: Number.NaN }));
    const bytes = encodeSnapshot(1, 0, 0, poisoned, null, emptyExtras());
    expect(() => decodeSnapshot(bytes, null)).toThrow(RangeError);
  });

  it('rejects a delta carrying a non-finite changed value', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, 0, 0, baselinePlayers, null, emptyExtras());
    // dirtyMask compares with `> EPSILON`, which NaN always fails, so a NaN x alone would
    // never mark the transform dirty and the field would just never make it into a delta.
    // Change y for real too, which does mark it dirty and gets the whole transform block
    // -- x included -- written, the way a real corrupted value reaching the wire would.
    source.players.position[a * 3] = Number.NaN;
    source.players.position[a * 3 + 1] = 5;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      1,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
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
    const deltaBytes = encodeSnapshot(
      2,
      1,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    expect(() => decodeSnapshot(deltaBytes, { snapshotId: 1, players: baselinePlayers })).toThrow(
      RangeError,
    );
  });
});
