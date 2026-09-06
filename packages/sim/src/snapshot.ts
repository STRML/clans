import { LIGHT_ARMOR } from './armor.js';
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
    health: LIGHT_ARMOR.maxDamage - num(p.damage, id),
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
  players.damage[data.id] = LIGHT_ARMOR.maxDamage - data.health;
  players.alive[data.id] = data.health > 0 ? 1 : 0;
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
}
