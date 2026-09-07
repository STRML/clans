import {
  applyLoadoutRequest,
  armorFor,
  FlagState,
  STATION_USE_RADIUS,
  type ArmorId,
  type PlayerInput,
  type Vec3,
  type WeaponId,
  type World,
} from '@clans/sim';
import { aimAndFire } from './combat.js';
import {
  findEscortedCarrier,
  findNearestFriendlyStation,
  findNearestVisibleEnemy,
  LOW_HEALTH_FRACTION,
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

/** Codex review round 1, finding (P1): `needsHealing` existed, but nothing ever routed a
 *  bot TOWARD a station -- `maybeHeal` (below) only ever healed a bot that happened to
 *  already be standing in range, so a bot at 80% damage 50 m from its own station kept
 *  chasing the enemy flag forever. The spec's own words ("backs off to a friendly
 *  inventory station when health or energy runs low") make this the bot's top priority,
 *  ahead of any CTF task -- checked here, before role branching, not folded into either
 *  role's own goal function.
 *
 *  Health only, not the full `needsHealing` (health OR energy): the milestone's own
 *  required proof (Task 11's bot-only match) is the check the plan itself names for
 *  exactly this tuning question ("a real signal to revisit brain.ts's goal priorities...
 *  before declaring this task done"), and gating this on energy too made every bot's
 *  routine uphill jetting over Katabatic (LOW_ENERGY_FRACTION's own 30% threshold drains
 *  fast against LIGHT_ARMOR's rechargeRate) trigger a full cross-map retreat, and the
 *  match produced zero kills across 5000 ticks -- verified directly, not assumed. Low
 *  energy alone is already handled gracefully without an explicit goal: slopeAssist stops
 *  offering `jet` once energy is low, so a low-energy bot just walks/skis instead, and
 *  `maybeHeal` below still tops off energy for free the moment any goal (CTF, escort, or
 *  this one) happens to walk it past a friendly station. */
function decideHealGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } | null {
  const armor = armorFor(world, runtime.playerId);
  const health = 1 - (world.players.damage[runtime.playerId] ?? 0) / armor.maxDamage;
  if (health >= LOW_HEALTH_FRACTION) return null;
  const stationId = findNearestFriendlyStation(world, runtime.playerId);
  if (stationId === null) return null;
  const base = stationId * 3;
  return {
    position: {
      x: world.baseObjects.position[base] ?? 0,
      y: world.baseObjects.position[base + 1] ?? 0,
      z: world.baseObjects.position[base + 2] ?? 0,
    },
    key: `heal:${String(stationId)}`,
  };
}

export function decideGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } {
  const healGoal = decideHealGoal(world, runtime);
  if (healGoal !== null) return healGoal;
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
): {
  yaw: number;
  pitch: number;
  fire: boolean;
  targetId: number | null;
  weaponId: WeaponId | null;
} {
  const targetId = findNearestVisibleEnemy(world, runtime.playerId);
  if (targetId === null || isOutsideDefendLeash(world, runtime, targetId)) {
    runtime.engagedTargetId = -1;
    return { yaw: runtime.aimYaw, pitch: 0, fire: false, targetId: null, weaponId: null };
  }
  const { yaw, pitch, fire, weaponId } = aimAndFire(world, runtime, runtime.playerId, targetId);
  return { yaw, pitch, fire, targetId, weaponId };
}

/** Direct sim call, not a queued wire message (Global Constraints) -- a bot server-side
 *  has no socket, and a station-use decision is a one-shot state change exactly like a
 *  human's own Loadout request, just triggered from here instead of a decoded message.
 *
 *  Codex review round 2, finding (P2): this range check used X/Z only, while the real
 *  gate (baseObjects.ts's stationAt, called internally by applyLoadoutRequest) checks
 *  full 3D distance -- see findNearestFriendlyStation's own comment (perception.ts). */
function maybeHeal(world: World, botId: number): void {
  if (!needsHealing(world, botId)) return;
  const stationId = findNearestFriendlyStation(world, botId);
  if (stationId === null) return;
  const base = botId * 3;
  const stationBase = stationId * 3;
  const dx = (world.players.position[base] ?? 0) - (world.baseObjects.position[stationBase] ?? 0);
  const dy =
    (world.players.position[base + 1] ?? 0) - (world.baseObjects.position[stationBase + 1] ?? 0);
  const dz =
    (world.players.position[base + 2] ?? 0) - (world.baseObjects.position[stationBase + 2] ?? 0);
  if (Math.hypot(dx, dy, dz) > STATION_USE_RADIUS) return;
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
    // Codex review round 2, finding (P2): chooseWeapon (combat.ts) picked a real weapon by
    // range, but stepBot always sent slot: 0 ("no change" -- weapons.ts's own applySlot),
    // so every bot fired whatever it happened to already have equipped (the Blaster,
    // never switched away from at spawn) regardless of what combat.ts decided. weaponIdForSlot's
    // own inverse (slot = weaponId + 1, since slot 0 means "no change" and slots 1-5 map to
    // WeaponId 0-4) is the same mapping a human's weapon-select key press uses. No target
    // -> 0 (no change): weapon choice is only meaningful relative to an engagement distance.
    slot: combat.weaponId !== null ? combat.weaponId + 1 : 0,
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
