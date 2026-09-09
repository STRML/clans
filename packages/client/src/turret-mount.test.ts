import * as THREE from 'three';
import { expect, it } from 'vitest';
import { TurretState } from '@clans/sim';
import {
  addTurretAnimations,
  mountTurretBarrel,
  prepareTurretPresentation,
  syncTurretPresentation,
} from './turret-mount.js';

it('aligns authored sockets through nested transforms, regardless of load order', () => {
  const root = new THREE.Group();
  root.position.set(10, 20, 30);
  root.rotation.y = 0.7;
  const barrel = new THREE.Group();
  const base = new THREE.Group();
  root.add(barrel, base);
  const socket = new THREE.Object3D();
  socket.name = 'Mount0';
  socket.position.set(0, 1.8, -0.4);
  socket.rotation.x = 0.2;
  base.add(socket);
  mountTurretBarrel(root);
  expect(root.userData.barrelMounted).toBeUndefined();
  const mount = new THREE.Object3D();
  mount.name = 'Mountpoint';
  mount.position.set(0, 0.35, 0);
  const nested = new THREE.Group();
  nested.rotation.y = 0.3;
  nested.add(mount);
  barrel.add(nested);
  mountTurretBarrel(root);
  root.updateMatrixWorld(true);
  const difference = mount
    .getWorldPosition(new THREE.Vector3())
    .distanceTo(socket.getWorldPosition(new THREE.Vector3()));
  expect(difference).toBeLessThan(1e-10);
  expect(
    mount
      .getWorldQuaternion(new THREE.Quaternion())
      .angleTo(socket.getWorldQuaternion(new THREE.Quaternion())),
  ).toBeLessThan(1e-6);
  const position = barrel.position.clone();
  mountTurretBarrel(root);
  expect(barrel.position).toEqual(position);
});

it('articulates the barrel at its authored socket without displacing the planted base', () => {
  const root = new THREE.Group();
  root.position.set(10, 0, 20);
  const barrel = new THREE.Group();
  const base = new THREE.Group();
  const turn = new THREE.Group();
  turn.name = 'DumTurn';
  const elevate = new THREE.Group();
  elevate.name = 'DumElevate';
  const socket = new THREE.Object3D();
  socket.name = 'Mount0';
  elevate.add(socket);
  turn.add(elevate);
  base.add(turn);
  const mount = new THREE.Object3D();
  mount.name = 'Mountpoint';
  barrel.add(mount);
  root.add(barrel, base);
  prepareTurretPresentation(root, barrel, base);
  syncTurretPresentation(root, new THREE.Vector3(30, 5, 50), TurretState.Ready);
  expect(root.position.toArray()).toEqual([10, 0, 20]);
  expect(base.parent).toBe(root);
  expect(barrel.parent).toBe(socket);
  expect(turn.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01);
});

it('plays a source Fire clip and flashes at its authored muzzle point', () => {
  const root = new THREE.Group();
  const barrel = new THREE.Group();
  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzlepoint';
  barrel.add(muzzle);
  root.add(barrel);
  prepareTurretPresentation(root, barrel);
  addTurretAnimations(root, barrel, [new THREE.AnimationClip('Fire', 0.1, [])]);
  syncTurretPresentation(root, undefined, TurretState.Firing);
  const flash = muzzle.getObjectByName('turret-muzzle-flash') as THREE.PointLight;
  expect(flash).toBeInstanceOf(THREE.PointLight);
  expect(flash.intensity).toBeGreaterThan(0);
});
