import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createWorld,
  FIXED_DT,
  LIGHT_ARMOR,
  stepWorld,
  type Heightfield,
} from './index.js';
import { ArmorId, ARMORS, HEAVY_ARMOR, MEDIUM_ARMOR } from './armor.js';
import { WeaponId, ammoIndex, respawnPlayer } from './weapons.js';
import { raycastInteriors } from './interiors.js';
import {
  activeForceFieldBlockers,
  applyBaseObjectDamage,
  applyLoadoutSelection,
  allowedWeaponMask,
  BASE_OBJECT_DATA,
  BaseObjectKind,
  clampWeaponMask,
  createBaseObjects,
  defaultWeaponMask,
  ENERGY_PACK_RECHARGE_BONUS,
  PackId,
  STATION_USE_RADIUS,
  stationAt,
  stepPower,
  teamHasPower,
} from './baseObjects.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function twoGeneratorsOneStation(world: ReturnType<typeof createWorld>): {
  gen1: number;
  gen2: number;
  station: number;
} {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
  ]);
  stepPower(world);
  return { gen1: 0, gen2: 1, station: 2 };
}

describe('BASE_OBJECT_DATA', () => {
  it('matches the spec Base asset numbers table and staticShape.cs exactly', () => {
    expect(BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth).toBe(1.5);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Generator].energyPerDamagePoint).toBe(30);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].maxHealth).toBe(1.5);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].energyPerDamagePoint).toBe(33);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].detectRadius).toBe(300);
    expect(BASE_OBJECT_DATA[BaseObjectKind.StationInventory].maxHealth).toBe(1.0);
    expect(BASE_OBJECT_DATA[BaseObjectKind.StationVehiclePad].invincible).toBe(true);
  });
});

describe('stepPower', () => {
  it('a team with at least one living generator powers its other objects', () => {
    const world = createWorld(flat, 1);
    const { station } = twoGeneratorsOneStation(world);
    expect(world.baseObjects.powered[station]).toBe(1);
    expect(teamHasPower(world, 1)).toBe(true);
  });
  it('destroying one of two generators keeps the team powered', () => {
    const world = createWorld(flat, 1);
    const { gen1, station } = twoGeneratorsOneStation(world);
    applyBaseObjectDamage(world, gen1, BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10);
    stepPower(world);
    expect(world.baseObjects.powered[station]).toBe(1);
  });
  it('failure matrix row 4: destroying both generators unpowers every other object of that team', () => {
    const world = createWorld(flat, 1);
    const { gen1, gen2, station } = twoGeneratorsOneStation(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, gen1, overkill);
    applyBaseObjectDamage(world, gen2, overkill);
    stepPower(world);
    expect(world.baseObjects.powered[station]).toBe(0);
  });
  it('a generator itself is always "powered" (it does not depend on another generator)', () => {
    const world = createWorld(flat, 1);
    const { gen1 } = twoGeneratorsOneStation(world);
    expect(world.baseObjects.powered[gen1]).toBe(1);
  });
});

describe('applyBaseObjectDamage: shielded damage spends energy before health', () => {
  it('spends energy at energyPerDamagePoint before touching health', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1.0);
    expect(world.baseObjects.damage[0]).toBe(0);
    expect(world.baseObjects.energy[0]).toBeCloseTo(50 - 1.0 * 30);
  });
  it('overflow past the shield reaches health', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 2.0);
    expect(world.baseObjects.energy[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBeCloseTo(2.0 - 50 / 30);
  });
  it('destroys at maxHealth and further damage is a no-op', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    const damageAfter = world.baseObjects.damage[0];
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.damage[0]).toBe(damageAfter);
  });
  it('a StationVehiclePad is invincible: damage is always a no-op (station.cs isInvincible)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBe(0);
  });
});

describe('stationAt', () => {
  it('finds a powered station within STATION_USE_RADIUS of the player', () => {
    const world = createWorld(flat, 1);
    const { station } = twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10 + STATION_USE_RADIUS - 0.1, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBe(station);
  });
  it('returns null outside the use radius', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10 + STATION_USE_RADIUS + 5, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
  it('returns null for an unpowered station (failure matrix row 4)', () => {
    const world = createWorld(flat, 1);
    const { gen1, gen2 } = twoGeneratorsOneStation(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, gen1, overkill);
    applyBaseObjectDamage(world, gen2, overkill);
    stepPower(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
  it('never returns an enemy team station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationInventory, team: 2, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
});

describe('ForceField', () => {
  const forceFieldPlacement = (team: number) => ({
    kind: BaseObjectKind.ForceField,
    team,
    position: { x: 0, y: 0, z: 0 },
    rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
    scale: { x: 6, y: 4, z: 1 },
  });

  it('BASE_OBJECT_DATA[ForceField] is invincible — forceField.cs has no energy/maxDamage field of its own', () => {
    expect(BASE_OBJECT_DATA[BaseObjectKind.ForceField].invincible).toBe(true);
    expect(BASE_OBJECT_DATA[BaseObjectKind.ForceField].maxHealth).toBe(0);
  });

  it('failure matrix row 18: an unpowered force field blocks no one', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [forceFieldPlacement(1)]);
    // No generator: stepPower leaves it unpowered.
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(0);
    expect(activeForceFieldBlockers(world, 1)).toHaveLength(0);
  });

  it('a powered force field blocks the opposing team and passes its own (failure matrix row 17)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1); // team 2 (enemy) is blocked
    expect(activeForceFieldBlockers(world, 1)).toHaveLength(0); // team 1 (owner) passes freely
  });

  it("destroying both of the owning team's generators drops the force field from every team's blocker list", () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 25, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, 0, overkill);
    applyBaseObjectDamage(world, 1, overkill);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(0);
  });

  it('a destroyed generator that leaves one alive keeps the force field powered', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 25, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, 0, overkill);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1);
  });

  it("the blocker geometry sits at the field's own position, sized from the placement scale", () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    const [blocker] = activeForceFieldBlockers(world, 2);
    // A ray straight through the field's own position, aimed at its plane, must hit it.
    const hit =
      blocker && raycastInteriors([blocker], { x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
  });
});

describe('applyLoadoutSelection (#55)', () => {
  it('applies an Energy Pack: mutually exclusive with the Repair Pack, full energy restore', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    // Arrive already wearing a Repair Pack: the station replaces the whole pack.
    expect(applyLoadoutSelection(world, player, ArmorId.Light, PackId.Repair, 0)).toBe(true);
    const applied = applyLoadoutSelection(world, player, ArmorId.Light, PackId.Energy, 0b01000);
    expect(applied).toBe(true);
    expect(world.players.hasEnergyPack[player]).toBe(1);
    expect(world.players.hasRepairPack[player]).toBe(0);
    expect(world.players.damage[player]).toBe(0);
    expect(world.players.energy[player]).toBe(LIGHT_ARMOR.maxEnergy);
  });

  it('the Energy Pack recharge bonus reaches the tick loop (+0.15/tick, committed spec value)', () => {
    // docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md, "Movement"
    // step 3: energypack.cs adds 0.15 recharge per tick ON TOP of the armor's own rate.
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    applyLoadoutSelection(world, player, ArmorId.Light, PackId.Energy, 0);
    world.players.energy[player] = 10;
    stepWorld(world, new Map(), FIXED_DT);
    expect(world.players.energy[player]).toBeCloseTo(
      10 + LIGHT_ARMOR.rechargeRate + ENERGY_PACK_RECHARGE_BONUS,
      10,
    );
    // Same tick without the pack must NOT include the bonus.
    const world2 = createWorld(flat, 1);
    twoGeneratorsOneStation(world2);
    const plain = addPlayer(world2, { x: 10, y: 0, z: 0 }, 1);
    world2.players.energy[plain] = 10;
    stepWorld(world2, new Map(), FIXED_DT);
    expect(world2.players.energy[plain]).toBeCloseTo(10 + LIGHT_ARMOR.rechargeRate, 10);
  });

  it('sanitizes the weapon mask against the armor: a Light can never talk a Mortar into the loadout', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    // Spinfusor + Chaingun + Mortar: three picks, so the weapon CAP (below) is not what
    // narrows this one -- the armor's per-weapon allowance is.
    expect(applyLoadoutSelection(world, player, ArmorId.Light, PackId.None, 0b00111)).toBe(true);
    // Mortar bit (1 << WeaponId.Mortar) sanitized away; everything Light allows survives.
    expect(world.players.carriedWeapons[player]).toBe(
      (1 << WeaponId.Spinfusor) | (1 << WeaponId.Chaingun),
    );
    expect(world.players.ammo[ammoIndex(player, WeaponId.Mortar)]).toBe(0);
    expect(world.players.ammo[ammoIndex(player, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo);
  });

  it('caps an over-full weapon mask at the armor maxWeapons, keeping the lowest-numbered weapons', () => {
    // #55 left ArmorData.maxWeapons unconsumed. Source: GameData/base/scripts/player.cs:1391
    // `maxWeapons = 3; // Max number of different weapons the player can have`, and the
    // server cuts a client's own submitted favorites down to it (hud.cs:349
    // `if (%weaponCount < %armor.maxWeapons)`), so the surplus weapons are DROPPED, not the
    // whole loadout. Light is the only armor in the committed table where a legal selection
    // can exceed the cap: it allows four weapons (laserRifleAllowed) but has three slots.
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    // Every bit at once: four survive sanitization (Mortar disallowed), three fit the cap.
    expect(applyLoadoutSelection(world, player, ArmorId.Light, PackId.None, 0b11111)).toBe(true);
    // Spinfusor (0) + Chaingun (1) + Laser Rifle (3); Blaster (4) is the surplus pick.
    expect(world.players.carriedWeapons[player]).toBe(0b01011);
    expect(world.players.carriedWeapons[player]).toBe(defaultWeaponMask(LIGHT_ARMOR));
    expect(world.players.ammo[ammoIndex(player, WeaponId.Blaster)]).toBe(0);
    expect(world.players.ammo[ammoIndex(player, WeaponId.Chaingun)]).toBe(LIGHT_ARMOR.chaingunAmmo);
    // The cap narrows the weapon set only: the visit still applies armor and pack.
    expect(world.players.armor[player]).toBe(ArmorId.Light);
    expect(world.players.hasRepairPack[player]).toBe(0);
  });

  it('accepts a loadout at exactly the cap unchanged', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    // A Light's three slots filled with a non-default set: Spinfusor + Chaingun + Blaster
    // (bits 0,1,4) must survive bit for bit -- the cap drops picks, it never reorders them.
    expect(applyLoadoutSelection(world, player, ArmorId.Light, PackId.None, 0b10011)).toBe(true);
    expect(world.players.carriedWeapons[player]).toBe(0b10011);
    // A Heavy can hold its whole four-weapon allowed set (4 <= maxWeapons 5).
    const heavyWorld = createWorld(flat, 1);
    twoGeneratorsOneStation(heavyWorld);
    const heavy = addPlayer(heavyWorld, { x: 10, y: 0, z: 0 }, 1);
    const heavyMask = allowedWeaponMask(HEAVY_ARMOR);
    expect(applyLoadoutSelection(heavyWorld, heavy, ArmorId.Heavy, PackId.None, heavyMask)).toBe(
      true,
    );
    expect(heavyWorld.players.carriedWeapons[heavy]).toBe(heavyMask);
  });

  it('every armor default loadout fits its own weapon cap', () => {
    // The mask-0 sentinel's set is the armor's own default loadout; #55 granted the FULL
    // allowed set, which for Light is four weapons against maxWeapons 3.
    expect(defaultWeaponMask(LIGHT_ARMOR)).toBe(0b01011);
    expect(defaultWeaponMask(MEDIUM_ARMOR)).toBe(0b10011);
    expect(defaultWeaponMask(HEAVY_ARMOR)).toBe(0b10111);
    for (const armor of [ArmorId.Light, ArmorId.Medium, ArmorId.Heavy]) {
      const data = ARMORS[armor];
      const weaponsInDefault = [0, 1, 2, 3, 4].filter(
        (bit) => defaultWeaponMask(data) & (1 << bit),
      );
      expect(weaponsInDefault.length).toBeLessThanOrEqual(data.maxWeapons);
      expect(weaponsInDefault.length).toBeGreaterThan(0);
      expect(clampWeaponMask(defaultWeaponMask(data), data)).toBe(defaultWeaponMask(data));
      // Behavior, not just the helper: an empty request lands on exactly that set.
      const world = createWorld(flat, 1);
      twoGeneratorsOneStation(world);
      const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
      expect(applyLoadoutSelection(world, player, armor, PackId.None, 0)).toBe(true);
      expect(world.players.carriedWeapons[player]).toBe(defaultWeaponMask(data));
    }
  });

  it('a narrowed selection persists through respawn and selects a carried weapon slot', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    // Spinfusor + Chaingun, Blaster NOT carried.
    applyLoadoutSelection(world, player, ArmorId.Light, PackId.None, 0b00011);
    respawnPlayer(world, player, { x: 10, y: 0, z: 0 });
    // The pre-#55 resetLoadout resurrected every weapon here; the station choice survives.
    expect(world.players.ammo[ammoIndex(player, WeaponId.Blaster)]).toBe(0);
    expect(world.players.ammo[ammoIndex(player, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo);
    // Blaster is not carried, so the slot points at the first carried weapon (lowest id).
    expect(world.players.weaponSlot[player]).toBe(WeaponId.Spinfusor);
  });

  it('an empty weapon mask lands on the armor defaults, within the armor weapon cap', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    applyLoadoutSelection(world, player, ArmorId.Light, PackId.None, 0b00001);
    applyLoadoutSelection(world, player, ArmorId.Light, PackId.None, 0);
    // An empty mask expands to the armor's defaults (see applyLoadoutSelection), so the
    // Chaingun comes back with its armor ammo, explicitly carried. Light's defaults cannot
    // be its full four-weapon allowed set -- maxWeapons is 3 -- so the last slot's weapon,
    // the Blaster (bit 4 of 5), is the one the cap drops (player.cs:1391, the station's
    // three "Weapon Slot" rows).
    expect(world.players.carriedWeapons[player]).toBe(defaultWeaponMask(LIGHT_ARMOR));
    expect(world.players.carriedWeapons[player]).toBe(0b01011);
    expect(world.players.ammo[ammoIndex(player, WeaponId.Chaingun)]).toBe(LIGHT_ARMOR.chaingunAmmo);
    expect(world.players.ammo[ammoIndex(player, WeaponId.Blaster)]).toBe(0);
  });

  it('refuses an unknown pack id, an out-of-range armor byte, and keeps the loadout untouched', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    expect(applyLoadoutSelection(world, player, ArmorId.Light, 3, 0)).toBe(false);
    expect(applyLoadoutSelection(world, player, 99 as ArmorId, PackId.None, 0)).toBe(false);
    expect(world.players.hasEnergyPack[player]).toBe(0);
    expect(world.players.hasRepairPack[player]).toBe(0);
    expect(world.players.armor[player]).toBe(ArmorId.Light);
  });

  it('armor defaults gate the Laser Rifle to light armor and the Mortar to heavy armor', () => {
    // The ArmorData allowance flags finally get a consumer: mask 0 (defaults) on a Heavy
    // must NOT grant the light-only Laser Rifle's infinite ammo it used to hand out.
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    expect(applyLoadoutSelection(world, player, ArmorId.Heavy, PackId.None, 0)).toBe(true);
    expect(world.players.ammo[ammoIndex(player, WeaponId.LaserRifle)]).toBe(0);
    expect(world.players.ammo[ammoIndex(player, WeaponId.Mortar)]).toBe(HEAVY_ARMOR.mortarAmmo);
    const world2 = createWorld(flat, 1);
    twoGeneratorsOneStation(world2);
    const medium = addPlayer(world2, { x: 10, y: 0, z: 0 }, 1);
    expect(applyLoadoutSelection(world2, medium, ArmorId.Medium, PackId.None, 0)).toBe(true);
    expect(world2.players.ammo[ammoIndex(medium, WeaponId.LaserRifle)]).toBe(0);
    expect(world2.players.ammo[ammoIndex(medium, WeaponId.Mortar)]).toBe(MEDIUM_ARMOR.mortarAmmo);
  });
});
