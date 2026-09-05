import { stepPlayers } from './movement.js';
import type { Heightfield } from './terrain.js';
import type { PlayerInput, Vec3, World } from './types.js';

export const FIXED_TICK_MS = 32;
export const FIXED_DT = FIXED_TICK_MS / 1000;

// Distance below the lowest terrain point at which a falling player returns to spawn.
export const KILL_DEPTH = 30;

function lowestTerrainHeight(terrain: Heightfield): number {
  let lowest = Infinity;
  for (const raw of terrain.heights) lowest = Math.min(lowest, raw);
  return terrain.originY + (Number.isFinite(lowest) ? lowest : 0) / terrain.heightScale;
}

/**
 * Every square, not just the diagonal-corner ones, must have a real sample: sampleTerrain
 * indexes rows and columns with `?? 0`, so a truncated heights array (a partial asset
 * fetch, say) would silently sample as flat rather than fail. Catch the mismatch here,
 * at the one place every heightfield passes through before it can be simulated on.
 */
function assertCompleteHeights(terrain: Heightfield): void {
  const expected = terrain.gridSize * terrain.gridSize;
  if (terrain.heights.length !== expected) {
    throw new RangeError(
      `Heightfield expects ${String(expected)} heights for a ${String(terrain.gridSize)}x${String(terrain.gridSize)} grid, got ${String(terrain.heights.length)}`,
    );
  }
}

export function createWorld(terrain: Heightfield, seed: number, capacity = 32): World {
  assertCompleteHeights(terrain);
  return {
    tick: 0,
    random: { value: seed || 1 },
    terrain,
    killY: lowestTerrainHeight(terrain) - KILL_DEPTH,
    players: {
      count: 0,
      position: new Float64Array(capacity * 3),
      spawn: new Float64Array(capacity * 3),
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
  world.players.spawn.set([spawn.x, spawn.y, spawn.z], id * 3);
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
