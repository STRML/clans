import { ArmorId } from './armor.js';
import { resetBaseObject } from './baseObjects.js';
import { GameOverReason, returnHome } from './flags.js';
import { createProjectileStore } from './projectiles.js';
import { baseFor, TurretBarrelId, TurretState } from './turrets.js';
import type { Vec3, World } from './types.js';
import { createVehicleStore } from './vehicles.js';
import { resetPlayerRow } from './world.js';

/**
 * Match lifecycle, sim side: everything a server needs to start the next match in an
 * already-loaded world.
 *
 * WHERE THE FLOW COMES FROM. The engine this game models has no in-mission "round" concept at
 * all: a mission runs one match and then either cycles to the next mission or ends the
 * session. The closest surviving relative of Tribes 2's own `game/gameConnection.cc` +
 * `game/game.cs` pair is Torque3D's `GameCore`, in
 * `Templates/Full/game/scripts/server/gameCore.cs`:
 *
 *   - `GameCore::startGame` starts a duration timer (`$Game::Duration` -> the
 *     `onGameDurationEnd` callback) and zeroes every client's score/kills/deaths;
 *   - `GameCore::endGame` cancels that timer and tells every client
 *     `commandToClient(%cl, 'GameEnd', $Game::EndGamePause)` -- i.e. the whole of "between
 *     matches" is a PAUSE long enough to read the score screen, nothing more;
 *   - `GameCore::cycleGame` then either `cycleGame()`s to the next mission in rotation, or --
 *     when the server is not cycling -- calls `endMission()`, which deletes `MissionGroup` and
 *     `MissionCleanup` and clears server paths.
 *
 * `GameConnection::resetMission` (same file) is the piece this reset is modelled on: it
 * deletes `MissionCleanup` -- the group every runtime object, players included, is
 * instantiated into -- and recreates the game object, i.e. "put this mission back to its
 * as-loaded state" WITHOUT a mission reload. `resetMatch` below has that shape: keep the map
 * (terrain, interiors, base/turret/flag placement and geometry, which the client already holds
 * and which no match can change) and return every piece of match STATE to its as-loaded
 * value.
 *
 * OURS, since the source has no in-mission round: Tribes 2 has no map rotation of its own
 * either (the community scripts that add one are what "cycle mission" refers to), so the
 * smallest honest flow is the one this project needs -- a match that ends starts another on
 * the same map, in the same process. Reloading the mission would also be wrong here: the
 * client's static scene is built once from the asset pipeline and never re-sent, so a reload
 * would be invisible to it.
 *
 * WHY THIS IS SIM CODE AND NOT SERVER CODE. Every other state transition in this project is a
 * deterministic step both sides can replay and hash (the spec's Testing section), and a match
 * reset is a transition like any other: a client that predicts "the match ended, then a new
 * one began" has to land on byte-identical state, and hashWorld has to agree about it. A
 * server-side reset reaching into the stores directly would be invisible to both. What the
 * server still owns is the POLICY -- how long the intermission between matches is, and when
 * the next match begins (packages/server/src/net.ts).
 *
 * MATCH_STATE_SLICES below is both the reset's implementation and its documentation: the
 * dispatch loop IS the list, so neither can be changed without the other. match.test.ts drives
 * a fixture per slice (proving first that the fixture genuinely dirty that slice), compares
 * the whole world against a freshly created one, and asserts hashWorld equality.
 */

/** One named slice of the state a match owns. `name` is what match.test.ts keys its fixture
 *  for that slice on: a slice with no fixture fails that test, which is the point -- a new
 *  piece of match state cannot be added here without someone writing down what "dirty" means
 *  for it. */
export interface MatchStateSlice {
  readonly name: string;
  readonly reset: (world: World) => void;
}

/**
 * The state a match owns, in reset order. Deliberately NOT reset:
 *
 *  - `world.random`: the sim's RNG stream (random.ts) has no consumer in the sim today (every
 *    bot's jitter comes from that bot's own seed, in packages/bots), and continuing the stream
 *    keeps a reset world's future identical for two servers with the same history. Reseeding
 *    would replay the same randomness every match instead.
 *  - the map: terrain, interiors, force-field geometry, and every base object's and turret's
 *    placement. None of it is touched by a match, and all of it is state the client holds.
 *  - `world.timeLimitTicks`: configuration, not state -- it is what the clock below is
 *    measured against, and a match reset must not rewrite the operator's own match length.
 *  - `ProjectileStore.impactSequence`: a monotonic identity counter, not match state (see the
 *    projectiles slice).
 */
export const MATCH_STATE_SLICES: readonly MatchStateSlice[] = [
  { name: 'clock', reset: resetClock },
  { name: 'outcome', reset: resetOutcome },
  { name: 'teamScores', reset: resetTeamScores },
  { name: 'players', reset: resetPlayers },
  { name: 'flags', reset: resetFlags },
  { name: 'baseObjects', reset: resetBaseObjects },
  { name: 'turrets', reset: resetTurrets },
  { name: 'vehicles', reset: resetVehicles },
  { name: 'projectiles', reset: resetProjectiles },
  { name: 'eventQueues', reset: resetEventQueues },
];

/**
 * Returns the world to the state a freshly loaded match is in: the same map, the same players
 * on the same teams, and no trace of the match that just ended. See this file's header for why
 * the reset lives here, and MATCH_STATE_SLICES for the state it is responsible for.
 */
export function resetMatch(world: World): void {
  for (const slice of MATCH_STATE_SLICES) slice.reset(world);
}

function resetClock(world: World): void {
  // world.tick IS the match clock: flags.ts's checkTimeLimit compares it against
  // world.timeLimitTicks, and every deadline the sim stores is relative to it (a player's
  // respawnAt, a dropped flag's returnAt, a projectile's expiryAtTick, an order's TTL on the
  // server side). Starting it back at 0 is therefore what gives the next match a full clock
  // without changing any of those rules -- and it is the one field every other slice here is
  // reset alongside, because every one of those deadlines is meaningless the moment the clock
  // no longer shares an epoch with them. T2 itself never rewinds a tick counter (a new match
  // is a new mission); the rewind is ours, which is why the server-side stores that key off
  // absolute ticks -- the lag-comp position history and the order board -- are cleared by the
  // server at the same moment it calls this (net.ts's startNextMatch).
  world.tick = 0;
}

function resetOutcome(world: World): void {
  world.gameOver = false;
  world.winnerTeam = 0;
  // createWorld's own initial value; leaving the previous match's reason in place would make
  // any consumer that reads it before the next match's first win report the wrong cause.
  world.gameOverReason = GameOverReason.CaptureLimit;
}

function resetTeamScores(world: World): void {
  world.teamScores.fill(0);
}

function resetPlayers(world: World): void {
  const players = world.players;
  for (let id = 0; id < players.count; id += 1) {
    if (!players.active[id]) continue;
    // Every player returns to the spawn the sim already recorded for them (PlayerStore.spawn,
    // written by addPlayer and by every respawn), which is the sim's own authoritative notion
    // of "a spawn point" -- so the reset needs no scene knowledge and stays deterministic.
    // ArmorId.Light is what world.ts's addPlayer gives a fresh join, so a reset player is
    // exactly a freshly joined player rather than a hybrid of the two states.
    const base = id * 3;
    const spawn: Vec3 = {
      x: players.spawn[base] ?? 0,
      y: players.spawn[base + 1] ?? 0,
      z: players.spawn[base + 2] ?? 0,
    };
    resetPlayerRow(world, id, spawn, ArmorId.Light);
  }
}

function resetFlags(world: World): void {
  for (let id = 0; id < world.flags.team.length; id += 1) returnHome(world, id);
}

function resetBaseObjects(world: World): void {
  for (let id = 0; id < world.baseObjects.count; id += 1) resetBaseObject(world, id);
}

function resetTurrets(world: World): void {
  const store = world.turrets;
  for (let id = 0; id < store.count; id += 1) {
    // Mirrors createTurrets's own initial values. turrets.ts is not this change's to refactor
    // (it just landed), so this stays a mirror rather than a shared helper -- match.test.ts's
    // turret fixture and its fresh-world hash comparison both fail if the two ever drift.
    store.damage[id] = 0;
    store.destroyed[id] = 0;
    store.energy[id] = baseFor(store.barrel[id] as TurretBarrelId).maxEnergy;
    // createTurrets leaves `powered` at 0 and lets stepTurretPower derive the real state on
    // the next tick; matching that, rather than pre-computing power here, keeps a reset world
    // field-for-field equal to a freshly created one.
    store.powered[id] = 0;
    store.targetId[id] = -1;
    store.targetKind[id] = 0;
    store.state[id] = TurretState.Ready;
    store.timer[id] = 0;
  }
}

function resetVehicles(world: World): void {
  // A fresh store rather than a field-by-field clear: vehicles are pure runtime state (the
  // mission places none), the capacity is fixed at construction, and a fresh store cannot miss
  // a field the way a hand-written clear can. Every slot is inactive afterwards, so a snapshot
  // and hashWorld both see what a brand-new world shows, and ids are handed out from 0 again.
  world.vehicles = createVehicleStore(world.vehicles.active.length);
}

function resetProjectiles(world: World): void {
  const capacity = world.projectiles.active.length;
  const sequence = world.projectiles.impactSequence;
  world.projectiles = createProjectileStore(capacity);
  // Carried across the reset rather than restarted: ProjectileImpact.seq is a wire-visible
  // identity ("a consumer can prove exactly-once consumption", types.ts) and its own doc calls
  // the counter monotonic per world. A match-two sequence starting at 0 again could make a
  // late record from match one look like a new one to any consumer comparing numbers. Not
  // match state, and not mixed into hashWorld.
  world.projectiles.impactSequence = sequence;
}

function resetEventQueues(world: World): void {
  // Every one-tick communication array on World, the set hash.ts's POLICY comment documents as
  // "not networked": they are deliberately absent from hashWorld, which is exactly why they
  // need an explicit entry here -- nothing else would ever notice a stale one. The projectile
  // store above already replaced its own lastImpacts along with the store.
  world.pendingDeaths = [];
  world.pendingFireEvents = [];
  world.lastFireEvents = [];
  world.pendingAmmoRefunds = [];
  world.pendingTurretFireEvents = [];
  world.pendingVehicleFireEvents = [];
  world.lastVehicleFireEvents = [];
  world.pendingVehicleDestroyed = [];
}
