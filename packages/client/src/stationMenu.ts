import { ArmorId, stationAt, type World } from '@clans/sim';

export function stationMenuVisible(world: World, playerId: number, menuOpen: boolean): boolean {
  return menuOpen && stationAt(world, playerId) !== null;
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
): StationMenu {
  const root = document.createElement('div');
  root.id = 'station-menu';
  root.hidden = true;
  let selectedArmor = ArmorId.Light;
  let repairPack = false;
  for (const armor of [ArmorId.Light, ArmorId.Medium, ArmorId.Heavy] as const) {
    const button = document.createElement('button');
    button.textContent = ARMOR_LABEL[armor];
    button.addEventListener('click', () => {
      selectedArmor = armor;
    });
    root.appendChild(button);
  }
  const repairToggle = document.createElement('input');
  repairToggle.type = 'checkbox';
  repairToggle.addEventListener('change', () => {
    repairPack = repairToggle.checked;
  });
  root.appendChild(repairToggle);
  const confirm = document.createElement('button');
  confirm.textContent = 'Confirm';
  confirm.addEventListener('click', () => onConfirm(selectedArmor, repairPack));
  root.appendChild(confirm);
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
