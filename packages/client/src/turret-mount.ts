import * as THREE from 'three';
import { withVisibility } from './shape-animation.js';
import { TurretBaseId, TurretState, TURRET_BASE_DATA } from '@clans/sim';

/** Original muzzle-flash window (was 80 wall-clock ms) and the shared aim smoothing rate:
 *  each sync closes `1 - exp(-AIM_RATE * dt)` of the remaining joint error. */
const FLASH_DURATION_S = 0.08;
const AIM_RATE = 12;

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
  flashUntilSeconds: number;
  /** Presentation-time clock in seconds: advanced only by simulated, time-scaled deltas so a
   *  pause or time-scale change cannot desynchronize clips, flash or aim from the simulation. */
  elapsedSeconds: number;
  /** Source rotation limits as an elevation-from-horizontal band; see
   *  prepareTurretPresentation for the theta conversion. */
  minElevation: number;
  maxElevation: number;
}

function presentationOf(root: THREE.Object3D): TurretPresentation | undefined {
  return root.userData.turretPresentation as TurretPresentation | undefined;
}

/** Register the source barrel and, where present, its separate large-turret pedestal.
 *
 * The pedestal is also which rotation limits apply: base-object-view.ts only adds the
 * separate turret_base_large pedestal for the two large barrels (`placement.barrel !== 2`)
 * and sim turrets.ts's BASE_FOR_BARREL maps exactly those to TurretBaseId.Large, while the
 * pedestal-less barrel is always the sentry. Both source datablocks constrain theta --
 * turret.cs:150-192 ("elevation 15 to 140") and sentryTurret.cs:92-227 (thetaMin 89,
 * thetaMax 175) -- the angle between the turret's own up axis and the barrel direction, so
 * the elevation-from-horizontal band is [90 - thetaMax, 90 - thetaMin] degrees. Turn stays
 * unrestricted in both, as in the original.
 */
export function prepareTurretPresentation(
  root: THREE.Object3D,
  barrel: THREE.Object3D,
  base?: THREE.Object3D,
): void {
  const source = TURRET_BASE_DATA[base ? TurretBaseId.Large : TurretBaseId.Sentry];
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
    flashUntilSeconds: 0,
    elapsedSeconds: 0,
    minElevation: THREE.MathUtils.degToRad(90 - source.thetaMax),
    maxElevation: THREE.MathUtils.degToRad(90 - source.thetaMin),
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
  // Clamp the target direction's own elevation to the source band (see
  // prepareTurretPresentation for the theta conversion), keeping the authored neutral pitch
  // as the joint delta: a near-overhead or underfoot target then pins the barrel at the
  // limit instead of chasing it through the joints.
  const elevation =
    Math.min(
      Math.max(
        Math.atan2(direction.y, Math.hypot(direction.x, direction.z)),
        presentation.minElevation,
      ),
      presentation.maxElevation,
    ) - Math.atan2(forward.y, Math.hypot(forward.x, forward.z));
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
  const blend = 1 - Math.exp(-AIM_RATE * dt);
  presentation.turn.quaternion.copy(turnBefore).slerp(turn, blend);
  presentation.elevate.quaternion.copy(elevateBefore).slerp(elevate, blend);
}

/**
 * Presentation delta in seconds: explicit simulated time when the caller provides it
 * (unscaled seconds since this root's previous sync, scaled by `timeScale`), otherwise the
 * wall clock -- first sync takes one 60 Hz frame, and a long gap (paused tab, hidden
 * window) resumes clamped to 0.1 s so the presentation never jumps the whole gap.
 * `timeScale` 0 is a paused frame.
 */
function presentationDelta(
  presentation: TurretPresentation,
  options: TurretSyncOptions | undefined,
): number {
  const now = performance.now();
  const wallDt =
    presentation.lastAtMs === 0
      ? 1 / 60
      : Math.min(0.1, Math.max(0, (now - presentation.lastAtMs) / 1000));
  const dt = (options?.dt ?? wallDt) * (options?.timeScale ?? 1);
  presentation.lastAtMs = now;
  presentation.elapsedSeconds += Math.max(0, dt);
  return Math.max(0, dt);
}

/** No replicated target (idle or destroyed, whose snapshots both drop targetId): settle both
 *  joints back to their authored rest pose at the aim smoothing rate, instead of freezing
 *  wherever the last target left them. A repaired mount must also start moving again from
 *  this defined pose. */
function relaxTowardRest(presentation: TurretPresentation, dt: number): void {
  prepareSentryArticulation(presentation);
  if (
    !presentation.turn ||
    !presentation.elevate ||
    !presentation.restTurn ||
    !presentation.restElevate
  )
    return;
  const blend = 1 - Math.exp(-AIM_RATE * dt);
  presentation.turn.quaternion.slerp(presentation.restTurn, blend);
  presentation.elevate.quaternion.slerp(presentation.restElevate, blend);
}

export interface TurretSyncOptions {
  /** Unscaled seconds since this root's previous sync. */
  dt?: number;
  /** Simulation rate multiplier; 0 freezes the presentation (pause). */
  timeScale?: number;
}

/** Updates source articulation and firing clips from the replicated turret state.
 *
 * Presentation time advances in simulated seconds, not raw wall time: the render loop keeps
 * calling this while the simulation is paused or time-scaled (app.frame runs every rAF and
 * its sim advances by `app.paused ? 0 : app.timeScale` fixed steps), so the fire clips,
 * muzzle flash and aim smoothing must consume the same scaled seconds the simulation does
 * -- a wall-clock-only presentation keeps animating through a pause and plays its clips at
 * half the simulated rate at 2x. Callers that cannot pass a clock yet fall back to the wall
 * clock; pass `dt` (unscaled seconds since this root's previous sync) and `timeScale`
 * (`app.paused ? 0 : app.timeScale`) to pin the presentation to the simulation. */
export function syncTurretPresentation(
  root: THREE.Object3D,
  target: THREE.Vector3 | undefined,
  state: number,
  options?: TurretSyncOptions,
): void {
  const presentation = presentationOf(root);
  if (!presentation) return;
  mountTurretBarrel(root);
  const dt = presentationDelta(presentation, options);
  presentation.mixer?.update(dt);
  if (target) aimAt(root, presentation, target, dt);
  else relaxTowardRest(presentation, dt);
  if (state === TurretState.Firing && presentation.state !== TurretState.Firing) {
    const action =
      presentation.fireActions[presentation.fireCount % presentation.fireActions.length];
    for (const previous of presentation.fireActions) previous.stop();
    action?.reset().play();
    presentation.fireCount += 1;
    presentation.flashUntilSeconds = presentation.elapsedSeconds + FLASH_DURATION_S;
  }
  if (presentation.flash) {
    const remaining = presentation.flashUntilSeconds - presentation.elapsedSeconds;
    presentation.flash.intensity = remaining > 0 ? (4 * remaining) / FLASH_DURATION_S : 0;
  }
  presentation.state = state;
}
