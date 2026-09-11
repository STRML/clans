import { VehicleKind, armorFor, vehiclePadAt, type World } from '@clans/sim';

/** Mirrors stationMenu.ts's own stationMenuVisible shape exactly: visible only while both
 *  toggled open AND still in range of a usable pad -- closes itself the instant the player
 *  walks away, the same self-closing behavior M4 established for the station menu. */
export function vehiclePadMenuVisible(world: World, playerId: number, menuOpen: boolean): boolean {
  return menuOpen && vehiclePadAt(world, playerId) !== null;
}

/** T2 station.cs uses a 1.5 m wide, 2 m high entry trigger at the control station. */
export function vehicleStationTriggerAt(world: World, playerId: number): number | null {
  if (!world.players.alive[playerId] || (world.players.mountedVehicleId[playerId] ?? -1) !== -1)
    return null;
  const pad = vehiclePadAt(world, playerId);
  if (pad === null) return null;
  const p = playerId * 3,
    base = pad * 3;
  const dx = world.players.position[p]! - world.baseObjects.usePosition[base]!;
  const dy = world.players.position[p + 1]! - world.baseObjects.usePosition[base + 1]!;
  const dz = world.players.position[p + 2]! - world.baseObjects.usePosition[base + 2]!;
  // Circular footprint stays inside the original square regardless of mission yaw.
  return Math.hypot(dx, dz) <= 0.75 && dy + armorFor(world, playerId).boundingBox[2] >= 0 && dy <= 2
    ? pad
    : null;
}

export interface VehiclePadMenu {
  show(padId: number): void;
  hide(): void;
}

/** The picker's own order, and the digit-key order (kind n is key n, 1-based): every base
 *  kind in VehicleKind order. Names are each script's own targetNameTag, the same convention
 *  the Shrike/Wildcat labels already used. */
const VEHICLE_MENU_ORDER = [
  VehicleKind.Shrike,
  VehicleKind.Wildcat,
  VehicleKind.Bomber,
  VehicleKind.Havoc,
  VehicleKind.Tank,
  VehicleKind.MobilePointBase,
] as const;

const VEHICLE_LABEL: Record<VehicleKind, string> = {
  [VehicleKind.Shrike]: 'Shrike', // vehicles/vehicle_shrike.cs:219
  [VehicleKind.Wildcat]: 'Wildcat', // vehicles/vehicle_wildcat.cs:205
  [VehicleKind.Bomber]: 'Thundersword', // vehicles/vehicle_bomber.cs:310
  [VehicleKind.Havoc]: 'Havoc', // vehicles/vehicle_havoc.cs:172
  [VehicleKind.Tank]: 'Beowulf', // vehicles/vehicle_tank.cs:333
  [VehicleKind.MobilePointBase]: 'Jericho', // vehicles/vehicle_mpb.cs:242
};

/** Digit n (1-based) orders `VEHICLE_MENU_ORDER[n - 1]`; null for anything else, including
 *  a digit past the end of the list. */
function kindForDigit(code: string): VehicleKind | null {
  const match = /^Digit([1-9])$/.exec(code);
  if (!match) return null;
  return VEHICLE_MENU_ORDER[Number(match[1]) - 1] ?? null;
}

/** The station-like vehicle picker shown while standing in a powered pad's use
 *  radius -- same show/hide/button shape stationMenu.ts already established, keyed off
 *  BaseObjectKind.StationVehiclePad/VEHICLE_PAD_USE_RADIUS instead of
 *  StationInventory/STATION_USE_RADIUS. `show` takes the pad id every call (unlike the
 *  station menu, which has no equivalent "which station" concept to carry) so `onConfirm`
 *  can name it in the outgoing VehicleSpawn message. Offers every kind in
 *  VEHICLE_MENU_ORDER: the real station's per-pad removable-type flags are not modeled (see
 *  the issue report), so any powered pad can order any of the six. */
export function createVehiclePadMenu(
  container: HTMLElement,
  onConfirm: (padId: number, kind: VehicleKind) => void,
  onClose: () => void = () => {},
): VehiclePadMenu {
  const root = document.createElement('div');
  root.id = 'vehicle-pad-menu';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Vehicle station');
  const heading = document.createElement('h2');
  heading.textContent = 'Vehicle station';
  root.appendChild(heading);
  let currentPadId = -1;
  VEHICLE_MENU_ORDER.forEach((kind, index) => {
    const button = document.createElement('button');
    button.textContent = `${String(index + 1)} · ${VEHICLE_LABEL[kind]}`;
    button.setAttribute('aria-label', VEHICLE_LABEL[kind]);
    button.addEventListener('click', () => {
      if (currentPadId !== -1) onConfirm(currentPadId, kind);
    });
    root.appendChild(button);
  });
  root.addEventListener('keydown', (event) => {
    if (root.hidden || event.repeat) return;
    const kind = kindForDigit(event.code);
    if (kind === null || currentPadId === -1) return;
    event.preventDefault();
    event.stopPropagation();
    onConfirm(currentPadId, kind);
  });
  root.tabIndex = -1;
  const close = document.createElement('button');
  close.textContent = 'Close (Esc)';
  close.addEventListener('click', onClose);
  const help = document.createElement('small');
  help.textContent = 'Press 1-6 to order. Fabrication and automatic boarding take 6.5 seconds.';
  root.append(close, help);
  container.appendChild(root);
  return {
    show(padId: number): void {
      currentPadId = padId;
      if (root.hidden) {
        root.hidden = false;
        root.focus();
      }
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
