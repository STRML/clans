import { describe, expect, it } from 'vitest';
import { type World, WeaponId } from '@clans/sim';
import { createWeaponModel } from './weapon-model.js';

describe('first-person weapon', () => {
  it('tracks weapon selection and hides when dead, mounted, or in free camera', () => {
    const world = {
      players: {
        alive: [1],
        mountedVehicleId: [-1],
        weaponSlot: [WeaponId.Spinfusor],
      },
    } as unknown as World;
    const view = createWeaponModel();
    view.sync(world, 0, false);
    expect(view.root.visible).toBe(true);
    expect(view.root.userData.weaponId).toBe(WeaponId.Spinfusor);
    world.players.weaponSlot[0] = WeaponId.LaserRifle;
    view.sync(world, 0, false);
    expect(view.root.userData.weaponId).toBe(WeaponId.LaserRifle);
    view.sync(world, 0, true);
    expect(view.root.visible).toBe(false);
    world.players.mountedVehicleId[0] = 0;
    view.sync(world, 0, false);
    expect(view.root.visible).toBe(false);
    world.players.mountedVehicleId[0] = -1;
    world.players.alive[0] = 0;
    view.sync(world, 0, false);
    expect(view.root.visible).toBe(false);
    world.players.alive[0] = 1;
    view.sync(world, 0, false);
    expect(view.root.visible).toBe(true);
    view.dispose();
  });
});
