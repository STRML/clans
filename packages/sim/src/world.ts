import { LIGHT_ARMOR } from './armor.js';
import { stepPlayers } from './movement.js';
import { createProjectileStore, stepProjectiles } from './projectiles.js';
import type { Heightfield } from './terrain.js';
import type { PlayerInput, Vec3, World } from './types.js';
import { resetLoadout, stepWeapons, WEAPON_COUNT } from './weapons.js';

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
      freeIds: [],
      active: new Uint8Array(capacity),
      team: new Uint8Array(capacity),
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
      damage: new Float64Array(capacity),
      alive: new Uint8Array(capacity),
      respawnAt: new Float64Array(capacity),
      score: new Int16Array(capacity),
      weaponSlot: new Uint8Array(capacity),
      weaponState: new Uint8Array(capacity),
      weaponTimer: new Float64Array(capacity),
      spunUp: new Uint8Array(capacity),
      grenadeCooldown: new Float64Array(capacity),
      ammo: new Int16Array(capacity * WEAPON_COUNT),
      grenades: new Uint8Array(capacity),
    },
    projectiles: createProjectileStore(),
    pendingDeaths: [],
    pendingFireEvents: [],
  };
}

/**
 * Resets one player's simulated state (position, velocity, energy, ground contact, ...)
 * to what a freshly spawned player would have. Shared by addPlayer and by a net client
 * correcting its locally-predicted player once the server's real spawn is known: both
 * cases need the same fresh-player state, not just position, or stale prediction (moving
 * velocity, drained energy, mid-jump flags) survives into a state that no spawn ever had.
 */
export function resetPlayerToSpawn(world: World, id: number, spawn: Vec3): void {
  const players = world.players;
  players.position.set([spawn.x, spawn.y, spawn.z], id * 3);
  players.spawn.set([spawn.x, spawn.y, spawn.z], id * 3);
  players.velocity.set([0, 0, 0], id * 3);
  players.yaw[id] = 0;
  players.energy[id] = LIGHT_ARMOR.maxEnergy;
  players.onGround[id] = 0;
  players.ski[id] = 0;
  players.wasGrounded[id] = 0;
  players.wasJumpHeld[id] = 0;
  players.landingSpeed[id] = 0;
}

export function addPlayer(world: World, spawn: Vec3, team = 0): number {
  const players = world.players;
  const id = players.freeIds.pop() ?? players.count;
  if (id >= players.energy.length) throw new RangeError('Player capacity exceeded');
  if (id === players.count) players.count += 1;
  players.active[id] = 1;
  players.team[id] = team;
  players.damage[id] = 0;
  players.alive[id] = 1;
  players.respawnAt[id] = -1;
  players.score[id] = 0;
  resetPlayerToSpawn(world, id, spawn);
  resetLoadout(world, id, LIGHT_ARMOR);
  return id;
}

export function removePlayer(world: World, id: number): void {
  const players = world.players;
  if (id < 0 || id >= players.count || !players.active[id]) {
    throw new RangeError(`Cannot remove inactive player ${String(id)}`);
  }
  players.active[id] = 0;
  players.freeIds.push(id);
}

export function stepWorld(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt = FIXED_DT,
): void {
  if (dt !== FIXED_DT)
    throw new RangeError(`Simulation step requires fixed tick ${FIXED_TICK_MS} ms`);
  stepPlayers(world, inputs, dt);
  stepWeapons(world, inputs, dt);
  stepProjectiles(world, dt);
  world.tick += 1;
}
