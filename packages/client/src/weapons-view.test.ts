import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
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
  armed: 1,
});

const mortarShell = (id: number, x: number): ProjectileSnapshotData => ({
  id,
  type: 1,
  weaponId: 2,
  x,
  y: 1,
  z: 0,
  vx: 0,
  vy: 20,
  vz: 0,
  ownerId: 1,
  armed: 0,
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

  it('rebuilds the mesh instead of reusing it when a recycled id gets a new projectile type', () => {
    // Codex review round 2 (PR #9), finding 8: the sim reuses freed projectile ids, so an
    // id surviving frame-to-frame is not proof it is the same projectile. A disc despawning
    // and a mortar shell being allocated the same id within one snapshot interval must not
    // reuse the disc's mesh -- that would render the mortar with the disc's geometry/color
    // at the mortar's position.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    syncProjectileMeshes(scene, meshes, [disc(1, 5)]);
    const discMesh = meshes.get(1);
    if (!discMesh) throw new Error('expected a mesh for the disc');
    const discGeometryDispose = vi.spyOn(discMesh.geometry, 'dispose');

    syncProjectileMeshes(scene, meshes, [mortarShell(1, 8)]);

    expect(discGeometryDispose).toHaveBeenCalledOnce();
    const shellMesh = meshes.get(1);
    expect(shellMesh).not.toBe(discMesh);
    expect(shellMesh?.position.x).toBe(8);
    expect(shellMesh?.geometry).not.toBe(discMesh.geometry);
    expect(scene.children).toHaveLength(1);
  });

  it('keeps the same mesh across frames when the id is not reused', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    syncProjectileMeshes(scene, meshes, [disc(1, 5)]);
    const mesh = meshes.get(1);
    syncProjectileMeshes(scene, meshes, [disc(1, 6)]);
    expect(meshes.get(1)).toBe(mesh);
    expect(mesh?.position.x).toBe(6);
  });

  it('disposes a pruned projectile mesh geometry and material instead of leaking them', () => {
    // Codex review round 1, finding 11 (PR #9): pruning only removed the mesh from the
    // scene and map; geometry and material created for it (createProjectileMesh) stayed
    // allocated, unlike the established convention elsewhere (remote.ts's disposeMesh,
    // flag-view.ts's disposeFlagGroup) -- a match with any sustained weapons fire leaks
    // WebGL resources the garbage collector never reclaims.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    syncProjectileMeshes(scene, meshes, [disc(1, 5)]);

    const mesh = meshes.get(1);
    if (!mesh || Array.isArray(mesh.material)) throw new Error('expected a single-material mesh');
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material, 'dispose');

    syncProjectileMeshes(scene, meshes, []);

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
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

  it('still flashes a died projectile whose id was immediately reused by a different type', () => {
    // Codex review round 2 (PR #9), finding 8: matching on id alone treated a recycled id
    // as "still present", so the old projectile's death never got its flash even though it
    // genuinely died -- a different projectile just happened to land on the same id in the
    // same snapshot interval.
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const previous = new Map([[1, disc(1, 5)]]);
    spawnExplosionsForExpired(scene, effects, previous, [mortarShell(1, 8)]);
    expect(effects).toHaveLength(1);
    expect(scene.children).toHaveLength(1);
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

  it('disposes an expired laser-beam effect instead of leaking its geometry and material', () => {
    // Codex review round 1, finding 11 (PR #9): same leak as the projectile mesh case,
    // for the other removal site in this file -- an expired effect (a laser beam Line, or
    // an explosion flash Mesh) left the scene but kept its GPU resources allocated.
    const scene = new THREE.Scene();
    const mesh = createLaserBeam({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    scene.add(mesh);
    if (Array.isArray(mesh.material)) throw new Error('expected a single-material line');
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material, 'dispose');

    const effects: Effect[] = [{ mesh, ttl: 0.01 }];
    updateEffects(scene, effects, 0.03);

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('disposes an expired explosion-flash effect instead of leaking its geometry and material', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const previous = new Map([[1, disc(1, 5)]]);
    spawnExplosionsForExpired(scene, effects, previous, []);
    const flash = effects[0];
    if (!flash || !(flash.mesh instanceof THREE.Mesh) || Array.isArray(flash.mesh.material)) {
      throw new Error('expected a single-material flash mesh');
    }
    const mesh = flash.mesh;
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material, 'dispose');

    flash.ttl = 0.01;
    updateEffects(scene, effects, 0.03);

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});
