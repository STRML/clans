import {
  armorFor,
  BaseObjectKind,
  hasLineOfSight,
  playerHitbox,
  type BaseObjectStore,
  type World,
} from '@clans/sim';

export const VISION_RANGE = 150; // Ours.
export const LOW_HEALTH_FRACTION = 0.4; // Ours.
export const LOW_ENERGY_FRACTION = 0.3; // Ours.
const MUZZLE_HEIGHT = 1.6; // weapons.ts's own constant, restated here to avoid a circular
// re-export dependency on weapons.ts internals -- the value is cited, not picked; see
// weapons.ts:53.

function botEye(world: World, botId: number): { x: number; y: number; z: number } {
  const base = botId * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: (world.players.position[base + 1] ?? 0) + MUZZLE_HEIGHT,
    z: world.players.position[base + 2] ?? 0,
  };
}

/** Failure matrix row 18, real M5 behavior (projectiles.ts's isValidTarget,
 *  weapons.ts:420): a mounted player has no separate hitbox while riding a vehicle --
 *  only the vehicle can be shot. A bot with no vehicle-combat logic this milestone
 *  treats a mounted enemy as simply not there, rather than "visible" and then wasting
 *  every shot against it. */
function isEngageableEnemy(world: World, botId: number, team: number, id: number): boolean {
  if (id === botId || !world.players.active[id] || !world.players.alive[id]) return false;
  if (world.players.team[id] === team) return false;
  if (world.players.mountedVehicleId[id] !== -1) return false;
  return true;
}

export function findNearestVisibleEnemy(world: World, botId: number): number | null {
  const team = world.players.team[botId] ?? 0;
  const eye = botEye(world, botId);
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < world.players.count; id += 1) {
    if (!isEngageableEnemy(world, botId, team, id)) continue;
    const hitbox = playerHitbox(world, id, armorFor(world, id));
    const d = Math.hypot(eye.x - hitbox.center.x, eye.y - hitbox.center.y, eye.z - hitbox.center.z);
    if (d > VISION_RANGE || d >= bestDistance) continue;
    if (!hasLineOfSight(world, eye, hitbox.center)) continue;
    best = id;
    bestDistance = d;
  }
  return best;
}

export function needsHealing(world: World, botId: number): boolean {
  const armor = armorFor(world, botId);
  const health = 1 - (world.players.damage[botId] ?? 0) / armor.maxDamage;
  const energy = (world.players.energy[botId] ?? 0) / armor.maxEnergy;
  return health < LOW_HEALTH_FRACTION || energy < LOW_ENERGY_FRACTION;
}

function isUsableFriendlyStation(store: BaseObjectStore, team: number, id: number): boolean {
  if (store.kind[id] !== BaseObjectKind.StationInventory) return false;
  if (store.team[id] !== team) return false;
  if (!store.powered[id]) return false;
  if (store.destroyed[id]) return false;
  return true;
}

export function findNearestFriendlyStation(world: World, botId: number): number | null {
  const store = world.baseObjects;
  const team = world.players.team[botId] ?? 0;
  const base = botId * 3;
  const bx = world.players.position[base] ?? 0,
    bz = world.players.position[base + 2] ?? 0;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let id = 0; id < store.count; id += 1) {
    if (!isUsableFriendlyStation(store, team, id)) continue;
    const ox = store.position[id * 3] ?? 0,
      oz = store.position[id * 3 + 2] ?? 0;
    const d = Math.hypot(bx - ox, bz - oz);
    if (d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  return best;
}

export function findEscortedCarrier(world: World, team: number, selfId: number): number | null {
  for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
    if (world.flags.team[flagId] === team) continue; // only the ENEMY flag has a carrier worth escorting
    const carrierId = world.flags.carrierId[flagId];
    if (
      carrierId === undefined ||
      carrierId < 0 ||
      carrierId === selfId ||
      !world.players.active[carrierId] ||
      !world.players.alive[carrierId] ||
      world.players.team[carrierId] !== team
    ) {
      continue;
    }
    return carrierId;
  }
  return null;
}
