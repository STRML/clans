import { VehicleKind, vehiclePadAt, type World } from '@clans/sim';

/** Mirrors stationMenu.ts's own stationMenuVisible shape exactly: visible only while both
 *  toggled open AND still in range of a usable pad -- closes itself the instant the player
 *  walks away, the same self-closing behavior M4 established for the station menu. */
export function vehiclePadMenuVisible(world: World, playerId: number, menuOpen: boolean): boolean {
  return menuOpen && vehiclePadAt(world, playerId) !== null;
}

export interface VehiclePadMenu {
  show(padId: number): void;
  hide(): void;
}

const VEHICLE_LABEL: Record<VehicleKind, string> = {
  [VehicleKind.Shrike]: 'Shrike',
  [VehicleKind.Wildcat]: 'Wildcat',
};

/** The station-like Shrike/Wildcat picker shown while standing in a powered pad's use
 *  radius -- same show/hide/button shape stationMenu.ts already established, keyed off
 *  BaseObjectKind.StationVehiclePad/VEHICLE_PAD_USE_RADIUS instead of
 *  StationInventory/STATION_USE_RADIUS. `show` takes the pad id every call (unlike the
 *  station menu, which has no equivalent "which station" concept to carry) so `onConfirm`
 *  can name it in the outgoing VehicleSpawn message. */
export function createVehiclePadMenu(
  container: HTMLElement,
  onConfirm: (padId: number, kind: VehicleKind) => void,
): VehiclePadMenu {
  const root = document.createElement('div');
  root.id = 'vehicle-pad-menu';
  root.hidden = true;
  let currentPadId = -1;
  for (const kind of [VehicleKind.Shrike, VehicleKind.Wildcat] as const) {
    const button = document.createElement('button');
    button.textContent = VEHICLE_LABEL[kind];
    button.addEventListener('click', () => {
      if (currentPadId !== -1) onConfirm(currentPadId, kind);
    });
    root.appendChild(button);
  }
  container.appendChild(root);
  return {
    show(padId: number): void {
      currentPadId = padId;
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
