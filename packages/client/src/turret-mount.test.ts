import * as THREE from 'three';
import { expect, it } from 'vitest';
import { mountTurretBarrel } from './turret-mount.js';

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
