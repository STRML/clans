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
  matchLaunchToBuffer,
  ProjectileBuffer,
  spawnLaserBeams,
  spawnProjectileImpacts,
  syncProjectileMeshes,
  updateEffects,
  type Effect,
  type PendingLaunch,
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

  it('draws the Blaster bolt at the size its own datablock gives', () => {
    // `EnergyBolt` (blaster.cs:255-262): `scale = "0.25 20.0 1.0"` is the stretched quad and
    // `crossSize = 0.55` the cross quad, textured `special/blasterBolt` and
    // `special/blasterBoltCross`. This replaces a sphere plus a positional-history line, which
    // was the approximation issue #53 named -- so the numbers here come from the script, not
    // from what the code used to do.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const bolt = { ...disc(1, 0), type: 3, weaponId: 4, vx: 10 };
    syncProjectileMeshes(scene, meshes, [bolt], 0.05);
    const mesh = meshes.get(1) as THREE.Mesh;
    const trail = mesh.geometry as THREE.PlaneGeometry;
    expect(trail.parameters.width).toBe(0.25);
    expect(trail.parameters.height).toBe(20);
    const head = mesh.getObjectByName('tracer-head') as THREE.Mesh;
    const cross = head.geometry as THREE.PlaneGeometry;
    expect(cross.parameters.width).toBe(0.55);
    expect(cross.parameters.height).toBe(0.55);
    // The textures themselves are the manifest's business and the browser suite's (it decodes
    // every shipped recording and bitmap); here the contract is the source's numbers.
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

  /** Issue #57: a disc launch was unreadable from the muzzle. The plate is 0.816 m across and
   *  0.062 m thick flying level, so a shooter looking down their own flight line sees it
   *  edge-on -- a sliver about 2 cm tall at 20 m -- and the disc's own glow quad is coplanar
   *  with that plate, so it adds nothing at exactly the angle the shooter has. The launch
   *  flash is the one moment this can be fixed without redrawing the flight presentation. */
  it('flashes a disc at the muzzle for the launch lifetime, then releases it (#57)', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const projectile = disc(1, 0);
    syncProjectileMeshes(scene, meshes, [projectile], 0);
    const mesh = meshes.get(1) as THREE.Mesh;
    const flash = mesh.getObjectByName('disc-muzzle-flash') as THREE.Mesh;
    expect(flash).toBeInstanceOf(THREE.Mesh);
    expect(flash.getObjectByName('disc-muzzle-flash-cross')).toBeInstanceOf(THREE.Mesh);
    expect((flash.material as THREE.MeshBasicMaterial).blending).toBe(THREE.AdditiveBlending);
    // The plate itself is readable from the frame it appears: full opacity, full size. Only
    // the flash is transient, and nothing scales or fades the disc in.
    expect((mesh.material as THREE.MeshBasicMaterial).opacity).toBe(1);
    expect(mesh.scale.toArray()).toEqual([1, 1, 1]);
    expect((flash.material as THREE.MeshBasicMaterial).opacity).toBe(1);
    const geometryDispose = vi.spyOn(flash.geometry, 'dispose');
    // Three 20 ms frames in: still launching, already fading.
    for (let frame = 0; frame < 3; frame += 1) {
      syncProjectileMeshes(scene, meshes, [projectile], 0.02);
    }
    expect(mesh.getObjectByName('disc-muzzle-flash')).toBe(flash);
    expect((flash.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(1);
    // Past its lifetime it is gone from the mesh and its own geometry is released, not just
    // detached -- the rule every owned mesh in this file follows.
    syncProjectileMeshes(scene, meshes, [projectile], 0.02);
    expect(mesh.getObjectByName('disc-muzzle-flash')).toBeUndefined();
    expect(geometryDispose).toHaveBeenCalledOnce();
  });

  it('keeps a launch-quad face toward the shooter whatever the frame time (#57)', () => {
    // The flash rides a mesh that resets to its flight frame every frame and then rotates by
    // that frame's own spin delta (syncOneProjectile: projectileOrientation, then rotateY(dt *
    // 30)), so the shift between a member's face and the flight line the shooter looks down is
    // 30*dt: 29 degrees at 60 fps, but 172 degrees across a 100 ms hitch. Two quads a quarter
    // turn apart on that axis keep one of them presented at every phase -- the same answer
    // addTracerCross gives the tracers -- where a single quad would turn its face away.
    const projectile = disc(1, 0);
    const flight = new THREE.Vector3(projectile.vx, projectile.vy, projectile.vz).normalize();
    const members = ['disc-muzzle-flash', 'disc-muzzle-flash-cross'];
    for (const dt of [1 / 60, 0.02, 0.04, 0.06]) {
      const scene = new THREE.Scene();
      const meshes = new Map<number, THREE.Mesh>();
      syncProjectileMeshes(scene, meshes, [projectile], 0);
      syncProjectileMeshes(scene, meshes, [projectile], dt);
      const mesh = meshes.get(1) as THREE.Mesh;
      const faceTo = (name: string): number => {
        const member = mesh.getObjectByName(name) as THREE.Mesh;
        const normal = new THREE.Vector3(0, 0, 1)
          .applyQuaternion(member.quaternion)
          .applyQuaternion(mesh.quaternion);
        return Math.abs(normal.dot(flight));
      };
      expect(mesh.getObjectByName('disc-muzzle-flash')).toBeDefined();
      expect(Math.max(...members.map(faceTo))).toBeGreaterThan(0.7);
    }
  });

  it('gives no launch flash to rounds that are not discs (#57)', () => {
    const shell = createProjectileMesh(mortarShell(1, 0));
    expect(shell.getObjectByName('disc-muzzle-flash')).toBeUndefined();
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

  it('draws the disc where its flight line puts it, not at the newest snapshot position', () => {
    // A disc moves 5.8 m between snapshots (90 m/s, WEAPON_DATA) and rendering it at the
    // newest sample's own position quantized every one of those to the 64 ms cadence.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, ProjectileBuffer>();
    const projectile = disc(1, 5.76); // one snapshot interval of flight at 90 m/s

    // First frame the client sees it: the render clock is one snapshot interval behind the
    // sample, which puts the disc back at the muzzle rather than hanging 5.8 m out.
    syncProjectileMeshes(scene, meshes, [projectile], 0, { buffers, nowMs: 64 });
    expect(meshes.get(1)?.position.x).toBeCloseTo(0);

    // One frame later it has moved a frame's worth (90 m/s / 60), not stood still.
    syncProjectileMeshes(scene, meshes, [projectile], 1 / 60, { buffers, nowMs: 64 + 1000 / 60 });
    expect(meshes.get(1)?.position.x).toBeCloseTo(1.5);
  });

  it('drops a flight history once its id leaves the snapshot list', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, ProjectileBuffer>();
    const interpolation = { buffers, nowMs: 0 };
    syncProjectileMeshes(scene, meshes, [disc(1, 5)], 0, interpolation);
    expect(buffers.size).toBe(1);
    syncProjectileMeshes(scene, meshes, [], 0, interpolation);
    expect(buffers.size).toBe(0);
  });

  it('starts a fresh flight when a recycled id comes back as a different projectile', () => {
    // The disc dies and the sim hands its id to a mortar shell: the mesh is rebuilt on the
    // type/weaponId swap (round 2, PR #9, finding 8), and the flight history has to go with
    // it -- otherwise the new shell's first frames are interpolated from the old disc's last
    // sample and it slides in from wherever that was.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, ProjectileBuffer>();
    const interpolation = { buffers, nowMs: 0 };
    syncProjectileMeshes(scene, meshes, [disc(1, 0)], 0, interpolation);
    syncProjectileMeshes(scene, meshes, [{ ...mortarShell(1, 40), y: 10 }], 0, interpolation);
    // The shell's own first frame: 64 ms back along its own 20 m/s climb from y = 10. The
    // disc it replaced sat at y = 1, which is nowhere on that line.
    expect(meshes.get(1)?.position.x).toBeCloseTo(40);
    expect(meshes.get(1)?.position.y).toBeCloseTo(8.72);
  });
});

describe('ProjectileBuffer', () => {
  it('interpolates between two samples one snapshot interval behind the newest', () => {
    const buffer = new ProjectileBuffer();
    buffer.push(0, disc(1, 0));
    buffer.push(64, disc(1, 5.76));
    // renderTime 32 -- halfway through the 0 -> 64 segment -- is a clock 96 ms in.
    expect(buffer.positionAt(96)?.x).toBeCloseTo(2.88);
  });

  it('returns null before any sample arrives', () => {
    expect(new ProjectileBuffer().positionAt(0)).toBeNull();
  });

  it('carries a freshly seen shot back along its own flight line instead of freezing it', () => {
    // The client learns of a shot up to a snapshot after it was fired, so the first sample it
    // gets already describes a disc several metres downrange. Drawing the sample's own
    // position would hang the disc there for a frame and then jump; carrying it back along the
    // reported velocity puts it where the flight line says it was -- at the muzzle.
    const buffer = new ProjectileBuffer();
    buffer.push(500, disc(1, 5.76));
    expect(buffer.positionAt(500)?.x).toBeCloseTo(0);
    expect(buffer.positionAt(516.7)?.x).toBeCloseTo(1.5);
  });

  it("keeps the wire's own spacing when two samples arrive inside one snapshot interval", () => {
    // A stalled socket releasing its backlog puts two samples 64 ms apart on the wire on
    // consecutive frames 17 ms apart. Interpolated at face value the disc crosses that
    // segment at 3.8x its real speed (remote.ts's stamp clamp, ported here).
    const buffer = new ProjectileBuffer();
    buffer.push(0, disc(1, 0));
    buffer.push(16.7, disc(1, 5.76));
    const first = buffer.positionAt(100)?.x ?? 0;
    const second = buffer.positionAt(116.7)?.x ?? 0;
    expect(second - first).toBeCloseTo(1.5);
  });

  it('ignores a re-observed sample instead of stamping it a segment later', () => {
    // app.ts polls the newest decoded projectile list every FRAME while snapshots only change
    // every 64 ms, so most pushes repeat the state already filed. Storing the repeats (each
    // stamped a segment after the last) would walk the render clock further behind the sim
    // every frame until the disc sat frozen hundreds of milliseconds back.
    const buffer = new ProjectileBuffer();
    const projectile = { ...disc(1, 0), vx: 90 };
    buffer.push(0, projectile);
    for (let frame = 1; frame <= 10; frame += 1) buffer.push(frame * 16.7, projectile);
    // 167 ms of render time, 64 ms of it the interp delay: 103 ms of flight at 90 m/s.
    expect(buffer.positionAt(167)?.x).toBeCloseTo(9.27);
  });

  it('dead-reckons past the newest sample and freezes at the extrapolation cap', () => {
    const buffer = new ProjectileBuffer();
    buffer.push(0, disc(1, 0));
    // 90 m/s over remote.ts's 320 ms horizon, then frozen: a socket that has gone quiet
    // must not glide a disc onward on forever.
    expect(buffer.positionAt(64 + 320)?.x).toBeCloseTo(28.8);
    expect(buffer.positionAt(64 + 320 + 500)?.x).toBeCloseTo(28.8);
  });

  it('draws every frame of a jittered snapshot feed moving, with no frozen frame and no burst', () => {
    // The complaint this closes: the mesh sat on the newest snapshot's position, so a disc
    // stood still for three frames and then jumped 5.8 m. Feed the buffer the way app.ts's
    // render loop does -- the newest decoded list, polled every frame -- with arrivals jittered
    // across the frame boundary, and measure what the mesh does.
    const FRAME_MS = 1000 / 60;
    const SPEED_M_S = 90; // WEAPON_DATA[WeaponId.Spinfusor].speed
    const NOMINAL_PER_FRAME = (SPEED_M_S * FRAME_MS) / 1000;
    // A deterministic jitter pattern: arrivals land 4 or 5 frames apart, the way a socket's
    // own delivery does, rather than on frame boundaries.
    const JITTER_MS = [0, 16, 8, 24, 4, 20, 12, 1, 17, 9, 25, 5, 21, 13, 2, 18];
    const buffer = new ProjectileBuffer();
    const moves: number[] = [];
    let latest: ProjectileSnapshotData | null = null;
    let index = 0;
    let previous: number | null = null;
    for (let nowMs = 0; nowMs <= 2000; nowMs += FRAME_MS) {
      const sendAtMs = index * 64;
      if (nowMs >= sendAtMs + (JITTER_MS[index % JITTER_MS.length] ?? 0)) {
        latest = disc(1, (sendAtMs * SPEED_M_S) / 1000);
        index += 1;
      }
      if (latest) buffer.push(nowMs, latest);
      const drawn = buffer.positionAt(nowMs)?.x ?? null;
      if (drawn !== null && previous !== null) moves.push(drawn - previous);
      previous = drawn;
    }
    expect(moves.length).toBeGreaterThan(100);
    // Every frame moves, in the flight's own direction, at a real fraction of the disc's
    // speed: the staircase this replaces drew three frozen frames out of every four.
    expect(Math.min(...moves)).toBeGreaterThan(0.5 * NOMINAL_PER_FRAME);
    // No frame covers more than 1.5x a nominal frame's travel -- the burst a face-value
    // reading of a backlog batch's close-together stamps would produce.
    expect(Math.max(...moves)).toBeLessThan(1.5 * NOMINAL_PER_FRAME);
    // And the feed as a whole runs at the disc's own 90 m/s. It can sit a hair under nominal:
    // an arrival that landed late on the frame clock stretches that segment's render time,
    // which is the honest lag for a delivery that really was late (the clamp is a floor under
    // the protocol's spacing, never a ceiling over it).
    const mean = moves.reduce((sum, move) => sum + move, 0) / moves.length;
    expect(mean).toBeCloseTo(NOMINAL_PER_FRAME, 1);
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

const dist = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('ProjectileBuffer launch correction (jetting disc birth, 2026-09-16)', () => {
  // The jetting shot, in client-clock numbers: fired at t=1000 from the predicted muzzle
  // (0, 2, 0) at the disc's 90 m/s. The server received the input a tick later and spawned
  // from ITS muzzle (-4, 1.6, 0.5) -- metres behind on the flight line and off-axis, which
  // is the whole complaint -- so the birth sample the client files at stamp 1064 already
  // describes the disc 32 ms down that lagged line.
  const muzzle = { x: 0, y: 2, z: 0 };
  const laggedSample = { ...disc(1, -1.12), y: 1.6, z: 0.5 };

  const corrected = (): ProjectileBuffer => {
    const buffer = new ProjectileBuffer();
    buffer.setLaunchCorrection(muzzle, 1_000);
    buffer.push(1_064, laggedSample);
    return buffer;
  };
  const plain = (): ProjectileBuffer => {
    const buffer = new ProjectileBuffer();
    buffer.push(1_064, laggedSample);
    return buffer;
  };

  it('draws the first frame at the predicted muzzle the raw sample is metres away from', () => {
    // renderTime 1000 sits exactly on the launch: the predicted line pure -- the disc
    // leaves the gun. The uncorrected buffer's birth pull-back lands the same flight on the
    // server's lagged spawn line, 6.9 m from that muzzle, which is the reported artifact.
    expect(corrected().positionAt(1_064)).toEqual(muzzle);
    const before = plain().positionAt(1_064);
    if (!before) throw new Error('expected a pose');
    expect(dist(before, muzzle)).toBeCloseTo(6.91, 2);
  });

  it('slides monotonically onto the server path across the blend window', () => {
    // Both lines share the wire's own velocity, so the offset between them is constant and
    // the mix weight (age / 250) walks it down linearly: the distance to where the plain
    // buffer draws the same clock shrinks strictly, never zig-zags.
    const buffer = corrected();
    const distances = [50, 125, 200].map((ageMs) => {
      const nowMs = 1_064 + ageMs;
      const pose = buffer.positionAt(nowMs);
      const server = plain().positionAt(nowMs);
      if (!pose || !server) throw new Error('expected poses');
      return dist(pose, server);
    });
    expect(distances[0]).toBeGreaterThan(distances[1]!);
    expect(distances[1]).toBeGreaterThan(distances[2]!);
  });

  it('sits exactly on the server path once LAUNCH_BLEND_MS has passed', () => {
    const buffer = corrected();
    for (const nowMs of [1_064 + 250, 1_064 + 400]) {
      expect(buffer.positionAt(nowMs)).toEqual(plain().positionAt(nowMs));
    }
  });

  it('re-anchors to a refire instead of stacking corrections', () => {
    // Second shot, 100 ms after the first and from a muzzle the player has since moved:
    // the overwrite replaces the live first correction wholesale, so the next birth again
    // renders from the new muzzle (age 0, pure predicted) rather than anywhere on shot one.
    const buffer = new ProjectileBuffer();
    buffer.setLaunchCorrection(muzzle, 1_000);
    buffer.setLaunchCorrection({ x: 30, y: 2, z: 0 }, 1_100);
    buffer.push(1_164, laggedSample);
    expect(buffer.positionAt(1_164)).toEqual({ x: 30, y: 2, z: 0 });
  });

  it('drops the correction when the id is recycled into a different flight', () => {
    const buffer = corrected();
    buffer.reset();
    buffer.push(1_064, laggedSample);
    expect(buffer.positionAt(1_064)).toEqual(plain().positionAt(1_064));
  });
});

describe('matchLaunchToBuffer (jetting disc birth, 2026-09-16)', () => {
  const pendingAt = (atMs: number, origin = { x: 0, y: 2, z: 0 }): PendingLaunch => ({
    origin,
    atMs,
  });

  it('anchors a local projectile on its first appearance and consumes the launch', () => {
    const buffers = new Map<number, ProjectileBuffer>();
    const pending = pendingAt(1_000, { x: 0, y: 1, z: 0 });
    const unconsumed = matchLaunchToBuffer(pending, [disc(1, -1.12)], 0, buffers, 1_064);
    expect(unconsumed).toBeUndefined();
    const buffer = buffers.get(1);
    if (!buffer) throw new Error('expected a buffer for the new id');
    // The correction rides the buffer syncProjectileMeshes is about to file samples into:
    // its first query, at the fire's own render clock, sits on the predicted muzzle.
    buffer.push(1_064, disc(1, -1.12));
    expect(buffer.positionAt(1_064)).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('keeps the launch while no local projectile has appeared, and expires it at 400 ms', () => {
    const buffers = new Map<number, ProjectileBuffer>();
    const pending = pendingAt(1_000);
    // A shot still in flight (input + tick + cadence + jitter) must stay anchored...
    expect(matchLaunchToBuffer(pending, [], 0, buffers, 1_399)).toBe(pending);
    // ...but one that never showed (dropped packet, pre-join fire) expires rather than
    // anchoring some later projectile's birth.
    expect(matchLaunchToBuffer(pending, [], 0, buffers, 1_400)).toBeUndefined();
    expect(buffers.size).toBe(0);
  });

  it("never matches another player's disc or a turret shot", () => {
    const buffers = new Map<number, ProjectileBuffer>();
    const pending = pendingAt(1_000);
    const remote = { ...disc(2, 5), ownerId: 1 };
    const turret = { ...disc(3, 5), ownerId: -1 };
    expect(matchLaunchToBuffer(pending, [remote, turret], 0, buffers, 1_064)).toBe(pending);
    expect(buffers.size).toBe(0);
  });

  it('leaves an id that already has flight history alone', () => {
    // First appearance only: a disc seen in an earlier snapshot is mid-flight, and pinning
    // its birth to a fire that happened after it was drawn would drag it metres sideways.
    const buffers = new Map<number, ProjectileBuffer>([[1, new ProjectileBuffer()]]);
    const pending = pendingAt(1_000);
    expect(matchLaunchToBuffer(pending, [disc(1, 20)], 0, buffers, 1_064)).toBe(pending);
  });

  it('feeds the flash the corrected birth frame through the normal sync path', () => {
    // app.ts matches before sync, the frame the snapshot first carries the shot; the flash
    // is parented to the disc mesh, so this is the proof flash and disc leave one muzzle.
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, ProjectileBuffer>();
    matchLaunchToBuffer(
      pendingAt(1_000, { x: 0, y: 1, z: 0 }),
      [disc(1, -1.12)],
      0,
      buffers,
      1_064,
    );
    syncProjectileMeshes(scene, meshes, [disc(1, -1.12)], 0, { buffers, nowMs: 1_064 });
    const mesh = meshes.get(1);
    if (!mesh) throw new Error('expected a disc mesh');
    expect(mesh.position.x).toBeCloseTo(0);
    const flash = mesh.getObjectByName('disc-muzzle-flash');
    if (!flash) throw new Error('expected a launch flash');
    const world = new THREE.Vector3();
    flash.getWorldPosition(world);
    expect(world.x).toBeCloseTo(0);
    expect(world.y).toBeCloseTo(1);
    expect(world.z).toBeCloseTo(0);
  });
});
