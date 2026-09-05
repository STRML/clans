import { stepPlayers } from './movement.js';
import type { Heightfield } from './terrain.js';
import type { PlayerInput, Vec3, World } from './types.js';

export const FIXED_TICK_MS = 32;
export const FIXED_DT = FIXED_TICK_MS / 1000;

export function createWorld(terrain: Heightfield, seed: number, capacity = 32): World {
  return {
    tick: 0,
    random: { value: seed || 1 },
    terrain,
    players: {
      count: 0,
      position: new Float64Array(capacity * 3),
      velocity: new Float64Array(capacity * 3),
      yaw: new Float64Array(capacity),
      energy: new Float64Array(capacity),
      onGround: new Uint8Array(capacity),
      ski: new Uint8Array(capacity),
      wasGrounded: new Uint8Array(capacity),
      wasJumpHeld: new Uint8Array(capacity),
      landingSpeed: new Float64Array(capacity),
    },
  };
}

export function addPlayer(world: World, spawn: Vec3): number {
  const id = world.players.count;
  if (id >= world.players.energy.length) throw new RangeError('Player capacity exceeded');
  world.players.count += 1;
  world.players.position.set([spawn.x, spawn.y, spawn.z], id * 3);
  world.players.energy[id] = 60;
  return id;
}

export function stepWorld(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt = FIXED_DT,
): void {
  if (dt !== FIXED_DT)
    throw new RangeError(`Simulation step requires fixed tick ${FIXED_TICK_MS} ms`);
  stepPlayers(world, inputs, dt);
  world.tick += 1;
}
