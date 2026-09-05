import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerSnapshotData } from '@clans/sim';
import { updateRemotes } from './app.js';
import { RemoteBuffer } from './remote.js';
import type { NetClient } from './netclient.js';

const snapshot: PlayerSnapshotData = {
  id: 1,
  team: 1,
  x: 10,
  y: 0,
  z: 5,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  energy: 60,
  onGround: 1,
  ski: 0,
};

describe('updateRemotes', () => {
  it('timestamps a pushed remote sample with the caller clock, not the server tick counter', () => {
    // Codex round 1 (PR #4): samples were timestamped with remoteTick * FIXED_TICK_MS
    // (the server's own tick counter, on a clock that starts whenever the server process
    // did) but RemoteBuffer.positionAt is later queried with the client's performance.now().
    // Those are unrelated epochs; a remote player either extrapolated forever or stuck to
    // a stale sample because renderTime never bracketed a sample timestamped that way.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const lastRemoteTick = { tick: 0 };
    const activeNet: Pick<NetClient, 'remoteTick' | 'remotePlayers' | 'connected'> = {
      remoteTick: 500, // a server tick count unrelated to any client-side clock reading
      remotePlayers: new Map([[1, snapshot]]),
      connected: true,
    };
    const nowMs = 123456; // an arbitrary performance.now() reading

    updateRemotes(activeNet, scene, meshes, buffers, lastRemoteTick, nowMs);

    const buffer = buffers.get(1);
    expect(buffer).toBeDefined();
    const samples = (buffer as unknown as { samples: Array<{ atMs: number }> }).samples;
    expect(samples[0]?.atMs).toBe(nowMs);
  });

  it('clears every remote buffer once the connection is no longer active, so pruning disposes their meshes', () => {
    // Codex round 2 (PR #4): remotePlayers only changes when a snapshot arrives, and
    // nothing else cleared it on disconnect, so a plain socket close left every remote
    // mesh (and the GPU resources behind it) stranded until the page tore down.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>();
    const lastRemoteTick = { tick: 0 };
    const fakeNet = {
      remoteTick: 1,
      remotePlayers: new Map([[1, snapshot]]),
      connected: true,
    };
    updateRemotes(fakeNet, scene, meshes, buffers, lastRemoteTick, 0);
    expect(buffers.has(1)).toBe(true);
    expect(scene.children).toHaveLength(1);

    fakeNet.connected = false;
    updateRemotes(fakeNet, scene, meshes, buffers, lastRemoteTick, 100);

    expect(buffers.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});
