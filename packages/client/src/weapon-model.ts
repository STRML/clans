import * as THREE from 'three';
import { WeaponId, type World } from '@clans/sim';

/** Procedural presentation art; dimensions and colors have no gameplay effect. */
export function createWeaponModel() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 1, 0.01, 10);
  const root = new THREE.Group();
  root.name = 'first-person-weapon';
  root.position.set(0.28, -0.23, -0.55);
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x38454d, roughness: 0.6 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x55ccff, emissive: 0x123344 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.34), bodyMaterial);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.28, 12), accent);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.015, -0.25);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.18, 0.09), bodyMaterial);
  grip.position.set(0, -0.13, 0.08);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 16), accent);
  disc.position.set(0, 0.065, -0.06);
  root.add(body, barrel, grip, disc);
  scene.add(root, new THREE.HemisphereLight(0xdcefff, 0x39424b, 3));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(-1, 2, 1);
  scene.add(light);

  function sync(world: World, playerId: number, freeCam: boolean): void {
    root.visible =
      !freeCam &&
      !!world.players.alive[playerId] &&
      (world.players.mountedVehicleId[playerId] ?? -1) === -1;
    const weapon = world.players.weaponSlot[playerId];
    root.userData.weaponId = weapon;
    disc.visible = weapon === WeaponId.Spinfusor;
    barrel.scale.set(1, weapon === WeaponId.LaserRifle ? 1.8 : 1, 1);
    body.scale.set(weapon === WeaponId.Mortar ? 1.4 : 1, 1, 1);
  }

  return {
    root,
    sync,
    render(renderer: THREE.WebGLRenderer, aspect: number): void {
      if (!root.visible) return;
      if (camera.aspect !== aspect) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      }
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    },
    dispose(): void {
      for (const mesh of [body, barrel, grip, disc]) mesh.geometry.dispose();
      bodyMaterial.dispose();
      accent.dispose();
    },
  };
}
