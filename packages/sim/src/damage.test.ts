import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import { addPlayer, createWorld, stepWorld, type Heightfield, type PlayerInput } from './index.js';
import {
  applyDamage,
  applyFallDamage,
  applyKickback,
  dueForRespawn,
  playerHitbox,
  radiusFalloff,
  raySphereDistance,
  respawnPlayer,
  RESPAWN_TICKS,
} from './damage.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const idle: PlayerInput = {
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

describe('radiusFalloff', () => {
  it('is full at the center and zero at the radius', () => {
    expect(radiusFalloff(0, 10)).toBe(1);
    expect(radiusFalloff(10, 10)).toBe(0);
    expect(radiusFalloff(5, 10)).toBeCloseTo(0.5);
    expect(radiusFalloff(20, 10)).toBe(0);
  });
});

describe('applyDamage and death', () => {
  it('kills at maxDamage and starts a 5 s respawn timer', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage - 0.01, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(1);
    applyDamage(world, id, 0.02, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
    expect(world.players.respawnAt[id]).toBe(RESPAWN_TICKS);
    expect(world.pendingDeaths).toEqual([{ id, attackerId: -1 }]);
    expect(dueForRespawn(world)).toEqual([]);
    world.tick = RESPAWN_TICKS;
    expect(dueForRespawn(world)).toEqual([id]);
  });

  it('two disc splashes at center kill a Light (0.5 + 0.5 > 0.66 maxDamage)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
  });

  it('scores +10 for a kill, -10 for a team kill, -10 for a suicide, nothing for env damage', () => {
    const world = createWorld(flat, 1);
    const victim = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: 5, y: 0, z: 5 }, 2);
    const ally = addPlayer(world, { x: 10, y: 0, z: 10 }, 1);
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.score[enemy]).toBe(0);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, enemy, LIGHT_ARMOR);
    expect(world.players.score[enemy]).toBe(10);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, ally, LIGHT_ARMOR);
    expect(world.players.score[ally]).toBe(-10);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, victim, LIGHT_ARMOR);
    expect(world.players.score[victim]).toBe(-10);
  });

  it('ignores damage against an already-dead or inactive player', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    const damageBefore = world.players.damage[id];
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(damageBefore);
  });
});

describe('applyFallDamage', () => {
  it('does nothing at or below minJumpSpeed', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyFallDamage(world, id, LIGHT_ARMOR.minJumpSpeed, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(0);
  });
  it('scales the excess over minJumpSpeed by speedDamageScale', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyFallDamage(world, id, LIGHT_ARMOR.minJumpSpeed + 10, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBeCloseTo(10 * LIGHT_ARMOR.speedDamageScale);
  });
  it('a hard landing from stepWorld applies fall damage exactly once per landing', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 60, z: 0 });
    // Air resistance (upResistFactor past upResistSpeed) means a 60 m drop takes ~81 ticks
    // to land, not the naive sqrt(2*60/GRAVITY)/dt ~= 60 ticks a no-drag fall would need.
    for (let tick = 0; tick < 90; tick += 1) stepWorld(world, new Map([[id, idle]]));
    expect(world.players.damage[id]).toBeGreaterThan(0);
    const afterLanding = world.players.damage[id];
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, new Map([[id, idle]]));
    expect(world.players.damage[id]).toBe(afterLanding);
  });
});

describe('respawnPlayer and dueForRespawn', () => {
  it('resets damage, aliveness, and position', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    respawnPlayer(world, id, { x: 42, y: 0, z: 7 });
    expect(world.players.alive[id]).toBe(1);
    expect(world.players.damage[id]).toBe(0);
    expect(world.players.position[id * 3]).toBe(42);
    expect(world.players.respawnAt[id]).toBe(-1);
  });
});

describe('playerHitbox and raySphereDistance', () => {
  it('hits a player standing on the ray and reports the correct distance', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    const distance = raySphereDistance(
      { x: 0, y: hitbox.center.y, z: 0 },
      { x: 1, y: 0, z: 0 },
      hitbox,
    );
    expect(distance).not.toBeNull();
    expect(distance ?? 0).toBeCloseTo(10 - hitbox.radius, 1);
  });
  it('misses a ray that passes outside the hit sphere', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    expect(raySphereDistance({ x: 0, y: 100, z: 0 }, { x: 1, y: 0, z: 0 }, hitbox)).toBeNull();
  });
});

describe('applyKickback', () => {
  it('scales the velocity change by magnitude/mass and the falloff', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyKickback(world, id, { x: 0, y: 1, z: 0 }, 1750, 1, LIGHT_ARMOR);
    expect(world.players.velocity[id * 3 + 1]).toBeCloseTo(1750 / LIGHT_ARMOR.mass);
  });
  it('does nothing at zero falloff', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyKickback(world, id, { x: 0, y: 1, z: 0 }, 1750, 0, LIGHT_ARMOR);
    expect(world.players.velocity[id * 3 + 1]).toBe(0);
  });
});
