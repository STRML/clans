import { ARMORS, ArmorId, type ArmorData } from './armor.js';
import { buildInteriorCollider, type InteriorInstance } from './interiors.js';
import type { Vec3, World } from './types.js';
import { resetLoadout } from './weapons.js';

export enum BaseObjectKind {
  Generator = 0,
  Sensor = 1,
  StationInventory = 2,
  StationVehiclePad = 3,
  ForceField = 4,
}

export interface BaseObjectData {
  maxHealth: number;
  maxEnergy: number;
  energyPerDamagePoint: number;
  rechargeRate: number;
  /** Generators and (per script) the vehicle pad never lose power themselves; every other
   *  kind goes offline the instant its team has no living generator. */
  needsPower: boolean;
  /** StationVehiclePad and ForceField only: `station.cs:235-247` sets `isInvincible = true`
   *  with no `maxDamage` field at all for the pad — the real T2 datablock cannot be
   *  destroyed by weapons fire. `ForceFieldBareData` (`forceField.cs:10-33`) has no
   *  `energy`/`maxDamage`/`invincib*` field of any kind, confirmed by a full-file grep —
   *  there is nothing to damage in the first place, so this plan treats it the same way.
   *  Both are genuine deviations from the spec's own Base asset numbers table, which lists
   *  them in the same damageable-asset row shape as everything else; see this plan's Spec
   *  gaps. */
  invincible: boolean;
  /** Sensor only. */
  detectRadius: number;
}

export const BASE_OBJECT_DATA: Record<BaseObjectKind, BaseObjectData> = {
  // staticShape.cs:447-467. Spec's Base asset numbers table: maxDamage 1.50, energyPerDamagePoint 30.
  [BaseObjectKind.Generator]: {
    maxHealth: 1.5,
    maxEnergy: 50,
    energyPerDamagePoint: 30,
    rechargeRate: 0.05,
    needsPower: false,
    invincible: false,
    detectRadius: 0,
  },
  // staticShape.cs:342-372 (StaticShapeData) + staticShape.cs:331-340 (SensorLgPulseObj).
  // Spec: maxDamage 1.50, energyPerDamagePoint 33, detectRadius 300 m.
  [BaseObjectKind.Sensor]: {
    maxHealth: 1.5,
    maxEnergy: 110,
    energyPerDamagePoint: 33,
    rechargeRate: 0.31,
    needsPower: true,
    invincible: false,
    detectRadius: 300,
  },
  // station.cs:136-166. Spec cites "from station.cs" with no number; every field here is
  // read straight out of the script.
  [BaseObjectKind.StationInventory]: {
    maxHealth: 1.0,
    maxEnergy: 50,
    energyPerDamagePoint: 75,
    rechargeRate: 0.35,
    needsPower: true,
    invincible: false,
    detectRadius: 0,
  },
  // station.cs:235-247: isInvincible = true, no maxDamage/isShielded fields at all.
  [BaseObjectKind.StationVehiclePad]: {
    maxHealth: 0,
    maxEnergy: 0,
    energyPerDamagePoint: 0,
    rechargeRate: 0.05,
    needsPower: true,
    invincible: true,
    detectRadius: 0,
  },
  // forceField.cs:10-33, 151-186, 213-236: no energy/maxDamage field; power is inherited
  // generically through StaticShapeData::gainPower/losePower, the same power-grid callback
  // every other poweredStaticShape uses. Spec: "ForceFieldBare — team-passable" (no number).
  [BaseObjectKind.ForceField]: {
    maxHealth: 0,
    maxEnergy: 0,
    energyPerDamagePoint: 0,
    rechargeRate: 0,
    needsPower: true,
    invincible: true,
    detectRadius: 0,
  },
};

export const STATION_USE_RADIUS = 2.5; // Ours — see this plan's "ours" numbers table.

export interface BaseObjectStore {
  count: number;
  kind: Uint8Array;
  team: Uint8Array;
  position: Float64Array;
  damage: Float64Array;
  destroyed: Uint8Array;
  energy: Float64Array;
  powered: Uint8Array;
}

const BASE_OBJECT_CAPACITY = 64; // Ours: Katabatic's real count is 28 (26 plus 2 force fields); headroom for other maps.

export function createEmptyBaseObjects(): BaseObjectStore {
  return {
    count: 0,
    kind: new Uint8Array(BASE_OBJECT_CAPACITY),
    team: new Uint8Array(BASE_OBJECT_CAPACITY),
    position: new Float64Array(BASE_OBJECT_CAPACITY * 3),
    damage: new Float64Array(BASE_OBJECT_CAPACITY),
    destroyed: new Uint8Array(BASE_OBJECT_CAPACITY),
    energy: new Float64Array(BASE_OBJECT_CAPACITY),
    powered: new Uint8Array(BASE_OBJECT_CAPACITY),
  };
}

export interface ForceFieldGeometry {
  baseObjectId: number;
  team: number;
  /** A cached two-triangle quad, built once here and reused by every later query — a real
   *  `PhysicalZone` in T2 is a solid polyhedron (`forceField.cs:242-252`), but a thin quad at
   *  the field's own plane is enough for a browser demo's block-and-render needs and reuses
   *  Task 2's already-tested `raycastInteriors`/`resolveSphereAgainstInteriors` verbatim. */
  instance: InteriorInstance;
}

/** A quad centered at the origin in the field's own local space, facing local +X (matching
 *  how the mission's own rotation already orients the placement) — `scale.z`/`scale.y` give
 *  its half-width/half-height (Torque Y-up scale: `scale.x` is thickness, unused here). */
function forceFieldQuad(scale: Vec3): { positions: Float32Array } {
  const hw = scale.z / 2 || 3; // Ours fallback if a placement omits scale — see "ours" table.
  const hh = scale.y / 2 || 2;
  return {
    positions: new Float32Array([
      0,
      -hh,
      -hw,
      0,
      hh,
      -hw,
      0,
      hh,
      hw,
      0,
      -hh,
      -hw,
      0,
      hh,
      hw,
      0,
      -hh,
      hw,
    ]),
  };
}

export function createBaseObjects(
  world: World,
  placements: Array<{
    kind: BaseObjectKind;
    team: number;
    position: Vec3;
    rotation?: { axis: Vec3; degrees: number };
    scale?: Vec3;
  }>,
): void {
  const store = world.baseObjects;
  placements.forEach(({ kind, team, position, rotation, scale }, id) => {
    if (id >= BASE_OBJECT_CAPACITY) throw new RangeError('Base object capacity exceeded');
    store.kind[id] = kind;
    store.team[id] = team;
    store.position.set([position.x, position.y, position.z], id * 3);
    store.damage[id] = 0;
    store.destroyed[id] = 0;
    store.energy[id] = BASE_OBJECT_DATA[kind].maxEnergy;
    store.powered[id] = 1;
    store.count = Math.max(store.count, id + 1);
    if (kind === BaseObjectKind.ForceField) {
      const instance = buildInteriorCollider(forceFieldQuad(scale ?? { x: 1, y: 4, z: 6 }), {
        position,
        rotation: rotation ?? { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
      });
      world.forceFields.push({ baseObjectId: id, team, instance });
    }
  });
}

/** Every powered, non-destroyed force field belonging to a team other than `forTeam` —
 *  Task 5 calls this once per shooter team before resolving a projectile segment, and Task 6
 *  calls it once per player team inside `stepPlayer`'s movement resolution. Spec: "ForceFieldBare
 *  — team-passable." Ours: this is a real deviation from the literal T2 script, which kills
 *  every player who touches `defaultForceFieldBare` regardless of team (`forceField.cs:175-178`,
 *  `killAllPlayersWithinZone` called with no `%team` argument so its own team check never
 *  short-circuits) — see this plan's Spec gaps and "ours" table. */
export function activeForceFieldBlockers(world: World, forTeam: number): InteriorInstance[] {
  const store = world.baseObjects;
  return world.forceFields
    .filter(
      (f) =>
        f.team !== forTeam &&
        store.powered[f.baseObjectId] === 1 &&
        !store.destroyed[f.baseObjectId],
    )
    .map((f) => f.instance);
}

/** A generator counts toward its team's power as long as it exists and is not destroyed —
 *  the sim never removes a base object once placed, so "exists" is just `id < count`. */
export function teamHasPower(world: World, team: number): boolean {
  const store = world.baseObjects;
  for (let id = 0; id < store.count; id += 1) {
    if (
      store.kind[id] === BaseObjectKind.Generator &&
      store.team[id] === team &&
      !store.destroyed[id]
    ) {
      return true;
    }
  }
  return false;
}

/** Spec: "a base is powered while at least one of its generators is alive. Unpowered
 *  inventory stations, vehicle pads, base turrets, sensors, and force fields go offline."
 *  Generators never depend on power themselves (`needsPower: false`), so this only ever
 *  clears the bit on the *other* kinds — see `BASE_OBJECT_DATA`'s `needsPower` field, which
 *  Task 4's turret power also reads. */
export function stepPower(world: World): void {
  const store = world.baseObjects;
  const teamPower = new Map<number, boolean>();
  for (let id = 0; id < store.count; id += 1) {
    const data = BASE_OBJECT_DATA[store.kind[id] as BaseObjectKind];
    if (!data.needsPower) {
      store.powered[id] = 1;
      continue;
    }
    const team = store.team[id] ?? 0;
    if (!teamPower.has(team)) teamPower.set(team, teamHasPower(world, team));
    store.powered[id] = teamPower.get(team) ? 1 : 0;
  }
}

/** Same shielded-damage rule the spec states for players: "shields ... spend energy at
 *  energyPerDamagePoint before health." An invincible object (StationVehiclePad) ignores
 *  every hit outright — see `BaseObjectData.invincible`'s own comment. */
export function applyBaseObjectDamage(world: World, id: number, amount: number): void {
  const store = world.baseObjects;
  const data = BASE_OBJECT_DATA[store.kind[id] as BaseObjectKind];
  if (data.invincible || amount <= 0 || store.destroyed[id]) return;
  const energy = store.energy[id] ?? 0;
  const shieldCapacity = data.energyPerDamagePoint > 0 ? energy / data.energyPerDamagePoint : 0;
  const shieldAbsorbed = Math.min(shieldCapacity, amount);
  store.energy[id] = energy - shieldAbsorbed * data.energyPerDamagePoint;
  const throughShield = amount - shieldAbsorbed;
  if (throughShield <= 0) return;
  store.damage[id] = (store.damage[id] ?? 0) + throughShield;
  if ((store.damage[id] ?? 0) >= data.maxHealth) store.destroyed[id] = 1;
}

function positionAt(arr: Float64Array, base: number): Vec3 {
  return { x: arr[base] ?? 0, y: arr[base + 1] ?? 0, z: arr[base + 2] ?? 0 };
}

function distanceVec(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The id of a powered `StationInventory` belonging to the player's own team within
 *  `STATION_USE_RADIUS`, or `null`. Never an enemy station (a real trigger in T2 is
 *  per-object anyway, but the sim also never wants a player "using" an enemy station to
 *  even be representable) and never an unpowered one (failure matrix row 4). */
export function stationAt(world: World, playerId: number): number | null {
  const store = world.baseObjects;
  const playerPos = positionAt(world.players.position, playerId * 3);
  const team = world.players.team[playerId] ?? 0;
  for (let id = 0; id < store.count; id += 1) {
    if (store.kind[id] !== BaseObjectKind.StationInventory) continue;
    // Codex round 1, finding 5: `powered` and `destroyed` are independent bits -- stepPower
    // derives `powered` purely from the TEAM's generator state, never from this object's own
    // `destroyed` flag, so a destroyed-but-still-"powered" station (its team's generator is
    // still alive) passed this check and stayed usable after being blown up.
    if (store.team[id] !== team || !store.powered[id] || store.destroyed[id]) continue;
    const stationPos = positionAt(store.position, id * 3);
    if (distanceVec(playerPos, stationPos) <= STATION_USE_RADIUS) return id;
  }
  return null;
}

/**
 * The one place a player's armor and Repair Pack choice actually change -- called directly by
 * server/net.ts's Loadout handler and by the client's single-player equivalent, never
 * threaded through PlayerInput/stepWorld (this is a one-shot request, not per-tick state,
 * matching how `setGodMode` already works). Re-checks `stationAt` at call time rather than
 * trusting an earlier "in range" result, which is what makes failure matrix row 4 true for
 * free: a request that arrives the same tick power drops (or after the player already walked
 * away) simply finds no station and returns false, leaving every field of the player's
 * current loadout untouched.
 */
/**
 * Codex round 1, finding 1: writes a decoded snapshot's DYNAMIC base-object fields
 * (damage/destroyed/powered) onto the store by id, growing `store.count` to fit an id that's
 * never been locally placed yet -- mirrors sim/snapshot.ts's `deserializePlayer`/`growTo` for
 * players. Static placement (kind/team/position) is never on the wire and doesn't need to be:
 * app.ts seeds it once from the same shared scene asset data the server's own
 * `loadKatabaticWorld` places objects from, in the same array order, so ids already line up
 * before the first snapshot ever arrives -- only the server-authoritative dynamic fields
 * need to travel over the wire and land here on every snapshot a NetClient decodes.
 */
export function applyBaseObjectSnapshot(
  world: World,
  data: { id: number; damage: number; destroyed: 0 | 1; powered: 0 | 1 },
): void {
  const store = world.baseObjects;
  if (data.id >= BASE_OBJECT_CAPACITY) return;
  if (data.id >= store.count) store.count = data.id + 1;
  store.damage[data.id] = data.damage;
  store.destroyed[data.id] = data.destroyed;
  store.powered[data.id] = data.powered;
}

export function applyLoadoutRequest(
  world: World,
  playerId: number,
  armor: ArmorId,
  repairPack: boolean,
): boolean {
  // decodeLoadout (protocol/handshake.ts) reads this straight off an untrusted wire byte, so
  // it can carry any u8 (0-255), not just a real ArmorId (0-2). ARMORS[armor] below is undefined
  // for anything out of range, and the caller (server/net.ts's handleLoadout) has no catch of
  // its own -- an invalid byte used to throw straight past applyLoadoutRequest's ability to
  // return false, poisoning the player's armor field with the raw invalid value before the
  // throw (players.armor[playerId] = armor ran first) and getting silently swallowed by the
  // server's own message-handler try/catch. Reject it here, before any state changes.
  if (!(armor in ARMORS)) return false;
  if (stationAt(world, playerId) === null) return false;
  const players = world.players;
  const data: ArmorData = ARMORS[armor];
  players.armor[playerId] = armor;
  players.damage[playerId] = 0;
  players.energy[playerId] = data.maxEnergy;
  players.hasRepairPack[playerId] = repairPack ? 1 : 0;
  resetLoadout(world, playerId, data);
  return true;
}
