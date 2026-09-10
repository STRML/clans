import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { createBaseObjects, BaseObjectKind, stepPower } from '@clans/sim';
import {
  currentLoadoutChoice,
  inventoryStationTriggerAt,
  LoadoutSelection,
  stationMenuVisible,
} from './stationMenu.js';
import { allowedWeaponMask, ArmorId, ARMORS, PackId, WeaponId } from '@clans/sim';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('stationMenuVisible', () => {
  it('is false when menuOpen is false, even at a powered station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, false)).toBe(false);
  });
  it('is true when menuOpen is true and the player is at a powered station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, true)).toBe(true);
  });
  it('is false when menuOpen is true but no station is in range (closes itself)', () => {
    const world = createWorld(flat, 1);
    const player = addPlayer(world, { x: 500, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, true)).toBe(false);
  });
});

it('requires inventory pad contact and a living, unmounted player for automatic entry', () => {
  const world = createWorld(flat, 1);
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
  ]);
  stepPower(world);
  const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
  expect(inventoryStationTriggerAt(world, player)).toBe(1);
  world.players.position[player * 3] = 2;
  expect(inventoryStationTriggerAt(world, player)).toBeNull();
  world.players.position[player * 3] = 1;
  world.players.mountedVehicleId[player] = 0;
  expect(inventoryStationTriggerAt(world, player)).toBeNull();
  world.players.mountedVehicleId[player] = -1;
  world.players.alive[player] = 0;
  expect(inventoryStationTriggerAt(world, player)).toBeNull();
});

describe('LoadoutSelection (#55)', () => {
  it('tracks armor, pack and weapons and refuses Confirm with an empty weapon set', () => {
    const selection = new LoadoutSelection({
      armor: ArmorId.Light,
      pack: PackId.None,
      weapons: 1 << WeaponId.Spinfusor,
    });
    expect(selection.confirmable).toBe(true);
    selection.toggleWeapon(WeaponId.Spinfusor);
    // Empty would decode as "armor defaults" on the wire -- the opposite of the pick.
    expect(selection.confirmable).toBe(false);
    selection.toggleWeapon(WeaponId.Blaster);
    expect(selection.confirmable).toBe(true);
    expect(selection.choice).toEqual({
      armor: ArmorId.Light,
      pack: PackId.None,
      weapons: 1 << WeaponId.Blaster, // the Spinfusor toggle above cleared its own bit
    });
  });

  it('re-sanitizes the weapon set when the armor changes: Heavy loses the Laser Rifle', () => {
    const selection = new LoadoutSelection({
      armor: ArmorId.Light,
      pack: PackId.Repair,
      weapons: (1 << WeaponId.Spinfusor) | (1 << WeaponId.LaserRifle) | (1 << WeaponId.Blaster),
    });
    expect(selection.isWeaponSelected(WeaponId.LaserRifle)).toBe(true);
    selection.setArmor(ArmorId.Heavy);
    expect(selection.isWeaponSelected(WeaponId.LaserRifle)).toBe(false);
    expect(selection.isWeaponAllowed(WeaponId.Mortar)).toBe(true);
    expect(selection.choice.pack).toBe(PackId.Repair); // armor switch keeps the pack
    expect(selection.confirmable).toBe(true);
  });

  it('ignores weapon toggles the current armor disallows and unknown pack ids', () => {
    const selection = new LoadoutSelection({
      armor: ArmorId.Medium,
      pack: PackId.None,
      weapons: allowedWeaponMask(ARMORS[ArmorId.Medium]),
    });
    expect(selection.isWeaponAllowed(WeaponId.Mortar)).toBe(false);
    expect(selection.isWeaponAllowed(WeaponId.LaserRifle)).toBe(false);
    selection.toggleWeapon(WeaponId.Mortar);
    expect(selection.isWeaponSelected(WeaponId.Mortar)).toBe(false);
    selection.setPack(99);
    expect(selection.choice.pack).toBe(PackId.None);
  });
});

describe('currentLoadoutChoice', () => {
  it('expands a zero carriedWeapons mask (no station visit yet) to the armor defaults', () => {
    const world = createWorld(flat, 1);
    const player = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const choice = currentLoadoutChoice(world, player);
    expect(choice).toEqual({
      armor: ArmorId.Light,
      pack: PackId.None,
      weapons: allowedWeaponMask(ARMORS[ArmorId.Light]),
    });
  });

  it('reads back a stored station loadout, pack included', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    world.players.armor[player] = ArmorId.Heavy;
    world.players.hasEnergyPack[player] = 1;
    world.players.carriedWeapons[player] = (1 << WeaponId.Spinfusor) | (1 << WeaponId.Mortar);
    expect(currentLoadoutChoice(world, player)).toEqual({
      armor: ArmorId.Heavy,
      pack: PackId.Energy,
      weapons: (1 << WeaponId.Spinfusor) | (1 << WeaponId.Mortar),
    });
  });
});
