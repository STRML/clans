import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EventKind, type EventMessage, type ProjectileSnapshotData } from '@clans/protocol';
import {
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  type ProjectileImpact,
} from '@clans/sim';
import {
  createLaserBeam,
  createProjectileMesh,
  spawnLaserBeams,
  spawnProjectileImpacts,
  syncProjectileMeshes,
  updateEffects,
  type Effect,
} from './weapons-view.js';

const discImpact = (over: Partial<ProjectileImpact>): ProjectileImpact => ({
  x: 5,
  y: 1,
  z: 0,
  weaponId: WeaponId.Spinfusor,
  type: ProjectileType.Linear,
  reason: ProjectileImpactReason.Direct,
  seq: 1,
  ...over,
});

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
  it('orients Shrike bolts along velocity and renders chaingun as a narrow tracer', () => {
    const shrike = createProjectileMesh({
      ...disc(1, 0),
      type: 4,
      weaponId: 1,
      vx: 0,
      vy: 0,
      vz: 100,
    });
    expect(shrike.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect((shrike.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xffffff);
    expect((shrike.material as THREE.MeshBasicMaterial).blending).toBe(THREE.AdditiveBlending);
    expect(shrike.getObjectByName('tracer-head')).toBeInstanceOf(THREE.Mesh);
    const shrikeGeometry = shrike.geometry as THREE.PlaneGeometry;
    expect(shrikeGeometry.parameters.height).toBeGreaterThan(shrikeGeometry.parameters.width);
    const tracer = createProjectileMesh({ ...disc(2, 0), type: 1, weaponId: 1 });
    expect(tracer.getObjectByName('tracer-ribbon')).toBeInstanceOf(THREE.Mesh);
    expect((tracer.geometry as THREE.PlaneGeometry).parameters.width).toBe(0.1);
  });

  it('keeps a bounded, position-following history trail for bouncing blaster bolts', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const bolt = { ...disc(1, 0), type: 3, weaponId: 4, vx: 10 };
    syncProjectileMeshes(scene, meshes, [bolt], 0.05);
    syncProjectileMeshes(scene, meshes, [{ ...bolt, x: 1 }], 0.05);
    const trail = meshes.get(1)?.getObjectByName('projectile-trail') as THREE.Line;
    expect(trail.geometry.getAttribute('position').count).toBe(2);
    syncProjectileMeshes(scene, meshes, [{ ...bolt, x: 10 }], 0.25);
    expect((meshes.get(1)?.userData.history as unknown[]).length).toBe(1);
  });

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

  it('keeps pitched discs level and forward at every cardinal flight heading', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const headings = [
      [20, 4, 0],
      [0, 4, 20],
      [-20, 4, 0],
      [0, 4, -20],
    ] as const;
    for (const [index, [vx, vy, vz]] of headings.entries()) {
      const projectile = { ...disc(index, 0), vx, vy, vz };
      syncProjectileMeshes(scene, meshes, [projectile], 0);
      const mesh = meshes.get(index);
      if (!mesh) throw new Error('expected disc mesh');
      const velocity = new THREE.Vector3(vx, vy, vz).normalize();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(mesh.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
      const levelUp = new THREE.Vector3(0, 1, 0).projectOnPlane(velocity).normalize();
      expect(forward.angleTo(velocity)).toBeLessThan(1e-6);
      expect(up.angleTo(levelUp)).toBeLessThan(1e-6);
    }
  });

  it('matches the source disc plate size and keeps its plate level while spinning at range', () => {
    // t2-mapper's disc.glb (disc.cs projectileShapeName = "disc.dts"): the Disc plate
    // mesh spans x/z ±0.408, y ±0.031. Distances 5/30/90 m stress the same orientation
    // math a viewer sees at short brick throws and long-range spars. The spin advances
    // the rim only -- a spinning plate's invariants are its normal (level, projected
    // world up) and its rim staying in the flight plane, never a fixed rim heading.
    const projectile = createProjectileMesh(disc(1, 0));
    const geometry = projectile.geometry as THREE.CylinderGeometry;
    expect(geometry.parameters.radiusTop).toBeCloseTo(0.408);
    expect(geometry.parameters.height).toBeCloseTo(0.062);
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    for (const distance of [5, 30, 90]) {
      for (const [index, [vx, vy, vz]] of (
        [
          [20, 4, 0],
          [0, 4, 20],
          [-20, 4, 0],
          [0, 4, -20],
        ] as const
      ).entries()) {
        const bolt = { ...disc(index, (vx * distance) / 20), y: 4, vx, vy, vz };
        for (let frame = 0; frame < 5; frame += 1) {
          syncProjectileMeshes(scene, meshes, [bolt], 1 / 60);
          const mesh = meshes.get(index)!;
          const velocity = new THREE.Vector3(vx, vy, vz).normalize();
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(mesh.quaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
          const levelUp = new THREE.Vector3(0, 1, 0).projectOnPlane(velocity).normalize();
          expect(up.angleTo(levelUp)).toBeLessThan(1e-4);
          expect(forward.angleTo(levelUp)).toBeCloseTo(Math.PI / 2, 5);
        }
      }
    }
  });

  it('alternates the Shrike bolt tail between two distinct twin-muzzle origins', () => {
    // vehicle_shrike.cs mounts the blaster image pair at x ±1.93 and %obj.nextWeaponFire
    // alternates the slots per shot; the sim has no per-side origins, so the client
    // shears the bolt's visible tail (head stays on the authoritative flight path). The
    // shear reads as the average of the two tail corners -- the ribbon's own half-width
    // offsets cancel out, keeping the check independent of vertex order and module state.
    const tailShear = (geometry: THREE.BufferGeometry): THREE.Vector2 => {
      const position = geometry.getAttribute('position');
      const corners: Array<[number, number]> = [];
      for (let vertex = 0; vertex < position.count; vertex += 1) {
        if (position.getZ(vertex) > 0) corners.push([position.getX(vertex), position.getY(vertex)]);
      }
      expect(corners.length).toBe(2);
      return new THREE.Vector2(
        (corners[0]![0] + corners[1]![0]) / 2,
        (corners[0]![1] + corners[1]![1]) / 2,
      );
    };
    const first = createProjectileMesh({ ...disc(1, 0), type: 4, weaponId: 1 });
    const second = createProjectileMesh({ ...disc(2, 0), type: 4, weaponId: 1 });
    const firstTail = tailShear(first.geometry);
    const secondTail = tailShear(second.geometry);
    // Two distinct origins on opposite wings, both lifted by the source's +0.044 z offset.
    expect(firstTail.x).toBeCloseTo(-secondTail.x);
    expect(Math.abs(firstTail.x)).toBeCloseTo(1.93);
    expect(firstTail.y).toBeCloseTo(0.044);
    expect(secondTail.y).toBeCloseTo(0.044);
    // The crossed ribbon is the same shear pre-rotated a quarter turn about the beam
    // axis so both ribbons' tails meet at one origin point.
    const ribbon = first.getObjectByName('tracer-ribbon') as THREE.Mesh;
    const ribbonTail = tailShear(ribbon.geometry);
    expect(ribbonTail.x).toBeCloseTo(0.044);
    expect(ribbonTail.y).toBeCloseTo(-firstTail.x);
    // Chaingun tracers have the single handheld barrel: no shear either way.
    const tracer = createProjectileMesh({ ...disc(3, 0), type: 1, weaponId: 1 });
    expect(tailShear(tracer.geometry).x).toBe(0);
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

  it('disposes child tracer geometry and material with its projectile', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    syncProjectileMeshes(scene, meshes, [{ ...disc(1, 0), type: 1, weaponId: 1 }]);
    const trail = meshes.get(1)?.getObjectByName('tracer-ribbon') as THREE.Mesh;
    const geometryDispose = vi.spyOn(trail.geometry, 'dispose');
    const materialDispose = vi.spyOn(trail.material as THREE.Material, 'dispose');
    syncProjectileMeshes(scene, meshes, []);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});

describe('spawnProjectileImpacts (#52)', () => {
  it('spawns exactly one effect per authoritative record, at the recorded contact point', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    spawnProjectileImpacts(scene, effects, [discImpact({ x: 7, y: 2, z: 1 })]);
    expect(effects).toHaveLength(1);
    expect(scene.children).toHaveLength(1);
    expect(effects[0]?.mesh.position.x).toBe(7);
    // Consuming the drained records again must not re-render them: one record, one effect.
    spawnProjectileImpacts(scene, effects, []);
    expect(effects).toHaveLength(1);
  });

  it('renders no effect for a non-explosive lifetime timeout -- removal is not an impact', () => {
    // #52's core fix: a disc or tracer expiring at end of lifetime used to flash exactly
    // like a real strike, at whatever position the last snapshot reported.
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    spawnProjectileImpacts(scene, effects, [
      discImpact({ reason: ProjectileImpactReason.Timeout }),
    ]);
    expect(effects).toHaveLength(0);
  });

  it('renders the detonation for an armed grenade expiring at lifetime', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    spawnProjectileImpacts(scene, effects, [
      discImpact({
        reason: ProjectileImpactReason.Timeout,
        type: ProjectileType.Grenade,
        weaponId: WeaponId.Mortar,
      }),
    ]);
    expect(effects).toHaveLength(1);
  });

  it('renders a bounce as a puff while the projectile keeps flying', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    spawnProjectileImpacts(scene, effects, [discImpact({ reason: ProjectileImpactReason.Bounce })]);
    expect(effects).toHaveLength(1);
  });

  it('does not duplicate the effect when the projectile is also seen disappearing', () => {
    // The impact record is the only effect source: the mesh sync's removal of the projectile
    // mesh must not add a second flash for the same shot (#52).
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const meshes = new Map<number, THREE.Mesh>();
    syncProjectileMeshes(scene, meshes, [{ ...disc(1, 5), weaponId: WeaponId.Spinfusor }]);
    spawnProjectileImpacts(scene, effects, [discImpact({ x: 5 })]);
    syncProjectileMeshes(scene, meshes, []); // projectile seen disappearing
    expect(effects).toHaveLength(1);
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

  it('draws the authoritative red beam for a terrain miss when endpoints are supplied', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const events: EventMessage[] = [
      {
        type: 6,
        kind: EventKind.LaserFired,
        a: 1,
        b: -1,
        beam: { from: { x: 0, y: 1, z: 0 }, to: { x: 0, y: 1, z: 40 } },
      },
    ];
    spawnLaserBeams(scene, effects, events, () => null);
    expect(effects).toHaveLength(1);
    const beam = effects[0]?.mesh;
    expect(beam).toBeInstanceOf(THREE.Line);
    expect((beam as THREE.Line).material).toHaveProperty('color');
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
    spawnProjectileImpacts(scene, effects, [discImpact({ x: 5 })]);
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
