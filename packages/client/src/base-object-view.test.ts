import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createBaseObjectView } from './base-object-view.js';

const stubAssets = {
  scene: {
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
    interiors: [],
    shapesForBaseObjectKind: { 0: 'station_generator_large' },
    shapesForTurretBarrel: { 2: 'turret_sentry' },
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
});
