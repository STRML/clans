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
    // Codex review round 13 (PR #9), finding 2: mixPlayer now also covers respawnAt, which
    // is NOT on the wire snapshot (deliberately -- see snapshot.ts's PlayerSnapshotData) and
    // so was never something deserializePlayer alone could reproduce. A real client doesn't
    // conjure a player from nothing on every snapshot either: it tracks one locally (via
    // addPlayer, same as source here) and reconciles it against incoming snapshots, so
    // pre-seeding target the same way is the realistic round trip, not a synthetic one.
    addPlayer(target, { x: 10, y: 0, z: -5 }, 2);
    target.tick = source.tick;
    for (const player of serializeActivePlayers(source)) deserializePlayer(target, player);
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
    // ski, wasGrounded, wasJumpHeld, godMode, alive, respawnAt, score, or respawnSeq;
    // mixProjectiles never mixed in expiresAtTick or armed; mixFlags never mixed in returnAt
    // or standPosition; and hashWorld itself never mixed in timeLimitTicks. Two worlds
    // identical everywhere else but different in exactly one of these fields hashed the
    // SAME, silently defeating the determinism check. Each field is checked in isolation
    // against a shared, otherwise-identical baseline, so a fix that only covers some of them
    // still fails this test. (spawn and landingSpeed are deliberately NOT covered here -- see
    // mixPlayer's doc comment in hash.ts for why neither is future-affecting state.)
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

    const respawnAtChanged = baseline();
    respawnAtChanged.players.respawnAt[0] = 42;
    expect(hashWorld(respawnAtChanged)).not.toBe(before);

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
});
