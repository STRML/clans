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
});
