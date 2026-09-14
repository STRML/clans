import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArmorId, type PlayerSnapshotData } from '@clans/sim';
import {
  BACK_CLIP,
  DIE_CLIP,
  FALL_CLIP,
  FORWARD_CLIP,
  JET_CLIP,
  JUMP_CLIP,
  LAND_CLIP,
  PlayerView,
  ROOT_CLIP,
  SIDE_CLIP,
  SKI_CLIP,
  STANDING_JUMP_CLIP,
  clipFor,
  landHoldMs,
  playerBodyFor,
  type PlayerAnimState,
} from './players-view.js';

afterEach(() => vi.restoreAllMocks());

/** A grounded, idle, healthy remote player: the state every test varies from. */
function state(overrides: Partial<PlayerAnimState> = {}): PlayerAnimState {
  return {
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    onGround: 1,
    ski: 0,
    health: 60,
    previousVy: 0,
    wasAirborne: false,
    msGrounded: Number.POSITIVE_INFINITY,
    touchdownVy: 0,
    ...overrides,
  };
}

function sample(overrides: Partial<PlayerSnapshotData> = {}): PlayerSnapshotData {
  return {
    id: 1,
    team: 1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    energy: 60,
    health: 60,
    weaponSlot: 4,
    onGround: 1,
    ski: 0,
    respawnSeq: 0,
    discAmmo: 15,
    chaingunAmmo: 100,
    mortarAmmo: 0,
    grenades: 5,
    weaponState: 1,
    weaponTimer: 0,
    spunUp: 0,
    grenadeCooldown: 0,
    score: 0,
    godMode: 0 as const,
    wasJumpHeld: 0 as const,
    armor: ArmorId.Light,
    hasRepairPack: 0 as const,
    hasEnergyPack: 0 as const,
    carriedWeapons: 0,
    ...overrides,
  };
}

const POSE = { x: 0, y: 0, z: 0, yaw: 0 };

describe('clipFor', () => {
  it('stands still in root, and forward/back/side project the velocity into the facing', () => {
    // pickActionAnimation's own selection (player.cc:2305-2321): the velocity is projected
    // into the player's frame -- forward is (sin yaw, 0, cos yaw), movement.ts:116-121 --
    // and the largest component above its 0.1 m/s floor wins.
    expect(clipFor(state())).toBe(ROOT_CLIP);
    expect(clipFor(state({ vz: 10 }))).toBe(FORWARD_CLIP); // yaw 0 faces +z
    expect(clipFor(state({ vz: -10 }))).toBe(BACK_CLIP);
    expect(clipFor(state({ vx: 10 }))).toBe(SIDE_CLIP); // +x is the facing's right
    expect(clipFor(state({ vx: 3, vz: 10 }))).toBe(FORWARD_CLIP); // 10 along the facing beats 3 across
    expect(clipFor(state({ vx: 10, vz: 3 }))).toBe(SIDE_CLIP);
    // Under the floor on every axis: the engine's `F32 curMax = 0.1` leaves RootAnim.
    expect(clipFor(state({ vx: 0.05, vz: 0.05 }))).toBe(ROOT_CLIP);
  });

  it('faces the velocity through yaw, not through world axes', () => {
    // Yaw a quarter turn: +x is now the facing, so the same world velocity picks a
    // different clip. Rotating the whole state must not change which clip is chosen.
    const yaw = Math.PI / 2;
    expect(clipFor(state({ vx: 10, yaw }))).toBe(FORWARD_CLIP);
    expect(clipFor(state({ vz: -10, yaw }))).toBe(SIDE_CLIP);
  });

  it('takes the takeoff as a jump, then separates a jet burn from the jump arc by vertical speed', () => {
    // Takeoff: vy climbs from 0 to the impulse in one sample, which must not read as thrust.
    expect(clipFor(state({ onGround: 0, vy: 8, previousVy: 0, wasAirborne: false, vz: 10 }))).toBe(
      JUMP_CLIP,
    );
    // A jump arc only decelerates (GRAVITY is the only force in flight, movement.ts:192-198).
    expect(clipFor(state({ onGround: 0, vy: 4, previousVy: 6, wasAirborne: true, vz: 10 }))).toBe(
      JUMP_CLIP,
    );
    // Thrust beats gravity: the sim adds jetForce/mass (26.21 m/s^2 for Light) per second
    // while the trigger is held (movement.ts:280-283), so a RISING vy while airborne is a
    // jet firing and nothing else.
    expect(clipFor(state({ onGround: 0, vy: 1, previousVy: 0.4, wasAirborne: true, vz: 10 }))).toBe(
      JET_CLIP,
    );
  });

  it('jumps from a standstill with standjump, and from a run with jump', () => {
    // sStandingJumpSpeed = 2.0 (player.cc:66, 1736-1739): the impulse picked the running
    // clip above it and the standing one at or below.
    const airborne = { onGround: 0 as const, vy: 5, previousVy: 6, wasAirborne: true };
    expect(clipFor(state({ ...airborne, vz: 10 }))).toBe(JUMP_CLIP);
    expect(clipFor(state({ ...airborne, vz: 1 }))).toBe(STANDING_JUMP_CLIP);
    expect(clipFor(state({ ...airborne, vz: 0 }))).toBe(STANDING_JUMP_CLIP);
  });

  it('calls a fast descent a fall and a slow one the tail of the jump arc', () => {
    // sFallingThreshold = -10 (player.cc:78) is tested first by pickActionAnimation
    // (player.cc:2281-2285), ahead of everything that would hold the jump pose.
    expect(clipFor(state({ onGround: 0, vy: -12, previousVy: -11, wasAirborne: true }))).toBe(
      FALL_CLIP,
    );
    expect(clipFor(state({ onGround: 0, vy: -9, previousVy: -8, wasAirborne: true }))).toBe(
      STANDING_JUMP_CLIP,
    );
  });

  it('skis with the ski clip and keeps it through a hop-sized landing', () => {
    expect(clipFor(state({ ski: 1, vz: 10 }))).toBe(SKI_CLIP);
    // A ski hop lands far below the 45 m/s an impact needs to be a recover state
    // (player.cc:2688-2701), so the landing must NOT take the pose over.
    expect(clipFor(state({ ski: 1, vz: 10, msGrounded: 50, touchdownVy: 12 }))).toBe(SKI_CLIP);
  });

  it('holds the landing pose only for a landing hard enough to open the engine recover state', () => {
    // 45 m/s is the threshold; inside it the pose never changes.
    expect(clipFor(state({ msGrounded: 100, touchdownVy: 45 }))).toBe(ROOT_CLIP);
    // Above it the window is recoverDelay ticks scaled to the impact (player.cc:2692-2701),
    // so a 60 m/s landing holds far less than its full 960 ms.
    const held = clipFor(state({ vz: 10, msGrounded: 100, touchdownVy: 60 }));
    expect(held).toBe(LAND_CLIP);
    expect(clipFor(state({ vz: 10, msGrounded: landHoldMs(60) + 1, touchdownVy: 60 }))).toBe(
      FORWARD_CLIP,
    );
    expect(clipFor(state({ msGrounded: 100, touchdownVy: 400 }))).toBe(LAND_CLIP);
    expect(clipFor(state({ msGrounded: 900, touchdownVy: 400 }))).toBe(LAND_CLIP);
    expect(clipFor(state({ msGrounded: 1000, touchdownVy: 400 }))).toBe(ROOT_CLIP);
  });

  it('is dead before anything else, whatever the body is doing', () => {
    expect(clipFor(state({ health: 0, vz: 10 }))).toBe(DIE_CLIP);
    expect(
      clipFor(state({ health: 0, onGround: 0, vy: 5, previousVy: 6, wasAirborne: true })),
    ).toBe(DIE_CLIP);
    // The sim reports health as maxDamage - damage, so exactly 0 is dead, not 1e-9 alive.
    expect(clipFor(state({ health: 0.66 }))).toBe(ROOT_CLIP);
  });
});

describe('landHoldMs', () => {
  it('opens the engine recover window, scaled from one tick to recoverDelay', () => {
    // recoverDelay = 30 ticks (player.cc:171) at this sim's own 32 ms tick, reached at
    // minImpactSpeed * 1.9 (player.cc:2694-2698).
    expect(landHoldMs(0)).toBe(0);
    expect(landHoldMs(45)).toBe(0);
    expect(landHoldMs(45.1)).toBe(32); // just inside the threshold: a single tick
    expect(landHoldMs(85.5)).toBe(960); // the far end of the ramp
    expect(landHoldMs(200)).toBe(960);
  });
});

describe('playerBodyFor', () => {
  it('maps the three armours to the three biped shapes, and anything else to Light', () => {
    expect(playerBodyFor(ArmorId.Light)).toBe('light_male');
    expect(playerBodyFor(ArmorId.Medium)).toBe('medium_male');
    expect(playerBodyFor(ArmorId.Heavy)).toBe('heavy_male');
    expect(playerBodyFor(9)).toBe('light_male');
  });
});

/** One clip that moves the biped's pelvis along x, so a seek is observable in the scene
 *  graph: glTF channels target node names, exactly as the emitted .dsq clips do. */
function pelvisClip(name: string, from: number, to: number): THREE.AnimationClip {
  return new THREE.AnimationClip(name, 1, [
    new THREE.VectorKeyframeTrack('Bip01 Pelvis.position', [0, 1], [from, 0, 0, to, 0, 0]),
  ]);
}

/** A loader stub that hands the view a scene whose pelvis carries the given clips, without
 *  touching the network (the shape-loader tests' own seam). The pelvis owns a mesh because
 *  loadShapeUrl rejects a scene with no geometry at all -- the fallback those tests share. */
function loadedScene(animations: THREE.AnimationClip[]): {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
} {
  const scene = new THREE.Group();
  const pelvis = new THREE.Object3D();
  pelvis.name = 'Bip01 Pelvis';
  pelvis.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  scene.add(pelvis);
  return { scene, animations };
}

function pelvisX(view: PlayerView): number {
  return view.root.getObjectByName('Bip01 Pelvis')?.position.x ?? Number.NaN;
}

describe('PlayerView', () => {
  it('places the root at the interpolated pose and loads the armour body by URL', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(7);
    view.sync(sample({ armor: ArmorId.Heavy }), { x: 1, y: 2, z: 3, yaw: 0.5 }, 0);

    expect(view.root.position.toArray()).toEqual([1, 2, 3]);
    expect(view.root.rotation.y).toBeCloseTo(0.5);
    expect(load.mock.calls[0]![0]).toMatch(/katabatic\/players\/heavy_male\.glb$/);
  });

  it('shows the capsule until a model arrives, then hides it behind the model', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(1);
    const capsule = view.root.children[0] as THREE.Mesh;
    view.sync(sample(), POSE, 0);
    expect(capsule.visible).toBe(true); // the fallback the contract keeps on a failed load

    load.mock.calls[0]![1]!(loadedScene([pelvisClip(ROOT_CLIP, 0, 10)]) as never);
    expect(capsule.visible).toBe(false);
  });

  it('drives the model nodes from the snapshot through the chosen clip', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(3);
    view.sync(sample(), POSE, 0);
    // Two clips with disjoint output ranges, so which one is playing is unambiguous.
    load.mock.calls[0]![1]!(
      loadedScene([pelvisClip(FORWARD_CLIP, 0, 10), pelvisClip(ROOT_CLIP, 100, 110)]) as never,
    );

    view.sync(sample({ vz: 10 }), POSE, 0);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(0);
    expect(pelvisX(view)).toBeLessThanOrEqual(10);

    view.sync(sample(), POSE, 0);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(100);
    expect(pelvisX(view)).toBeLessThanOrEqual(110);
  });

  it('falls back to root for a clip the model does not carry', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(5);
    view.sync(sample(), POSE, 0);
    // No ski clip in this model: the pose must come from root, not stay at the bind pose
    // (poseShape is a no-op for an unknown name, which would freeze the last seeked pose).
    load.mock.calls[0]![1]!(loadedScene([pelvisClip(ROOT_CLIP, 100, 110)]) as never);

    view.sync(sample({ ski: 1 }), POSE, 0);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(100);
  });

  it('holds a single-keyframe clip at its only frame', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(6);
    view.sync(sample(), POSE, 0);
    // A one-key sequence exports as a zero-length clip, and the loop phase is a modulo by
    // that length: the pose must be the clip's only frame, not an empty scene graph.
    const pose = new THREE.AnimationClip(ROOT_CLIP, 0, [
      new THREE.VectorKeyframeTrack('Bip01 Pelvis.position', [0], [5, 0, 0]),
    ]);
    load.mock.calls[0]![1]!(loadedScene([pose]) as never);

    view.sync(sample(), POSE, 1000);
    expect(pelvisX(view)).toBe(5);
  });

  it('reloads when a reused id changes armour, dropping the old model', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(2);
    view.sync(sample({ armor: ArmorId.Light }), POSE, 0);
    load.mock.calls[0]![1]!(loadedScene([pelvisClip(ROOT_CLIP, 0, 10)]) as never);
    view.sync(sample({ armor: ArmorId.Medium }), POSE, 0);

    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]![0]).toMatch(/medium_male\.glb$/);
    // The capsule is the only other child: the Light model's holder is gone, not stacked.
    expect(view.root.children).toHaveLength(2);
    expect(view.root.getObjectByName('Bip01 Pelvis')).toBeUndefined();
  });

  it('separates a takeoff, a jet burn and the jump arc across consecutive samples', () => {
    // The clip choice reads the PREVIOUS sample (takeoff, thrust, landing edge), which the
    // view only has if it captures it before its own latches move: reading it after left
    // every airborne frame comparing a sample against itself, so a jet burn drew the jump
    // pose and a takeoff drew the jet pose.
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(9);
    view.sync(sample({ vz: 10 }), POSE, 0);
    load.mock.calls[0]![1]!(
      loadedScene([
        pelvisClip(JUMP_CLIP, 0, 10),
        pelvisClip(JET_CLIP, 100, 110),
        pelvisClip(ROOT_CLIP, 200, 210),
      ]) as never,
    );

    // Takeoff: vy climbs off zero with nothing to compare against, which is a jump.
    view.sync(sample({ onGround: 0, vy: 8, vz: 10 }), POSE, 32);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(0);
    expect(pelvisX(view)).toBeLessThanOrEqual(10);

    // Thrust: still airborne and rising faster than the last sample.
    view.sync(sample({ onGround: 0, vy: 9, vz: 10 }), POSE, 64);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(100);
    expect(pelvisX(view)).toBeLessThanOrEqual(110);

    // The arc resumes when the vertical speed is decelerating again.
    view.sync(sample({ onGround: 0, vy: 5, vz: 10 }), POSE, 96);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(0);
    expect(pelvisX(view)).toBeLessThanOrEqual(10);
  });

  it('takes the landing pose only from the impact speed of the sample before it', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(11);
    view.sync(sample({ onGround: 0, vy: -60, vz: 10 }), POSE, 0);
    load.mock.calls[0]![1]!(
      loadedScene([pelvisClip(LAND_CLIP, 0, 10), pelvisClip(FORWARD_CLIP, 100, 110)]) as never,
    );

    view.sync(sample({ onGround: 1, vy: 0, vz: 10 }), POSE, 32);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(0);
    expect(pelvisX(view)).toBeLessThanOrEqual(10);

    // The same 60 m/s touchdown, long past its scaled recover window.
    view.sync(sample({ onGround: 1, vy: 0, vz: 10 }), POSE, 5000);
    expect(pelvisX(view)).toBeGreaterThanOrEqual(100);
    expect(pelvisX(view)).toBeLessThanOrEqual(110);
  });

  it('collapses with another die clip when the body does not carry the preferred one', () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const view = new PlayerView(8);
    view.sync(sample(), POSE, 0);
    // medium_male.glb's own set: nine die clips, no dieslump. Falling through to root would
    // leave a dead player standing, which is what this list exists to prevent.
    load.mock.calls[0]![1]!(
      loadedScene([pelvisClip(ROOT_CLIP, 200, 210), pelvisClip('diechest', 0, 10)]) as never,
    );

    view.sync(sample({ health: 0 }), POSE, 0);
    const first = pelvisX(view);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(10);

    // The remapped clip is still a one-shot: it advances from the death edge (a tenth of
    // the 1 s clip at 100 ms, which a movement clip would have cycled past) and holds at
    // its end however much later it is asked for.
    view.sync(sample({ health: 0 }), POSE, 100);
    expect(pelvisX(view)).toBeCloseTo(1);
    view.sync(sample({ health: 0 }), POSE, 5000);
    expect(pelvisX(view)).toBe(10);
  });

  it('frees the fallback capsule GPU resources when the view is disposed', () => {
    const view = new PlayerView(4);
    const capsule = view.root.children[0] as THREE.Mesh;
    const geometry = vi.spyOn(capsule.geometry, 'dispose');
    const material = vi.spyOn(capsule.material as THREE.Material, 'dispose');

    view.dispose();

    expect(geometry).toHaveBeenCalledOnce();
    expect(material).toHaveBeenCalledOnce();
    expect(view.root.children).toHaveLength(0);
  });
});
