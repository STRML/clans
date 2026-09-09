import * as THREE from 'three';
import { withVisibility } from './shape-animation.js';
import { TurretState } from '@clans/sim';

interface TurretPresentation {
  barrel: THREE.Object3D;
  base: THREE.Object3D | undefined;
  mounted: boolean;
  turn: THREE.Object3D | undefined;
  elevate: THREE.Object3D | undefined;
  restTurn: THREE.Quaternion | undefined;
  restElevate: THREE.Quaternion | undefined;
  mixer: THREE.AnimationMixer | undefined;
  fireActions: THREE.AnimationAction[];
  fireCount: number;
  state: number;
  lastAtMs: number;
  flash: THREE.PointLight | undefined;
  flashUntilMs: number;
}

function presentationOf(root: THREE.Object3D): TurretPresentation | undefined {
  return root.userData.turretPresentation as TurretPresentation | undefined;
}

/** Register the source barrel and, where present, its separate large-turret pedestal. */
export function prepareTurretPresentation(
  root: THREE.Object3D,
  barrel: THREE.Object3D,
  base?: THREE.Object3D,
): void {
  root.userData.turretPresentation = {
    barrel,
    base,
    mounted: false,
    turn: undefined,
    elevate: undefined,
    restTurn: undefined,
    restElevate: undefined,
    mixer: undefined,
    fireActions: [],
    fireCount: 0,
    state: TurretState.Ready,
    lastAtMs: 0,
    flash: undefined,
    flashUntilMs: 0,
  } satisfies TurretPresentation;
}

function mountParts(
  root: THREE.Object3D,
  presentation: TurretPresentation | undefined,
): { barrel: THREE.Object3D; base: THREE.Object3D } | undefined {
  const barrel = presentation ? presentation.barrel : root.children[0];
  const base = presentation ? presentation.base : root.children[1];
  if (!barrel || !base || presentation?.mounted) return undefined;
  return { barrel, base };
}

function alignMount(
  root: THREE.Object3D,
  barrel: THREE.Object3D,
  socket: THREE.Object3D,
  mount: THREE.Object3D,
): void {
  root.updateWorldMatrix(true, true);
  const socketInRoot = root.matrixWorld.clone().invert().multiply(socket.matrixWorld);
  const mountInBarrel = barrel.matrixWorld.clone().invert().multiply(mount.matrixWorld);
  socketInRoot
    .multiply(mountInBarrel.invert())
    .decompose(barrel.position, barrel.quaternion, barrel.scale);
  socket.attach(barrel);
}

function rememberArticulation(
  presentation: TurretPresentation | undefined,
  base: THREE.Object3D,
): void {
  if (!presentation) return;
  presentation.mounted = true;
  presentation.turn = base.getObjectByName('DumTurn');
  presentation.elevate = base.getObjectByName('DumElevate');
  presentation.restTurn = presentation.turn?.quaternion.clone();
  presentation.restElevate = presentation.elevate?.quaternion.clone();
}

/**
 * Align the barrel's authored mount point to the pedestal socket. Afterwards the barrel is a
 * child of Mount0, allowing the source turn/elevation linkage to move it while the pedestal
 * remains planted at its mission position.
 */
export function mountTurretBarrel(root: THREE.Object3D): void {
  const presentation = presentationOf(root);
  const parts = mountParts(root, presentation);
  if (!parts) return;
  const socket = parts.base.getObjectByName('Mount0');
  const mount = parts.barrel.getObjectByName('Mountpoint');
  if (!socket || !mount) return;
  alignMount(root, parts.barrel, socket, mount);
  rememberArticulation(presentation, parts.base);
  root.userData.barrelMounted = true;
}

/** Play the original Fire clips and locate their authored muzzle point for a brief flash. */
export function addTurretAnimations(
  root: THREE.Object3D,
  scene: THREE.Object3D,
  clips: THREE.AnimationClip[],
): void {
  const presentation = presentationOf(root);
  if (!presentation || presentation.mixer) return;
  presentation.mixer = new THREE.AnimationMixer(scene);
  presentation.fireActions = withVisibility(scene, clips)
    .filter((clip) => /^fire[12]?$/i.test(clip.name))
    .map((clip) => {
      const action = presentation.mixer!.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      return action;
    });
  const muzzle = scene.getObjectByName('Muzzlepoint') ?? scene.getObjectByName('Muzzlepoint_alt');
  if (muzzle) {
    const flash = new THREE.PointLight(0xffc36a, 0, 3, 2);
    flash.name = 'turret-muzzle-flash';
    muzzle.add(flash);
    presentation.flash = flash;
  }
}

function prepareSentryArticulation(presentation: TurretPresentation): void {
  if (presentation.base || presentation.turn || presentation.elevate) return;
  presentation.turn = presentation.barrel.getObjectByName('Dum_turn_collar_rotate');
  presentation.elevate = presentation.barrel.getObjectByName('Dum_elevate');
  presentation.restTurn = presentation.turn?.quaternion.clone();
  presentation.restElevate = presentation.elevate?.quaternion.clone();
}

function rotateInWorld(
  node: THREE.Object3D,
  rest: THREE.Quaternion,
  axis: THREE.Vector3,
  angle: number,
): THREE.Quaternion {
  const parentRotation =
    node.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  const localAxis = axis.clone().applyQuaternion(parentRotation.invert()).normalize();
  return new THREE.Quaternion().setFromAxisAngle(localAxis, angle).multiply(rest);
}

function neutralBarrel(root: THREE.Object3D, barrel: THREE.Object3D) {
  const mount = barrel.getObjectByName('Mountpoint') ?? barrel;
  const muzzle = barrel.getObjectByName('Muzzlepoint') ?? barrel.getObjectByName('Muzzlepoint_alt');
  const origin = mount.getWorldPosition(new THREE.Vector3());
  const forward = muzzle
    ? muzzle.getWorldPosition(new THREE.Vector3()).sub(origin).normalize()
    : new THREE.Vector3(0, 0, 1);
  const inverseRoot = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  return { origin, forward: forward.applyQuaternion(inverseRoot), inverseRoot };
}

function aimAt(
  root: THREE.Object3D,
  presentation: TurretPresentation,
  target: THREE.Vector3,
  dt: number,
): void {
  prepareSentryArticulation(presentation);
  if (
    !presentation.turn ||
    !presentation.elevate ||
    !presentation.restTurn ||
    !presentation.restElevate
  )
    return;
  const turnBefore = presentation.turn.quaternion.clone();
  const elevateBefore = presentation.elevate.quaternion.clone();
  presentation.turn.quaternion.copy(presentation.restTurn);
  presentation.elevate.quaternion.copy(presentation.restElevate);
  root.updateWorldMatrix(true, true);
  const { origin, forward, inverseRoot } = neutralBarrel(root, presentation.barrel);
  const direction = target.clone().sub(origin).applyQuaternion(inverseRoot);
  const yaw = Math.atan2(direction.x, direction.z);
  const neutralYaw = Math.atan2(forward.x, forward.z);
  const elevation =
    Math.atan2(direction.y, Math.hypot(direction.x, direction.z)) -
    Math.atan2(forward.y, Math.hypot(forward.x, forward.z));
  const rootRotation = inverseRoot.invert();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rootRotation);
  const turn = rotateInWorld(presentation.turn, presentation.restTurn, up, yaw - neutralYaw);
  presentation.turn.quaternion.copy(turn);
  root.updateWorldMatrix(true, true);
  const pitchAxis = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    .applyQuaternion(rootRotation)
    .cross(up);
  const elevate = rotateInWorld(
    presentation.elevate,
    presentation.restElevate,
    pitchAxis,
    elevation,
  );
  const blend = 1 - Math.exp(-12 * dt);
  presentation.turn.quaternion.copy(turnBefore).slerp(turn, blend);
  presentation.elevate.quaternion.copy(elevateBefore).slerp(elevate, blend);
}

/** Updates source articulation and firing clips from the replicated turret state. */
function elapsedPresentation(lastAtMs: number, now: number): number {
  return lastAtMs === 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (now - lastAtMs) / 1000));
}

export function syncTurretPresentation(
  root: THREE.Object3D,
  target: THREE.Vector3 | undefined,
  state: number,
): void {
  const presentation = presentationOf(root);
  if (!presentation) return;
  mountTurretBarrel(root);
  const now = performance.now();
  const dt = elapsedPresentation(presentation.lastAtMs, now);
  presentation.mixer?.update(dt);
  presentation.lastAtMs = now;
  if (target) aimAt(root, presentation, target, dt);
  if (state === TurretState.Firing && presentation.state !== TurretState.Firing) {
    const action =
      presentation.fireActions[presentation.fireCount % presentation.fireActions.length];
    for (const previous of presentation.fireActions) previous.stop();
    action?.reset().play();
    presentation.fireCount += 1;
    presentation.flashUntilMs = now + 80;
  }
  if (presentation.flash)
    presentation.flash.intensity =
      now < presentation.flashUntilMs ? (4 * (presentation.flashUntilMs - now)) / 80 : 0;
  presentation.state = state;
}
