import { ARMORS, ArmorId, armorFor } from './armor.js';
import { GameOverReason, stepFlags, TIME_LIMIT_TICKS } from './flags.js';
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
    interiors: [],
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
      godMode: new Uint8Array(capacity),
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
      respawnSeq: new Uint16Array(capacity),
      armor: new Uint8Array(capacity),
      hasRepairPack: new Uint8Array(capacity),
    },
    projectiles: createProjectileStore(),
    pendingDeaths: [],
    pendingFireEvents: [],
    lastFireEvents: [],
    pendingAmmoRefunds: [],
    flags: {
      team: new Uint8Array(0),
      state: new Uint8Array(0),
      position: new Float64Array(0),
      standPosition: new Float64Array(0),
      carrierId: new Int16Array(0),
      returnAt: new Float64Array(0),
    },
    teamScores: new Uint16Array(3),
    gameOver: false,
    winnerTeam: 0,
    timeLimitTicks: TIME_LIMIT_TICKS,
    gameOverReason: GameOverReason.CaptureLimit,
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
  players.energy[id] = armorFor(world, id).maxEnergy;
  players.onGround[id] = 0;
  players.ski[id] = 0;
  players.wasGrounded[id] = 0;
  players.wasJumpHeld[id] = 0;
  players.landingSpeed[id] = 0;
}

export function addPlayer(world: World, spawn: Vec3, team = 0, armor = ArmorId.Light): number {
  const players = world.players;
  const id = players.freeIds.pop() ?? players.count;
  if (id >= players.energy.length) throw new RangeError('Player capacity exceeded');
  if (id === players.count) players.count += 1;
  players.active[id] = 1;
  players.team[id] = team;
  players.armor[id] = armor;
  players.hasRepairPack[id] = 0;
  players.damage[id] = 0;
  // A reused id (see removePlayer's own reused-id comment) must not inherit whatever the
  // previous occupant's god-mode toggle -- or respawn count -- was left at.
  players.godMode[id] = 0;
  players.alive[id] = 1;
  players.respawnAt[id] = -1;
  players.respawnSeq[id] = 0;
  players.score[id] = 0;
  resetPlayerToSpawn(world, id, spawn);
  resetLoadout(world, id, ARMORS[armor]);
  return id;
}

export function removePlayer(world: World, id: number): void {
  const players = world.players;
  if (id < 0 || id >= players.count || !players.active[id]) {
    throw new RangeError(`Cannot remove inactive player ${String(id)}`);
  }
  players.active[id] = 0;
  players.freeIds.push(id);
  // Codex review round 2, finding 7 (ammo-refund half): a refund recorded by stepProjectiles
  // for this id is consumed one tick later by stepWeapons. Without this, a disconnect landing
  // in between lets a new player who gets this same numeric id inherit someone else's stale
  // refund. Dropping this player's pending entries here closes that specific hole -- it does
  // not touch the deeper reused-id identity problem (stale projectile ownerId self-exclusion),
  // which is already tracked separately at github.com/STRML/clans/issues/8.
  world.pendingAmmoRefunds = world.pendingAmmoRefunds.filter((refund) => refund.playerId !== id);
}

/**
 * Toggles a player's invulnerability proactively, at the sim level, rather than the reactive
 * post-hoc approach it replaces (a server-side set that zeroed damage back to full AFTER
 * stepWorld had already run -- see applyDamage's godMode guard for why that was too late to
 * stop a flag drop or score event). Server code calling this is the ONLY thing that should
 * ever flip the flag; the sim itself never sets it on its own.
 */
export function setGodMode(world: World, id: number, enabled: boolean): void {
  world.players.godMode[id] = enabled ? 1 : 0;
}

export function stepWorld(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt = FIXED_DT,
): void {
  if (dt !== FIXED_DT)
    throw new RangeError(`Simulation step requires fixed tick ${FIXED_TICK_MS} ms`);
  // Once the match is over the authoritative sim freezes: no more movement, weapons, or
  // projectiles, and the tick itself stops advancing (matches real T2; Codex review round 1,
  // finding 9). world.tick is not part of "state at the moment of game over" for any other
  // test, so freezing it here too is in scope.
  if (world.gameOver) return;
  stepPlayers(world, inputs, dt);
  stepWeapons(world, inputs, dt);
  stepProjectiles(world, dt);
  stepFlags(world, dt);
  world.tick += 1;
}
