import { canSendVehicleUse, stationAt, type World } from '@clans/sim';

export function interactionLabel(world: World, playerId: number): string {
  if (!world.players.alive[playerId] || world.gameOver) return '';
  if ((world.players.mountedVehicleId[playerId] ?? -1) !== -1) return 'Dismount vehicle';
  if (canSendVehicleUse(world, playerId)) return 'Mount vehicle';
  if (stationAt(world, playerId) !== null) return 'Inventory station';
  return '';
}

export function createInteractionPrompt(container: HTMLElement) {
  const root = document.createElement('div');
  root.id = 'interaction-prompt';
  root.hidden = true;
  const key = document.createElement('kbd');
  key.textContent = 'E';
  const text = document.createElement('span');
  root.append(key, text);
  container.append(root);
  return {
    update(world: World, playerId: number, hidden: boolean): void {
      const label = hidden ? '' : interactionLabel(world, playerId);
      root.dataset['piloting'] = String((world.players.mountedVehicleId[playerId] ?? -1) !== -1);
      root.hidden = !label;
      text.textContent = label;
    },
    dispose(): void {
      root.remove();
    },
  };
}
