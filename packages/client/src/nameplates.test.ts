import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  addPlayer,
  applyDamage,
  ARMORS,
  ArmorId,
  createWorld,
  type Heightfield,
  type PlayerSnapshotData,
} from '@clans/sim';
import {
  HOVER_DWELL_IDLE,
  HOVER_RANGE_M,
  HOVER_SUSTAIN_MS,
  hoverDwell,
  hoverEnemyState,
  hoverSettled,
  NAMEPLATE_RANGE_M,
  nameplateStates,
  teammatesFromSnapshots,
  teammatesFromWorld,
  type NameplateCameraInput,
  type NameplatePlayerInput,
} from './nameplates.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

const player = (over: Partial<NameplatePlayerInput>): NameplatePlayerInput => ({
  id: 2,
  team: 1,
  x: 0,
  y: 0,
  z: 50,
  healthFraction: 1,
  alive: true,
  ...over,
});

/** A 90-degree-fov, square camera placed at `eye` looking straight at `target`, matrices
 *  brought current exactly the way a rendered frame leaves them (renderer.render refreshes
 *  camera.matrixWorldInverse via Camera.updateMatrixWorld). */
function cameraLookingAt(
  eye: [number, number, number],
  target: [number, number, number],
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1200);
  camera.position.set(...eye);
  camera.lookAt(...target);
  camera.updateMatrixWorld();
  return camera;
}

function cameraInput(camera: THREE.PerspectiveCamera): NameplateCameraInput {
  return {
    position: camera.position,
    matrixWorldInverse: camera.matrixWorldInverse,
    projectionMatrix: camera.projectionMatrix,
  };
}

const VIEW = { width: 800, height: 600 };

function statesFor(
  players: NameplatePlayerInput[],
  camera: THREE.PerspectiveCamera,
  names: ReadonlyMap<number, string> = new Map(),
  localPlayerId = 1,
  localTeam = 1,
) {
  return nameplateStates(players, localPlayerId, localTeam, names, cameraInput(camera), VIEW);
}

describe('nameplateStates', () => {
  it('plates living teammates, plus the hovered enemy: the local player and the dead get nothing', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    const states = statesFor(
      [
        player({ id: 1, team: 1, z: 50 }), // the local player themself
        player({ id: 2, team: 1, z: 50 }),
        player({ id: 3, team: 2, z: 50 }), // enemy dead ahead: the crosshair's own plate
        player({ id: 4, team: 1, z: 50, alive: false }),
      ],
      camera,
    );
    // The enemy is plated by the hover rule alone, and that plate is the flagged one -- no
    // enemy gets a teammate-style plate with a name on it.
    expect(states.map((state) => state.playerId)).toEqual([2, 3]);
    expect(states.map((state) => state.hover)).toEqual([false, true]);
    expect(states[0]?.team).toBe(1);
  });

  it('culls a teammate behind the camera rather than mirroring them across the screen', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    expect(statesFor([player({ z: -50 })], camera)).toEqual([]);
  });

  it('culls teammates beyond NAMEPLATE_RANGE_M and keeps one just inside it', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    expect(statesFor([player({ z: NAMEPLATE_RANGE_M + 100 })], camera)).toEqual([]);
    expect(statesFor([player({ z: NAMEPLATE_RANGE_M - 50 })], camera)).toHaveLength(1);
  });

  it('culls teammates projecting outside the viewport', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    // atan(100/50) is 63 degrees off-axis, well outside the square 90-degree frustum.
    expect(statesFor([player({ x: 100, z: 50 })], camera)).toEqual([]);
  });

  it('projects a dead-ahead teammate to the viewport centre and an offset one to the right', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    const centred = statesFor([player({ z: 50 })], camera)[0];
    expect(centred?.screenX).toBeCloseTo(VIEW.width / 2, 6);
    // The anchor sits NAMEPLATE_ANCHOR_M over the feet, so "centre" is fractionally above
    // the exact middle: ndc.y = 2.9/50 at 50 m out.
    expect(centred?.screenY).toBeCloseTo((0.5 - 2.9 / 50 / 2) * VIEW.height, 5);

    // World +X is screen-LEFT for a camera looking down world +Z (right-handed basis,
    // flipped 180 degrees by lookAt): x = -25 gives ndc.x = (25/50)/tan(45) = 0.5, i.e.
    // three quarters across the square viewport.
    const offset = statesFor([player({ x: -25, z: 50 })], camera)[0];
    expect(offset?.screenX).toBeCloseTo(0.75 * VIEW.width, 6);
    expect(offset!.screenX).toBeGreaterThan(centred!.screenX);
  });

  it('clamps the health fraction into [0, 1] for the bar', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    const states = statesFor(
      [player({ id: 2, healthFraction: -0.2 }), player({ id: 3, healthFraction: 1.5 })],
      camera,
    );
    expect(states.map((state) => state.healthFraction)).toEqual([0, 1]);
  });

  it('names plates from the roster and falls back to P<id> when the roster has no row yet', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    const states = statesFor(
      [player({ id: 2 }), player({ id: 7 })],
      camera,
      new Map([[7, 'Bot 7']]),
    );
    expect(states.find((state) => state.playerId === 2)?.name).toBe('P2');
    expect(states.find((state) => state.playerId === 7)?.name).toBe('Bot 7');
  });

  it('appends the crosshair-hovered enemy after the teammate plates, bar-only and flagged', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    const states = statesFor(
      [player({ id: 2, team: 1, z: 50 }), player({ id: 3, team: 2, z: 40, healthFraction: 0.5 })],
      camera,
    );
    expect(states.map((state) => [state.playerId, state.hover])).toEqual([
      [2, false],
      [3, true],
    ]);
    // Bar alone: the hovered enemy keeps the team for the plate's own colour key but gets no
    // name, unlike every teammate plate (which falls back to P<id>).
    expect(states[1]).toMatchObject({ team: 2, name: '', healthFraction: 0.5 });
  });

  it('plates no enemy at all once the crosshair is off them', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    // 5 m to the side at 40 m: on screen, inside both ranges, and nowhere near the 0.6 m body
    // radius the hover test is measured against.
    expect(statesFor([player({ id: 3, team: 2, x: 5, z: 40 })], camera)).toEqual([]);
  });
});

describe('hoverEnemyState (the crosshair over an enemy)', () => {
  const hover = (players: NameplatePlayerInput[], localTeam = 1) =>
    hoverEnemyState(
      players,
      1,
      localTeam,
      cameraInput(cameraLookingAt([0, 0, 0], [0, 0, 100])),
      VIEW,
    );

  it('hovers the enemy the aim axis crosses, teammates and the local player never', () => {
    expect(
      hover([
        player({ id: 1, team: 1, z: 50 }), // the local player themself
        player({ id: 2, team: 1, z: 50 }),
        player({ id: 3, team: 2, z: 50, healthFraction: 0.4 }),
      ]),
    ).toMatchObject({
      playerId: 3,
      team: 2,
      name: '',
      healthFraction: 0.4,
      hover: true,
    });
    expect(hover([player({ id: 2, team: 1, z: 50 })])).toBeNull();
  });

  it('anchors the hover plate where the teammate plates go: the head, on the aim axis', () => {
    const state = hover([player({ id: 3, team: 2, z: 50 })]);
    expect(state?.screenX).toBeCloseTo(VIEW.width / 2, 6);
    // NAMEPLATE_ANCHOR_M over the feet at 50 m, the same projection the teammate test pins.
    expect(state?.screenY).toBeCloseTo((0.5 - 2.9 / 50 / 2) * VIEW.height, 5);
  });

  it('counts the crosshair as on the enemy inside the body radius and off it outside', () => {
    // The radius is half the Light armor's 1.2 m box: 0.5 m off the axis is still the enemy,
    // 0.7 m is beside them.
    expect(hover([player({ id: 3, team: 2, x: 0.5, z: 50 })])).not.toBeNull();
    expect(hover([player({ id: 3, team: 2, x: 0.7, z: 50 })])).toBeNull();
    // And the test is the body, not just the axis: an enemy floating 3 m over a level eye is
    // missed even dead ahead, because their 2.6 m body never comes back down to the ray.
    expect(hover([player({ id: 3, team: 2, y: 3, z: 50 })])).toBeNull();
  });

  it('hovers out to HOVER_RANGE_M and no further', () => {
    expect(hover([player({ id: 3, team: 2, z: HOVER_RANGE_M - 1 })])).not.toBeNull();
    expect(hover([player({ id: 3, team: 2, z: HOVER_RANGE_M + 1 })])).toBeNull();
    // The teammate rule is not the hover rule: this plate is not drawn at 1090 m either, but
    // at 200-300 m a teammate still wears a plate the enemy does not.
    expect(hover([player({ id: 3, team: 2, z: NAMEPLATE_RANGE_M - 10 })])).toBeNull();
  });

  it('hovers the enemy nearest the aim axis when two bodies are under it', () => {
    const near = player({ id: 3, team: 2, x: 0.2, z: 50 });
    const far = player({ id: 4, team: 2, x: 0.5, z: 50 });
    expect(hover([near, far])?.playerId).toBe(3);
    expect(hover([far, near])?.playerId).toBe(3);
  });

  it('never hovers the dead', () => {
    expect(hover([player({ id: 3, team: 2, z: 50, alive: false })])).toBeNull();
  });
});

describe('hoverDwell/hoverSettled (the sustain the hover plate needs)', () => {
  it('holds the plate back until the enemy has been under the crosshair for HOVER_SUSTAIN_MS', () => {
    const dwell = hoverDwell(HOVER_DWELL_IDLE, 7, 1000);
    expect(dwell).toEqual({ playerId: 7, sinceMs: 1000 });
    expect(hoverSettled(dwell, 1000 + HOVER_SUSTAIN_MS - 1)).toBe(false);
    expect(hoverSettled(dwell, 1000 + HOVER_SUSTAIN_MS)).toBe(true);
  });

  it('restarts the timer when the crosshair sweeps from one enemy to the next', () => {
    const first = hoverDwell(HOVER_DWELL_IDLE, 7, 1000);
    const second = hoverDwell(first, 9, 1050);
    // 50 ms on the new enemy, not the 100 the first one had accumulated.
    expect(second).toEqual({ playerId: 9, sinceMs: 1050 });
    expect(hoverSettled(second, 1100)).toBe(false);
    expect(hoverSettled(second, 1150)).toBe(true);
  });

  it('keeps the dwell running while the same enemy stays under the crosshair', () => {
    const dwell = hoverDwell(HOVER_DWELL_IDLE, 7, 1000);
    expect(hoverDwell(dwell, 7, 1016).sinceMs).toBe(1000);
    expect(hoverSettled(hoverDwell(dwell, 7, 1016), 1100)).toBe(true);
  });

  it('goes idle the frame the crosshair leaves, so a second pass starts a fresh dwell', () => {
    const left = hoverDwell(hoverDwell(HOVER_DWELL_IDLE, 7, 1000), null, 1016);
    expect(left).toEqual(HOVER_DWELL_IDLE);
    expect(hoverSettled(left, 1017)).toBe(false);
    // Re-entering the same enemy does not inherit the first visit's 100 ms.
    const again = hoverDwell(left, 7, 5000);
    expect(again).toEqual({ playerId: 7, sinceMs: 5000 });
    expect(hoverSettled(again, 5050)).toBe(false);
  });

  it('draws the bar only after a sustained hover and drops it once the aim moves off', () => {
    const camera = cameraInput(cameraLookingAt([0, 0, 0], [0, 0, 100]));
    const onTarget = nameplateStates(
      [player({ id: 3, team: 2, z: 50 })],
      1,
      1,
      new Map(),
      camera,
      VIEW,
    );
    const hoverId = onTarget.find((state) => state.hover)?.playerId ?? null;
    expect(hoverId).toBe(3);

    let dwell = hoverDwell(HOVER_DWELL_IDLE, hoverId, 0);
    expect(hoverSettled(dwell, 50)).toBe(false);
    expect(hoverSettled(dwell, 100)).toBe(true);

    // The bot steps out of the crosshair: the frame no longer carries a hover plate, and the
    // dwell resets rather than leaving the bar up.
    const offTarget = nameplateStates(
      [player({ id: 3, team: 2, x: 5, z: 50 })],
      1,
      1,
      new Map(),
      camera,
      VIEW,
    );
    expect(offTarget.find((state) => state.hover)).toBeUndefined();
    dwell = hoverDwell(dwell, offTarget.find((state) => state.hover)?.playerId ?? null, 116);
    expect(dwell).toEqual(HOVER_DWELL_IDLE);
  });
});

describe('teammatesFromWorld', () => {
  it("reads every active non-local player with the wire's own health arithmetic", () => {
    const world = createWorld(flat, 1);
    const local = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const mate = addPlayer(world, { x: 10, y: 4, z: 20 }, 1);
    addPlayer(world, { x: -10, y: 4, z: -20 }, 2); // enemy: the adapter still lists them...
    // ...the model, not the adapter, applies the teammates-only rule, mirroring how
    // commander-map's adapters hand every player to its drawer.
    applyDamage(world, mate, 0.33, local, ARMORS[ArmorId.Light]);

    const inputs = teammatesFromWorld(world, local);
    const mateInput = inputs.find((input) => input.id === mate);
    expect(mateInput).toMatchObject({
      id: mate,
      team: 1,
      x: 10,
      y: 4,
      z: 20,
      // Light armor maxes at 0.66 (sim/armor.ts), so 0.33 damage is exactly half health.
      healthFraction: 0.5,
      alive: true,
    });
    expect(inputs).toHaveLength(2);
  });

  it('drops dead and deactivated seats from the candidate list', () => {
    const world = createWorld(flat, 1);
    const local = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const dead = addPlayer(world, { x: 0, y: 0, z: 40 }, 1);
    const gone = addPlayer(world, { x: 0, y: 0, z: 80 }, 1);
    // A just-killed teammate still occupies an active seat until the next snapshot, but
    // alive is already 0; a deactivated seat is a freed id, not a corpse.
    world.players.alive[dead] = 0;
    world.players.active[gone] = 0;
    const inputs = teammatesFromWorld(world, local);
    expect(inputs.find((input) => input.id === dead)).toMatchObject({ alive: false });
    expect(inputs.some((input) => input.id === gone)).toBe(false);
  });
});

describe('teammatesFromSnapshots', () => {
  const snapshot = (over: Partial<PlayerSnapshotData>): PlayerSnapshotData =>
    ({
      id: 5,
      team: 1,
      x: 3,
      y: 7,
      z: 9,
      health: 0.66,
      armor: ArmorId.Light,
      ...over,
    }) as PlayerSnapshotData;

  it("rescales the snapshot's absolute health against that snapshot's own armor max", () => {
    const inputs = teammatesFromSnapshots([
      snapshot({ id: 5, health: 0.33, armor: ArmorId.Light }),
      snapshot({ id: 6, health: 0.55, armor: ArmorId.Heavy }), // heavy maxes at 1.32
      snapshot({ id: 7, health: 0, armor: ArmorId.Light }),
    ]);
    expect(inputs[0]).toMatchObject({
      id: 5,
      x: 3,
      y: 7,
      z: 9,
      team: 1,
      healthFraction: 0.5,
      alive: true,
    });
    expect(inputs[1]).toMatchObject({ id: 6, healthFraction: 0.55 / 1.32, alive: true });
    expect(inputs[2]).toMatchObject({ id: 7, healthFraction: 0, alive: false });
  });
});
