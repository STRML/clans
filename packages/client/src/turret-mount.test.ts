import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { TurretBarrelId, TurretState, baseFor } from '@clans/sim';
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

const STEP_S = 1 / 30;

/** Minimal source-shaped large turret: DumTurn/DumElevate/Mount0 linkage on the separate
 *  pedestal (base-object-view.ts's turret_base_large branch) and a barrel whose
 *  Mountpoint/Muzzlepoint pair points down +Z one metre ahead at rest. */
function largeTurret(rootAt?: [number, number, number]) {
  const root = new THREE.Group();
  if (rootAt) root.position.set(...rootAt);
  const barrel = new THREE.Group();
  const mount = new THREE.Object3D();
  mount.name = 'Mountpoint';
  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzlepoint';
  muzzle.position.set(0, 0, 1);
  barrel.add(mount, muzzle);
  const turn = new THREE.Group();
  turn.name = 'DumTurn';
  const elevate = new THREE.Group();
  elevate.name = 'DumElevate';
  const socket = new THREE.Object3D();
  socket.name = 'Mount0';
  elevate.add(socket);
  turn.add(elevate);
  const base = new THREE.Group();
  base.add(turn);
  root.add(barrel, base);
  prepareTurretPresentation(root, barrel, base);
  return { root, barrel, turn, elevate, mount, muzzle };
}

/** Same shape as the self-contained sentry: its linkage lives inside the barrel under the
 *  authored Dum_turn_collar_rotate/Dum_elevate names and never mounts onto a pedestal. */
function sentryTurret() {
  const root = new THREE.Group();
  const barrel = new THREE.Group();
  const turn = new THREE.Group();
  turn.name = 'Dum_turn_collar_rotate';
  const elevate = new THREE.Group();
  elevate.name = 'Dum_elevate';
  const mount = new THREE.Object3D();
  mount.name = 'Mountpoint';
  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzlepoint';
  muzzle.position.set(0, 0, 1);
  elevate.add(mount, muzzle);
  turn.add(elevate);
  barrel.add(turn);
  root.add(barrel);
  prepareTurretPresentation(root, barrel);
  return { root, barrel, turn, elevate, mount, muzzle };
}

/** Run sync at a fixed simulated step until the aim smoothing settles onto its fixed point
 *  (40 steps leaves ~1e-7 of the initial error). */
function settle(
  root: THREE.Object3D,
  target: THREE.Vector3,
  steps = 40,
  options?: { timeScale?: number },
): void {
  for (let i = 0; i < steps; i += 1) {
    syncTurretPresentation(root, target, TurretState.Ready, { dt: STEP_S, ...options });
  }
}

function muzzleDirection(root: THREE.Object3D, barrel: THREE.Object3D): THREE.Vector3 {
  root.updateWorldMatrix(true, true);
  const mount = barrel.getObjectByName('Mountpoint')!.getWorldPosition(new THREE.Vector3());
  return barrel
    .getObjectByName('Muzzlepoint')!
    .getWorldPosition(new THREE.Vector3())
    .sub(mount)
    .normalize();
}

/** The e2e turret-effects.spec.ts error metric: muzzle direction versus mount-to-target. */
function aimError(root: THREE.Object3D, barrel: THREE.Object3D, target: THREE.Vector3): number {
  const mount = barrel.getObjectByName('Mountpoint')!.getWorldPosition(new THREE.Vector3());
  return muzzleDirection(root, barrel).angleTo(target.clone().sub(mount).normalize());
}

/** Direction elevation above horizontal in the turret's own frame -- the quantity the
 *  source thetaMin/thetaMax band constrains. */
function barrelElevation(root: THREE.Object3D, barrel: THREE.Object3D): number {
  const inverseRoot = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  const direction = muzzleDirection(root, barrel).applyQuaternion(inverseRoot);
  return Math.atan2(direction.y, Math.hypot(direction.x, direction.z));
}

it('tracks a moving vehicle target with the AA barrel', () => {
  const turret = largeTurret([0, 30, 0]);
  turret.root.rotation.y = 0.4;
  // A Shrike-speed (40 m/s) crossing flyby 60 m off the mount's own line. The sim's
  // AABarrelLarge is vehiclesOnly (turrets.ts) and base-object-view.ts feeds these targets
  // through the -targetId - 2 vehicle key; the mount itself only sees the tracked position.
  const start = new THREE.Vector3(-120, 24, 60);
  const velocity = new THREE.Vector3(40, 0, 0);
  let worst = 0;
  let tracked = false;
  for (let i = 0; i < 240; i += 1) {
    const target = start.clone().addScaledVector(velocity, i * STEP_S);
    syncTurretPresentation(turret.root, target, TurretState.Ready, { dt: STEP_S });
    const error = aimError(turret.root, turret.barrel, target);
    if (i * STEP_S >= 2) {
      tracked = true;
      worst = Math.max(worst, error);
    }
  }
  expect(tracked).toBe(true);
  // The 12/s aim smoothing chasing a 40/60 rad/s crossing leaves ~3.2 degrees of lag.
  expect(worst).toBeLessThan(THREE.MathUtils.degToRad(5));
});

it('clamps the sentry to its source elevation band', () => {
  const turret = sentryTurret();
  const sentry = baseFor(TurretBarrelId.SentryTurretBarrel);
  // sentryTurret.cs:92-227 via TURRET_BASE_DATA: thetaMin 89 / thetaMax 175 -- barely above
  // horizontal down to 85 degrees below it. Targets past either end pin at the limit.
  const maxElevation = THREE.MathUtils.degToRad(90 - sentry.thetaMin);
  const minElevation = THREE.MathUtils.degToRad(90 - sentry.thetaMax);
  settle(turret.root, new THREE.Vector3(0, 40, 30)); // 53 degrees up
  expect(barrelElevation(turret.root, turret.barrel)).toBeCloseTo(maxElevation, 5);
  settle(turret.root, new THREE.Vector3(0, -40, 3)); // 85.7 degrees down
  expect(barrelElevation(turret.root, turret.barrel)).toBeCloseTo(minElevation, 5);
});

it('clamps angle extremes to the source rotation limits', () => {
  const turret = largeTurret();
  const large = baseFor(TurretBarrelId.PlasmaBarrelLarge);
  // turret.cs:150-192 via TURRET_BASE_DATA: thetaMin 15 / thetaMax 140 -- 75 degrees above
  // horizontal down to 50 below. A near-vertical target must not pull the barrel past the top.
  const maxElevation = THREE.MathUtils.degToRad(90 - large.thetaMin);
  const minElevation = THREE.MathUtils.degToRad(90 - large.thetaMax);
  settle(turret.root, new THREE.Vector3(0, 100, 2)); // ~89 degrees up, past thetaMin
  expect(barrelElevation(turret.root, turret.barrel)).toBeCloseTo(maxElevation, 5);
  settle(turret.root, new THREE.Vector3(0, -100, 2)); // ~89 degrees down, past thetaMax
  expect(barrelElevation(turret.root, turret.barrel)).toBeCloseTo(minElevation, 5);
  // The AA barrel shares the same Large pedestal band by construction.
  expect(baseFor(TurretBarrelId.AABarrelLarge)).toBe(large);
});

it('keeps aiming sane for a sub-metre target', () => {
  const turret = largeTurret();
  const near = new THREE.Vector3(0.4, 0.2, 0.3); // ~54 cm from the mount point
  settle(turret.root, near);
  expect(aimError(turret.root, turret.barrel, near)).toBeLessThan(1e-4);
  // A target at the mount point itself has no direction at all; the pose stays finite and
  // settles back at rest instead of producing NaN joints.
  settle(turret.root, new THREE.Vector3(0, 0, 0));
  for (const quaternion of [turret.turn.quaternion, turret.elevate.quaternion]) {
    for (const component of quaternion.toArray()) {
      expect(Number.isFinite(component)).toBe(true);
    }
  }
  expect(turret.turn.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
});

it('returns the mount to rest when destroyed and re-acquires after repair', () => {
  const turret = largeTurret();
  const target = new THREE.Vector3(20, -5, 10);
  const rest = new THREE.Quaternion();
  settle(turret.root, target);
  const deflected = turret.turn.quaternion.angleTo(rest);
  expect(deflected).toBeGreaterThan(0.1);
  // Destroyed snapshots drop targetId, so the view syncs with no target: one smoothing step
  // starts the return (a smooth settle, not a snap), and the pose ends exactly at rest.
  syncTurretPresentation(turret.root, undefined, TurretState.Ready, { dt: STEP_S });
  const halfway = turret.turn.quaternion.angleTo(rest);
  expect(halfway).toBeGreaterThan(0);
  expect(halfway).toBeLessThan(deflected);
  for (let i = 0; i < 40; i += 1) {
    syncTurretPresentation(turret.root, undefined, TurretState.Ready, { dt: STEP_S });
  }
  expect(turret.turn.quaternion.angleTo(rest)).toBeLessThan(1e-3);
  expect(turret.elevate.quaternion.angleTo(rest)).toBeLessThan(1e-3);
  // Repaired: the same target returns and the mount re-acquires it from the rest pose.
  settle(turret.root, target);
  expect(aimError(turret.root, turret.barrel, target)).toBeLessThan(1e-4);
});

it('freezes the animation through paused syncs instead of drifting ahead', () => {
  const turret = largeTurret();
  const target = new THREE.Vector3(-15, 25, 20);
  settle(turret.root, target, 2); // deliberately mid-transition
  addTurretAnimations(turret.root, turret.barrel, [new THREE.AnimationClip('Fire', 0.1, [])]);
  syncTurretPresentation(turret.root, target, TurretState.Firing, { dt: STEP_S });
  const flash = turret.muzzle.getObjectByName('turret-muzzle-flash') as THREE.PointLight;
  const turnPose = turret.turn.quaternion.clone();
  const elevatePose = turret.elevate.quaternion.clone();
  for (let i = 0; i < 10; i += 1) {
    syncTurretPresentation(turret.root, target, TurretState.Firing, {
      dt: STEP_S,
      timeScale: 0,
    });
  }
  expect(turret.turn.quaternion.angleTo(turnPose)).toBe(0);
  expect(turret.elevate.quaternion.angleTo(elevatePose)).toBe(0);
  // Frozen mid-flash: presentation time stopped, so the decay cannot run on wall time.
  // 4 within float error of the 0.1 s + 0.08 s presentation-time bookkeeping.
  expect(flash.intensity).toBeCloseTo(4, 12);
  // Control: the very next live step does move, so the freeze came from the pause itself.
  syncTurretPresentation(turret.root, target, TurretState.Ready, { dt: STEP_S });
  expect(turret.turn.quaternion.angleTo(turnPose)).toBeGreaterThan(0);
});

it('follows simulated time across time-scale changes', () => {
  const direct = largeTurret();
  const scaled = largeTurret();
  const target = new THREE.Vector3(-25, 10, 15);
  // The same simulated second: one client at 1x, one at 0.5x with twice the frames.
  settle(direct.root, target, 30);
  settle(scaled.root, target, 60, { timeScale: 0.5 });
  expect(direct.turn.quaternion.angleTo(scaled.turn.quaternion)).toBeLessThan(1e-4);
  expect(direct.elevate.quaternion.angleTo(scaled.elevate.quaternion)).toBeLessThan(1e-4);
  // The muzzle flash decays on presentation time too: fire both with the flash anchored at
  // elapsed 0.04 s, then compare after 40 ms more of simulated time.
  addTurretAnimations(direct.root, direct.barrel, [new THREE.AnimationClip('Fire', 0.1, [])]);
  addTurretAnimations(scaled.root, scaled.barrel, [new THREE.AnimationClip('Fire', 0.1, [])]);
  syncTurretPresentation(direct.root, undefined, TurretState.Ready, { dt: 0.02 });
  syncTurretPresentation(direct.root, undefined, TurretState.Firing, { dt: 0.02 });
  for (let i = 0; i < 3; i += 1) {
    syncTurretPresentation(scaled.root, undefined, TurretState.Ready, {
      dt: 0.02,
      timeScale: 0.5,
    });
  }
  syncTurretPresentation(scaled.root, undefined, TurretState.Firing, {
    dt: 0.02,
    timeScale: 0.5,
  });
  for (let i = 0; i < 2; i += 1) {
    syncTurretPresentation(direct.root, undefined, TurretState.Firing, { dt: 0.02 });
  }
  for (let i = 0; i < 4; i += 1) {
    syncTurretPresentation(scaled.root, undefined, TurretState.Firing, {
      dt: 0.02,
      timeScale: 0.5,
    });
  }
  const flashDirect = direct.muzzle.getObjectByName('turret-muzzle-flash') as THREE.PointLight;
  const flashScaled = scaled.muzzle.getObjectByName('turret-muzzle-flash') as THREE.PointLight;
  expect(flashDirect.intensity).toBeCloseTo(flashScaled.intensity, 9);
});

it('clamps a wall-clock pause gap on resume', () => {
  const clock = vi.spyOn(performance, 'now');
  clock.mockReturnValue(1000);
  const wall = largeTurret();
  const reference = largeTurret();
  const target = new THREE.Vector3(30, 5, 40);
  // Two healthy frames on both: the wall-clock path defaults to 1/60 then takes 10 ms.
  syncTurretPresentation(wall.root, target, TurretState.Ready);
  clock.mockReturnValue(1010);
  syncTurretPresentation(wall.root, target, TurretState.Ready);
  syncTurretPresentation(reference.root, target, TurretState.Ready, { dt: 1 / 60 });
  syncTurretPresentation(reference.root, target, TurretState.Ready, { dt: 0.01 });
  // A ~4 s paused gap must resume clamped to 0.1 s of presentation time, not the whole gap.
  clock.mockReturnValue(5000);
  syncTurretPresentation(wall.root, target, TurretState.Ready);
  syncTurretPresentation(reference.root, target, TurretState.Ready, { dt: 0.1 });
  // angleTo floors at ~3e-8 even for identical quaternions (acos of a 1-ulp-short dot), so
  // assert the components themselves: the clamped resume must be bit-identical to the
  // explicit-dt reference.
  expect(wall.turn.quaternion.toArray()).toEqual(reference.turn.quaternion.toArray());
  expect(wall.elevate.quaternion.toArray()).toEqual(reference.elevate.quaternion.toArray());
});

afterEach(() => {
  vi.restoreAllMocks();
});
