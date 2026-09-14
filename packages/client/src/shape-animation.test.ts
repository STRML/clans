import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { poseShape } from './shape-animation.js';

afterEach(() => vi.restoreAllMocks());

/** A clip whose pelvis track carries fewer values than its keys name -- the shape every
 *  shipped `<body>.glb` gives `JetFlare`/`Damage`: 11 keys against 2 VEC3 values, i.e. a
 *  stride of 6/11. */
function corruptClip(name: string): THREE.AnimationClip {
  const times = Array.from({ length: 11 }, (_, i) => i / 10);
  return new THREE.AnimationClip(name, 1, [
    new THREE.VectorKeyframeTrack('Bip01 Pelvis.position', times, [0, 0, 0, 1, 0, 0]),
  ]);
}

function goodClip(name: string): THREE.AnimationClip {
  return new THREE.AnimationClip(name, 1, [
    new THREE.VectorKeyframeTrack('Bip01 Pelvis.position', [0, 1], [0, 0, 0, 10, 0, 0]),
  ]);
}

describe('malformed keyframe tracks', () => {
  it('drops a corrupt track instead of wedging the mixer on it', () => {
    // three derives a track's valueSize from its own lengths, so 6 values over 11 keys is a
    // stride of 6/11 -- and PropertyMixer.saveOriginalState's accumulator copy loop
    // (`for (let i = stride, e = stride * this._origIndex; i !== e; ++ i)`, three.core.js)
    // only terminates when that end value is an exact multiple of the stride. It spins with
    // no allocation and no throw: the main thread simply stops. The shipped player GLBs had
    // exactly this track on Bip01 Pelvis under JetFlare/Damage, and because three shares one
    // PropertyMixer per track name within a mixer, the corrupt one owned the pelvis for
    // every clip -- so playing `root` or `forward` hung the client.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = new THREE.Group();
    const pelvis = new THREE.Object3D();
    pelvis.name = 'Bip01 Pelvis';
    root.add(pelvis);
    root.userData.animationClips = [corruptClip('JetFlare'), goodClip('root')];

    // Both seeks must return: a wedged mixer never gets here.
    poseShape(root, 'JetFlare', 0);
    poseShape(root, 'root', 1);

    expect(pelvis.position.x).toBeCloseTo(10); // the good track still poses the node
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('JetFlare');
  });

  it('leaves well-formed clips untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = new THREE.Group();
    const pelvis = new THREE.Object3D();
    pelvis.name = 'Bip01 Pelvis';
    root.add(pelvis);
    root.userData.animationClips = [goodClip('root')];

    poseShape(root, 'root', 0.5);

    expect(pelvis.position.x).toBeCloseTo(5);
    expect(warn).not.toHaveBeenCalled();
  });
});
