import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
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
});
