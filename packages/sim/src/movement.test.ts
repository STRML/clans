import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  addPlayer,
  createWorld,
  sampleTerrain,
  stepWorld,
  type Heightfield,
  type PlayerInput,
} from './index.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const idle: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };
const inputMap = (id: number, input: Partial<PlayerInput>) =>
  new Map([[id, { ...idle, ...input }]]);

describe('Light movement', () => {
  it('reaches and holds 15 m/s when running forward on flat terrain', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < Math.ceil(2 / FIXED_DT); tick += 1)
      stepWorld(world, inputMap(id, { moveZ: 1 }));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBeCloseTo(15, 1);
  });

  it('strafes right (-X at yaw 0) on positive moveX, matching the camera basis', () => {
    // Camera forward at yaw 0 is +Z; right = forward x up = -X.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, inputMap(id, { moveX: 1 }));
    expect(world.players.velocity[id * 3]).toBeLessThan(-5);
    expect(Math.abs(world.players.velocity[id * 3 + 2] ?? 0)).toBeLessThan(1e-9);
  });

  it('settles when idle on a 20 degree slope instead of creeping downhill', () => {
    const rise = Math.tan((20 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < 50; tick += 1) stepWorld(world, inputMap(id, {}));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBe(0);
    expect(world.players.position[id * 3 + 2]).toBeCloseTo(500, 3);
  });

  it('falls through an empty square and returns to spawn below the kill depth', () => {
    const holed: Heightfield = { ...flat, emptySquares: new Set([0]) };
    const world = createWorld(holed, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    stepWorld(world, inputMap(id, {}));
    expect(world.players.onGround[id]).toBe(0);
    expect(world.players.velocity[id * 3 + 1]).toBeLessThan(0);
    for (let tick = 0; tick < 200; tick += 1) stepWorld(world, inputMap(id, {}));
    // 200 ticks of free fall is over 200 m; the reset put the player back at the spawn.
    expect(world.players.position[id * 3 + 1]).toBeGreaterThan(-30);
    expect(world.players.position[id * 3]).toBe(10);
    expect(world.players.position[id * 3 + 2]).toBe(10);
  });

  it('holds the run cap when running downhill without skiing', () => {
    const rise = Math.tan((30 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    // Facing downhill (-z): yaw PI makes forward (sin, cos) = (0, -1).
    for (let tick = 0; tick < Math.ceil(3 / FIXED_DT); tick += 1) {
      stepWorld(world, inputMap(id, { moveZ: 1, yaw: Math.PI }));
    }
    // The cap is along the surface, as in Torque, so measure the full tangent speed.
    const speed = Math.hypot(
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 1] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeLessThanOrEqual(15.01);
    expect(speed).toBeGreaterThan(14);
    expect(world.players.ski[id]).toBe(0);
  });

  it('fires a held jump on the tick after landing (the ski hop)', () => {
    // Spawned 0.1 m above flat ground with Space already held, as the client does.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0.1, z: 10 });
    let ticks = 0;
    while (world.players.onGround[id] === 0 && ticks < 20) {
      stepWorld(world, inputMap(id, { jump: true }));
      ticks += 1;
    }
    expect(world.players.onGround[id]).toBe(1);
    stepWorld(world, inputMap(id, { jump: true }));
    expect(world.players.velocity[id * 3 + 1]).toBeGreaterThan(5);
  });

  it('stops from run speed in under 0.5 seconds', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.velocity[id * 3 + 2] = 15;
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < Math.floor(0.5 / FIXED_DT); tick += 1)
      stepWorld(world, inputMap(id, {}));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBe(0);
  });

  it('refuses a jet at minJetEnergy and never drains below zero', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 10, z: 10 });
    world.players.energy[id] = 1;
    stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.energy[id]).toBe(1);
    expect(world.players.velocity[id * 3 + 1]).toBeCloseTo(-20 * FIXED_DT);
  });

  it('drains only while jetting and recharges 0.256 per released tick', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 10, z: 10 });
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.energy[id]).toBeCloseTo(52);
    for (let tick = 0; tick < 100; tick += 1) stepWorld(world, inputMap(id, {}));
    expect(world.players.energy[id]).toBeCloseTo(60);
  });

  it('pushes a fast descending player onto a slope and records landing speed', () => {
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 8,
      originX: 0,
      originY: 0,
      originZ: 8,
      heightScale: 1,
      heights: Uint16Array.from([0, 4, 0, 4]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 4, y: 3, z: 4 });
    world.players.velocity[id * 3 + 1] = -80;
    stepWorld(world, inputMap(id, {}));
    expect(world.players.position[id * 3 + 1]).toBeCloseTo(2);
    // Landing removes the velocity into the surface and keeps the tangent part.
    const { normal } = sampleTerrain(slope, 4, 4);
    const [vx, vy, vz] = [
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 1] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    ];
    expect(vx * normal.x + vy * normal.y + vz * normal.z).toBeCloseTo(0);
    expect(Math.hypot(vx, vy, vz)).toBeGreaterThan(30);
    expect(world.players.landingSpeed[id]).toBeGreaterThanOrEqual(80);
  });

  it('runs up a 60 degree slope at run speed instead of stalling', () => {
    // Torque steers velocity toward the run speed at runForce/mass, and that steering is
    // also what stops a player. A separate friction term fought the run force uphill and
    // left the player crawling at 1 m/s into the spawn hill.
    const rise = Math.tan((60 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    // Facing uphill (+z): yaw 0 makes forward (sin, cos) = (0, 1).
    for (let tick = 0; tick < Math.ceil(2 / FIXED_DT); tick += 1) {
      stepWorld(world, inputMap(id, { moveZ: 1 }));
    }
    const speed = Math.hypot(
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 1] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeGreaterThan(14);
    expect(speed).toBeLessThanOrEqual(15.01);
    expect(world.players.position[id * 3 + 2]).toBeGreaterThan(510);
  });

  it('keeps its speed while skiing slowly on flat ground with no move input', () => {
    // Skiing removes the ground's grip. Below run speed a skier may still run, but only
    // when a move key is held; with none held nothing may brake them.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    world.players.wasJumpHeld[id] = 1;
    world.players.velocity[id * 3 + 2] = 5;
    for (let tick = 0; tick < 15; tick += 1) stepWorld(world, inputMap(id, { jump: true }));
    expect(world.players.velocity[id * 3 + 2]).toBeCloseTo(5, 6);
    expect(world.players.ski[id]).toBe(1);
  });

  it('gains speed every tick while skiing down a 20 degree slope for 3 seconds', () => {
    const rise = Math.tan((20 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    world.players.wasJumpHeld[id] = 1;
    let previous = 0;
    for (let tick = 0; tick < Math.ceil(3 / FIXED_DT); tick += 1) {
      stepWorld(world, inputMap(id, { jump: true }));
      const speed = Math.hypot(
        world.players.velocity[id * 3] ?? 0,
        world.players.velocity[id * 3 + 2] ?? 0,
      );
      expect(speed + 1e-9).toBeGreaterThanOrEqual(previous);
      previous = speed;
    }
    // 3 s at g*sin(20 deg) = 6.84 m/s^2 stays under horizResistSpeed (33), so speed is
    // monotonic. Above 33 the resistance term can win a tick and the assertion is invalid.
    expect(previous).toBeGreaterThan(15);
  });

  it('fires one jump impulse and refuses it above 80 degrees', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    stepWorld(world, inputMap(id, { jump: true }));
    const first = world.players.velocity[id * 3 + 1] ?? 0;
    stepWorld(world, inputMap(id, { jump: true }));
    expect(world.players.velocity[id * 3 + 1]).toBeLessThan(first);

    const cliff: Heightfield = {
      gridSize: 2,
      squareSize: 8,
      originX: 0,
      originY: 0,
      originZ: 8,
      heightScale: 1,
      heights: Uint16Array.from([64, 64, 0, 0]),
    };
    const steep = createWorld(cliff, 1);
    const steepId = addPlayer(steep, { x: 4, y: 32, z: 4 });
    steep.players.onGround[steepId] = 1;
    steep.players.wasGrounded[steepId] = 1;
    stepWorld(steep, inputMap(steepId, { jump: true }));
    // Refused jump: no upward impulse. Slope gravity may pull the value below zero.
    expect(steep.players.velocity[steepId * 3 + 1]).toBeLessThanOrEqual(0);
    expect(steep.players.ski[steepId]).toBe(1);
  });

  it('scales the jump impulse down between minJumpSpeed and maxJumpSpeed and refuses it above', () => {
    const gainFrom = (vy: number): number => {
      const world = createWorld(flat, 1);
      const id = addPlayer(world, { x: 10, y: 0, z: 10 });
      world.players.onGround[id] = 1;
      world.players.wasGrounded[id] = 1;
      world.players.velocity[id * 3 + 1] = vy;
      stepWorld(world, inputMap(id, { jump: true }));
      return (world.players.velocity[id * 3 + 1] ?? 0) - vy;
    };
    const full = gainFrom(0);
    expect(full).toBeCloseTo(8.3, 6);
    const partial = gainFrom(25);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(full);
    // Above maxJumpSpeed the jump is refused; only the run steering toward rest remains.
    expect(gainFrom(31)).toBeLessThanOrEqual(0);
  });

  it('hard caps horizontal speed at 68 m/s for 100 ticks', () => {
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([1000, 1000, 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: 500, z: 500 });
    world.players.velocity[id * 3 + 2] = -80; // downhill: row 1 (z = 0) is the low edge
    world.players.wasGrounded[id] = 1;
    world.players.wasJumpHeld[id] = 1;
    for (let tick = 0; tick < 100; tick += 1) stepWorld(world, inputMap(id, { jump: true }));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBeLessThanOrEqual(68);
  });
});
