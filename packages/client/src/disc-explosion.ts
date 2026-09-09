import * as THREE from 'three';
import { withVisibility, bindIflPlayback } from './shape-animation.js';
import { loadShapeInto } from './shape-loader.js';

const template = new THREE.Group();
let templateClips: THREE.AnimationClip[] = [];

/**
 * Preload the original DTS-derived effect once. A missing or still-loading template simply
 * lets the caller retain its ordinary impact fallback; no projectile ever starts a network
 * or model load of its own.
 */
if (typeof document !== 'undefined') {
  loadShapeInto(template, 'disc_explosion', Math.PI, (_scene, clips) => {
    templateClips = clips;
  });
}

export interface DiscExplosion {
  mesh: THREE.Group;
  ttl: number;
  update(dt: number, camera?: THREE.Camera): void;
  dispose(): void;
}

function cloneMaterials(root: THREE.Object3D): THREE.Material[] {
  const materials: THREE.Material[] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const source = Array.isArray(node.material) ? node.material : [node.material];
    const copies = source.map((material) => {
      const copy =
        material instanceof THREE.MeshStandardMaterial
          ? new THREE.MeshBasicMaterial({
              map: material.map,
              color: material.color,
              side: material.side,
              blending: THREE.AdditiveBlending,
              transparent: true,
              depthWrite: false,
              fog: false,
            })
          : material.clone();
      // The model's authored texture/color/blending remain intact; opacity is local to this
      // blast so concurrent explosions can fade independently.
      copy.transparent = true;
      materials.push(copy);
      return copy;
    });
    node.material = Array.isArray(node.material) ? copies : copies[0]!;
  });
  return materials;
}

function playAmbient(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const mixer = new THREE.AnimationMixer(root);
  const visibleClips = withVisibility(root, clips);
  // The exporter splits the DTS ambient sequence into a node-transform clip plus
  // per-node `ambient_<mesh>_frame` morph-weight companion clips (the blast wave's
  // 28-frame morph run). The name filter must keep both or the wave holds frame 0.
  const ambient = visibleClips.filter((clip) => /^ambient(_.+_frame)?$/i.test(clip.name));
  const selected = ambient.length > 0 ? ambient : visibleClips;
  let duration = 0.5;
  for (const clip of selected) {
    duration = Math.max(duration, clip.duration);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
  }
  return { mixer, duration };
}

/** Creates one face-viewer instance from the cached, authored `disc_explosion` GLB. */
export function createDiscExplosion(position: THREE.Vector3Like): DiscExplosion | null {
  if (template.userData.shapeStatus !== 'loaded') return null;
  const mesh = template.clone(true);
  mesh.name = 'disc-explosion';
  mesh.position.set(position.x, position.y, position.z);
  const materials = cloneMaterials(mesh);
  // Object3D.copy neither clones onBeforeRender handlers nor remaps them to the clone's
  // nodes, so the clone's IflMaterial meshes must rebind or the blue flash would hold
  // its first frame instead of playing blue00/disc00 with the ambient clip.
  mesh.traverse((node) => {
    if (node instanceof THREE.Mesh) bindIflPlayback(node);
  });
  const { mixer, duration } = playAmbient(mesh, templateClips);
  let disposed = false;

  // `faceViewer = true` in disc.cs. This runs with the render camera and avoids plumbing a
  // camera through every simulation-presentation update call.
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    mesh.quaternion.copy(camera.quaternion);
  };

  const effect: DiscExplosion = {
    mesh,
    ttl: duration,
    update(dt: number, camera?: THREE.Camera): void {
      if (disposed) return;
      if (camera) mesh.quaternion.copy(camera.quaternion);
      mixer.update(Math.max(0, dt));
      // The shared effects loop owns ttl, allowing this effect to share its pruning path with
      // flashes and beams while retaining an instance-local material fade.
      const opacity = duration > 0 ? Math.max(0, effect.ttl / duration) : 0;
      for (const material of materials) material.opacity = opacity;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      mixer.stopAllAction();
      mixer.uncacheRoot(mesh);
      mesh.onBeforeRender = () => {};
      for (const material of materials) material.dispose();
      mesh.removeFromParent();
    },
  };
  return effect;
}
