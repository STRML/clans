import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createFlags,
  createWorld,
  deserializePlayer,
  FlagState,
  GameOverReason,
  hashWorld,
  serializeActivePlayers,
  type Heightfield,
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
