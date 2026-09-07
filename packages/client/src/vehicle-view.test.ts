import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { VehicleKind } from '@clans/sim';
import { createVehicleView } from './vehicle-view.js';
import { shapeUrl } from './assets.js';

const proceduralAssets = {
  scene: {
    vehicles: {
      shrike: { source: 'procedural' as const, shape: 'vehicle_shrike.glb' },
      wildcat: { source: 'procedural' as const, shape: 'vehicle_wildcat.glb' },
    },
  },
} as never;

const glbAssets = {
  scene: {
    vehicles: {
      shrike: { source: 'glb' as const, shape: 'vehicle_shrike.glb' },
      wildcat: { source: 'glb' as const, shape: 'vehicle_wildcat.glb' },
    },
  },
} as never;

describe('createVehicleView', () => {
  it('a procedural-tier vehicle renders a placeholder mesh, no glb load attempted', () => {
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load');
    const scene = new THREE.Scene();
    const view = createVehicleView(scene, proceduralAssets);
    view.sync([
      {
        id: 0,
        kind: VehicleKind.Shrike,
        team: 1,
        x: 5,
        y: 10,
        z: -5,
        yaw: 0,
        pitch: 0,
        roll: 0,
        energy: 280,
        damage: 0,
        destroyed: 0,
        driverId: -1,
      },
    ]);
    expect(view.meshes.size).toBe(1);
    const mesh = view.meshes.get(0);
    expect(mesh).toBeInstanceOf(THREE.Group);
    expect(mesh?.position.toArray()).toEqual([5, 10, -5]);
    expect(scene.children).toContain(mesh);
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  it('a glb-tier vehicle requests its real shape', () => {
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load');
    const scene = new THREE.Scene();
    const view = createVehicleView(scene, glbAssets);
    view.sync([
      {
        id: 0,
        kind: VehicleKind.Wildcat,
        team: 1,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        roll: 0,
        energy: 150,
        damage: 0,
        destroyed: 0,
        driverId: -1,
      },
    ]);
    expect(loadSpy).toHaveBeenCalledWith(
      shapeUrl('vehicle_wildcat'),
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
    loadSpy.mockRestore();
  });

  it('a destroyed vehicle removes its mesh from the scene (mirrors flag-view.ts)', () => {
    const scene = new THREE.Scene();
    const view = createVehicleView(scene, proceduralAssets);
    const data = {
      id: 0,
      kind: VehicleKind.Shrike,
      team: 1,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      energy: 0,
      damage: 1.4,
      destroyed: 0 as const,
      driverId: -1,
    };
    view.sync([data]);
    expect(view.meshes.size).toBe(1);
    const mesh = view.meshes.get(0);
    view.sync([{ ...data, destroyed: 1 }]);
    expect(view.meshes.size).toBe(0);
    expect(scene.children).not.toContain(mesh);
  });

  it('an id that simply stops appearing in the list is pruned the same way (disconnect/despawn)', () => {
    const scene = new THREE.Scene();
    const view = createVehicleView(scene, proceduralAssets);
    view.sync([
      {
        id: 0,
        kind: VehicleKind.Shrike,
        team: 1,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        roll: 0,
        energy: 0,
        damage: 0,
        destroyed: 0,
        driverId: -1,
      },
    ]);
    expect(view.meshes.size).toBe(1);
    view.sync([]);
    expect(view.meshes.size).toBe(0);
  });
});
