import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerSnapshotData } from '@clans/sim';
import { RemoteBuffer, syncRemoteMeshes } from './remote.js';

const sample = (x: number, vx: number): PlayerSnapshotData => ({
  id: 1,
  team: 1,
  x,
  y: 0,
  z: 0,
  vx,
  vy: 0,
  vz: 0,
  yaw: 0,
  energy: 60,
  weaponSlot: 4,
  onGround: 1,
  ski: 0,
});

describe('RemoteBuffer', () => {
  it('linearly interpolates between two samples 100 ms behind the newest', () => {
    const buffer = new RemoteBuffer();
    buffer.push(0, sample(0, 0));
    buffer.push(100, sample(10, 0));
    expect(buffer.positionAt(150)?.x).toBeCloseTo(5);
  });

  it('extrapolates up to 50 ms past the newest sample using its velocity', () => {
    const buffer = new RemoteBuffer();
    buffer.push(0, sample(0, 20));
    expect(buffer.positionAt(200)?.x).toBeCloseTo(1);
  });

  it('returns null before any sample arrives', () => {
    expect(new RemoteBuffer().positionAt(0)).toBeNull();
  });

  it('snaps instead of smearing a straight line across a teleport (respawn or reused id)', () => {
    // Codex round 16 (PR #4): a respawn (falling out of the world) or a disconnected
    // player id reused by a new player before an intervening snapshot appended the new,
    // unrelated position straight onto the same history as the old one. positionAt()
    // then interpolated a straight line between them, so an observer saw the player
    // visibly slide from the old position to the spawn point instead of an instant snap.
    const buffer = new RemoteBuffer();
    buffer.push(0, sample(0, 0));
    buffer.push(50, sample(500, 0)); // far beyond any real movement in one tick
    expect(buffer.positionAt(60)?.x).toBeCloseTo(500);
  });

  it('keeps interpolating normally for ordinary movement well under the teleport threshold', () => {
    const buffer = new RemoteBuffer();
    buffer.push(0, sample(0, 0));
    buffer.push(100, sample(1, 0)); // 1 m in 100 ms: ordinary run speed, not a teleport
    expect(buffer.positionAt(150)?.x).toBeCloseTo(0.5);
  });
});

describe('syncRemoteMeshes', () => {
  it('adds a mesh per remote id and removes it once the id drops out', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>([[1, new RemoteBuffer()]]);
    buffers.get(1)?.push(0, sample(3, 0));

    syncRemoteMeshes(scene, meshes, buffers, 100);
    expect(scene.children).toHaveLength(1);
    expect(meshes.get(1)?.position.x).toBeCloseTo(3);

    buffers.delete(1);
    syncRemoteMeshes(scene, meshes, buffers, 100);
    expect(scene.children).toHaveLength(0);
  });

  it('disposes a pruned mesh geometry and material instead of leaking them', () => {
    // Codex round 1 (PR #4): pruning only removed the mesh from the scene and map;
    // geometry and material created for it stayed allocated, so a disconnect/rejoin
    // cycle across a match leaked GPU resources the garbage collector never reclaims.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>([[1, new RemoteBuffer()]]);
    buffers.get(1)?.push(0, sample(3, 0));
    syncRemoteMeshes(scene, meshes, buffers, 100);

    const mesh = meshes.get(1);
    if (!mesh || Array.isArray(mesh.material)) throw new Error('expected a single-material mesh');
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material, 'dispose');

    buffers.delete(1);
    syncRemoteMeshes(scene, meshes, buffers, 100);

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});
