import { MOUNT_RANGE, type Vec3, type VehicleStore, type World } from '@clans/sim';
import type { BotRuntimeState } from './types.js';

/** Real M5 mount is permissive about team (vehicles.ts's own findUnoccupiedVehicleInRange
 *  has no team check at all -- any player can mount any unoccupied vehicle). Bots
 *  deliberately narrow this to the bot's own team: the same "don't exploit unintended
 *  permissiveness" policy Global Constraints already states for spawnVehicleAtPad, applied
 *  here to mounting instead of spawning. This is a bot policy choice, not a sim rule. */
function isUsableByTeam(store: VehicleStore, vehicleId: number, team: number): boolean {
  return (
    store.active[vehicleId] === 1 &&
    store.destroyed[vehicleId] === 0 &&
    store.driverId[vehicleId] === -1 &&
    store.team[vehicleId] === team
  );
}

/** Codex review round 1, finding: real mounting (sim/vehicles.ts's own
 *  findUnoccupiedVehicleInRange) checks full 3D distance
 *  (`Math.hypot(dx, dy, dz)` against `minMountDist`), not a horizontal-only one -- a
 *  same-team vehicle directly above or below a bot (a cliff edge, a ledge) previously read
 *  as "in range" here on X/Z alone while the real mount check in stepVehicles kept
 *  rejecting it, leaving the bot stuck holding `use: true` at a vehicle goal that could
 *  never actually resolve. */
function distance3D(world: World, botId: number, vehicleId: number): number {
  const base = botId * 3;
  const vBase = vehicleId * 3;
  const dx = (world.players.position[base] ?? 0) - (world.vehicles.position[vBase] ?? 0);
  const dy = (world.players.position[base + 1] ?? 0) - (world.vehicles.position[vBase + 1] ?? 0);
  const dz = (world.players.position[base + 2] ?? 0) - (world.vehicles.position[vBase + 2] ?? 0);
  return Math.hypot(dx, dy, dz);
}

export function findMountableVehicle(world: World, botId: number): number | null {
  const store = world.vehicles;
  const team = world.players.team[botId] ?? 0;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < store.count; id += 1) {
    if (!isUsableByTeam(store, id, team)) continue;
    const d = distance3D(world, botId, id);
    if (d <= MOUNT_RANGE && d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  return best;
}

/** Only ever offered as a fallback goal, checked by brain.ts AFTER every CTF priority
 *  (carry home, chase enemy flag, recover own flag, escort a carrier) comes up empty --
 *  a bot never abandons an active CTF task to go joyride a vehicle. See Task 6's
 *  decideGoal and this task's own note in Global Constraints about bots never spawning
 *  a vehicle themselves, only mounting one that already exists. */
export function decideVehicleGoal(
  world: World,
  runtime: BotRuntimeState,
): { position: Vec3; key: string } | null {
  const vehicleId = findMountableVehicle(world, runtime.playerId);
  if (vehicleId === null) return null;
  const base = vehicleId * 3;
  return {
    position: {
      x: world.vehicles.position[base] ?? 0,
      y: world.vehicles.position[base + 1] ?? 0,
      z: world.vehicles.position[base + 2] ?? 0,
    },
    key: `vehicle:${String(vehicleId)}`,
  };
}

/** Feeds Task 6's composeInput: true only once the bot's CURRENT goal is a vehicle goal
 *  (never sent opportunistically just because a vehicle happens to be nearby -- a bot
 *  only presses "E" on the vehicle it actually walked toward) and it is still within
 *  MOUNT_RANGE and still unoccupied by the time the bot arrives -- re-checked fresh every
 *  call, not cached from when the goal was set, so a vehicle taken by a teammate (or
 *  destroyed) in the interim is simply not mounted. Real stepVehicles (vehicles.ts) does
 *  the actual mounting off this bit exactly as it does for a human holding E; this
 *  function only decides whether to send it. */
function vehicleGoalId(goalKey: string | null, vehicleCount: number): number | null {
  if (goalKey === null || !goalKey.startsWith('vehicle:')) return null;
  const vehicleId = Number(goalKey.slice('vehicle:'.length));
  if (Number.isNaN(vehicleId) || vehicleId < 0 || vehicleId >= vehicleCount) return null;
  return vehicleId;
}

export function shouldUseVehicle(world: World, runtime: BotRuntimeState, botId: number): boolean {
  const store = world.vehicles;
  const vehicleId = vehicleGoalId(runtime.goalKey, store.count);
  if (vehicleId === null) return false;
  const team = world.players.team[botId] ?? 0;
  if (!isUsableByTeam(store, vehicleId, team)) return false;
  return distance3D(world, botId, vehicleId) <= MOUNT_RANGE;
}
