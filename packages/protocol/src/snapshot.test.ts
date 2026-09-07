import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  ammoIndex,
  ArmorId,
  createFlags,
  HEAVY_ARMOR,
  createWorld,
  deserializePlayer,
  GameOverReason,
  hashWorld,
  removePlayer,
  serializeActivePlayers,
  WeaponId,
  WeaponState,
  type Heightfield,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import { bytesOf, createWriter, writeU16, writeU32, writeU8 } from './codec.js';
import {
  MAX_SNAPSHOT_FLAGS,
  MAX_SNAPSHOT_PLAYERS,
  MAX_SNAPSHOT_PROJECTILES,
  MessageType,
} from './messages.js';
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
      baseObjects: [],
      turrets: [],
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
      { id: 3, type: 0, weaponId: 0, x: 1, y: 2, z: 3, vx: 90, vy: 0, vz: 0, ownerId: 0, armed: 1 },
    ];
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 },
      { id: 1, team: 2, state: 1, x: 5, y: 0, z: 5, carrierId: 2, returnInS: -1 },
    ];
    const bytes = encodeSnapshot(1, 0, 0, [], null, {
      projectiles,
      flags,
      baseObjects: [],
      turrets: [],
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

  it('round-trips respawnSeq through a full snapshot', () => {
    // Codex review round 8, PR #9: respawnSeq is the authoritative wire signal netclient.ts's
    // syncRespawnState now relies on to catch a full-health-to-full-health respawn that
    // health/alive alone cannot detect. If it did not survive the wire, that fix would be a
    // no-op.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    source.players.respawnSeq[id] = 7;
    const players = serializeActivePlayers(source);
    expect(players[0]?.respawnSeq).toBe(7);
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.players[0]?.respawnSeq).toBe(7);
  });

  it('marks only respawnSeq dirty in a delta when nothing else changed, and round-trips it', () => {
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());
    const decodedBaseline = decodeSnapshot(baselineBytes, null);

    source.players.respawnSeq[id] = 1; // simulate a respawn; nothing else about this player moved
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, {
      snapshotId: 1,
      players: decodedBaseline.players,
    });
    expect(decoded.players.find((p) => p.id === id)?.respawnSeq).toBe(1);
  });

  it('round-trips ammo and grenade counts through a full snapshot', () => {
    // Codex review round 10, PR #9, finding 1: ammo/grenades were never on the wire at all,
    // so reconciliation had no authoritative value to correct client-side prediction
    // against, and a lost or evicted input's ammo drift persisted forever. If these fields
    // did not survive the wire, that fix would be a no-op.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    source.players.ammo[ammoIndex(id, WeaponId.Spinfusor)] = 12;
    source.players.ammo[ammoIndex(id, WeaponId.Chaingun)] = 40;
    source.players.ammo[ammoIndex(id, WeaponId.Mortar)] = 3;
    source.players.grenades[id] = 2;
    const players = serializeActivePlayers(source);
    expect(players[0]).toMatchObject({
      discAmmo: 12,
      chaingunAmmo: 40,
      mortarAmmo: 3,
      grenades: 2,
    });
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.players[0]).toMatchObject({
      discAmmo: 12,
      chaingunAmmo: 40,
      mortarAmmo: 3,
      grenades: 2,
    });
  });

  it('marks only ammo dirty in a delta when nothing else changed, and round-trips it', () => {
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());
    const decodedBaseline = decodeSnapshot(baselineBytes, null);

    // Simulate a shot landing on the server: only the disc ammo pool moves.
    const discIndex = ammoIndex(id, WeaponId.Spinfusor);
    source.players.ammo[discIndex] = (source.players.ammo[discIndex] ?? 0) - 1;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, {
      snapshotId: 1,
      players: decodedBaseline.players,
    });
    // Fresh from addPlayer's default LIGHT_ARMOR loadout, minus the one disc just spent --
    // chaingun/mortar/grenades are untouched, and the delta must still round-trip them
    // correctly by copying them forward from the (already wire-quantized) baseline.
    expect(decoded.players).toEqual([
      {
        ...decodedBaseline.players[0],
        discAmmo: 14,
        chaingunAmmo: 100,
        mortarAmmo: 0,
        grenades: 5,
      },
    ]);
  });

  it('marks only weapon-state-machine fields dirty in a delta when nothing else changed, and round-trips them (Codex review round 11, PR #9)', () => {
    // Round 11: weaponState/weaponTimer/spunUp share DIRTY_PREDICTION with ammo rather than
    // claiming a new bit -- see that constant's comment for why. This is the same shape as
    // the ammo-only delta test above, but for the state machine itself.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());
    const decodedBaseline = decodeSnapshot(baselineBytes, null);

    // Simulate a shot landing on the server: only the weapon state machine moves, same as
    // stepWeapons's tryFireWeapon would leave it mid-Firing.
    source.players.weaponState[id] = WeaponState.Firing;
    source.players.weaponTimer[id] = 1.218;
    source.players.spunUp[id] = 1;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, {
      snapshotId: 1,
      players: decodedBaseline.players,
    });
    expect(decoded.players).toEqual([
      {
        ...decodedBaseline.players[0],
        weaponState: WeaponState.Firing,
        weaponTimer: expect.closeTo(1.218, 3) as number,
        spunUp: 1,
      },
    ]);
  });

  it('marks only grenadeCooldown dirty in a delta when nothing else changed, and round-trips it (Codex review round 12, PR #9, finding 1)', () => {
    // Round 12: grenadeCooldown -- the grenade throw's own parallel cooldown timer, a
    // sibling round 11 missed -- folds into the SAME DIRTY_PREDICTION bit as ammo and the
    // primary weapon state machine, for the reasoning DIRTY_PREDICTION's own comment gives.
    // Same shape as the weapon-state-machine delta test above, but for grenadeCooldown alone.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());
    const decodedBaseline = decodeSnapshot(baselineBytes, null);

    // Simulate a grenade throw landing on the server: only the grenade cooldown moves, same
    // as stepWeapons's tryThrowGrenade would leave it mid-cooldown.
    source.players.grenadeCooldown[id] = 0.62;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, {
      snapshotId: 1,
      players: decodedBaseline.players,
    });
    expect(decoded.players).toEqual([
      {
        ...decodedBaseline.players[0],
        grenadeCooldown: expect.closeTo(0.62, 3) as number,
      },
    ]);
  });

  it('round-trips score and godMode through a full snapshot (Codex review round 14, PR #9, finding 1)', () => {
    // Round 13's hashWorld/mixPlayer already mixed score and godMode into the determinism
    // hash, but neither field was ever actually wired onto the wire format itself, so a
    // decoded/reconstructed player always came back with score 0 / godMode 0 regardless of
    // the source's real values. score is signed (damage.ts's suicide/team-kill scoring can
    // drive it negative), so exercise a negative value, not just the ammo fields' always-
    // nonnegative range.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    source.players.score[id] = -5;
    source.players.godMode[id] = 1;
    const players = serializeActivePlayers(source);
    expect(players[0]).toMatchObject({ score: -5, godMode: 1 });
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.players[0]).toMatchObject({ score: -5, godMode: 1 });
  });

  it('round-trips a Heavy armor + Repair Pack loadout through a full snapshot (Codex round 1, finding 2)', () => {
    // sim/snapshot.ts's serializePlayer/deserializePlayer have carried armor/hasRepairPack
    // since Task 6, and the sim-side round trip is already covered directly -- but
    // writePlayerFull/readPlayerFull never actually put either field on the wire, so a
    // decoded/reconstructed player always came back Light/no-pack regardless of what a real
    // station visit (applyLoadoutRequest) had set. Exercise Heavy specifically, not just any
    // nonzero armor: it's the armor id furthest from the 0 default this bug always produced.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1, ArmorId.Heavy);
    source.players.hasRepairPack[id] = 1;
    const players = serializeActivePlayers(source);
    expect(players[0]).toMatchObject({ armor: ArmorId.Heavy, hasRepairPack: 1 });
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.players[0]).toMatchObject({ armor: ArmorId.Heavy, hasRepairPack: 1 });
  });

  it('marks armor/hasRepairPack dirty in a delta (sharing DIRTY_TEAM with team) and round-trips them', () => {
    // Same shape as the score/godMode delta test above, but for armor/hasRepairPack, which
    // share DIRTY_TEAM with team (identityChanged). health also legitimately changes here --
    // not a bug this test is proving, but a real side effect of health being derived from
    // armor's own maxDamage at serialize time (serializePlayer), so DIRTY_HEALTH is expected
    // to be set alongside DIRTY_TEAM.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());
    const decodedBaseline = decodeSnapshot(baselineBytes, null);

    source.players.armor[id] = ArmorId.Heavy;
    source.players.hasRepairPack[id] = 1;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, {
      snapshotId: 1,
      players: decodedBaseline.players,
    });
    const [decodedPlayer] = decoded.players;
    expect(decodedPlayer).toMatchObject({ armor: ArmorId.Heavy, hasRepairPack: 1 });
    // f32 round trip, not exact -- same tolerance the rest of this file's float fields use.
    expect(decodedPlayer?.health).toBeCloseTo(HEAVY_ARMOR.maxDamage, 5);
    expect({ ...decoded.players[0], armor: 0, hasRepairPack: 0, health: 0 }).toEqual({
      ...decodedBaseline.players[0],
      armor: 0,
      hasRepairPack: 0,
      health: 0,
    });
  });

  it('marks only score/godMode dirty in a delta when nothing else changed, and round-trips them', () => {
    // Same shape as the ammo-only and weapon-state-machine-only delta tests above, but for
    // the newly wired score/godMode pair, which share DIRTY_PREDICTION with them.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());
    const decodedBaseline = decodeSnapshot(baselineBytes, null);

    source.players.score[id] = 12;
    source.players.godMode[id] = 1;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, {
      snapshotId: 1,
      players: decodedBaseline.players,
    });
    expect(decoded.players).toEqual([
      {
        ...decodedBaseline.players[0],
        score: 12,
        godMode: 1,
      },
    ]);
  });

  it('round-trips wasJumpHeld through a full snapshot (Codex review round 15, PR #9, finding 1)', () => {
    // netclient.ts's reconcile() used to hardcode wasJumpHeld to 0 after every snapshot,
    // since there was no wire field to read the real value from. This wire fix is what
    // lets reconcile() stop doing that -- see PlayerSnapshotData.wasJumpHeld's doc comment
    // (sim/snapshot.ts) for the misprediction that caused.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    source.players.wasJumpHeld[id] = 1;
    const players = serializeActivePlayers(source);
    expect(players[0]).toMatchObject({ wasJumpHeld: 1 });
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.players[0]).toMatchObject({ wasJumpHeld: 1 });
  });

  it('marks only status dirty in a delta when wasJumpHeld alone changes, and round-trips it', () => {
    // wasJumpHeld packs into the same status byte as onGround/ski (statusByte's own
    // comment), so it must participate in statusChanged/DIRTY_STATUS like they do.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());
    const decodedBaseline = decodeSnapshot(baselineBytes, null);

    source.players.wasJumpHeld[id] = 1;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(
      2,
      source.tick,
      0,
      nextPlayers,
      { snapshotId: 1, players: baselinePlayers },
      emptyExtras(),
    );
    const decoded = decodeSnapshot(deltaBytes, {
      snapshotId: 1,
      players: decodedBaseline.players,
    });
    expect(decoded.players).toEqual([
      {
        ...decodedBaseline.players[0],
        wasJumpHeld: 1,
      },
    ]);
  });

  it("round-trips a projectile's armed flag through a full snapshot (Codex review round 15, PR #9, finding 2)", () => {
    // hash.ts's mixProjectiles has hashed armed since round 13, but it was never wired onto
    // the snapshot itself. expiresAtTick is deliberately NOT wired -- see
    // ProjectileSnapshotData's doc comment for why.
    const projectiles: ProjectileSnapshotData[] = [
      { id: 5, type: 1, weaponId: 2, x: 1, y: 2, z: 3, vx: 0, vy: 0, vz: 0, ownerId: 0, armed: 1 },
    ];
    const bytes = encodeSnapshot(1, 0, 0, [], null, {
      ...emptyExtras(),
      projectiles,
    });
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.projectiles).toEqual(projectiles);
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

  it('rejects a full snapshot whose declared projectile or flag count exceeds the plausible maximum', () => {
    // The player-count guard above (Codex round 3, PR #4) never covered the WorldExtras counts
    // readExtras added in M3 task 6 -- a corrupted or adversarial packet declaring 65535
    // projectiles or 255 flags would decode all of them with no upper bound.
    const projectileCursor = createWriter(30);
    writeU8(projectileCursor, MessageType.Snapshot);
    writeU32(projectileCursor, 1);
    writeU32(projectileCursor, 0);
    writeU32(projectileCursor, 0);
    writeU32(projectileCursor, 0);
    writeU8(projectileCursor, 0);
    writeU16(projectileCursor, 0); // player count
    writeU16(projectileCursor, MAX_SNAPSHOT_PROJECTILES + 1); // declared projectile count
    expect(() => decodeSnapshot(bytesOf(projectileCursor), null)).toThrow(RangeError);

    const flagCursor = createWriter(30);
    writeU8(flagCursor, MessageType.Snapshot);
    writeU32(flagCursor, 1);
    writeU32(flagCursor, 0);
    writeU32(flagCursor, 0);
    writeU32(flagCursor, 0);
    writeU8(flagCursor, 0);
    writeU16(flagCursor, 0); // player count
    writeU16(flagCursor, 0); // projectile count
    writeU8(flagCursor, MAX_SNAPSHOT_FLAGS + 1); // declared flag count
    expect(() => decodeSnapshot(bytesOf(flagCursor), null)).toThrow(RangeError);
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

describe('WorldExtras: baseObjects and turrets', () => {
  it('emptyExtras includes empty baseObjects/turrets arrays', () => {
    const extras = emptyExtras();
    expect(extras.baseObjects).toEqual([]);
    expect(extras.turrets).toEqual([]);
  });
  it('a full snapshot round-trips baseObjects and turrets exactly', () => {
    const extras = {
      ...emptyExtras(),
      baseObjects: [{ id: 0, damage: 0.5, destroyed: 0 as const, powered: 1 as const }],
      turrets: [
        { id: 3, damage: 0, destroyed: 0 as const, powered: 1 as const, targetId: 7, state: 1 },
      ],
    };
    const bytes = encodeSnapshot(1, 100, 5, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.baseObjects).toEqual(extras.baseObjects);
    expect(decoded.turrets).toEqual(extras.turrets);
  });
  it('a destroyed turret carries destroyed: 1 and an unset target', () => {
    const extras = {
      ...emptyExtras(),
      turrets: [
        { id: 0, damage: 1.25, destroyed: 1 as const, powered: 0 as const, targetId: -1, state: 0 },
      ],
    };
    const bytes = encodeSnapshot(1, 0, 0, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.turrets[0]).toEqual(extras.turrets[0]);
  });
});
