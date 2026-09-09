import { ArmorId, armorFor, stationAt, type World } from '@clans/sim';

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

export interface StationMenu {
  show(): void;
  hide(): void;
}

const ARMOR_LABEL: Record<ArmorId, string> = {
  [ArmorId.Light]: 'Light',
  [ArmorId.Medium]: 'Medium',
  [ArmorId.Heavy]: 'Heavy',
};

export function createStationMenu(
  container: HTMLElement,
  onConfirm: (armor: ArmorId, repairPack: boolean) => void,
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
  let selectedArmor = ArmorId.Light;
  let repairPack = false;
  for (const armor of [ArmorId.Light, ArmorId.Medium, ArmorId.Heavy] as const) {
    const button = document.createElement('button');
    button.textContent = ARMOR_LABEL[armor];
    button.setAttribute('aria-pressed', String(armor === selectedArmor));
    button.addEventListener('click', () => {
      selectedArmor = armor;
      for (const option of root.querySelectorAll('[aria-pressed]'))
        option.setAttribute('aria-pressed', String(option === button));
    });
    root.appendChild(button);
  }
  const repairToggle = document.createElement('input');
  repairToggle.type = 'checkbox';
  repairToggle.addEventListener('change', () => {
    repairPack = repairToggle.checked;
  });
  const repairLabel = document.createElement('label');
  repairLabel.append(repairToggle, ' Repair Pack');
  root.appendChild(repairLabel);
  const confirm = document.createElement('button');
  confirm.textContent = 'Confirm';
  confirm.addEventListener('click', () => onConfirm(selectedArmor, repairPack));
  root.appendChild(confirm);
  const close = document.createElement('button');
  close.textContent = 'Close (Esc)';
  close.addEventListener('click', onClose);
  const help = document.createElement('small');
  help.textContent = 'Click the game after closing to resume mouse look.';
  root.append(close, help);
  container.appendChild(root);
  return {
    show(): void {
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
