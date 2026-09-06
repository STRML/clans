import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventKind, type EventMessage, type ProjectileSnapshotData } from '@clans/protocol';
import {
  createLaserBeam,
  spawnExplosionsForExpired,
  spawnLaserBeams,
  syncProjectileMeshes,
  updateEffects,
  type Effect,
} from './weapons-view.js';

const disc = (id: number, x: number): ProjectileSnapshotData => ({
  id,
  type: 0,
  weaponId: 0,
  x,
  y: 1,
  z: 0,
  vx: 90,
  vy: 0,
  vz: 0,
  ownerId: 0,
});

describe('syncProjectileMeshes', () => {
  it('adds a mesh per projectile and removes it once the id disappears', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    syncProjectileMeshes(scene, meshes, [disc(1, 5)]);
    expect(scene.children).toHaveLength(1);
    expect(meshes.get(1)?.position.x).toBe(5);
    syncProjectileMeshes(scene, meshes, []);
    expect(scene.children).toHaveLength(0);
  });
});

describe('spawnExplosionsForExpired', () => {
  it('spawns one flash per projectile id that vanished between frames', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const previous = new Map([[1, disc(1, 5)]]);
    spawnExplosionsForExpired(scene, effects, previous, []);
    expect(effects).toHaveLength(1);
    expect(scene.children).toHaveLength(1);
  });

  it('spawns nothing for a projectile that is still present', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const previous = new Map([[1, disc(1, 5)]]);
    spawnExplosionsForExpired(scene, effects, previous, [disc(1, 6)]);
    expect(effects).toHaveLength(0);
  });
});

describe('spawnLaserBeams', () => {
  it('draws a beam between the shooter and the reported hit player', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const events: EventMessage[] = [{ type: 6, kind: EventKind.LaserFired, a: 1, b: 2 }];
    const positions = new Map([
      [1, { x: 0, y: 1.6, z: 0 }],
      [2, { x: 0, y: 1.15, z: 10 }],
    ]);
    spawnLaserBeams(scene, effects, events, (id) => positions.get(id) ?? null);
    expect(effects).toHaveLength(1);
    expect(scene.children).toHaveLength(1);
  });

  it('skips a miss (b === -1): there is no target position to draw to', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const events: EventMessage[] = [{ type: 6, kind: EventKind.LaserFired, a: 1, b: -1 }];
    spawnLaserBeams(scene, effects, events, () => ({ x: 0, y: 0, z: 0 }));
    expect(effects).toHaveLength(0);
  });

  it('ignores non-LaserFired events', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const events: EventMessage[] = [{ type: 6, kind: EventKind.PlayerKilled, a: 1, b: 2 }];
    spawnLaserBeams(scene, effects, events, () => ({ x: 0, y: 0, z: 0 }));
    expect(effects).toHaveLength(0);
  });
});

describe('updateEffects', () => {
  it('removes an effect from the scene once its ttl elapses', () => {
    const scene = new THREE.Scene();
    const mesh = createLaserBeam({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    scene.add(mesh);
    const effects: Effect[] = [{ mesh, ttl: 0.05 }];
    updateEffects(scene, effects, 0.03);
    expect(effects).toHaveLength(1);
    updateEffects(scene, effects, 0.03);
    expect(effects).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
  });
});
