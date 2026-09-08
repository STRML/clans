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
  disposeMeshes(root);
  root.clear();
}

/** Retain the fallback on failure, but make the failing asset visible in diagnostics. */
export function loadShapeInto(root: THREE.Object3D, name: string | undefined): void {
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
          if (node instanceof THREE.Mesh) hasMesh = true;
          if (typeof node.userData.vis === 'number') node.visible = node.userData.vis > 0;
        });
        if (!hasMesh) {
          disposeMeshes(gltf.scene);
          fail(new Error('Shape contains no meshes'));
          return;
        }
        disposeMeshes(root);
        root.clear();
        root.add(gltf.scene);
        root.userData.shapeStatus = 'loaded';
      },
      undefined,
      fail,
    );
  } catch (error) {
    fail(error);
  }
}
