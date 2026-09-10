import {
  allowedWeaponMask,
  ARMORS,
  ArmorId,
  armorFor,
  PackId,
  stationAt,
  type ArmorData,
  type World,
} from '@clans/sim';

export function stationMenuVisible(world: World, playerId: number, menuOpen: boolean): boolean {
  return menuOpen && stationAt(world, playerId) !== null;
}

/** Original inventory trigger: 1.5 m wide, from 0.1 to 2.4 m above the station. */
export function inventoryStationTriggerAt(world: World, playerId: number): number | null {
  if (!world.players.alive[playerId] || (world.players.mountedVehicleId[playerId] ?? -1) !== -1)
    return null;
  const station = stationAt(world, playerId);
  if (station === null) return null;
  const p = playerId * 3,
    base = station * 3;
  const dx = world.players.position[p]! - world.baseObjects.position[base]!;
  const dy = world.players.position[p + 1]! - world.baseObjects.position[base + 1]!;
  const dz = world.players.position[p + 2]! - world.baseObjects.position[base + 2]!;
  return Math.hypot(dx, dz) <= 0.75 &&
    dy + armorFor(world, playerId).boundingBox[2] >= 0.1 &&
    dy <= 2.4
    ? station
    : null;
}

/** One full station loadout (#55) -- what Confirm sends and what the sim applies. */
export interface LoadoutChoice {
  armor: ArmorId;
  pack: PackId;
  /** `1 << WeaponId` bitmask, already sanitized to the armor's allowed set. The menu never
   *  produces 0: on the wire 0 means "armor defaults", so an empty Confirm would send the
   *  opposite of what the player picked -- see LoadoutSelection.confirmable. */
  weapons: number;
}

const LIGHT_DEFAULT: LoadoutChoice = {
  armor: ArmorId.Light,
  pack: PackId.None,
  weapons: allowedWeaponMask(ARMORS[ArmorId.Light]),
};

/** The loadout the player currently carries, for pre-filling the menu on every open --
 *  the source station shows your existing inventory, not a blank form. A stored
 *  carriedWeapons of 0 (no station visit yet) expands to the armor's own defaults. */
export function currentLoadoutChoice(world: World, playerId: number): LoadoutChoice {
  const armor = (world.players.armor[playerId] ?? ArmorId.Light) as ArmorId;
  const stored = world.players.carriedWeapons[playerId] ?? 0;
  return {
    armor,
    pack: world.players.hasEnergyPack[playerId]
      ? PackId.Energy
      : world.players.hasRepairPack[playerId]
        ? PackId.Repair
        : PackId.None,
    weapons: stored === 0 ? allowedWeaponMask(ARMORS[armor]) : stored,
  };
}

/**
 * Pure selection state behind the station menu (#55), kept DOM-free for the node-environment
 * unit tests the same way hud.ts keeps describeHud pure. Every mutation re-sanitizes against
 * the CURRENT armor: switching armor unchecks weapons it disallows (Laser Rifle is
 * light-only, Mortar heavy-only -- sim/baseObjects.ts's allowedWeaponMask is the one gate
 * list, shared with the sim itself). `armor` must be a real ArmorId; anything else is
 * caller error and reads as Light, exactly like the sim's own armorFor fallback.
 */
export class LoadoutSelection {
  private data: ArmorData;
  private armor: ArmorId;
  private pack: PackId;
  private weapons: number;

  constructor(choice: LoadoutChoice) {
    this.armor = choice.armor;
    this.data = ARMORS[choice.armor];
    this.pack = choice.pack;
    this.weapons = choice.weapons & allowedWeaponMask(this.data);
  }

  setArmor(armor: ArmorId): void {
    this.armor = armor;
    this.data = ARMORS[armor];
    // Dropping to an armor that cannot carry a checked weapon unchecks it, exactly like the
    // source station re-filtering its item list around the selected armor.
    this.weapons &= allowedWeaponMask(this.data);
  }

  setPack(pack: number): void {
    // Enum membership by VALUE: a numeric enum object's keys are the names, so `pack in
    // PackId` would test '0' and never match -- compare against the three values instead.
    if (pack === PackId.None || pack === PackId.Repair || pack === PackId.Energy) this.pack = pack;
  }

  toggleWeapon(weapon: number): void {
    if ((allowedWeaponMask(this.data) & (1 << weapon)) === 0) return;
    this.weapons ^= 1 << weapon;
  }

  isWeaponAllowed(weapon: number): boolean {
    return (allowedWeaponMask(this.data) & (1 << weapon)) !== 0;
  }

  isWeaponSelected(weapon: number): boolean {
    return (this.weapons & (1 << weapon)) !== 0;
  }

  /** A loadout with no weapons would decode as "armor defaults" (mask 0 on the wire), not
   *  as an unarmed loadout -- so Confirm refuses an empty selection rather than silently
   *  sending the opposite of what the player picked. */
  get confirmable(): boolean {
    return this.weapons !== 0;
  }

  get choice(): LoadoutChoice {
    return { armor: this.armor, pack: this.pack, weapons: this.weapons };
  }
}

export interface StationMenu {
  show(choice?: LoadoutChoice): void;
  hide(): void;
}

const ARMOR_LABEL: Record<ArmorId, string> = {
  [ArmorId.Light]: 'Light',
  [ArmorId.Medium]: 'Medium',
  [ArmorId.Heavy]: 'Heavy',
};

const PACK_LABEL: Record<PackId, string> = {
  [PackId.None]: 'No Pack',
  [PackId.Repair]: 'Repair Pack',
  [PackId.Energy]: 'Energy Pack',
};

// Menu order mirrors the sim's own WeaponId order, so slot numbers stay consistent with
// the number-key weapon selection and the HUD rack.
const WEAPON_LABEL: Record<number, string> = {
  0: 'Spinfusor',
  1: 'Chaingun',
  2: 'Mortar',
  3: 'Laser Rifle',
  4: 'Blaster',
};

export function createStationMenu(
  container: HTMLElement,
  onConfirm: (choice: LoadoutChoice) => void,
  onClose: () => void = () => {},
): StationMenu {
  const root = document.createElement('div');
  root.id = 'station-menu';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Inventory station');
  const heading = document.createElement('h2');
  heading.textContent = 'Inventory station';
  root.appendChild(heading);
  let selection = new LoadoutSelection(LIGHT_DEFAULT);

  const armorHeading = document.createElement('h3');
  armorHeading.textContent = 'Armor';
  root.append(armorHeading);
  const armorButtons: Record<number, HTMLButtonElement> = {};
  for (const armor of [ArmorId.Light, ArmorId.Medium, ArmorId.Heavy] as const) {
    const button = document.createElement('button');
    button.textContent = ARMOR_LABEL[armor];
    button.addEventListener('click', () => {
      selection.setArmor(armor);
      syncSelection();
    });
    armorButtons[armor] = button;
    root.appendChild(button);
  }

  const packHeading = document.createElement('h3');
  packHeading.textContent = 'Pack';
  root.append(packHeading);
  const packButtons: Record<number, HTMLButtonElement> = {};
  for (const pack of [PackId.None, PackId.Repair, PackId.Energy] as const) {
    const button = document.createElement('button');
    button.textContent = PACK_LABEL[pack];
    button.addEventListener('click', () => {
      selection.setPack(pack);
      syncSelection();
    });
    packButtons[pack] = button;
    root.appendChild(button);
  }

  const weaponsHeading = document.createElement('h3');
  weaponsHeading.textContent = 'Weapons';
  root.append(weaponsHeading);
  const weaponBoxes: Record<number, HTMLInputElement> = {};
  for (const weapon of Object.keys(WEAPON_LABEL)) {
    const id = Number(weapon);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      selection.toggleWeapon(id);
      syncSelection();
    });
    const rowLabel = document.createElement('label');
    rowLabel.append(checkbox, ` ${WEAPON_LABEL[id]}`);
    root.appendChild(rowLabel);
    weaponBoxes[id] = checkbox;
  }

  const confirm = document.createElement('button');
  confirm.textContent = 'Confirm';
  confirm.addEventListener('click', () => {
    if (selection.confirmable) onConfirm(selection.choice);
  });
  root.appendChild(confirm);
  const close = document.createElement('button');
  close.textContent = 'Close (Esc)';
  close.addEventListener('click', onClose);
  const help = document.createElement('small');
  help.textContent = 'Click the game after closing to resume mouse look.';
  root.append(close, help);
  container.appendChild(root);

  /** One repaint of every control from the selection state -- every mutation goes through
   *  here, so the DOM can never drift from what Confirm would actually send. */
  function syncSelection(): void {
    for (const armor of Object.keys(armorButtons))
      armorButtons[Number(armor)]!.setAttribute(
        'aria-pressed',
        String(Number(armor) === selection.choice.armor),
      );
    for (const pack of Object.keys(packButtons))
      packButtons[Number(pack)]!.setAttribute(
        'aria-pressed',
        String(Number(pack) === selection.choice.pack),
      );
    for (const weapon of Object.keys(weaponBoxes)) {
      const id = Number(weapon);
      weaponBoxes[id]!.checked = selection.isWeaponSelected(id);
      weaponBoxes[id]!.disabled = !selection.isWeaponAllowed(id);
    }
    confirm.disabled = !selection.confirmable;
  }

  return {
    // Resets the whole selection each open (the source station presents your current
    // inventory afresh), so a rejected confirm can never leak into the next visit.
    show(choice: LoadoutChoice = LIGHT_DEFAULT): void {
      selection = new LoadoutSelection(choice);
      syncSelection();
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
