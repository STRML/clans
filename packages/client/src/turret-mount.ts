import * as THREE from 'three';

/** Align the barrel's authored mount point to the pedestal socket, once both decode. */
export function mountTurretBarrel(root: THREE.Object3D): void {
  if (root.userData.barrelMounted) return;
  const [barrel, base] = root.children;
  if (!barrel || !base) return;
  const socket = base.getObjectByName('Mount0');
  const mount = barrel.getObjectByName('Mountpoint');
  if (!socket || !mount) return;
  root.updateWorldMatrix(true, true);
  const socketInRoot = root.matrixWorld.clone().invert().multiply(socket.matrixWorld);
  const mountInBarrel = barrel.matrixWorld.clone().invert().multiply(mount.matrixWorld);
  socketInRoot
    .multiply(mountInBarrel.invert())
    .decompose(barrel.position, barrel.quaternion, barrel.scale);
  root.userData.barrelMounted = true;
}
