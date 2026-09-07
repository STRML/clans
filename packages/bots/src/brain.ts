import {
  applyLoadoutRequest,
  armorFor,
  FlagState,
  STATION_USE_RADIUS,
  type ArmorId,
  type PlayerInput,
  type Vec3,
  type World,
} from '@clans/sim';
import { aimAndFire } from './combat.js';
import {
  findEscortedCarrier,
  findNearestFriendlyStation,
  findNearestVisibleEnemy,
  needsHealing,
} from './perception.js';
import { steerToward } from './steering.js';
import { BotRole, BotState, type BotRuntimeState } from './types.js';
import { decideVehicleGoal, shouldUseVehicle } from './vehicles.js';
import type { WaypointGraph } from './waypoints.js';

export const DEFEND_ENGAGE_RADIUS = 120; // Ours.

function playerPoint(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: world.players.position[base + 1] ?? 0,
    z: world.players.position[base + 2] ?? 0,
  };
}

function ownFlagId(world: World, team: number): number {
  for (let id = 0; id < world.flags.team.length; id += 1)
    if (world.flags.team[id] === team) return id;
  return 0;
}
function enemyFlagId(world: World, team: number): number {
  for (let id = 0; id < world.flags.team.length; id += 1)
    if (world.flags.team[id] !== team) return id;
  return 1;
}

function flagPosition(world: World, flagId: number): Vec3 {
  const base = flagId * 3;
  return {
    x: world.flags.position[base] ?? 0,
    y: world.flags.position[base + 1] ?? 0,
    z: world.flags.position[base + 2] ?? 0,
  };
}

function flagStandPosition(world: World, flagId: number): Vec3 {
  const base = flagId * 3;
  return {
    x: world.flags.standPosition[base] ?? 0,
    y: world.flags.standPosition[base + 1] ?? 0,
    z: world.flags.standPosition[base + 2] ?? 0,
  };
}

/** Attacker: carrying the enemy flag -> head home; otherwise -> head to the enemy flag
 *  wherever it currently is (home, dropped, or being carried by a teammate you're about
 *  to catch up to and pass, which is fine -- there's nothing wrong with two teammates
 *  converging on the same flag). Defender: the team's own flag is dropped -> go recover
 *  it; a teammate is carrying the enemy flag -> escort them; otherwise -> hold near the
 *  team's own flag stand. */
function decideAttackerGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } {
  const team = world.players.team[runtime.playerId] ?? 0;
  const ownId = ownFlagId(world, team);
  const enemyId = enemyFlagId(world, team);
  if (world.flags.carrierId[enemyId] === runtime.playerId) {
    return { position: flagStandPosition(world, ownId), key: `home:${String(ownId)}` };
  }
  return { position: flagPosition(world, enemyId), key: `enemyFlag:${String(enemyId)}` };
}

function decideDefenderGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } {
  const team = world.players.team[runtime.playerId] ?? 0;
  const ownId = ownFlagId(world, team);
  if (world.flags.state[ownId] === FlagState.Dropped) {
    return { position: flagPosition(world, ownId), key: `recoverOwn:${String(ownId)}` };
  }
  const carrier = findEscortedCarrier(world, team, runtime.playerId);
  if (carrier !== null) {
    return { position: playerPoint(world, carrier), key: `escort:${String(carrier)}` };
  }
  // Fallback checked only when every CTF priority above comes up empty (Task 7): mount a
  // nearby own-team vehicle if one is reachable, otherwise hold at the flag stand as before.
  const vehicleGoal = decideVehicleGoal(world, runtime);
  if (vehicleGoal !== null) return vehicleGoal;
  return { position: flagStandPosition(world, ownId), key: `home:${String(ownId)}` };
}

export function decideGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } {
  return runtime.role === BotRole.Attacker
    ? decideAttackerGoal(world, runtime)
    : decideDefenderGoal(world, runtime);
}

export function decideState(runtime: BotRuntimeState, engagedTargetId: number | null): BotState {
  if (engagedTargetId === null) return BotState.Idle;
  return runtime.role === BotRole.Defender ? BotState.Defend : BotState.Attack;
}

function isOutsideDefendLeash(world: World, runtime: BotRuntimeState, targetId: number): boolean {
  if (runtime.role !== BotRole.Defender) return false;
  const team = world.players.team[runtime.playerId] ?? 0;
  const home = flagStandPosition(world, ownFlagId(world, team));
  const target = playerPoint(world, targetId);
  return Math.hypot(home.x - target.x, home.z - target.z) > DEFEND_ENGAGE_RADIUS;
}

/** A Defender only engages within DEFEND_ENGAGE_RADIUS of its own flag stand; an
 *  Attacker (and a Defender escorting a carrier already away from home) engages any
 *  visible enemy in range with no leash. Row 9: engagedTargetId is re-derived fresh
 *  every call from a live scan, never trusted across ticks, so a target that died or
 *  disconnected between calls simply doesn't come back from findNearestVisibleEnemy. */
export function decideCombat(
  world: World,
  runtime: BotRuntimeState,
): { yaw: number; pitch: number; fire: boolean; targetId: number | null } {
  const targetId = findNearestVisibleEnemy(world, runtime.playerId);
  if (targetId === null || isOutsideDefendLeash(world, runtime, targetId)) {
    runtime.engagedTargetId = -1;
    return { yaw: runtime.aimYaw, pitch: 0, fire: false, targetId: null };
  }
  const { yaw, pitch, fire } = aimAndFire(world, runtime, runtime.playerId, targetId);
  return { yaw, pitch, fire, targetId };
}

/** Direct sim call, not a queued wire message (Global Constraints) -- a bot server-side
 *  has no socket, and a station-use decision is a one-shot state change exactly like a
 *  human's own Loadout request, just triggered from here instead of a decoded message. */
function maybeHeal(world: World, botId: number): void {
  if (!needsHealing(world, botId)) return;
  const stationId = findNearestFriendlyStation(world, botId);
  if (stationId === null) return;
  const base = botId * 3;
  const stationBase = stationId * 3;
  const dx = (world.players.position[base] ?? 0) - (world.baseObjects.position[stationBase] ?? 0);
  const dz =
    (world.players.position[base + 2] ?? 0) - (world.baseObjects.position[stationBase + 2] ?? 0);
  if (Math.hypot(dx, dz) > STATION_USE_RADIUS) return;
  applyLoadoutRequest(
    world,
    botId,
    world.players.armor[botId] as ArmorId,
    world.players.hasRepairPack[botId] === 1,
  );
}

export function stepBot(world: World, graph: WaypointGraph, runtime: BotRuntimeState): PlayerInput {
  maybeHeal(world, runtime.playerId);
  const goal = decideGoal(world, runtime);
  const armor = armorFor(world, runtime.playerId);
  const energy = world.players.energy[runtime.playerId] ?? 0;
  const team = world.players.team[runtime.playerId] ?? 0;
  const currentPosition = playerPoint(world, runtime.playerId);
  const move = steerToward(
    graph,
    world,
    team,
    runtime,
    runtime.playerId,
    goal.position,
    goal.key,
    currentPosition,
    armor,
    energy,
  );
  const combat = decideCombat(world, runtime);
  const yaw = combat.targetId !== null ? combat.yaw : move.headingYaw;
  runtime.aimYaw = yaw;
  runtime.state = decideState(runtime, combat.targetId);
  return {
    moveX: move.moveX ?? 0,
    moveZ: move.moveZ ?? 0,
    yaw,
    pitch: combat.pitch,
    jump: move.jump ?? false,
    jet: move.jet ?? false,
    fire: combat.fire,
    altFire: false,
    slot: 0,
    packActive: false,
    // Real PlayerInput.use is a required field (M5, packages/sim/src/types.ts:23). Never a
    // queued wire message -- see Global Constraints on why mounting is a PlayerInput bit,
    // not a direct sim call: shouldUseVehicle re-checks range/occupancy fresh every tick and
    // stepVehicles itself edge-detects the bit, so holding this true for several consecutive
    // ticks still mounts exactly once, the same as a human holding E.
    use: shouldUseVehicle(world, runtime, runtime.playerId),
  };
}

export function stepBots(
  world: World,
  graph: WaypointGraph,
  runtimes: Map<number, BotRuntimeState>,
): Map<number, PlayerInput> {
  const inputs = new Map<number, PlayerInput>();
  for (const [botId, runtime] of runtimes) {
    if (!world.players.active[botId] || !world.players.alive[botId]) continue;
    inputs.set(botId, stepBot(world, graph, runtime));
  }
  return inputs;
}
