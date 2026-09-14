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
  it('plates only living teammates: the local player, enemies and the dead get nothing', () => {
    const camera = cameraLookingAt([0, 0, 0], [0, 0, 100]);
    const states = statesFor(
      [
        player({ id: 1, team: 1, z: 50 }), // the local player themself
        player({ id: 2, team: 1, z: 50 }),
        player({ id: 3, team: 2, z: 50 }), // enemy: nameless on the world HUD, per spec
        player({ id: 4, team: 1, z: 50, alive: false }),
      ],
      camera,
    );
    expect(states.map((state) => state.playerId)).toEqual([2]);
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
