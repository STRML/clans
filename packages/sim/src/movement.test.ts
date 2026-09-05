import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  addPlayer,
  createWorld,
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
});
