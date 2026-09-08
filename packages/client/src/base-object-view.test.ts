import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBaseObjectView, raycastAimedStructure } from './base-object-view.js';
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

beforeEach(() => {
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('createBaseObjectView', () => {
  it('keeps every loaded mesh, its transform and material, replacing the fallback', () => {
    const view = createBaseObjectView(new THREE.Scene(), stubAssets);
    const loaded = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0xabcdef });
    const first = new THREE.Mesh(new THREE.BoxGeometry(), material);
    first.position.set(2, 3, 4);
    loaded.add(first, new THREE.Mesh(new THREE.SphereGeometry(), material));
    const onLoad = vi.mocked(GLTFLoader.prototype.load).mock.calls[0]![1];
    onLoad({ scene: loaded } as never);
    const root = view.baseObjectMeshes.get(0)!;
    expect(root.children).toEqual([loaded]);
    expect(first.position.toArray()).toEqual([2, 3, 4]);
    view.sync([{ id: 0, damage: 0, destroyed: 0, powered: 1 }], []);
    expect(first.material.color.getHex()).toBe(0xabcdef);
    expect(first.material.emissive.getHex()).toBe(0);
    view.sync([{ id: 0, damage: 1.5, destroyed: 1, powered: 0 }], []);
    expect(first.material.color.getHex()).toBe(0x1a1a1a);
    view.sync([{ id: 0, damage: 0, destroyed: 0, powered: 1 }], []);
    expect(first.material.color.getHex()).toBe(0xabcdef);
  });

  it('reports a failed shape URL and keeps the neutral fallback', () => {
    const error = new Error('decode failed');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = createBaseObjectView(new THREE.Scene(), stubAssets);
    vi.mocked(GLTFLoader.prototype.load).mock.calls[0]![3]!(error);
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining('station_generator_large.glb'),
      error,
    );
    const fallback = view.baseObjectMeshes.get(0)!.children[0] as THREE.Mesh;
    expect(fallback.geometry).toBeInstanceOf(THREE.BoxGeometry);
    expect((fallback.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0);
  });

  it('uses source visibility for intact, powered, and destroyed parts', () => {
    const view = createBaseObjectView(new THREE.Scene(), stubAssets);
    const loaded = new THREE.Group();
    const intact = new THREE.Mesh(new THREE.BoxGeometry());
    intact.userData.vis_keyframes_visibility = [1, 0];
    const wreck = new THREE.Mesh(new THREE.BoxGeometry());
    wreck.userData.vis_keyframes_visibility = [0, 1];
    const glow = new THREE.Mesh(new THREE.BoxGeometry());
    glow.userData.vis_keyframes_power = [0.25, 1];
    loaded.add(intact, wreck, glow);
    vi.mocked(GLTFLoader.prototype.load).mock.calls[0]![1]({ scene: loaded } as never);
    view.sync([{ id: 0, damage: 0, destroyed: 0, powered: 1 }], []);
    expect([intact.visible, wreck.visible, glow.visible]).toEqual([true, false, true]);
    view.sync([{ id: 0, damage: 0, destroyed: 0, powered: 0 }], []);
    expect(glow.visible).toBe(false);
    view.sync([{ id: 0, damage: 1, destroyed: 1, powered: 0 }], []);
    expect([intact.visible, wreck.visible, glow.visible]).toEqual([false, true, false]);
  });

  it('raycasts nested model parts back to their structure, excluding hidden parts', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    const loaded = new THREE.Group();
    const part = new THREE.Mesh(new THREE.BoxGeometry());
    loaded.add(part);
    vi.mocked(GLTFLoader.prototype.load).mock.calls[0]![1]({ scene: loaded } as never);
    scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const world = { baseObjects: { kind: [0], damage: [0] } } as never;
    expect(raycastAimedStructure(camera, view, world)?.name).toBe('Generator');
    part.visible = false;
    expect(raycastAimedStructure(camera, view, world)).toBeNull();
  });

  it('reports synchronous loader errors and empty decoded scenes', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(GLTFLoader.prototype.load).mockImplementationOnce(() => {
      throw new Error('bad URL');
    });
    const view = createBaseObjectView(new THREE.Scene(), stubAssets);
    expect(view.baseObjectMeshes.get(0)!.userData.shapeStatus).toBe('failed');
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining('station_generator_large'),
      expect.any(Error),
    );
    const turretCall = vi.mocked(GLTFLoader.prototype.load).mock.calls[1]!;
    turretCall[1]({ scene: new THREE.Group() } as never);
    expect(report).toHaveBeenLastCalledWith(
      expect.stringContaining('turret_sentry'),
      expect.any(Error),
    );
  });

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

  it('a force-field mesh geometry lies in the local YZ plane, matching the sim collider forceFieldQuad (closes #18)', () => {
    // sim/baseObjects.ts's forceFieldQuad has every vertex at local x = 0 (the collider
    // lies in the local YZ plane, normal along local +X). The stub placement's own
    // rotation is 0 degrees, so this reads the mesh's geometry directly, before any
    // placement.rotation transform, and would previously fail because PlaneGeometry's
    // untransformed default lies in the local XY plane (normal along +Z) instead.
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    const fieldMesh = view.baseObjectMeshes.get(1) as THREE.Mesh;
    const positionAttribute = fieldMesh.geometry.attributes.position;
    if (!positionAttribute) throw new Error('expected a position attribute');
    const positions = positionAttribute.array;
    const ys = new Set<number>();
    const zs = new Set<number>();
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]).toBeCloseTo(0);
      ys.add(Math.round((positions[i + 1] as number) * 100));
      zs.add(Math.round((positions[i + 2] as number) * 100));
    }
    // Not a degenerate single point -- the plane still spans real extent in y and z.
    expect(ys.size).toBeGreaterThan(1);
    expect(zs.size).toBeGreaterThan(1);
  });

  it('sync fades a force field to zero opacity when it goes unpowered', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    view.sync([{ id: 1, damage: 0, destroyed: 0, powered: 0 }], []);
    const fieldMesh = view.baseObjectMeshes.get(1) as THREE.Mesh;
    const material = fieldMesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBe(0);
    expect(fieldMesh.visible).toBe(false);
    view.sync([{ id: 1, damage: 0, destroyed: 0, powered: 1 }], []);
    expect(fieldMesh.visible).toBe(true);
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
