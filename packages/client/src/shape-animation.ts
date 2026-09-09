import * as THREE from 'three';
/** DTS visibility tracks live in node extras because glTF has no visibility channel. */
export function withVisibility(
  root: THREE.Object3D,
  source: THREE.AnimationClip[],
): THREE.AnimationClip[] {
  const clips = new Map(source.map((clip) => [clip.name.toLowerCase(), clip.clone()]));
  root.traverse((node) => {
    for (const [key, value] of Object.entries(node.userData)) {
      if (!key.startsWith('vis_keyframes_') || !Array.isArray(value)) continue;
      const name = key.slice('vis_keyframes_'.length);
      const duration = Number(node.userData[`vis_duration_${name}`]);
      if (!(duration > 0) || value.length < 2) continue;
      const clip = clips.get(name) ?? new THREE.AnimationClip(name, duration, []);
      clip.tracks.push(
        new THREE.BooleanKeyframeTrack(
          `${node.uuid}.visible`,
          value.map((_, index) => (index * duration) / (value.length - 1)),
          value.map((visibility: number) => visibility > 0),
        ),
      );
      clip.duration = Math.max(clip.duration, duration);
      clips.set(name, clip);
    }
  });
  return [...clips.values()].map((clip) => {
    // Use the Float32 track endpoint so a clamped one-shot reaches its final off key.
    clip.resetDuration();
    return clip;
  });
}

/** Seek original DTS clips by simulation time, including late-loaded assets. */
export function poseShape(root: THREE.Object3D, name: string, seconds: number): void {
  const clips = root.userData.animationClips as THREE.AnimationClip[] | undefined;
  if (!clips) return;
  let animation = root.userData.shapeAnimation as ReturnType<typeof createAnimation> | undefined;
  if (!animation) {
    animation = createAnimation(root, clips);
    root.userData.shapeAnimation = animation;
  }
  animation.seek(name, seconds);
}

function createAnimation(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map(
    withVisibility(root, clips).map((clip) => [clip.name.toLowerCase(), mixer.clipAction(clip)]),
  );
  return {
    seek(name: string, seconds: number): void {
      const action = actions.get(name.toLowerCase());
      if (!action) return;
      action.play();
      action.paused = true;
      action.time = Math.min(Math.max(0, seconds), action.getClip().duration);
      mixer.update(0);
    },
    dispose(): void {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
