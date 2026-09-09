import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { VehicleKind, type VehicleSnapshotData } from '@clans/sim';
import { createVehicleView, VehicleBuffer, vehicleRenderDataFrom } from './vehicle-view.js';
import { shapeUrl } from './assets.js';

// Codex review round 1 (this PR), finding 4 added six new required VehicleSnapshotData
// fields (vx/vy/vz, angVelYaw/Pitch/Roll, padId, weaponTimer, onGround, wasJumpHeld) that
// this file's own tests don't otherwise care about -- a shared, all-zero base keeps every
// call site below focused on the fields it's actually testing.
function vehicleData(overrides: Partial<VehicleSnapshotData>): VehicleSnapshotData {
  return {
    id: 0,
    kind: VehicleKind.Shrike,
    team: 1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    angVelYaw: 0,
    angVelPitch: 0,
    angVelRoll: 0,
    energy: 0,
    damage: 0,
    destroyed: 0,
    driverId: -1,
    padId: -1,
    weaponTimer: 0,
    onGround: 0,
    wasJumpHeld: 0,
    ...overrides,
  };
}

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
      vehicleData({ kind: VehicleKind.Shrike, team: 1, x: 5, y: 10, z: -5, energy: 280 }),
    ]);
    expect(view.meshes.size).toBe(1);
    const mesh = view.meshes.get(0);
    expect(mesh).toBeInstanceOf(THREE.Group);
    expect(mesh?.position.toArray()).toEqual([5, 10, -5]);
    expect(scene.children).toContain(mesh);
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  it('points its +Z nose along the flight heading, including positive climb pitch', () => {
    const view = createVehicleView(new THREE.Scene(), proceduralAssets);
    const yaw = 0.7,
      pitch = 0.3;
    view.sync([vehicleData({ yaw, pitch })]);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(view.meshes.get(0)!.quaternion);
    expect(forward.x).toBeCloseTo(Math.sin(yaw) * Math.cos(pitch));
    expect(forward.y).toBeCloseTo(Math.sin(pitch));
    expect(forward.z).toBeCloseTo(Math.cos(yaw) * Math.cos(pitch));
  });

  it('emits destruction feedback once for a visible vehicle, never for historical deaths', () => {
    const destroyed = vi.fn();
    const view = createVehicleView(new THREE.Scene(), proceduralAssets, destroyed);
    view.sync([vehicleData({ id: 1, destroyed: 1 })]);
    expect(destroyed).not.toHaveBeenCalled();
    view.sync([vehicleData({})]);
    view.sync([vehicleData({ destroyed: 1, damage: 1.4 })]);
    view.sync([vehicleData({ destroyed: 1, damage: 1.4 })]);
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('disposes vehicle geometry, fabrication effects, and pad mixers on teardown', () => {
    const scene = new THREE.Scene();
    const pad = new THREE.Group();
    const disposeMixer = vi.fn();
    pad.userData.shapeAnimation = { dispose: disposeMixer };
    const view = createVehicleView(scene, proceduralAssets, undefined, new Map([[0, pad]]));
    view.sync([vehicleData({ spawnTime: 4, padId: 0 })]);
    const mesh = view.meshes.get(0)!;
    const geometry = (mesh.children[0]!.children[0] as THREE.Mesh).geometry;
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const effect = scene.getObjectByName('vehicle-fabrication') as THREE.Mesh;
    const disposeEffect = vi.spyOn(effect.geometry, 'dispose');
    view.dispose();
    expect(disposeGeometry).toHaveBeenCalled();
    expect(disposeEffect).toHaveBeenCalledOnce();
    expect(disposeMixer).toHaveBeenCalledOnce();
    expect(view.meshes.size).toBe(0);
    expect(scene.children).toHaveLength(0);
    view.sync([vehicleData({})]);
    expect(view.meshes.size).toBe(0);
  });

  it('a glb-tier vehicle requests its real shape', () => {
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load');
    const scene = new THREE.Scene();
    const view = createVehicleView(scene, glbAssets);
    view.sync([vehicleData({ kind: VehicleKind.Wildcat, team: 1, energy: 150 })]);
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
    const data = vehicleData({ kind: VehicleKind.Shrike, team: 1, damage: 1.4, destroyed: 0 });
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
    view.sync([vehicleData({ kind: VehicleKind.Shrike, team: 1 })]);
    expect(view.meshes.size).toBe(1);
    view.sync([]);
    expect(view.meshes.size).toBe(0);
  });

  it('a reused id arriving as a different kind recreates the mesh instead of reusing the old one (issue #27)', () => {
    const scene = new THREE.Scene();
    const view = createVehicleView(scene, proceduralAssets);
    view.sync([vehicleData({ id: 3, kind: VehicleKind.Shrike, x: 10 })]);
    const shrikeMesh = view.meshes.get(3);
    expect(shrikeMesh).toBeDefined();
    // Same id, still alive, different kind: only id reuse produces this on the wire, and
    // the new vehicle must never render with the old one's mesh (issue #27).
    view.sync([vehicleData({ id: 3, kind: VehicleKind.Wildcat, x: 12 })]);
    const wildcatMesh = view.meshes.get(3);
    expect(wildcatMesh).toBeDefined();
    expect(wildcatMesh).not.toBe(shrikeMesh);
    expect(scene.children).not.toContain(shrikeMesh);
    expect(scene.children).toContain(wildcatMesh);
  });
});

// Codex review round 1 (this PR), finding 9: before VehicleBuffer existed, every OTHER
// vehicle on screen (never the locally-mounted one, which app.ts's placeVehicleCamera
// already reads live off world.vehicles) visibly snapped to a new position/orientation once
// per snapshot interval instead of smoothing through it, unlike remote players
// (remote.ts's own RemoteBuffer, which these tests deliberately mirror).
describe('VehicleBuffer', () => {
  it('linearly interpolates position/orientation between two samples 100 ms behind the newest', () => {
    const buffer = new VehicleBuffer();
    buffer.push(0, vehicleData({ x: 0, yaw: 0 }));
    buffer.push(100, vehicleData({ x: 10, yaw: 1 }));
    const pose = buffer.positionAt(150);
    expect(pose?.x).toBeCloseTo(5);
    expect(pose?.yaw).toBeCloseTo(0.5);
  });

  it('extrapolates up to 50 ms past the newest sample using its own velocity', () => {
    const buffer = new VehicleBuffer();
    buffer.push(0, vehicleData({ x: 0, vx: 20 }));
    expect(buffer.positionAt(200)?.x).toBeCloseTo(1);
  });

  it('returns null before any sample arrives', () => {
    expect(new VehicleBuffer().positionAt(0)).toBeNull();
  });

  it('latest() returns the newest sample unmodified, for the non-positional fields positionAt cannot supply', () => {
    const buffer = new VehicleBuffer();
    buffer.push(0, vehicleData({ energy: 100, damage: 0.2, driverId: 3 }));
    expect(buffer.latest()?.energy).toBe(100);
    expect(buffer.latest()?.damage).toBeCloseTo(0.2);
    expect(buffer.latest()?.driverId).toBe(3);
  });

  it('a same-id destroy/respawn resets history: the respawn does not interpolate from the wreck (issue #27)', () => {
    const buffer = new VehicleBuffer();
    buffer.push(0, vehicleData({ x: 100, destroyed: 1 }));
    // Same kind, respawned 5 m from the wreck -- under any teleport threshold, so only
    // the destroyed -> alive lifecycle boundary can catch this one.
    buffer.push(100, vehicleData({ x: 105 }));
    expect(buffer.positionAt(150)?.x).toBeCloseTo(105);
  });

  it('a kind change on a live id is reuse: history resets with no destroyed sample in between (issue #27)', () => {
    const buffer = new VehicleBuffer();
    buffer.push(0, vehicleData({ kind: VehicleKind.Shrike, x: 0 }));
    buffer.push(100, vehicleData({ kind: VehicleKind.Wildcat, x: 2 }));
    expect(buffer.positionAt(150)?.x).toBeCloseTo(2);
  });

  it('a respawn far from the last sample snaps instead of smearing even with no destroyed sample observed (issue #27)', () => {
    const buffer = new VehicleBuffer();
    buffer.push(0, vehicleData({ x: 0 }));
    buffer.push(100, vehicleData({ x: 100 }));
    expect(buffer.positionAt(150)?.x).toBeCloseTo(100);
  });

  it('an ordinary death keeps history: the wreck interpolates from where the vehicle actually was', () => {
    const buffer = new VehicleBuffer();
    buffer.push(0, vehicleData({ x: 0 }));
    buffer.push(100, vehicleData({ x: 10, destroyed: 1 }));
    expect(buffer.positionAt(150)?.x).toBeCloseTo(5);
  });
});

describe('vehicleRenderDataFrom', () => {
  it('excludes the locally-mounted vehicle id -- the caller supplies that one live off world.vehicles instead', () => {
    const buffers = new Map<number, VehicleBuffer>([
      [1, new VehicleBuffer()],
      [2, new VehicleBuffer()],
    ]);
    buffers.get(1)?.push(0, vehicleData({ id: 1 }));
    buffers.get(2)?.push(0, vehicleData({ id: 2 }));
    const out = vehicleRenderDataFrom(buffers, 0, 1);
    expect(out.map((v) => v.id)).toEqual([2]);
  });

  it('includes every buffered vehicle when nothing is locally mounted', () => {
    const buffers = new Map<number, VehicleBuffer>([[1, new VehicleBuffer()]]);
    buffers.get(1)?.push(0, vehicleData({ id: 1 }));
    const out = vehicleRenderDataFrom(buffers, 0, -1);
    expect(out.map((v) => v.id)).toEqual([1]);
  });
});
