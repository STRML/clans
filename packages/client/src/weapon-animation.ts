import * as THREE from 'three';
import { FIXED_DT, WeaponState } from '@clans/sim';

import { withVisibility } from './shape-animation.js';

/** Local presentation only: follow simulated weapon states; never synthesize a shot from input. */
export function createWeaponAnimation(root: THREE.Object3D, source: THREE.AnimationClip[]) {
  const mixer = new THREE.AnimationMixer(root);
  const clips = withVisibility(root, source);
  const actions = new Map(clips.map((clip) => [clip.name.toLowerCase(), mixer.clipAction(clip)]));
  let previousState = -1;
  let previousTimer = 0;
  let activation = 0;

  function play(name: string, loop = false): THREE.AnimationAction | undefined {
    const action = actions.get(name);
    if (!action) return;
    action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.play();
    return action;
  }

  function startLoop(name: string): void {
    if (!actions.get(name)?.isRunning()) play(name, true);
  }

  function stopStateActions(): void {
    for (const [name, action] of actions) {
      if (name !== 'spin' && name !== 'ambient') action.stop();
    }
  }

  function enter(state: WeaponState): void {
    if (state === WeaponState.Reload && !actions.has('reload')) return;
    stopStateActions();
    startLoop('ambient');
    if (state === WeaponState.Ready) play('discspin', true);
    if (state === WeaponState.SpinUp) startLoop('spin');
    if (state === WeaponState.Firing) {
      if (!play('fire')) play('recoil');
      play('fire_vis');
      startLoop('spin');
    }
    if (state === WeaponState.Reload) play('reload');
  }

  return {
    reset(): void {
      mixer.stopAllAction();
      previousState = -1;
      previousTimer = 0;
      const primary = play('activation') ?? play('activate');
      activation = primary?.getClip().duration ?? 0;
    },
    update(state: WeaponState, timer: number, dt: number, spunUp: boolean): void {
      // A new firing timer also identifies consecutive Chaingun shots without an idle frame.
      const freshShot = state === WeaponState.Firing && timer > previousTimer + FIXED_DT;
      if (activation > 0 && state === WeaponState.Ready) {
        activation = Math.max(0, activation - dt);
      } else {
        activation = 0;
        if (state !== previousState || freshShot) enter(state);
        previousState = state;
      }
      previousTimer = timer;
      if (!spunUp && state !== WeaponState.Firing && state !== WeaponState.SpinUp)
        actions.get('spin')?.stop();
      mixer.update(dt);
    },
    dispose(): void {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
