import { ARMORS, armorFor, type ArmorId } from './armor.js';
import type { PlayerStore, World } from './types.js';
import { ammoIndex, WeaponId } from './weapons.js';

export interface PlayerSnapshotData {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  energy: number;
  health: number;
  weaponSlot: number;
  onGround: 0 | 1;
  ski: 0 | 1;
  /** See PlayerStore.respawnSeq (types.ts) -- the authoritative "a respawn just happened"
   *  wire signal a client compares against what the previous snapshot reported. */
  respawnSeq: number;
  /**
   * The three finite ammo pools (PlayerStore.ammo, indexed via weapons.ts's ammoIndex) --
   * the Laser Rifle and Blaster are never sent, since their ammo is permanently -1
   * (infinite, gated by energy only) and never changes. Wired onto the snapshot so
   * reconciliation has an authoritative value to correct client-side prediction against on
   * every snapshot, not just at respawn -- see netclient.ts's reconcile/deserializePlayer.
   * Codex review round 10 (PR #9), finding 1.
   */
  discAmmo: number;
  chaingunAmmo: number;
  mortarAmmo: number;
  /** PlayerStore.grenades -- same self-heal rationale as the ammo fields above. */
  grenades: number;
  /**
   * PlayerStore.weaponState/weaponTimer/spunUp -- the fire-eligibility state MACHINE
   * itself (weapons.ts's stepWeapons/WeaponState), as opposed to the ammo counts above.
   * Round 10 wired ammo so a lost fire input's ammo drift self-heals within one snapshot,
   * but left this machine off the wire entirely: a client whose locally-predicted shot
   * never landed server-side could get its ammo corrected back up while staying stuck in
   * a stale Firing state, and stepWeapons only allows firing from Ready/NoAmmo -- so the
   * player's next real fire attempt was silently suppressed for up to a full fire-cycle
   * duration even with full ammo. Codex review round 11 (PR #9).
   */
  weaponState: number;
  weaponTimer: number;
  spunUp: 0 | 1;
  /**
   * PlayerStore.grenadeCooldown -- the grenade throw's own little state machine (a 1 s
   * cooldown gate in weapons.ts's tryThrowGrenade), a sibling to weaponState/weaponTimer/
   * spunUp above but never wired onto the snapshot when those were (round 11). Round 10's
   * ammo fix self-heals the grenade COUNT after a lost altFire input, but left this cooldown
   * timer stuck at its locally-predicted value: the player's next real altFire attempt
   * within that stale window was silently suppressed even though the server -- which never
   * actually saw the throw -- would have allowed it. Codex review round 12 (PR #9).
   */
  grenadeCooldown: number;
  /**
   * PlayerStore.score -- signed (suicide/team-kill scoring in damage.ts can drive it
   * negative). Round 13's hashWorld/mixPlayer already mixed this in, but it was never
   * actually wired onto PlayerSnapshotData/writePlayerFull/serializePlayer, so a
   * decoded/reconstructed player always came back with score 0 regardless of the source's
   * real value -- hashWorld on the two worlds diverged even though the wire faithfully
   * transmitted everything it actually carried. Codex review round 14 (PR #9), finding 1.
   */
  score: number;
  /** PlayerStore.godMode -- same gap and same fix as score above: round 13 hashed it,
   *  round 14 wires it. Also the authoritative correction netclient.ts's reconcile applies
   *  on every snapshot for the networked god-mode fix (see netclient.ts's setGodMode,
   *  Codex review round 14, finding 2). */
  godMode: 0 | 1;
  /** PlayerStore.armor (ArmorId) -- see armor.ts's armorFor for why every per-player
   *  calculation reads this instead of a hardcoded constant. */
  armor: number;
  /** PlayerStore.hasRepairPack -- the only pack modeled this milestone (Task 6). */
  hasRepairPack: 0 | 1;
  /**
   * PlayerStore.wasJumpHeld -- movement.ts's jumpEdge check
   * (`input.jump && (!players.wasJumpHeld[id] || !players.wasGrounded[id])`) reads this to
   * tell a freshly-pressed jump apart from a continuously-held one. It was never wired onto
   * the snapshot, so netclient.ts's reconcile() hardcoded it to 0 after every snapshot --
   * "treat the jump key as freshly pressed" -- which is wrong whenever the LOCAL player is
   * actually holding jump/jet across the snapshot boundary: the very next replayed input
   * then looks like a fresh press and triggers an extra jump impulse the server never
   * produced, a real misprediction. wasGrounded stays off the wire deliberately (its
   * onGround-as-proxy approximation in reconcile() already works and is not this finding).
   * Codex review round 15 (PR #9), finding 1.
   */
  wasJumpHeld: 0 | 1;
}

function num(arr: Float64Array | Uint8Array | Uint16Array | Int16Array, i: number): number {
  return arr[i] ?? 0;
}

function bit(arr: Uint8Array, i: number): 0 | 1 {
  return num(arr, i) ? 1 : 0;
}

export function serializePlayer(world: World, id: number): PlayerSnapshotData {
  const p = world.players;
  const base = id * 3;
  return {
    id,
    team: num(p.team, id),
    x: num(p.position, base),
    y: num(p.position, base + 1),
    z: num(p.position, base + 2),
    vx: num(p.velocity, base),
    vy: num(p.velocity, base + 1),
    vz: num(p.velocity, base + 2),
    yaw: num(p.yaw, id),
    energy: num(p.energy, id),
    health: armorFor(world, id).maxDamage - num(p.damage, id),
    weaponSlot: num(p.weaponSlot, id),
    onGround: bit(p.onGround, id),
    ski: bit(p.ski, id),
    respawnSeq: num(p.respawnSeq, id),
    discAmmo: num(p.ammo, ammoIndex(id, WeaponId.Spinfusor)),
    chaingunAmmo: num(p.ammo, ammoIndex(id, WeaponId.Chaingun)),
    mortarAmmo: num(p.ammo, ammoIndex(id, WeaponId.Mortar)),
    grenades: num(p.grenades, id),
    weaponState: num(p.weaponState, id),
    weaponTimer: num(p.weaponTimer, id),
    spunUp: bit(p.spunUp, id),
    grenadeCooldown: num(p.grenadeCooldown, id),
    score: num(p.score, id),
    godMode: bit(p.godMode, id),
    armor: num(p.armor, id),
    hasRepairPack: bit(p.hasRepairPack, id),
    wasJumpHeld: bit(p.wasJumpHeld, id),
  };
}

export function serializeActivePlayers(world: World): PlayerSnapshotData[] {
  const out: PlayerSnapshotData[] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (world.players.active[id]) out.push(serializePlayer(world, id));
  }
  return out;
}

function growTo(players: PlayerStore, id: number): void {
  if (id >= players.energy.length)
    throw new RangeError(`Player id ${String(id)} exceeds store capacity`);
  while (players.count <= id) {
    players.active[players.count] = 0;
    players.count += 1;
  }
}

/** Writes a snapshot into its own id slot, growing the store if the id has not been seen yet. */
export function deserializePlayer(world: World, data: PlayerSnapshotData): void {
  const players = world.players;
  growTo(players, data.id);
  players.active[data.id] = 1;
  players.team[data.id] = data.team;
  players.position.set([data.x, data.y, data.z], data.id * 3);
  players.velocity.set([data.vx, data.vy, data.vz], data.id * 3);
  players.yaw[data.id] = data.yaw;
  players.energy[data.id] = data.energy;
  players.armor[data.id] = data.armor;
  players.hasRepairPack[data.id] = data.hasRepairPack;
  players.damage[data.id] = ARMORS[data.armor as ArmorId].maxDamage - data.health;
  players.alive[data.id] = data.health > 0 ? 1 : 0;
  // A live decoded player is never due for a respawn. `respawnAt` isn't itself on the wire
  // (a dead player's local countdown is set separately, see netclient.ts's death detection),
  // but leaving it at the typed array's raw zero-init (rather than addPlayer's -1 "not
  // scheduled" sentinel) desynced hashWorld's now-full-state hash from a freshly addPlayer'd
  // world with no wire round trip at all -- Codex review round 13 (PR #9).
  if (players.alive[data.id]) players.respawnAt[data.id] = -1;
  players.weaponSlot[data.id] = data.weaponSlot;
  players.onGround[data.id] = data.onGround;
  players.ski[data.id] = data.ski;
  players.respawnSeq[data.id] = data.respawnSeq;
  players.ammo[ammoIndex(data.id, WeaponId.Spinfusor)] = data.discAmmo;
  players.ammo[ammoIndex(data.id, WeaponId.Chaingun)] = data.chaingunAmmo;
  players.ammo[ammoIndex(data.id, WeaponId.Mortar)] = data.mortarAmmo;
  players.grenades[data.id] = data.grenades;
  players.weaponState[data.id] = data.weaponState;
  players.weaponTimer[data.id] = data.weaponTimer;
  players.spunUp[data.id] = data.spunUp;
  players.grenadeCooldown[data.id] = data.grenadeCooldown;
  players.score[data.id] = data.score;
  players.godMode[data.id] = data.godMode;
  players.wasJumpHeld[data.id] = data.wasJumpHeld;
}

/** The wire shape of one vehicle. Unlike base objects/turrets, vehicles have no mission-file
 *  placement to pre-seed from -- Katabatic's .mis places only the pad, never a vehicle --
 *  every field here is genuinely dynamic, including `kind`/`team`, which for a base object or
 *  turret would be static placement data never carried on the wire at all. `energy` is
 *  included deliberately (unlike BaseObjectSnapshotData/TurretSnapshotData, which omit it,
 *  issue #14): a vehicle's shield depletion needs to reach the client the same way its
 *  health does. */
/**
 * Codex review round 1 (this PR), finding 4: vx/vy/vz, angVelYaw/Pitch/Roll, padId,
 * weaponTimer, onGround, and wasJumpHeld were all real VehicleStore state hashWorld's own
 * mixVehicle already covers -- state stepVehicles mutates every tick and depends on to
 * decide next tick's behavior -- but none of them reached the wire. A client reconstructing
 * a vehicle purely from the fields above got a physically frozen snapshot: zero velocity/
 * angular velocity every tick regardless of the vehicle's actual motion, which starved the
 * mounted driver's own client-side prediction replay (reconcile() in netclient.ts) of the
 * one thing it most needs to continue simulating from -- and would have desynced hashWorld
 * against a decoded world the instant any vehicle was moving.
 */
export interface VehicleSnapshotData {
  id: number;
  kind: number;
  team: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  roll: number;
  angVelYaw: number;
  angVelPitch: number;
  angVelRoll: number;
  energy: number;
  damage: number;
  destroyed: 0 | 1;
  driverId: number;
  padId: number;
  weaponTimer: number;
  onGround: 0 | 1;
  wasJumpHeld: 0 | 1;
}

export function serializeVehicle(world: World, id: number): VehicleSnapshotData {
  const v = world.vehicles;
  const base = id * 3;
  return {
    id,
    kind: num(v.kind, id),
    team: num(v.team, id),
    x: num(v.position, base),
    y: num(v.position, base + 1),
    z: num(v.position, base + 2),
    vx: num(v.velocity, base),
    vy: num(v.velocity, base + 1),
    vz: num(v.velocity, base + 2),
    yaw: num(v.yaw, id),
    pitch: num(v.pitch, id),
    roll: num(v.roll, id),
    angVelYaw: num(v.angVel, base),
    angVelPitch: num(v.angVel, base + 1),
    angVelRoll: num(v.angVel, base + 2),
    energy: num(v.energy, id),
    damage: num(v.damage, id),
    destroyed: bit(v.destroyed, id),
    driverId: num(v.driverId, id),
    padId: num(v.padId, id),
    weaponTimer: num(v.weaponTimer, id),
    onGround: bit(v.onGround, id),
    wasJumpHeld: bit(v.wasJumpHeld, id),
  };
}

export function serializeActiveVehicles(world: World): VehicleSnapshotData[] {
  const out: VehicleSnapshotData[] = [];
  for (let id = 0; id < world.vehicles.count; id += 1) {
    if (world.vehicles.active[id]) out.push(serializeVehicle(world, id));
  }
  return out;
}

/**
 * Writes a decoded snapshot's vehicle fields onto `world.vehicles` by id, growing the store
 * to fit -- the vehicle sibling of `deserializePlayer`'s own `growTo`, but for vehicles this
 * is not a rare "id we've never locally placed" fallback: because there is no mission-file
 * placement to pre-seed from (see this interface's own doc comment), `deserializeVehicle` is
 * the ONLY path a client-side vehicle id is ever created. Every field, including `kind`/
 * `team`, is written every call rather than assumed already-seeded.
 */
export function deserializeVehicle(world: World, data: VehicleSnapshotData): void {
  const v = world.vehicles;
  if (data.id >= v.active.length) return;
  if (data.id >= v.count) v.count = data.id + 1;
  v.active[data.id] = 1;
  v.kind[data.id] = data.kind;
  v.team[data.id] = data.team;
  v.position.set([data.x, data.y, data.z], data.id * 3);
  v.velocity.set([data.vx, data.vy, data.vz], data.id * 3);
  v.yaw[data.id] = data.yaw;
  v.pitch[data.id] = data.pitch;
  v.roll[data.id] = data.roll;
  v.angVel.set([data.angVelYaw, data.angVelPitch, data.angVelRoll], data.id * 3);
  v.energy[data.id] = data.energy;
  v.damage[data.id] = data.damage;
  v.destroyed[data.id] = data.destroyed;
  v.driverId[data.id] = data.driverId;
  v.padId[data.id] = data.padId;
  v.weaponTimer[data.id] = data.weaponTimer;
  v.onGround[data.id] = data.onGround;
  v.wasJumpHeld[data.id] = data.wasJumpHeld;
}
