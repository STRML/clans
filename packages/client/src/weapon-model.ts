import * as THREE from 'three';
import { WeaponId, type World } from '@clans/sim';
import { disposeShape, loadShapeInto } from './shape-loader.js';

const WEAPON_SHAPES: Record<WeaponId, string> = {
  [WeaponId.Spinfusor]: 'weapon_disc',
  [WeaponId.Chaingun]: 'weapon_chaingun',
  [WeaponId.Mortar]: 'weapon_mortar',
  [WeaponId.LaserRifle]: 'weapon_sniper',
  [WeaponId.Blaster]: 'weapon_energy',
};

/** Original weapon meshes, mounted to their authored grip in a separate first-person scene. */
export function createWeaponModel() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 1, 0.01, 10);
  const root = new THREE.Group();
  root.name = 'first-person-weapon';
  root.position.set(0.26, -0.24, -0.4);
  scene.add(root);
  const models = new Map<number, THREE.Group>();
  for (const [id, name] of Object.entries(WEAPON_SHAPES)) {
    const model = new THREE.Group();
    model.name = name;
    model.userData.weaponId = Number(id);
    model.visible = false;
    root.add(model);
    models.set(Number(id), model);
    loadShapeInto(model, name, Math.PI, (loaded) => {
      loaded.updateWorldMatrix(true, true);
      const mount = loaded.getObjectByName('Mountpoint');
      if (mount) {
        const point = model.worldToLocal(mount.getWorldPosition(new THREE.Vector3()));
        loaded.position.sub(point);
      }
      // Presentation scale only; original mesh proportions and mount/muzzle direction stay intact.
      model.scale.setScalar(0.65);
    });
  }
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x39424b, 3));
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
    for (const [id, model] of models) model.visible = id === weapon;
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
      for (const model of models.values()) disposeShape(model);
      root.clear();
    },
  };
}
