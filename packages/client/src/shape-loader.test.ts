import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, expect, it, vi } from 'vitest';
import { disposeShape, loadShapeInto } from './shape-loader.js';

afterEach(() => vi.restoreAllMocks());

it('disposes shared geometry, materials, and textures exactly once', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture });
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const spies = [geometry, texture, material].map((resource) => vi.spyOn(resource, 'dispose'));
  disposeShape(root);
  for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  expect(root.children).toHaveLength(0);
});

it('disposes a late load instead of attaching it to a despawned vehicle', () => {
  const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
  const root = new THREE.Group();
  loadShapeInto(root, 'vehicle_wildcat');
  disposeShape(root);
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  const dispose = vi.spyOn(mesh.geometry, 'dispose');
  load.mock.calls[0]![1]({ scene } as never);
  expect(dispose).toHaveBeenCalledOnce();
  expect(root.children).toHaveLength(0);
});
