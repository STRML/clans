import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import {
  addPlayer,
  createWorld,
  deserializePlayer,
  removePlayer,
  respawnPlayer,
  serializeActivePlayers,
  serializePlayer,
  type Heightfield,
} from './index.js';
import { ammoIndex, WeaponId, WeaponState } from './weapons.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('player snapshots', () => {
  it('serializes only what the protocol needs', () => {
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 }, 1);
    world.players.velocity.set([4, 5, 6], id * 3);
    world.players.yaw[id] = 0.5;
    world.players.energy[id] = 40;
    world.players.onGround[id] = 1;
    expect(serializePlayer(world, id)).toEqual({
      id,
      team: 1,
      x: 1,
      y: 2,
      z: 3,
      vx: 4,
      vy: 5,
      vz: 6,
      yaw: 0.5,
      energy: 40,
      health: LIGHT_ARMOR.maxDamage,
      weaponSlot: WeaponId.Blaster,
      onGround: 1,
      ski: 0,
      respawnSeq: 0,
      discAmmo: LIGHT_ARMOR.discAmmo,
      chaingunAmmo: LIGHT_ARMOR.chaingunAmmo,
      mortarAmmo: LIGHT_ARMOR.mortarAmmo,
      grenades: LIGHT_ARMOR.grenadeCount,
      weaponState: WeaponState.Ready,
      weaponTimer: 0,
      spunUp: 0,
      grenadeCooldown: 0,
      score: 0,
      godMode: 0,
      wasJumpHeld: 0,
    });
  });

  it('serializes only active players', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    addPlayer(world, { x: 1, y: 0, z: 0 });
    removePlayer(world, a);
    expect(serializeActivePlayers(world).map((p) => p.id)).toEqual([1]);
  });

  it('deserializes back into an equivalent player, growing the store if needed', () => {
    const world = createWorld(terrain, 1);
    deserializePlayer(world, {
      id: 3,
      team: 2,
      x: 9,
      y: 0,
      z: 9,
      vx: 1,
      vy: 0,
      vz: 0,
      yaw: 1,
      energy: 30,
      health: LIGHT_ARMOR.maxDamage,
      weaponSlot: WeaponId.Blaster,
      onGround: 0,
      ski: 1,
      respawnSeq: 2,
      discAmmo: 9,
      chaingunAmmo: 50,
      mortarAmmo: 4,
      grenades: 3,
      weaponState: WeaponState.Reload,
      weaponTimer: 0.35,
      spunUp: 1,
      grenadeCooldown: 0.6,
      score: -3,
      godMode: 1,
      wasJumpHeld: 1,
    });
    expect(world.players.count).toBe(4);
    expect(world.players.active[3]).toBe(1);
    expect(serializePlayer(world, 3)).toEqual({
      id: 3,
      team: 2,
      x: 9,
      y: 0,
      z: 9,
      vx: 1,
      vy: 0,
      vz: 0,
      yaw: 1,
      energy: 30,
      health: LIGHT_ARMOR.maxDamage,
      weaponSlot: WeaponId.Blaster,
      onGround: 0,
      ski: 1,
      respawnSeq: 2,
      discAmmo: 9,
      chaingunAmmo: 50,
      mortarAmmo: 4,
      grenades: 3,
      weaponState: WeaponState.Reload,
      weaponTimer: 0.35,
      spunUp: 1,
      grenadeCooldown: 0.6,
      score: -3,
      godMode: 1,
      wasJumpHeld: 1,
    });
  });

  it('round-trips respawnSeq through serialize/deserialize', () => {
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    respawnPlayer(world, id, { x: 1, y: 0, z: 1 });
    respawnPlayer(world, id, { x: 2, y: 0, z: 2 });
    expect(world.players.respawnSeq[id]).toBe(2);
    const data = serializePlayer(world, id);
    expect(data.respawnSeq).toBe(2);

    const target = createWorld(terrain, 1);
    deserializePlayer(target, data);
    expect(target.players.respawnSeq[id]).toBe(2);
  });

  it('round-trips ammo and grenades through serialize/deserialize', () => {
    // Codex review round 10, PR #9, finding 1: these must round-trip through the same
    // serialize/deserialize pair the wire protocol uses, so the client's reconciliation has
    // a real authoritative value to correct locally-predicted ammo drift against.
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)] = 8;
    world.players.ammo[ammoIndex(id, WeaponId.Chaingun)] = 33;
    world.players.ammo[ammoIndex(id, WeaponId.Mortar)] = 1;
    world.players.grenades[id] = 4;
    const data = serializePlayer(world, id);
    expect(data.discAmmo).toBe(8);
    expect(data.chaingunAmmo).toBe(33);
    expect(data.mortarAmmo).toBe(1);
    expect(data.grenades).toBe(4);

    const target = createWorld(terrain, 1);
    deserializePlayer(target, data);
    expect(target.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(8);
    expect(target.players.ammo[ammoIndex(id, WeaponId.Chaingun)]).toBe(33);
    expect(target.players.ammo[ammoIndex(id, WeaponId.Mortar)]).toBe(1);
    expect(target.players.grenades[id]).toBe(4);
  });

  it('round-trips the weapon state machine (weaponState, weaponTimer, spunUp) through serialize/deserialize', () => {
    // Round 11 (PR #9): round 10 wired ammo/grenades so a lost fire input's ammo drift
    // self-heals within one snapshot, but the state MACHINE driving fire eligibility
    // (weapons.ts's stepWeapons) was still missing from the wire entirely. Without these
    // three fields round-tripping, a client left in a stale Firing state by a lost input
    // has nothing to correct it against, and stepWeapons's fire-eligibility check (only
    // Ready/NoAmmo may fire) would go on suppressing a real subsequent shot indefinitely.
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.weaponState[id] = WeaponState.Firing;
    world.players.weaponTimer[id] = 1.218;
    world.players.spunUp[id] = 1;
    const data = serializePlayer(world, id);
    expect(data.weaponState).toBe(WeaponState.Firing);
    expect(data.weaponTimer).toBeCloseTo(1.218, 3);
    expect(data.spunUp).toBe(1);

    const target = createWorld(terrain, 1);
    deserializePlayer(target, data);
    expect(target.players.weaponState[id]).toBe(WeaponState.Firing);
    expect(target.players.weaponTimer[id]).toBeCloseTo(1.218, 3);
    expect(target.players.spunUp[id]).toBe(1);
  });

  it('round-trips grenadeCooldown through serialize/deserialize (Codex review round 12, PR #9)', () => {
    // Round 11 wired the primary weapon's state machine (weaponState/weaponTimer/spunUp)
    // onto the wire but missed its sibling: the grenade throw's own cooldown timer
    // (weapons.ts's tryThrowGrenade). Without this round-tripping, a client left with a
    // stale nonzero grenadeCooldown by a lost altFire input has nothing to correct it
    // against, and tryThrowGrenade's own cooldown guard would go on suppressing a real
    // subsequent throw even after the server corrects the grenade count back up.
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.grenadeCooldown[id] = 0.62;
    const data = serializePlayer(world, id);
    expect(data.grenadeCooldown).toBeCloseTo(0.62, 3);

    const target = createWorld(terrain, 1);
    deserializePlayer(target, data);
    expect(target.players.grenadeCooldown[id]).toBeCloseTo(0.62, 3);
  });

  it('round-trips score and godMode through serialize/deserialize (Codex review round 14, PR #9, finding 1)', () => {
    // Round 13's hashWorld/mixPlayer already mixed score and godMode into the determinism
    // hash, but neither was ever wired onto PlayerSnapshotData/serializePlayer/
    // deserializePlayer -- so a decoded/reconstructed player always came back with score 0 /
    // godMode 0 regardless of the source's real values. score is signed (damage.ts's
    // suicide/team-kill scoring can drive it negative), so exercise a negative value here,
    // not just the ammo/grenade fields' always-nonnegative range.
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.score[id] = -5;
    world.players.godMode[id] = 1;
    const data = serializePlayer(world, id);
    expect(data.score).toBe(-5);
    expect(data.godMode).toBe(1);

    const target = createWorld(terrain, 1);
    deserializePlayer(target, data);
    expect(target.players.score[id]).toBe(-5);
    expect(target.players.godMode[id]).toBe(1);
  });

  it('round-trips wasJumpHeld through serialize/deserialize (Codex review round 15, PR #9, finding 1)', () => {
    // netclient.ts's reconcile() used to hardcode wasJumpHeld to 0 after every snapshot,
    // since it had no wire field to read it from -- see this field's doc comment on
    // PlayerSnapshotData for the misprediction that caused. If it did not survive the wire,
    // that fix would be a no-op.
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.wasJumpHeld[id] = 1;
    const data = serializePlayer(world, id);
    expect(data.wasJumpHeld).toBe(1);

    const target = createWorld(terrain, 1);
    deserializePlayer(target, data);
    expect(target.players.wasJumpHeld[id]).toBe(1);
  });
});
