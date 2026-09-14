import {
  allowedWeaponMask,
  ARMORS,
  ArmorId,
  armorFor,
  clampWeaponMask,
  defaultWeaponMask,
  PackId,
  stationAt,
  WEAPON_COUNT,
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

// The picker's own default when it has never shown a loadout; app.ts always opens it with
// currentLoadoutChoice, so this is the pre-first-open fallback. It is the armor's CLAMPED
// default (defaultWeaponMask), not every weapon it allows: Light can list four weapons but
// carries three.
const LIGHT_DEFAULT: LoadoutChoice = {
  armor: ArmorId.Light,
  pack: PackId.None,
  weapons: defaultWeaponMask(ARMORS[ArmorId.Light]),
};

/** The loadout the player currently carries, for pre-filling the menu on every open --
 *  the source station shows your existing inventory, not a blank form. A stored
 *  carriedWeapons of 0 (no station visit yet) expands to the armor's own default loadout
 *  (baseObjects.ts's defaultWeaponMask) -- the same set the sim grants an empty station
 *  request, capped at the armor's weapon-slot count, so the menu cannot prefill a loadout
 *  the sim would truncate on Confirm. */
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
    weapons: stored === 0 ? defaultWeaponMask(ARMORS[armor]) : stored,
  };
}

/** Where the station menu keeps this browser's favorites (spec Client bullet
 *  "...save favorites"). Keyed per origin like any localStorage user; the value is
 *  saveFavorites's JSON below. */
export const FAVORITES_STORAGE_KEY = 'clans.station-favorites';

/** The three storage operations favorites need, stated structurally: the browser's
 *  localStorage satisfies it as-is, and the node-environment unit tests stub any object
 *  with the same three methods. */
export interface FavoritesStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage when the environment offers one. The property access itself can throw
 *  (sandboxed frames, some privacy modes), and a missing storage reads as "none" either
 *  way -- favorites are a convenience, never a requirement. */
export function defaultFavoritesStore(): FavoritesStore | null {
  try {
    const storage = globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** Saves the full chosen loadout as this browser's favorites. What is saved is exactly
 *  what Confirm sends -- armor, pack, weapons; the grenade has no Loadout-message field
 *  to carry a choice (see the grenade row in createStationMenu), so there is nothing to
 *  save for it. Throws if the store refuses the write (quota, privacy mode): the caller
 *  decides whether that blocks anything, and the menu's Confirm handler treats it as
 *  best-effort. */
export function saveFavorites(store: FavoritesStore, choice: LoadoutChoice): void {
  store.setItem(
    FAVORITES_STORAGE_KEY,
    JSON.stringify({ armor: choice.armor, pack: choice.pack, weapons: choice.weapons }),
  );
}

/** The saved favorites, or null when there are none -- or when the payload is unusable:
 *  a parse failure, an armor id no ArmorData backs, a pack outside PackId, or a weapons
 *  mask outside the five WeaponId bits the wire itself bounds (decodeLoadout's 0x1f), so
 *  the menu can never prefill a bit Confirm would silently drop. Sanitizing a legal but
 *  over-cap mask against the saved armor is deliberately NOT this function's job --
 *  LoadoutSelection's constructor does that for a favorites prefill exactly as it already
 *  does for a currentLoadoutChoice one. A store that throws on read also reads as "no
 *  favorites": the menu must open even when storage is hostile. */
export function loadFavorites(store: FavoritesStore): LoadoutChoice | null {
  let raw: string | null;
  try {
    raw = store.getItem(FAVORITES_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return parseFavoritesPayload(raw);
}

function parseFavoritesPayload(raw: string): LoadoutChoice | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  // `in` narrowing keeps every read checked: after the guards pass, parsed.armor/.pack/
  // .weapons are ArmorId/PackId/number, and a MISSING key reads as undefined, which every
  // guard rejects -- one rejection path per field, no shape cast.
  if (!('armor' in parsed && 'pack' in parsed && 'weapons' in parsed)) return null;
  if (!validArmorId(parsed.armor)) return null;
  if (!validPackId(parsed.pack)) return null;
  if (!validWeaponMask(parsed.weapons)) return null;
  return { armor: parsed.armor, pack: parsed.pack, weapons: parsed.weapons };
}

function validArmorId(armor: unknown): armor is ArmorId {
  // ARMORS is keyed by the enum's VALUES ('0'/'1'/'2'), so `armor in ARMORS` is exact
  // value membership -- no cast, and no name-key trap the way `in` on a numeric ENUM
  // object would have (see validPackId).
  return typeof armor === 'number' && armor in ARMORS;
}

function validPackId(pack: unknown): pack is PackId {
  // Enum membership by VALUE (LoadoutSelection.setPack's idiom): a numeric enum object's
  // keys are the names, so `pack in PackId` would test '0' and never match.
  const PACK_CHOICES: readonly number[] = [PackId.None, PackId.Repair, PackId.Energy];
  return typeof pack === 'number' && PACK_CHOICES.includes(pack);
}

function validWeaponMask(weapons: unknown): weapons is number {
  // The wire's own bound (decodeLoadout's 0x1f): only the five WeaponId bits are
  // meaningful, and favorites must never hold a bit the menu has no row for.
  return (
    typeof weapons === 'number' && Number.isInteger(weapons) && weapons >= 0 && weapons <= 0x1f
  );
}

/**
 * Pure selection state behind the station menu (#55), kept DOM-free for the node-environment
 * unit tests the same way hud.ts keeps describeHud pure. Every mutation re-sanitizes against
 * the CURRENT armor: switching armor unchecks weapons it disallows (Laser Rifle is
 * light-only, Mortar heavy-only -- sim/baseObjects.ts's allowedWeaponMask is the one gate
 * list, shared with the sim itself), and the set is capped at the armor's `maxWeapons`
 * (clampWeaponMask) so the menu can never hold a loadout the sim would truncate. `armor`
 * must be a real ArmorId; anything else is caller error and reads as Light, exactly like
 * the sim's own armorFor fallback.
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
    // The same two steps the sim applies to a wire mask (baseObjects.ts's
    // applyLoadoutSelection): sanitize to the armor's list, then cap to its slot count. A
    // stored set from a pre-#55 save (Light's four-weapon legacy table) prefills as what the
    // player will actually carry after Confirm, not as what the save holds.
    this.weapons = clampWeaponMask(choice.weapons & allowedWeaponMask(this.data), this.data);
  }

  setArmor(armor: ArmorId): void {
    this.armor = armor;
    this.data = ARMORS[armor];
    // Dropping to an armor that cannot carry a checked weapon unchecks it, exactly like the
    // source station re-filtering its item list around the selected armor; an armor with
    // fewer slots (Light's 3) drops the surplus picks the same way.
    this.weapons = clampWeaponMask(this.weapons & allowedWeaponMask(this.data), this.data);
  }

  setPack(pack: number): void {
    // Enum membership by VALUE: a numeric enum object's keys are the names, so `pack in
    // PackId` would test '0' and never match -- compare against the three values instead.
    if (pack === PackId.None || pack === PackId.Repair || pack === PackId.Energy) this.pack = pack;
  }

  /** Ticks a weapon on or off. An unselected weapon with no slot left is refused outright,
   *  never checked and then dropped later: the source station builds exactly `maxWeapons`
   *  weapon rows (`inventoryHud.cs:254-279`, `"Weapon Slot " @ %x + 1`) and its server keeps
   *  only the first `maxWeapons` of a client's picks (`hud.cs:349`), so a fourth Light pick
   *  has no slot to land in and the honest thing to show is a full rack, not a vanishing
   *  checkmark. Unchecking a selected weapon always works -- that is how a slot frees up. */
  toggleWeapon(weapon: number): void {
    const bit = 1 << weapon;
    if ((allowedWeaponMask(this.data) & bit) === 0) return;
    if ((this.weapons & bit) === 0 && this.slotCount >= this.data.maxWeapons) return;
    this.weapons ^= bit;
  }

  isWeaponAllowed(weapon: number): boolean {
    return (allowedWeaponMask(this.data) & (1 << weapon)) !== 0;
  }

  isWeaponSelected(weapon: number): boolean {
    return (this.weapons & (1 << weapon)) !== 0;
  }

  /** How many weapon slots the current set fills. */
  get slotCount(): number {
    let count = 0;
    for (let bit = 0; bit < WEAPON_COUNT; bit += 1) {
      if ((this.weapons & (1 << bit)) !== 0) count += 1;
    }
    return count;
  }

  /** The armor's own weapon-slot count (`ArmorData.maxWeapons`) -- the cap toggleWeapon
   *  enforces and the menu renders the slot counter against. */
  get slotCapacity(): number {
    return this.data.maxWeapons;
  }

  /** The current armor's hand-grenade grant (`ArmorData.grenadeCount`) -- the count the
   *  menu's grenade row renders. The sim has no grenade CHOICE to expose: it models
   *  exactly one thrown type (weapons.ts's tryThrowGrenade alt-fire) and grants this many
   *  of it on every loadout. */
  get grenadeCount(): number {
    return this.data.grenadeCount;
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
  // Favorites storage; defaults to this environment's localStorage, null when there is
  // none (favorites then read as never-saved and Confirm skips the save). Tests pass a
  // stub. Optional, so app.ts's three-argument call is unchanged.
  favorites: FavoritesStore | null = defaultFavoritesStore(),
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
  // The source station lists exactly one row per armor weapon slot (inventoryHud.cs:254-279,
  // `for (%x = 0; %x < %armor.maxWeapons; %x++)`, each labelled "Weapon Slot N"), so the
  // picker has to say how many slots this armor has and hold the player to them: ticking a
  // weapon the armor has no room for would be dropped by the sim on Confirm anyway
  // (baseObjects.ts's clampWeaponMask, from hud.cs:349).
  const slotLine = document.createElement('small');
  slotLine.id = 'station-weapon-slots';
  root.append(slotLine);
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

  // Grenade row (spec Client bullet "pick an armor, weapons, pack, and grenades"): present
  // but DISABLED, because that is the honest state of the wire. The sim models exactly one
  // thrown grenade type -- weapons.ts's tryThrowGrenade alt-fire, whose body rides the
  // firing weapon's id as ProjectileType.Grenade -- and every armor carries its own count
  // of it (ArmorData.grenadeCount, restocked by applyLoadoutSelection's resetLoadout).
  // There is no GrenadeId to pick, and protocol 11's LoadoutMessage (protocol/src/
  // messages.ts) is armor/pack/weapons only -- LOADOUT_MESSAGE_BYTES = 4, no grenade
  // field -- so a selectable row would promise a loadout slot the server can never honor.
  // Grenade selection needs a protocol bump first; this wave ships the disabled row
  // instead of inventing a field.
  const grenadeHeading = document.createElement('h3');
  grenadeHeading.textContent = 'Grenades';
  root.append(grenadeHeading);
  const grenadeBox = document.createElement('input');
  grenadeBox.type = 'checkbox';
  // Always carried, never chosen: checked and disabled rather than an empty grey row, so
  // the picker shows the state the sim actually grants.
  grenadeBox.checked = true;
  grenadeBox.disabled = true;
  const grenadeLabel = document.createElement('label');
  grenadeLabel.append(grenadeBox, ' Hand Grenade');
  root.append(grenadeLabel);
  const grenadeNote = document.createElement('small');
  grenadeNote.id = 'station-grenade-note';
  root.append(grenadeNote);

  // Clear favorites (the "save favorites" half of the spec needs a way back out): empties
  // the stored favorites so the next open prefills from the carried loadout. The
  // in-progress selection is deliberately untouched -- clearing is about future visits.
  const clearFavoritesButton = document.createElement('button');
  clearFavoritesButton.textContent = 'Clear favorites';
  clearFavoritesButton.disabled = favorites === null;
  clearFavoritesButton.addEventListener('click', () => {
    if (favorites === null) return;
    try {
      favorites.removeItem(FAVORITES_STORAGE_KEY);
    } catch {
      // A refusing store never held usable favorites, so the button's outcome stands.
    }
    clearFavoritesButton.disabled = true;
  });

  const confirm = document.createElement('button');
  confirm.textContent = 'Confirm';
  confirm.addEventListener('click', () => {
    if (!selection.confirmable) return;
    // Favorites save BEFORE the loadout leaves, best-effort: a refusing store (quota,
    // privacy mode) must never keep the player from applying the chosen loadout.
    if (favorites) {
      try {
        saveFavorites(favorites, selection.choice);
        clearFavoritesButton.disabled = false;
      } catch {
        // Storage unavailable: the loadout still applies; favorites are simply not kept.
      }
    }
    onConfirm(selection.choice);
  });
  root.append(confirm, clearFavoritesButton);
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
    const slotsUsed = selection.slotCount;
    const slotCapacity = selection.slotCapacity;
    slotLine.textContent = `Weapon slots ${String(slotsUsed)} / ${String(slotCapacity)}`;
    grenadeNote.textContent = `×${String(selection.grenadeCount)} carried -- granted by the armor, not chosen here.`;
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
    const full = slotsUsed >= slotCapacity;
    for (const weapon of Object.keys(weaponBoxes)) {
      const id = Number(weapon);
      const selected = selection.isWeaponSelected(id);
      weaponBoxes[id]!.checked = selected;
      // A full rack keeps the checked weapons clickable (unchecking is how a slot frees) and
      // greys out the rest, so the picker shows the refusal instead of dropping a tick.
      weaponBoxes[id]!.disabled = !selection.isWeaponAllowed(id) || (full && !selected);
    }
    confirm.disabled = !selection.confirmable;
  }

  return {
    // Idempotent per visit: re-showing while VISIBLE must not re-prefill. app.ts's frame
    // loop calls this every frame while the menu is open, and a per-frame re-prefill wiped
    // the player's in-progress picks between their armor click and Confirm -- the loadout
    // silently snapped back to the current one before the click could land
    // (e2e/menus.spec.ts's real-click flow caught this). Every NEW visit still prefills
    // from the current loadout because every close path goes through hide() first.
    show(choice: LoadoutChoice = LIGHT_DEFAULT): void {
      if (!root.hidden) return;
      // A saved favorites loadout prefills over the current carried one on every NEW
      // visit -- the source station opens on the client's own favorites string
      // (hud.cs:324-392). Corrupt or absent favorites fall through to the passed choice.
      const saved = favorites === null ? null : loadFavorites(favorites);
      selection = new LoadoutSelection(saved ?? choice);
      clearFavoritesButton.disabled = favorites === null || saved === null;
      syncSelection();
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
