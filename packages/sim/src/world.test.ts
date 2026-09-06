import { describe, expect, it } from 'vitest';
import * as sim from './index.js';
import {
  addPlayer,
  createWorld,
  nextRandom,
  removePlayer,
  setGodMode,
  stepWorld,
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

describe('fixed world', () => {
  it('generates the same random stream from the same seed', () => {
    const a = { value: 123 },
      b = { value: 123 };
    expect([nextRandom(a), nextRandom(a), nextRandom(a)]).toEqual([
      nextRandom(b),
      nextRandom(b),
      nextRandom(b),
    ]);
  });
  it('rejects frame delta instead of the fixed tick', () => {
    const world = createWorld(terrain, 1);
    expect(() => stepWorld(world, new Map(), 1 / 60)).toThrowError(
      new RangeError('Simulation step requires fixed tick 32 ms'),
    );
  });

  it('does not export the per-tick player step, so the fixed-tick guard cannot be bypassed', () => {
    expect('stepPlayers' in sim).toBe(false);
  });

  it('puts the kill plane 30 m below the lowest terrain point, not the origin', () => {
    const raised: Heightfield = {
      ...terrain,
      heights: Uint16Array.from([1600, 1700, 1800, 1900]),
      heightScale: 32,
    };
    expect(createWorld(raised, 1).killY).toBe(50 - 30);
  });

  it('rejects a heightfield whose heights array does not match gridSize squared', () => {
    // Codex round 15: sampleTerrain indexes with `?? 0`, so a truncated heights array
    // (a partial asset fetch) silently sampled as flat instead of failing to load.
    const truncated: Heightfield = { ...terrain, heights: new Uint16Array(3) };
    expect(() => createWorld(truncated, 1)).toThrow(RangeError);
  });

  it('assigns a default team of 0 and lets addPlayer set an explicit team', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    const b = addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    expect(world.players.team[a]).toBe(0);
    expect(world.players.team[b]).toBe(2);
  });

  it('frees a removed id and reuses it before growing the store', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 1, y: 0, z: 1 });
    const b = addPlayer(world, { x: 2, y: 0, z: 2 });
    removePlayer(world, a);
    const c = addPlayer(world, { x: 3, y: 0, z: 3 }, 1);
    expect(c).toBe(a);
    expect(world.players.active[a]).toBe(1);
    expect(world.players.position[a * 3]).toBe(3);
    expect(world.players.count).toBe(2);
    expect(b).not.toBe(c);
  });

  it('rejects removing an id that is not active', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    removePlayer(world, a);
    expect(() => removePlayer(world, a)).toThrow(RangeError);
  });

  it("setGodMode toggles the flag, and a reused id does not inherit the previous occupant's setting", () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    setGodMode(world, a, true);
    expect(world.players.godMode[a]).toBe(1);
    setGodMode(world, a, false);
    expect(world.players.godMode[a]).toBe(0);
    setGodMode(world, a, true);
    removePlayer(world, a);
    const b = addPlayer(world, { x: 1, y: 0, z: 1 });
    expect(b).toBe(a);
    expect(world.players.godMode[b]).toBe(0);
  });

  it("addPlayer starts respawnSeq at 0, and a reused id does not inherit the previous occupant's count (Codex review round 8, PR #9)", () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.respawnSeq[a]).toBe(0);
    world.players.respawnSeq[a] = 5; // simulate several respawns before this player leaves
    removePlayer(world, a);
    const b = addPlayer(world, { x: 1, y: 0, z: 1 });
    expect(b).toBe(a);
    expect(world.players.respawnSeq[b]).toBe(0);
  });

  it('drops a pending ammo refund for a removed player so a reused id cannot inherit it (Codex review round 2, finding 7)', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    const b = addPlayer(world, { x: 1, y: 0, z: 1 });
    world.pendingAmmoRefunds.push({ playerId: a, weaponId: 0, isAltFire: false });
    world.pendingAmmoRefunds.push({ playerId: b, weaponId: 1, isAltFire: true });
    removePlayer(world, a);
    expect(world.pendingAmmoRefunds).toEqual([{ playerId: b, weaponId: 1, isAltFire: true }]);
  });

  it('skips inactive players when stepping the world', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 5, y: 0, z: 5 });
    removePlayer(world, a);
    expect(() => stepWorld(world, new Map())).not.toThrow();
    expect(world.players.position[a * 3]).toBe(5);
  });

  it('freezes the simulation once gameOver is true (Codex review round 1, finding 8)', () => {
    // Real T2 freezes the match at game over; an authoritative sim must not keep moving
    // players, spending ammo, or advancing the tick once gameOver is true.
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.gameOver = true;
    const tickBefore = world.tick;
    const positionBefore = Array.from(world.players.position);
    const velocityBefore = Array.from(world.players.velocity);
    const ammoBefore = Array.from(world.players.ammo);
    const input = {
      moveX: 1,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      jump: true,
      jet: true,
      fire: true,
      altFire: false,
      slot: 0,
      packActive: false,
    };
    stepWorld(world, new Map([[a, input]]));
    expect(world.tick).toBe(tickBefore);
    expect(Array.from(world.players.position)).toEqual(positionBefore);
    expect(Array.from(world.players.velocity)).toEqual(velocityBefore);
    expect(Array.from(world.players.ammo)).toEqual(ammoBefore);
  });
});
