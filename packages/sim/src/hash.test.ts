import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  ammoIndex,
  createFlags,
  createWorld,
  deserializePlayer,
  FlagState,
  GameOverReason,
  hashWorld,
  serializeActivePlayers,
  WeaponId,
  WeaponState,
  type Heightfield,
  type World,
} from './index.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('hashWorld', () => {
  it('matches for two worlds with the same tick and player state', () => {
    const a = createWorld(terrain, 1);
    addPlayer(a, { x: 1, y: 2, z: 3 }, 1);
    const b = createWorld(terrain, 99); // different seed, identical players
    addPlayer(b, { x: 1, y: 2, z: 3 }, 1);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('changes when a player moves, including moves that only touch high bits', () => {
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    const before = hashWorld(world);
    world.players.position[id * 3] = 1.5;
    expect(hashWorld(world)).not.toBe(before);
    // 100.000 m and 165.536 m differ only above the low 16 bits of the millimetre value.
    world.players.position[id * 3] = 100;
    const at100 = hashWorld(world);
    world.players.position[id * 3] = 165.536;
    expect(hashWorld(world)).not.toBe(at100);
  });

  it('reproduces the hash after a serialize and deserialize round trip', () => {
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 10, y: 0, z: -5 }, 2);
    source.players.velocity.set([3, -1, 2], id * 3);
    source.players.yaw[id] = 1.2;
    source.players.energy[id] = 55;
    const target = createWorld(terrain, 1);
    // A real client doesn't conjure a player from nothing on every snapshot either: it
    // tracks one locally (via addPlayer, same as source here) and reconciles it against
    // incoming snapshots, so pre-seeding target the same way is the realistic round trip,
    // not a synthetic one.
    addPlayer(target, { x: 10, y: 0, z: -5 }, 2);
    target.tick = source.tick;
    for (const player of serializeActivePlayers(source)) deserializePlayer(target, player);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('reproduces the hash after a round trip with real (non-default) respawnAt/score/godMode/respawnSeq, without every PlayerStore field needing to be wire-carried (Codex review round 15, PR #9, findings 3a/3b)', () => {
    // The reviewer's own repro, generalized: a dead source player with a real respawnAt, a
    // nonzero score/godMode, and a respawnSeq that survives the wire's mod-256 truncation
    // must still hash identically to its round-tripped target -- even though respawnAt is
    // not on the wire at all and respawnSeq is truncated on it. deserializePlayer forces an
    // ALIVE decoded player's respawnAt to -1 (round 13's fix), so give target's pre-seeded
    // player a deliberately different respawnAt (10, not source's 42) to prove the hash
    // genuinely ignores it rather than happening to agree by coincidence.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 10, y: 0, z: -5 }, 2);
    // Damage past maxDamage drives health <= 0, which is what serializePlayer actually wires
    // ("health", not "alive" or "damage" directly) -- deserializePlayer derives both alive
    // and damage back out of that single wire field.
    source.players.damage[id] = 1;
    source.players.alive[id] = 0;
    source.players.respawnAt[id] = 42;
    source.players.score[id] = -5;
    source.players.godMode[id] = 1;
    source.players.respawnSeq[id] = 3;
    const target = createWorld(terrain, 1);
    addPlayer(target, { x: 10, y: 0, z: -5 }, 2);
    target.players.respawnAt[id] = 10;
    target.tick = source.tick;
    for (const player of serializeActivePlayers(source)) deserializePlayer(target, player);
    expect(target.players.alive[id]).toBe(0);
    expect(target.players.respawnAt[id]).toBe(10); // deserializePlayer never touches a dead player's respawnAt
    expect(target.players.score[id]).toBe(-5);
    expect(target.players.godMode[id]).toBe(1);
    expect(target.players.respawnSeq[id]).toBe(3);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('reproduces the hash after a round trip when score or godMode differ from their zero defaults (Codex review round 14, PR #9, finding 1)', () => {
    // Round 13 extended mixPlayer to mix score and godMode into the determinism hash, but
    // neither field was ever actually wired onto PlayerSnapshotData/writePlayerFull/
    // serializePlayer -- so a decoded/reconstructed player always came back with score 0 /
    // godMode 0 regardless of the source's real values, and hashWorld on the two worlds
    // diverged even though the wire faithfully transmitted everything it actually carried.
    // This is the reviewer's own repro: set score away from 0, snapshot/decode into a
    // freshly seeded world, and the hashes must still match.
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 10, y: 0, z: -5 }, 2);
    source.players.score[id] = 7;
    source.players.godMode[id] = 1;
    const target = createWorld(terrain, 1);
    addPlayer(target, { x: 10, y: 0, z: -5 }, 2);
    target.tick = source.tick;
    for (const player of serializeActivePlayers(source)) deserializePlayer(target, player);
    expect(target.players.score[id]).toBe(7);
    expect(target.players.godMode[id]).toBe(1);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('changes when a projectile is added', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.projectiles.active[0] = 1;
    world.projectiles.count = 1;
    world.projectiles.type[0] = 0;
    world.projectiles.position.set([1, 2, 3], 0);
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when a flag changes state', () => {
    const world = createWorld(terrain, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    const before = hashWorld(world);
    world.flags.state[0] = FlagState.Dropped;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when a team score changes', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.teamScores[1] = 100;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when the match tick advances', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.tick += 1;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when the match ends', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.gameOver = true;
    world.winnerTeam = 1;
    world.gameOverReason = GameOverReason.TimeLimit;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when ammo, grenades, or the weapon/grenade state machines differ (Codex review round 12, PR #9, finding 2)', () => {
    // Through round 11, mixPlayer stopped at weaponSlot and never mixed in ammo, grenades,
    // weaponState, weaponTimer, spunUp, or grenadeCooldown -- all real simulation state that
    // stepWeapons (weapons.ts) mutates every tick. Two worlds identical everywhere else but
    // different in exactly these fields hashed the SAME, silently defeating the
    // determinism-check mechanism the spec's Testing section documents: a real client/server
    // divergence in weapon state would go completely undetected. Each field below is checked
    // in isolation against a shared, otherwise-identical baseline, so a fix that only covers
    // some of them still fails this test.
    const baseline = (): World => {
      const world = createWorld(terrain, 1);
      addPlayer(world, { x: 1, y: 2, z: 3 }, 1);
      return world;
    };
    const before = hashWorld(baseline());

    const discChanged = baseline();
    discChanged.players.ammo[ammoIndex(0, WeaponId.Spinfusor)] = 3;
    expect(hashWorld(discChanged)).not.toBe(before);

    const chaingunChanged = baseline();
    chaingunChanged.players.ammo[ammoIndex(0, WeaponId.Chaingun)] = 3;
    expect(hashWorld(chaingunChanged)).not.toBe(before);

    const mortarChanged = baseline();
    mortarChanged.players.ammo[ammoIndex(0, WeaponId.Mortar)] = 3;
    expect(hashWorld(mortarChanged)).not.toBe(before);

    const grenadesChanged = baseline();
    grenadesChanged.players.grenades[0] = 1;
    expect(hashWorld(grenadesChanged)).not.toBe(before);

    const weaponStateChanged = baseline();
    weaponStateChanged.players.weaponState[0] = WeaponState.Firing;
    expect(hashWorld(weaponStateChanged)).not.toBe(before);

    const weaponTimerChanged = baseline();
    weaponTimerChanged.players.weaponTimer[0] = 1.218;
    expect(hashWorld(weaponTimerChanged)).not.toBe(before);

    const spunUpChanged = baseline();
    spunUpChanged.players.spunUp[0] = 1;
    expect(hashWorld(spunUpChanged)).not.toBe(before);

    const grenadeCooldownChanged = baseline();
    grenadeCooldownChanged.players.grenadeCooldown[0] = 0.62;
    expect(hashWorld(grenadeCooldownChanged)).not.toBe(before);
  });

  it('matches for two independently built worlds with identical CTF state', () => {
    const stands = [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ];
    const a = createWorld(terrain, 1);
    createFlags(a, stands, 500);
    a.teamScores[1] = 300;
    const b = createWorld(terrain, 2); // different seed, identical CTF state
    createFlags(b, stands, 500);
    b.teamScores[1] = 300;
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it("changes when any player field mixPlayer stopped short of through round 12, a projectile's expiry/armed state, a flag's return timer/stand position, or the match time limit differ (Codex review round 13, PR #9, finding 2)", () => {
    // Through round 12, mixPlayer stopped at grenadeCooldown and never mixed in onGround,
    // ski, wasGrounded, wasJumpHeld, godMode, alive, score, or respawnSeq; mixProjectiles
    // never mixed in expiresAtTick or armed; mixFlags never mixed in returnAt or
    // standPosition; and hashWorld itself never mixed in timeLimitTicks. Two worlds
    // identical everywhere else but different in exactly one of these fields hashed the
    // SAME, silently defeating the determinism check. Each field is checked in isolation
    // against a shared, otherwise-identical baseline, so a fix that only covers some of them
    // still fails this test. (spawn and landingSpeed are deliberately NOT covered here -- see
    // mixPlayer's doc comment in hash.ts for why neither is future-affecting state. respawnAt
    // was covered here through round 14 but round 15, finding 3a, removed it from mixPlayer
    // -- see the dedicated respawnAt test below for its current, correct behavior.)
    const stands = [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ];
    const baseline = (): World => {
      const world = createWorld(terrain, 1);
      addPlayer(world, { x: 1, y: 2, z: 3 }, 1);
      world.projectiles.active[0] = 1;
      world.projectiles.count = 1;
      world.projectiles.type[0] = 0;
      world.projectiles.position.set([1, 2, 3], 0);
      createFlags(world, stands);
      return world;
    };
    const before = hashWorld(baseline());

    const onGroundChanged = baseline();
    onGroundChanged.players.onGround[0] = 1;
    expect(hashWorld(onGroundChanged)).not.toBe(before);

    const skiChanged = baseline();
    skiChanged.players.ski[0] = 1;
    expect(hashWorld(skiChanged)).not.toBe(before);

    const wasGroundedChanged = baseline();
    wasGroundedChanged.players.wasGrounded[0] = 1;
    expect(hashWorld(wasGroundedChanged)).not.toBe(before);

    const wasJumpHeldChanged = baseline();
    wasJumpHeldChanged.players.wasJumpHeld[0] = 1;
    expect(hashWorld(wasJumpHeldChanged)).not.toBe(before);

    const godModeChanged = baseline();
    godModeChanged.players.godMode[0] = 1;
    expect(hashWorld(godModeChanged)).not.toBe(before);

    const aliveChanged = baseline();
    aliveChanged.players.alive[0] = 0;
    expect(hashWorld(aliveChanged)).not.toBe(before);

    // respawnAt is NOT checked here -- round 15 (PR #9, finding 3a) removed it from
    // mixPlayer entirely, since it fails hashWorld's own "matches across encode and decode"
    // contract. See the dedicated test below.

    const scoreChanged = baseline();
    scoreChanged.players.score[0] = 10;
    expect(hashWorld(scoreChanged)).not.toBe(before);

    const respawnSeqChanged = baseline();
    respawnSeqChanged.players.respawnSeq[0] = 1;
    expect(hashWorld(respawnSeqChanged)).not.toBe(before);

    const expiresAtTickChanged = baseline();
    expiresAtTickChanged.projectiles.expiresAtTick[0] = 100;
    expect(hashWorld(expiresAtTickChanged)).not.toBe(before);

    const armedChanged = baseline();
    armedChanged.projectiles.armed[0] = 1;
    expect(hashWorld(armedChanged)).not.toBe(before);

    const returnAtChanged = baseline();
    returnAtChanged.flags.returnAt[0] = 100;
    expect(hashWorld(returnAtChanged)).not.toBe(before);

    const standPositionChanged = baseline();
    standPositionChanged.flags.standPosition[0] = 99;
    expect(hashWorld(standPositionChanged)).not.toBe(before);

    const timeLimitChanged = baseline();
    timeLimitChanged.timeLimitTicks = 100;
    expect(hashWorld(timeLimitChanged)).not.toBe(before);
  });

  it("hashes identically for two worlds differing only in a DEAD player's respawnAt (Codex review round 15, PR #9, finding 3a)", () => {
    // respawnAt is not on the wire for a dead player (the client reconstructs its own
    // respawn-countdown estimate locally -- see netclient.ts's death-detection code), so it
    // is not something a correct encode/decode round trip is expected to reproduce.
    // hashWorld must not treat two otherwise-identical dead players as different just
    // because their local respawnAt bookkeeping differs.
    const baseline = (): World => {
      const world = createWorld(terrain, 1);
      const id = addPlayer(world, { x: 1, y: 2, z: 3 }, 1);
      world.players.alive[id] = 0;
      world.players.respawnAt[id] = 5;
      return world;
    };
    const a = baseline();
    const b = baseline();
    b.players.respawnAt[0] = 42;
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it("hashes identically for two worlds whose respawnSeq differs by exactly 256, matching the wire's mod-256 truncation (Codex review round 15, PR #9, finding 3b)", () => {
    // protocol/snapshot.ts truncates respawnSeq to a single wire byte (round 8's choice).
    // hashWorld must mask to the same width, or it would demand more precision from a
    // round trip than the wire is designed to carry.
    const a = createWorld(terrain, 1);
    addPlayer(a, { x: 1, y: 2, z: 3 }, 1);
    a.players.respawnSeq[0] = 3;
    const b = createWorld(terrain, 1);
    addPlayer(b, { x: 1, y: 2, z: 3 }, 1);
    b.players.respawnSeq[0] = 3 + 256;
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
});
