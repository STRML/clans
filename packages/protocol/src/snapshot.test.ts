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
import { bytesOf, createWriter, writeF32, writeU16, writeU32, writeU8 } from './codec.js';
import {
  MAX_SNAPSHOT_BASE_OBJECTS,
  MAX_SNAPSHOT_BOTS,
  MAX_SNAPSHOT_FLAGS,
  MAX_SNAPSHOT_ORDERS,
  MAX_SNAPSHOT_PLAYERS,
  MAX_SNAPSHOT_PROJECTILES,
  MAX_SNAPSHOT_TURRETS,
  MessageType,
  OrderKind,
} from './messages.js';
import {
  decodeSnapshot,
  emptyExtras,
  encodeSnapshot,
  type BaseObjectSnapshotData,
  type BotDebugSnapshotData,
  type DecodedSnapshot,
  type FlagSnapshotData,
  type OrderSnapshotData,
  type ProjectileSnapshotData,
  type TurretSnapshotData,
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
      vehicles: [],
      teamScores: [300, 100],
      gameOver: true,
      winnerTeam: 1,
      timeRemainingS: 0,
      gameOverReason: GameOverReason.CaptureLimit,
      bots: [],
      orders: [],
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

  it('round-trips projectiles, flags, team scores, game over, and bots -- bots decoded in order, after every other field', () => {
    const projectiles: ProjectileSnapshotData[] = [
      { id: 3, type: 0, weaponId: 0, x: 1, y: 2, z: 3, vx: 90, vy: 0, vz: 0, ownerId: 0, armed: 1 },
    ];
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 },
      { id: 1, team: 2, state: 1, x: 5, y: 0, z: 5, carrierId: 2, returnInS: -1 },
    ];
    const bots: BotDebugSnapshotData[] = [
      { playerId: 4, state: 0 },
      { playerId: 9, state: 1 },
      { playerId: 2, state: 2 },
    ];
    const bytes = encodeSnapshot(1, 0, 0, [], null, {
      projectiles,
      flags,
      baseObjects: [],
      turrets: [],
      vehicles: [],
      teamScores: [100, 200],
      gameOver: true,
      winnerTeam: 1,
      timeRemainingS: 723.4,
      gameOverReason: 0,
      bots,
      orders: [],
    });
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.projectiles).toEqual(projectiles);
    expect(decoded.flags).toEqual(flags);
    expect(decoded.teamScores).toEqual([100, 200]);
    expect(decoded.gameOver).toBe(true);
    expect(decoded.winnerTeam).toBe(1);
    expect(decoded.timeRemainingS).toBeCloseTo(723.4, 1);
    expect(decoded.gameOverReason).toBe(0);
    expect(decoded.bots).toEqual(bots);
  });

  it('round-trips a full 48-bot (24 v 24) extras payload -- the match size the target roster seats', () => {
    // 24 v 24 is 48 bots, so MAX_SNAPSHOT_BOTS has to cover a full match rather than only
    // M6's 16 v 16: at 32 this encode threw RangeError, which crashed the server on the
    // very first snapshot of a real 48-bot seating. The count is one u8 on the wire, so 48
    // has to survive as a single byte and come back with every entry, in order.
    const bots: BotDebugSnapshotData[] = Array.from({ length: 48 }, (_, i) => ({
      playerId: i,
      state: i % 3,
    }));
    const decoded = decodeSnapshot(
      encodeSnapshot(1, 0, 0, [], null, { ...emptyExtras(), bots }),
      null,
    );
    expect(decoded.bots).toHaveLength(48);
    expect(decoded.bots).toEqual(bots);
    expect(decoded.bots[47]).toEqual({ playerId: 47, state: 2 });
  });

  it('throws at encode time when the bots array exceeds MAX_SNAPSHOT_BOTS', () => {
    const bots: BotDebugSnapshotData[] = Array.from({ length: MAX_SNAPSHOT_BOTS + 1 }, (_, i) => ({
      playerId: i,
      state: 0,
    }));
    expect(() => encodeSnapshot(1, 0, 0, [], null, { ...emptyExtras(), bots })).toThrow(RangeError);
  });

  it('emptyExtras includes an empty bots array', () => {
    expect(emptyExtras().bots).toEqual([]);
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
    // station visit (applyLoadoutSelection) had set. Exercise Heavy specifically, not just any
    // nonzero armor: it's the armor id furthest from the 0 default this bug always produced.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 0, y: 0, z: 0 }, 1, ArmorId.Heavy);
    source.players.hasRepairPack[id] = 1;
    source.players.hasEnergyPack[id] = 1;
    source.players.carriedWeapons[id] = 0b10001;
    const players = serializeActivePlayers(source);
    expect(players[0]).toMatchObject({
      armor: ArmorId.Heavy,
      hasRepairPack: 1,
      hasEnergyPack: 1,
      carriedWeapons: 0b10001,
    });
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.players[0]).toMatchObject({
      armor: ArmorId.Heavy,
      hasRepairPack: 1,
      hasEnergyPack: 1,
      carriedWeapons: 0b10001,
    });
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
  it('a full snapshot round-trips baseObjects and turrets exactly, including shield energy and targetKind (issues #14/#24)', () => {
    const extras = {
      ...emptyExtras(),
      baseObjects: [
        { id: 0, damage: 0.5, destroyed: 0 as const, powered: 1 as const, energy: 37.5 },
      ],
      turrets: [
        {
          id: 3,
          damage: 0,
          destroyed: 0 as const,
          powered: 1 as const,
          targetId: 7,
          state: 1,
          energy: 112.5,
          targetKind: 0,
        },
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
        {
          id: 0,
          damage: 1.25,
          destroyed: 1 as const,
          powered: 0 as const,
          targetId: -1,
          state: 0,
          energy: 0,
          targetKind: 0,
        },
      ],
    };
    const bytes = encodeSnapshot(1, 0, 0, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.turrets[0]).toEqual(extras.turrets[0]);
  });
});

describe('snapshot wire fixes (issues #14/#24/#15/#16/#25)', () => {
  it('round-trips targetKind so a turret aimed at player 5 and one aimed at a vehicle that shares id 5 stay distinguishable (issue #24)', () => {
    // Player ids and vehicle ids are independent spaces that CAN collide, so a decoder
    // that only carried targetId could not tell these two snapshots apart -- the exact
    // ambiguity acquireTarget/targetStillValid/fireAt resolve with TurretStore.targetKind.
    const makeExtras = (targetKind: number): WorldExtras => ({
      ...emptyExtras(),
      turrets: [
        {
          id: 0,
          damage: 0,
          destroyed: 0 as const,
          powered: 1 as const,
          targetId: 5,
          state: 1,
          energy: 150,
          targetKind,
        },
      ],
    });
    const decodedPlayer = decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, makeExtras(0)), null);
    const decodedVehicle = decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, makeExtras(1)), null);
    expect(decodedPlayer.turrets[0]).toEqual({ ...makeExtras(0).turrets[0] });
    expect(decodedVehicle.turrets[0]?.targetId).toBe(5);
    expect(decodedVehicle.turrets[0]?.targetKind).toBe(1);
    expect(decodedPlayer.turrets[0]?.targetKind).toBe(0);
  });

  it('still encodes a pre-#14 turret/base-object literal without the new fields, decoding to zeroed defaults', () => {
    // The optional fields exist so existing object literals in other packages keep
    // compiling (see TurretSnapshotData.targetKind's doc comment); writeTurret/writeBaseObject
    // default a missing energy to 0 and a missing targetKind to 0 (player) -- the stores'
    // own zero-init values.
    const extras = {
      ...emptyExtras(),
      baseObjects: [{ id: 1, damage: 0.25, destroyed: 0 as const, powered: 1 as const }],
      turrets: [
        { id: 2, damage: 0, destroyed: 0 as const, powered: 1 as const, targetId: -1, state: 0 },
      ],
    } as WorldExtras;
    const decoded = decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, extras), null);
    expect(decoded.baseObjects[0]).toEqual({
      id: 1,
      damage: 0.25,
      destroyed: 0,
      powered: 1,
      energy: 0,
    });
    expect(decoded.turrets[0]).toEqual({
      id: 2,
      damage: 0,
      destroyed: 0,
      powered: 1,
      targetId: -1,
      state: 0,
      energy: 0,
      targetKind: 0,
    });
  });

  it('round-trips the turret-shot ownerId -1 sentinel instead of corrupting it to 65535, and leaves real player ids alone (issue #15)', () => {
    // spawnTurretShot (projectiles.ts) writes ownerId -1 for a shot with no player
    // identity; the old u16 write turned that into 65535 on the wire, so every consumer
    // comparing a decoded owner against real player ids (self-exclusion, kill attribution)
    // saw a phantom player. A turret shot (-1) and a player shot (a real id) must both
    // survive the round trip -- and stay distinct from each other.
    const makeProjectile = (ownerId: number): ProjectileSnapshotData => ({
      id: 9,
      type: 0,
      weaponId: 0,
      x: 1,
      y: 2,
      z: 3,
      vx: 0,
      vy: 0,
      vz: 0,
      ownerId,
      armed: 1,
    });
    const extrasFor = (ownerId: number): WorldExtras => ({
      ...emptyExtras(),
      projectiles: [makeProjectile(ownerId)],
    });
    const turretShot = decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, extrasFor(-1)), null);
    const playerShot = decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, extrasFor(12)), null);
    expect(turretShot.projectiles[0]?.ownerId).toBe(-1);
    expect(playerShot.projectiles[0]?.ownerId).toBe(12);
    expect(turretShot.projectiles[0]?.ownerId).not.toBe(playerShot.projectiles[0]?.ownerId);
  });

  it('throws at encode time when flags, baseObjects, or turrets exceed their MAX_SNAPSHOT ceilings, instead of silently wrapping the u8 count (issue #16)', () => {
    // Before this guard, each count was an UNCHECKED u8 write: a length of exactly 256
    // wrapped to 0 on the wire with no error, and the decoder then read zero records where
    // 256 were written -- silently dropping the entire array and misaligning everything
    // after it. Guarding at the same MAX_SNAPSHOT_* ceilings readExtras enforces (each far
    // below the u8 wrap point) makes the wrap unreachable and the encode fail loudly, the
    // same explicit-throw convention the vehicles/bots/orders blocks always had.
    const flag = (i: number): FlagSnapshotData => ({
      id: i,
      team: 1,
      state: 0,
      x: 0,
      y: 0,
      z: 0,
      carrierId: -1,
      returnInS: -1,
    });
    const baseObject = (i: number): BaseObjectSnapshotData => ({
      id: i,
      damage: 0,
      destroyed: 0 as const,
      powered: 1 as const,
      energy: 50,
    });
    const turret = (i: number): TurretSnapshotData => ({
      id: i,
      damage: 0,
      destroyed: 0 as const,
      powered: 1 as const,
      targetId: -1,
      state: 0,
      energy: 150,
      targetKind: 0,
    });
    const extras = emptyExtras();
    expect(() =>
      encodeSnapshot(1, 0, 0, [], null, {
        ...extras,
        flags: Array.from({ length: MAX_SNAPSHOT_FLAGS + 1 }, (_, i) => flag(i)),
      }),
    ).toThrow(RangeError);
    expect(() =>
      encodeSnapshot(1, 0, 0, [], null, {
        ...extras,
        baseObjects: Array.from({ length: MAX_SNAPSHOT_BASE_OBJECTS + 1 }, (_, i) => baseObject(i)),
      }),
    ).toThrow(RangeError);
    expect(() =>
      encodeSnapshot(1, 0, 0, [], null, {
        ...extras,
        turrets: Array.from({ length: MAX_SNAPSHOT_TURRETS + 1 }, (_, i) => turret(i)),
      }),
    ).toThrow(RangeError);
  });

  it('still encodes arrays at exactly the MAX_SNAPSHOT ceiling, and they decode back intact (issue #16 boundary)', () => {
    const flags: FlagSnapshotData[] = Array.from({ length: MAX_SNAPSHOT_FLAGS }, (_, i) => ({
      id: i,
      team: 1,
      state: 0,
      x: i,
      y: 0,
      z: 0,
      carrierId: -1,
      returnInS: -1,
    }));
    const baseObjects: BaseObjectSnapshotData[] = Array.from(
      { length: MAX_SNAPSHOT_BASE_OBJECTS },
      (_, i) => ({
        id: i,
        damage: 0,
        destroyed: 0 as const,
        powered: 1 as const,
        energy: 50,
      }),
    );
    const turrets: TurretSnapshotData[] = Array.from({ length: MAX_SNAPSHOT_TURRETS }, (_, i) => ({
      id: i,
      damage: 0,
      destroyed: 0 as const,
      powered: 1 as const,
      targetId: -1,
      state: 0,
      energy: 150,
      targetKind: 0,
    }));
    const decoded = decodeSnapshot(
      encodeSnapshot(1, 0, 0, [], null, { ...emptyExtras(), flags, baseObjects, turrets }),
      null,
    );
    expect(decoded.flags).toHaveLength(MAX_SNAPSHOT_FLAGS);
    expect(decoded.baseObjects).toHaveLength(MAX_SNAPSHOT_BASE_OBJECTS);
    expect(decoded.turrets).toHaveLength(MAX_SNAPSHOT_TURRETS);
    // The "no silent corruption of later arrays" half of #16: every array keeps its own
    // records, in order, all the way to the last one.
    expect(decoded.baseObjects[MAX_SNAPSHOT_BASE_OBJECTS - 1]?.id).toBe(
      MAX_SNAPSHOT_BASE_OBJECTS - 1,
    );
    expect(decoded.turrets[MAX_SNAPSHOT_TURRETS - 1]?.energy).toBe(150);
  });
  it('a hostile frame declaring an implausible u8 count fails loudly instead of decoding fewer records and misaligning the arrays after it (issue #16)', () => {
    // Same header + "player count 0, projectile count 0" framing the plausible-maximum
    // tests above use, then a flag-count byte of 255 (a plausible-looking u8 that exceeds
    // MAX_SNAPSHOT_FLAGS). The decode must throw on the count itself -- not silently
    // return zero flags and read the base-object count out of what was meant to be flag
    // payload.
    const cursor = createWriter(40);
    writeU8(cursor, MessageType.Snapshot);
    writeU32(cursor, 1);
    writeU32(cursor, 0);
    writeU32(cursor, 0);
    writeU32(cursor, 0);
    writeU8(cursor, 0);
    writeU16(cursor, 0); // player count
    writeU16(cursor, 0); // projectile count
    writeU8(cursor, 255); // declared flag count: above MAX_SNAPSHOT_FLAGS, wraps nothing
    writeU8(cursor, 0); // base-object count, present so misalignment would be observable
    expect(() => decodeSnapshot(bytesOf(cursor), null)).toThrow(RangeError);
  });

  it('rejects a hostile frame declaring an implausible bot count instead of reading a truncated bot block (issue #16)', () => {
    // Same framing as the hostile flag-count test above, but the implausible u8 lands in
    // the bot count -- read after the trailing scalars, so a decoder that returned zero
    // bots would then read the order count out of what was meant to be bot payload.
    // MAX_SNAPSHOT_BOTS has to stay far enough below 256 for this guard to mean anything:
    // at 255 the only wire value it could reject is 255 itself, and 256 would wrap the
    // write side to a 0 count that silently drops the whole block.
    const cursor = createWriter(40);
    writeU8(cursor, MessageType.Snapshot);
    writeU32(cursor, 1);
    writeU32(cursor, 0);
    writeU32(cursor, 0);
    writeU32(cursor, 0);
    writeU8(cursor, 0); // flags: full, not delta
    writeU16(cursor, 0); // player count
    writeU16(cursor, 0); // projectile count
    writeU8(cursor, 0); // flag count
    writeU8(cursor, 0); // base-object count
    writeU8(cursor, 0); // turret count
    writeU8(cursor, 0); // vehicle count
    writeU16(cursor, 0); // teamScores[0]
    writeU16(cursor, 0); // teamScores[1]
    writeU8(cursor, 0); // gameOver
    writeU8(cursor, 0); // winnerTeam
    writeF32(cursor, 0); // timeRemainingS
    writeU8(cursor, 0); // gameOverReason
    writeU8(cursor, 255); // declared bot count: above MAX_SNAPSHOT_BOTS, no bot data follows
    expect(() => decodeSnapshot(bytesOf(cursor), null)).toThrow(RangeError);
  });

  it("decodes a structurally valid vehicle frame carrying kind 255 unchanged -- rejection is deserializeVehicle's job (issue #25)", () => {
    // The protocol layer carries VehicleKind as a plain number (the same convention as
    // every other sim enum on the wire) and has no VEHICLE_DATA to validate against; the
    // sim layer's deserializeVehicle rejects the value BEFORE activating the slot, which
    // sim/src/snapshot.test.ts covers directly. Here we pin the protocol half of the
    // contract: an out-of-range kind neither throws on decode nor gets rewritten.
    const extras = {
      ...emptyExtras(),
      vehicles: [
        {
          id: 0,
          kind: 255,
          team: 1,
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          yaw: 0,
          pitch: 0,
          roll: 0,
          angVelYaw: 0,
          angVelPitch: 0,
          angVelRoll: 0,
          energy: 0,
          damage: 0,
          destroyed: 0 as const,
          driverId: -1,
          padId: -1,
          weaponTimer: 0,
          onGround: 0 as const,
          wasJumpHeld: 0 as const,
        },
      ],
    };
    const decoded = decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, extras), null);
    expect(decoded.vehicles).toHaveLength(1);
    expect(decoded.vehicles[0]?.kind).toBe(255);
  });
});

describe('WorldExtras: vehicles (M5)', () => {
  it('emptyExtras includes an empty vehicles array', () => {
    expect(emptyExtras().vehicles).toEqual([]);
  });

  it('a full snapshot round-trips vehicles exactly, including energy', () => {
    const extras = {
      ...emptyExtras(),
      vehicles: [
        {
          id: 0,
          kind: 0,
          team: 1,
          x: 10.5,
          y: 20.25,
          z: -30.125,
          vx: 1.5,
          vy: -2.5,
          vz: 3.5,
          yaw: 0.5,
          pitch: -0.2,
          roll: 0.1,
          angVelYaw: 0.05,
          angVelPitch: -0.06,
          angVelRoll: 0.07,
          energy: 150.5,
          damage: 0.25,
          destroyed: 0 as const,
          driverId: 3,
          padId: 2,
          weaponTimer: 0.1,
          spawnTime: 4.5,
          reservedPilotId: 7,
          onGround: 1 as const,
          wasJumpHeld: 1 as const,
        },
      ],
    };
    const bytes = encodeSnapshot(1, 100, 5, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.vehicles).toHaveLength(1);
    const vehicle = decoded.vehicles[0] as (typeof decoded.vehicles)[number];
    expect(vehicle.id).toBe(0);
    expect(vehicle.kind).toBe(0);
    expect(vehicle.team).toBe(1);
    expect(vehicle.x).toBeCloseTo(10.5, 3);
    expect(vehicle.y).toBeCloseTo(20.25, 3);
    expect(vehicle.z).toBeCloseTo(-30.125, 3);
    // Codex review round 1 (this PR), finding 4: velocity/angVel/padId/weaponTimer/onGround/
    // wasJumpHeld are new wire fields -- asserted here at the protocol layer, alongside
    // sim/src/snapshot.test.ts's own round trip of the same fields through
    // serializeVehicle/deserializeVehicle, so a regression in either the encode/decode byte
    // layout or the sim-level (de)serializers is caught independently.
    expect(vehicle.vx).toBeCloseTo(1.5, 3);
    expect(vehicle.vy).toBeCloseTo(-2.5, 3);
    expect(vehicle.vz).toBeCloseTo(3.5, 3);
    expect(vehicle.yaw).toBeCloseTo(0.5, 5);
    expect(vehicle.angVelYaw).toBeCloseTo(0.05, 5);
    expect(vehicle.angVelPitch).toBeCloseTo(-0.06, 5);
    expect(vehicle.angVelRoll).toBeCloseTo(0.07, 5);
    expect(vehicle.energy).toBeCloseTo(150.5, 3);
    expect(vehicle.damage).toBeCloseTo(0.25, 5);
    expect(vehicle.destroyed).toBe(0);
    expect(vehicle.driverId).toBe(3);
    expect(vehicle.padId).toBe(2);
    expect(vehicle.weaponTimer).toBeCloseTo(0.1, 5);
    expect(vehicle.spawnTime).toBe(4.5);
    expect(vehicle.reservedPilotId).toBe(7);
    expect(vehicle.onGround).toBe(1);
    expect(vehicle.wasJumpHeld).toBe(1);
  });

  it('a destroyed, unpiloted vehicle carries destroyed: 1 and driverId -1', () => {
    const extras = {
      ...emptyExtras(),
      vehicles: [
        {
          id: 1,
          kind: 1,
          team: 2,
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          yaw: 0,
          pitch: 0,
          roll: 0,
          angVelYaw: 0,
          angVelPitch: 0,
          angVelRoll: 0,
          energy: 0,
          damage: 0.6,
          destroyed: 1 as const,
          driverId: -1,
          padId: -1,
          weaponTimer: 0,
          onGround: 0 as const,
          wasJumpHeld: 0 as const,
        },
      ],
    };
    const bytes = encodeSnapshot(1, 0, 0, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.vehicles[0]?.destroyed).toBe(1);
    expect(decoded.vehicles[0]?.driverId).toBe(-1);
  });
});

describe('WorldExtras: orders (M7)', () => {
  it('emptyExtras includes an empty orders array', () => {
    expect(emptyExtras().orders).toEqual([]);
  });

  it('round-trips WorldExtras.orders through a full snapshot', () => {
    const orders: OrderSnapshotData[] = [
      { team: 1, kind: OrderKind.Repair, x: 10, z: -5, expiresInS: 42.5 },
    ];
    const extras = { ...emptyExtras(), orders };
    const bytes = encodeSnapshot(1, 0, 0, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.orders[0]?.team).toBe(1);
    expect(decoded.orders[0]?.kind).toBe(OrderKind.Repair);
    expect(decoded.orders[0]?.x).toBeCloseTo(10, 3);
    expect(decoded.orders[0]?.z).toBeCloseTo(-5, 3);
    expect(decoded.orders[0]?.expiresInS).toBeCloseTo(42.5, 1);
  });

  it('rejects an orders array longer than MAX_SNAPSHOT_ORDERS', () => {
    const orders: OrderSnapshotData[] = Array.from({ length: MAX_SNAPSHOT_ORDERS + 1 }, () => ({
      team: 1,
      kind: OrderKind.Attack,
      x: 0,
      z: 0,
      expiresInS: 1,
    }));
    expect(() => encodeSnapshot(1, 0, 0, [], null, { ...emptyExtras(), orders })).toThrow(
      RangeError,
    );
  });
});

describe('boarding state snapshots', () => {
  it('preserves use and boarding suppression through full and delta snapshots, including release', () => {
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 0, y: 10, z: 0 }, 1);
    world.players.wasUseHeld[id] = 3;
    const full = decodeSnapshot(
      encodeSnapshot(1, 0, 0, serializeActivePlayers(world), null, emptyExtras()),
      null,
    );
    expect(full.players[0]?.wasUseHeld).toBe(3);
    let baseline = { snapshotId: 1, players: full.players };
    for (const state of [2, 0, 1] as const) {
      world.players.wasUseHeld[id] = state;
      const nextId = baseline.snapshotId + 1;
      const decoded = decodeSnapshot(
        encodeSnapshot(nextId, nextId, 0, serializeActivePlayers(world), baseline, emptyExtras()),
        baseline,
      );
      expect(decoded.players[0]?.wasUseHeld ?? 0).toBe(state);
      baseline = { snapshotId: nextId, players: decoded.players };
    }
  });
});
