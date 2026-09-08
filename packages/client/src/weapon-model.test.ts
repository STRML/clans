import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createWeaponAnimation } from './weapon-animation.js';
import { loadShapeInto } from './shape-loader.js';
import { type World, WeaponId, WeaponState } from '@clans/sim';
import { createWeaponModel } from './weapon-model.js';

vi.mock('./shape-loader.js', () => ({ loadShapeInto: vi.fn(), disposeShape: vi.fn() }));

describe('first-person weapon', () => {
  it('tracks weapon selection and hides when dead, mounted, or in free camera', () => {
    const world = {
      players: {
        alive: [1],
        weaponState: [WeaponState.Ready],
        weaponTimer: [0],
        spunUp: [0],
        mountedVehicleId: [-1],
        weaponSlot: [WeaponId.Spinfusor],
      },
    } as unknown as World;
    const view = createWeaponModel();
    expect(view.root.parent?.type).toBe('Scene');
    expect(view.root.children).toHaveLength(5);
    for (const model of view.root.children) expect(model.children[0]?.type).toBe('Mesh');
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

describe('original weapon animation playback', () => {
  it('spins the ready disc and plays exported muzzle visibility on firing', () => {
    const view = createWeaponModel();
    const loaded = new THREE.Group();
    const disc = new THREE.Group();
    disc.name = 'Disc';
    loaded.add(disc);
    const flash = new THREE.Group();
    flash.name = 'Flash';
    flash.visible = false;
    flash.userData = { vis: 0, vis_keyframes_fire: [0, 1, 0], vis_duration_fire: 0.3 };
    loaded.add(flash);
    const clip = new THREE.AnimationClip('discSpin', 1, [
      new THREE.NumberKeyframeTrack('Disc.rotation[z]', [0, 1], [0, Math.PI * 2]),
    ]);
    const call = vi.mocked(loadShapeInto).mock.calls.findLast((call) => call[1] === 'weapon_disc')!;
    call[0].add(loaded);
    call[3]!(loaded, [clip]);
    const world = {
      players: {
        alive: [1],
        mountedVehicleId: [-1],
        weaponSlot: [WeaponId.Spinfusor],
        weaponState: [WeaponState.Ready],
        weaponTimer: [0],
        spunUp: [0],
      },
    } as unknown as World;
    view.sync(world, 0, false, 0.1);
    expect(disc.rotation.z).toBeGreaterThan(0);
    world.players.weaponState[0] = WeaponState.Firing;
    world.players.weaponTimer[0] = 1;
    view.sync(world, 0, false, 0.2);
    expect(flash.visible).toBe(true);
    view.sync(world, 0, false, 0.2);
    expect(flash.visible).toBe(false);
    view.dispose();
  });
});

it('keeps barrel spin continuous across consecutive shots and clears it on reset', () => {
  const root = new THREE.Group();
  const barrel = new THREE.Group();
  barrel.name = 'Barrel';
  root.add(barrel);
  const spin = new THREE.AnimationClip('Spin', 1, [
    new THREE.NumberKeyframeTrack('Barrel.rotation[z]', [0, 1], [0, 1]),
  ]);
  const animation = createWeaponAnimation(root, [spin]);
  animation.reset();
  animation.update(WeaponState.Firing, 0.1, 0.1, true);
  expect(barrel.rotation.z).toBeCloseTo(0.1);
  animation.update(WeaponState.Firing, 0.15, 0.1, true);
  expect(barrel.rotation.z).toBeCloseTo(0.2);
  animation.reset();
  expect(barrel.rotation.z).toBe(0);
  animation.dispose();
});
