import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { createBaseObjectView } from './base-object-view.js';
import { shapeUrl } from './assets.js';

const baseScene = {
  baseObjects: [
    { kind: 0, team: 1, position: [0, 0, 0] as [number, number, number] },
    {
      kind: 4,
      team: 1,
      position: [5, 2, 0] as [number, number, number],
      rotation: { axis: [0, 1, 0] as [number, number, number], degrees: 0 },
      scale: [1, 4, 6] as [number, number, number],
    },
  ],
  turrets: [{ barrel: 2, team: 1, position: [10, 0, 0] as [number, number, number] }],
  interiors: [] as Array<{
    shape: string;
    position: [number, number, number];
    rotation: { axis: [number, number, number]; degrees: number };
  }>,
  shapesForBaseObjectKind: { 0: 'station_generator_large' },
  shapesForTurretBarrel: { 2: 'turret_sentry' },
};

const stubAssets = { scene: baseScene } as never;

const stubAssetsWithInterior = {
  scene: {
    ...baseScene,
    interiors: [
      {
        shape: 'sbunk2',
        position: [1, 2, 3] as [number, number, number],
        rotation: { axis: [0, 1, 0] as [number, number, number], degrees: 45 },
      },
    ],
  },
} as never;

describe('createBaseObjectView', () => {
  it('places one mesh per base object and one per turret at their scene position', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    expect(view.baseObjectMeshes.size).toBe(2);
    expect(view.turretMeshes.size).toBe(1);
    const genMesh = view.baseObjectMeshes.get(0);
    expect(genMesh?.position.toArray()).toEqual([0, 0, 0]);
  });

  it('sync tints a destroyed base object and dims an unpowered one', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    view.sync([{ id: 0, damage: 1.5, destroyed: 1, powered: 0 }], []);
    const genMesh = view.baseObjectMeshes.get(0);
    expect(genMesh?.userData.destroyed).toBe(true);
  });

  it('sync aims a turret mesh at its target position', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    view.sync([], [{ id: 0, damage: 0, destroyed: 0, powered: 1, targetId: -1, state: 0 }]);
    const turretMesh = view.turretMeshes.get(0);
    expect(turretMesh).toBeDefined();
  });

  it('a force-field base object gets a translucent quad mesh, sized from its own scale, not a loaded shape', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    const fieldMesh = view.baseObjectMeshes.get(1);
    expect(fieldMesh).toBeInstanceOf(THREE.Mesh);
    expect(fieldMesh?.userData.isForceField).toBe(true);
    expect(fieldMesh?.position.toArray()).toEqual([5, 2, 0]);
  });

  it('sync fades a force field to zero opacity when it goes unpowered', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    view.sync([{ id: 1, damage: 0, destroyed: 0, powered: 0 }], []);
    const fieldMesh = view.baseObjectMeshes.get(1) as THREE.Mesh;
    const material = fieldMesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBe(0);
  });

  it('places one mesh per interior at its scene position and requests its real shape (Codex round 1, finding 6)', () => {
    // interior-collision.ts already loads collision for this same placement data (for
    // movement collision); before this fix, createBaseObjectView never created a visible mesh
    // for it at all, so every interior building was invisible geometry a player could walk
    // into the collision of but never see rendered.
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load');
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssetsWithInterior);
    expect(view.interiorMeshes.size).toBe(1);
    const mesh = view.interiorMeshes.get(0);
    expect(mesh).toBeInstanceOf(THREE.Object3D);
    expect(mesh?.position.toArray()).toEqual([1, 2, 3]);
    expect(scene.children).toContain(mesh);
    expect(loadSpy).toHaveBeenCalledWith(
      shapeUrl('sbunk2'),
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
    loadSpy.mockRestore();
  });

  it('an empty interiors list adds no interior meshes (existing base objects/turrets unaffected)', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    expect(view.interiorMeshes.size).toBe(0);
  });
});
