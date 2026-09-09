import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import decoderJs from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import decoderWasm from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import { shapeUrl } from './assets.js';

// Vite bundles both decoder files locally, including on the relative-base Pages build.
// Share a bounded worker pool across all structures, interiors, and vehicles.
const draco = new DRACOLoader()
  .setDecoderPath({ js: decoderJs, wasm: decoderWasm })
  .setWorkerLimit(2);
const loader = new GLTFLoader().setDRACOLoader(draco);

function disposeMeshes(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    geometries.add(node.geometry);
    const entries = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of entries) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/** Invalidate pending loads as well as freeing the currently displayed model. */
export function disposeShape(root: THREE.Object3D): void {
  root.userData.shapeDisposed = true;
  root.userData.shapeAnimation?.dispose();
  disposeMeshes(root);
  root.clear();
}

function prepareMaterial(material: THREE.Material): void {
  // glTF has no additive blend mode; preserve Torque's exported flag at runtime.
  const flags = material.userData.flag_names as string[] | undefined;
  if (flags?.includes('Additive')) {
    material.blending = THREE.AdditiveBlending;
    material.transparent = true;
    material.depthWrite = false;
  }
  if (!(material instanceof THREE.MeshStandardMaterial)) return;
  // DIF exports carry baked lighting in glTF's emissive texture / UV1.
  if (material.emissiveMap?.channel === 1) {
    material.lightMap = material.emissiveMap;
    material.lightMap.colorSpace = THREE.SRGBColorSpace;
    material.emissiveMap = null;
    material.needsUpdate = true;
  }
}

/** Retain the fallback on failure, but make the failing asset visible in diagnostics. */
export function loadShapeInto(
  root: THREE.Object3D,
  name: string | undefined,
  modelRotationY = 0,
  onLoad?: (scene: THREE.Group, animations: THREE.AnimationClip[]) => void,
): void {
  if (!name) return;
  const url = shapeUrl(name);
  root.userData.shapeUrl = url;
  root.userData.shapeStatus = 'loading';
  const fail = (error: unknown): void => {
    root.userData.shapeStatus = 'failed';
    console.error(`Shape load failed: ${url}`, error);
  };
  try {
    loader.load(
      url,
      (gltf) => {
        if (root.userData.shapeDisposed) {
          disposeMeshes(gltf.scene);
          return;
        }
        let hasMesh = false;
        gltf.scene.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            hasMesh = true;
            for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
              prepareMaterial(material);
            }
          }
          if (typeof node.userData.vis === 'number') node.visible = node.userData.vis > 0;
        });
        if (!hasMesh) {
          disposeMeshes(gltf.scene);
          fail(new Error('Shape contains no meshes'));
          return;
        }
        disposeMeshes(root);
        root.clear();
        // DIF interiors already match our basis. Unmounted DTS shapes need a half-turn:
        // upstream uses +PI/2 for shapes in its (y,z,x) world; our (x,z,-y) adds +PI/2.
        gltf.scene.applyMatrix4(new THREE.Matrix4().makeRotationY(modelRotationY));
        root.add(gltf.scene);
        root.userData.shapeStatus = 'loaded';
        root.userData.animationClips = gltf.animations;
        onLoad?.(gltf.scene, gltf.animations);
      },
      undefined,
      fail,
    );
  } catch (error) {
    fail(error);
  }
}
