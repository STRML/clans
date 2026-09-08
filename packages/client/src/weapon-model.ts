import * as THREE from 'three';
import { WeaponId, WeaponState, type World } from '@clans/sim';
import { createWeaponAnimation } from './weapon-animation.js';
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
  const animations = new Map<number, ReturnType<typeof createWeaponAnimation>>();
  let previousWeapon: number | undefined;
  let wasVisible = false;
  for (const [id, name] of Object.entries(WEAPON_SHAPES)) {
    const model = new THREE.Group();
    const fallback = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x777777 }),
    );
    fallback.position.z = -0.2;
    model.add(fallback);
    model.name = name;
    model.userData.weaponId = Number(id);
    model.visible = false;
    root.add(model);
    models.set(Number(id), model);
    loadShapeInto(model, name, Math.PI, (loaded, clips) => {
      loaded.updateWorldMatrix(true, true);
      const mount = loaded.getObjectByName('Mountpoint');
      if (mount) {
        const point = model.worldToLocal(mount.getWorldPosition(new THREE.Vector3()));
        loaded.position.sub(point);
      }
      // Presentation scale only; original mesh proportions and mount/muzzle direction stay intact.
      model.scale.setScalar(0.65);
      const animation = createWeaponAnimation(loaded, clips);
      animation.reset();
      animations.set(Number(id), animation);
    });
  }
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x39424b, 3));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(-1, 2, 1);
  scene.add(light);

  function sync(world: World, playerId: number, freeCam: boolean, dt = 0): void {
    root.visible =
      !freeCam &&
      !!world.players.alive[playerId] &&
      (world.players.mountedVehicleId[playerId] ?? -1) === -1;
    const weapon = world.players.weaponSlot[playerId];
    root.userData.weaponId = weapon;
    for (const [id, model] of models) model.visible = id === weapon;
    syncAnimation(world, playerId, weapon, dt);
  }

  function syncAnimation(
    world: World,
    playerId: number,
    weapon: number | undefined,
    dt: number,
  ): void {
    const animation = animations.get(weapon!);
    if (weapon !== previousWeapon || (root.visible && !wasVisible)) animation?.reset();
    if (root.visible)
      animation?.update(
        (world.players.weaponState[playerId] ?? WeaponState.Ready) as WeaponState,
        world.players.weaponTimer[playerId] ?? 0,
        dt,
        !!world.players.spunUp[playerId],
      );
    previousWeapon = weapon;
    wasVisible = root.visible;
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
      for (const animation of animations.values()) animation.dispose();
      for (const model of models.values()) disposeShape(model);
      root.clear();
    },
  };
}
