import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import { addPlayer, createWorld, type Heightfield, type PlayerInput } from './index.js';
import { PROJECTILE_CAPACITY, stepProjectiles } from './projectiles.js';
import {
  ammoIndex,
  GRENADE_DATA,
  respawnPlayer,
  stepWeapons,
  WEAPON_DATA,
  WeaponId,
  WeaponState,
  weaponIdForSlot,
} from './weapons.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const IDLE: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  jet: false,
  fire: false,
  altFire: false,
  slot: 0,
};
const FIXED_DT = 32 / 1000;
const ticksFor = (seconds: number): number => Math.ceil(seconds / FIXED_DT);

function fireOnce(world: ReturnType<typeof createWorld>, id: number, weaponId: WeaponId): void {
  world.players.weaponSlot[id] = weaponId;
  world.players.weaponState[id] = WeaponState.Ready;
  world.players.weaponTimer[id] = 0;
  stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
}

describe('weaponIdForSlot', () => {
  it('maps keys 1..5 to Spinfusor, Chaingun, Mortar, Laser Rifle, Blaster and 0 to no change', () => {
    expect(weaponIdForSlot(1)).toBe(WeaponId.Spinfusor);
    expect(weaponIdForSlot(2)).toBe(WeaponId.Chaingun);
    expect(weaponIdForSlot(3)).toBe(WeaponId.Mortar);
    expect(weaponIdForSlot(4)).toBe(WeaponId.LaserRifle);
    expect(weaponIdForSlot(5)).toBe(WeaponId.Blaster);
    expect(weaponIdForSlot(0)).toBeNull();
    expect(weaponIdForSlot(6)).toBeNull();
  });
});

describe('stepWeapons: Spinfusor timing (fire 1.25 s, reload 0.5 s)', () => {
  it('emits one FireEvent per full 1.75 s cycle, none while Firing or Reload', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.pendingFireEvents).toHaveLength(1);
    expect(world.players.weaponState[id]).toBe(WeaponState.Firing);
    for (let tick = 0; tick < ticksFor(1.25) - 1; tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
      expect(world.pendingFireEvents).toHaveLength(0);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.Reload);
    for (let tick = 0; tick < ticksFor(0.5) - 1; tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.Ready);
    stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    expect(world.pendingFireEvents).toHaveLength(1);
  });

  it('consumes one disc per shot from the Light loadout of 15', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo);
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo - 1);
  });

  it('goes DryFire then NoAmmo when the clip empties, and never emits a FireEvent again', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)] = 0;
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.pendingFireEvents).toHaveLength(0);
    expect(world.players.weaponState[id]).toBe(WeaponState.DryFire);
    // Matches the sibling Firing/Reload tests' "-1" pattern: this loop must land on the
    // exact tick the DryFire timer expires, or the very next tick's fire-eligibility
    // check (fire is still held) immediately retriggers a fresh dry-fire and NoAmmo is
    // never the externally observed state.
    for (let tick = 0; tick < ticksFor(0.2) - 1; tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.NoAmmo);
    stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    expect(world.pendingFireEvents).toHaveLength(0);
  });
});

describe('stepWeapons: idle fallback for a tick with no input entry at all (Codex review round 3, finding 2)', () => {
  it('keeps the reload timer advancing through Firing and Reload even when inputs has no entry for the player', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.players.weaponState[id]).toBe(WeaponState.Firing);
    // stepPlayers (movement.ts) already falls back to an idle input for an active player
    // missing from the map; stepWeapons used to just skip the player outright instead,
    // freezing weaponTimer/weaponState solid for as long as a tick's input entry was
    // missing. An empty map -- not even an idle entry -- for the full 1.75 s firing+reload
    // cycle below reproduces that.
    for (let tick = 0; tick < ticksFor(1.25) - 1; tick += 1) {
      stepWeapons(world, new Map(), FIXED_DT);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.Reload);
    for (let tick = 0; tick < ticksFor(0.5) - 1; tick += 1) {
      stepWeapons(world, new Map(), FIXED_DT);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.Ready);
    stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    expect(world.pendingFireEvents).toHaveLength(1);
  });
});

describe('stepWeapons: Chaingun spin-up (0.5 s once, then 0.15 s per shot while held)', () => {
  it('the first shot of a burst costs spinUp + fireTime; a held burst then costs only fireTime', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Chaingun);
    expect(world.pendingFireEvents).toHaveLength(1);
    const spunUpCost =
      WEAPON_DATA[WeaponId.Chaingun].spinUpTime! + WEAPON_DATA[WeaponId.Chaingun].fireTime;
    for (let tick = 0; tick < ticksFor(spunUpCost) - 1; tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
      expect(world.pendingFireEvents).toHaveLength(0);
    }
    stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    expect(world.pendingFireEvents).toHaveLength(1); // second shot: fireTime only, no second spin-up
  });

  it('releasing fire clears the spin-up so the next burst pays it again', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Chaingun);
    stepWeapons(world, new Map([[id, { ...IDLE, fire: false }]]), FIXED_DT);
    expect(world.players.spunUp[id]).toBe(0);
  });
});

describe('stepWeapons: Mortar timing (fire 0.8 s, reload 2.0 s)', () => {
  it('consumes no ammo — Light carries none, Mortar is not Light-allowed', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.ammo[ammoIndex(id, WeaponId.Mortar)]).toBe(0);
    fireOnce(world, id, WeaponId.Mortar);
    expect(world.pendingFireEvents).toHaveLength(0);
    expect(world.players.weaponState[id]).toBe(WeaponState.DryFire);
  });
});

describe('stepWeapons: Laser Rifle energy scaling and the minEnergy 6 refusal', () => {
  it('scales energyScale by energy/maxEnergy and spends energyPerShot', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.energy[id] = LIGHT_ARMOR.maxEnergy;
    fireOnce(world, id, WeaponId.LaserRifle);
    expect(world.pendingFireEvents[0]?.energyScale).toBeCloseTo(1);
    expect(world.players.energy[id]).toBeCloseTo(
      LIGHT_ARMOR.maxEnergy - WEAPON_DATA[WeaponId.LaserRifle].energyPerShot!,
    );
  });

  it('scales damage down at partial energy and refuses below minEnergy 6', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.energy[id] = 30;
    fireOnce(world, id, WeaponId.LaserRifle);
    expect(world.pendingFireEvents[0]?.energyScale).toBeCloseTo(30 / LIGHT_ARMOR.maxEnergy);
    world.players.energy[id] = 5;
    fireOnce(world, id, WeaponId.LaserRifle);
    expect(world.pendingFireEvents).toHaveLength(0);
    expect(world.players.weaponState[id]).toBe(WeaponState.DryFire);
  });
});

describe('stepWeapons: altFire grenade throw', () => {
  it('throws from the Light loadout of 5, gated by a 1.0 s cooldown, independent of the held weapon', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount);
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount - 1);
    expect(world.pendingFireEvents[0]?.isAltFire).toBe(true);
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount - 1); // cooldown still active
    for (let tick = 0; tick < ticksFor(GRENADE_DATA.throwCooldown); tick += 1) {
      stepWeapons(world, new Map([[id, IDLE]]), FIXED_DT);
    }
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount - 2);
  });
});

describe('slot switching', () => {
  it('switches instantly (0 s activate) and resets state to Ready', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Spinfusor);
    stepWeapons(world, new Map([[id, { ...IDLE, slot: 2 }]]), FIXED_DT);
    expect(world.players.weaponSlot[id]).toBe(WeaponId.Chaingun);
    expect(world.players.weaponState[id]).toBe(WeaponState.Ready);
  });
});

describe('projectile-capacity exhaustion refunds the shot one tick later', () => {
  it('credits back one disc when the 256-slot projectile store is full', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.projectiles.count = PROJECTILE_CAPACITY; // store full: allocate() can't fit another
    const ammoBefore = world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]!;
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(ammoBefore - 1);
    stepProjectiles(world, FIXED_DT); // fails to allocate a slot for the shot
    // Not refunded yet: the credit lands at the start of the *next* stepWeapons call, one
    // tick later, the same boundary pendingDeaths already crosses.
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(ammoBefore - 1);
    stepWeapons(world, new Map([[id, IDLE]]), FIXED_DT);
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(ammoBefore);
  });

  it('credits back one grenade, not ammo, when a thrown grenade fails to allocate', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.projectiles.count = PROJECTILE_CAPACITY;
    const grenadesBefore = world.players.grenades[id]!;
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(grenadesBefore - 1);
    stepProjectiles(world, FIXED_DT);
    stepWeapons(world, new Map([[id, IDLE]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(grenadesBefore);
  });
});

describe('respawnPlayer resets the loadout', () => {
  it('restores full ammo, grenades, and the starting weapon', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Spinfusor);
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    respawnPlayer(world, id, { x: 0, y: 0, z: 0 });
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount);
    expect(world.players.weaponSlot[id]).toBe(WeaponId.Blaster);
    expect(world.players.weaponState[id]).toBe(WeaponState.Ready);
  });
});
