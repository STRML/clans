import { describe, expect, it } from 'vitest';
import { ArmorId, HEAVY_ARMOR } from './armor.js';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import {
  FIXED_DT,
  addPlayer,
  createWorld,
  dueForRespawn,
  respawnPlayer,
  sampleTerrain,
  stepWorld,
  type Heightfield,
  type PlayerInput,
} from './index.js';
import {
  buildInteriorCollider,
  type InteriorPlacement,
  type InteriorTriangles,
} from './interiors.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const idle: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  jet: false,
  fire: false,
  altFire: false,
  slot: 0,
  packActive: false,
};
const inputMap = (id: number, input: Partial<PlayerInput>) =>
  new Map([[id, { ...idle, ...input }]]);

describe('Light movement', () => {
  it('reaches and holds 15 m/s when running forward on flat terrain', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < Math.ceil(2 / FIXED_DT); tick += 1)
      stepWorld(world, inputMap(id, { moveZ: 1 }));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBeCloseTo(15, 1);
  });

  it('a Heavy player accelerates toward 7 m/s forward, not the Light 15 m/s cap', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1, ArmorId.Heavy);
    const forward: PlayerInput = { ...idle, moveZ: 1 };
    for (let tick = 0; tick < 200; tick += 1) stepWorld(world, new Map([[id, forward]]));
    const speed = Math.hypot(
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeLessThanOrEqual(HEAVY_ARMOR.maxForwardSpeed + 0.01);
    expect(speed).toBeGreaterThan(6);
  });

  it('strafes right (-X at yaw 0) on positive moveX, matching the camera basis', () => {
    // Camera forward at yaw 0 is +Z; right = forward x up = -X.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, inputMap(id, { moveX: 1 }));
    expect(world.players.velocity[id * 3]).toBeLessThan(-5);
    expect(Math.abs(world.players.velocity[id * 3 + 2] ?? 0)).toBeLessThan(1e-9);
  });

  it('settles when idle on a 20 degree slope instead of creeping downhill', () => {
    const rise = Math.tan((20 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < 50; tick += 1) stepWorld(world, inputMap(id, {}));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBe(0);
    expect(world.players.position[id * 3 + 2]).toBeCloseTo(500, 3);
  });

  it('falls through an empty square and dies instead of instantly resetting to spawn', () => {
    // Codex review round 9, PR #9 (P1): the kill plane used to reposition the player
    // directly, bypassing pendingDeaths/respawnAt entirely -- a real CTF exploit, since a
    // flag carrier who fell out kept the flag and just teleported with it back to spawn.
    // Falling below world.killY must now go through applyDamage like any other death: no
    // free instant reset, a real pendingDeaths entry, and the standard 5 s respawn timer.
    const holed: Heightfield = { ...flat, emptySquares: new Set([0]) };
    const world = createWorld(holed, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    stepWorld(world, inputMap(id, {}));
    expect(world.players.onGround[id]).toBe(0);
    expect(world.players.velocity[id * 3 + 1]).toBeLessThan(0);
    let deathTick = -1;
    // Tracks the position committed just before the tick that ends up killing the player,
    // for the round 13 finding 4 assertions below.
    let yBeforeFinalTick = world.players.position[id * 3 + 1] ?? 0;
    for (let tick = 0; tick < 200; tick += 1) {
      if (world.players.alive[id] === 0) break;
      yBeforeFinalTick = world.players.position[id * 3 + 1] ?? 0;
      stepWorld(world, inputMap(id, {}));
      if (world.players.alive[id] === 0 && deathTick < 0) deathTick = world.tick - 1;
    }
    expect(deathTick).toBeGreaterThanOrEqual(0);
    expect(world.players.alive[id]).toBe(0);
    // The fix does NOT teleport the player back to spawn on its own -- only respawnPlayer
    // (called once dueForRespawn) does that. But (Codex review round 13, PR #9, finding 4)
    // it now DOES commit the death tick's own newly-integrated position, since stepFlags
    // reads world.players.position for a dying carrier's flag-drop point later in this same
    // stepWorld call: the committed position is strictly past the kill plane and strictly
    // below where the previous tick left off, not stuck at the pre-death value.
    expect(world.players.position[id * 3 + 1]).toBeLessThan(world.killY);
    expect(world.players.position[id * 3 + 1]).toBeLessThan(yBeforeFinalTick);
  });

  it('routes a kill-plane death through the real respawn cycle: full energy/ground-state reset once due', () => {
    // Codex round 10 (PR #4) established that a fall-out must leave the same fresh state
    // addPlayer produces; round 9 moved *how* that happens from a bespoke reset to the
    // standard dueForRespawn/respawnPlayer cycle every other death already uses.
    const holed: Heightfield = { ...flat, emptySquares: new Set([0]) };
    const world = createWorld(holed, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.energy[id] = 10;
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < 200 && world.players.alive[id] === 1; tick += 1) {
      stepWorld(world, inputMap(id, {}));
    }
    expect(world.players.alive[id]).toBe(0);
    while (dueForRespawn(world).length === 0) stepWorld(world, inputMap(id, {}));
    for (const respawnId of dueForRespawn(world)) {
      respawnPlayer(world, respawnId, { x: 10, y: 0, z: 10 });
    }
    expect(world.players.alive[id]).toBe(1);
    expect(world.players.energy[id]).toBe(60);
    expect(world.players.onGround[id]).toBe(0);
    expect(world.players.ski[id]).toBe(0);
    expect(world.players.wasGrounded[id]).toBe(0);
    expect(world.players.position[id * 3]).toBe(10);
    expect(world.players.position[id * 3 + 1]).toBe(0);
    expect(world.players.position[id * 3 + 2]).toBe(10);
  });

  it('holds the run cap when running downhill without skiing', () => {
    const rise = Math.tan((30 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    // Facing downhill (-z): yaw PI makes forward (sin, cos) = (0, -1).
    for (let tick = 0; tick < Math.ceil(3 / FIXED_DT); tick += 1) {
      stepWorld(world, inputMap(id, { moveZ: 1, yaw: Math.PI }));
    }
    // The cap is along the surface, as in Torque, so measure the full tangent speed.
    const speed = Math.hypot(
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 1] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeLessThanOrEqual(15.01);
    expect(speed).toBeGreaterThan(14);
    expect(world.players.ski[id]).toBe(0);
  });

  it('fires a held jump on the tick after landing (the ski hop)', () => {
    // Spawned 0.1 m above flat ground with Space already held, as the client does.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0.1, z: 10 });
    let ticks = 0;
    while (world.players.onGround[id] === 0 && ticks < 20) {
      stepWorld(world, inputMap(id, { jump: true }));
      ticks += 1;
    }
    expect(world.players.onGround[id]).toBe(1);
    stepWorld(world, inputMap(id, { jump: true }));
    expect(world.players.velocity[id * 3 + 1]).toBeGreaterThan(5);
  });

  it('stops from run speed in under 0.5 seconds', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.velocity[id * 3 + 2] = 15;
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < Math.floor(0.5 / FIXED_DT); tick += 1)
      stepWorld(world, inputMap(id, {}));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBe(0);
  });

  it('refuses a jet at minJetEnergy and never drains below zero', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 10, z: 10 });
    world.players.energy[id] = 1;
    stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.energy[id]).toBe(1);
    expect(world.players.velocity[id * 3 + 1]).toBeCloseTo(-20 * FIXED_DT);
  });

  it('drains only while jetting and recharges 0.256 per released tick', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 10, z: 10 });
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.energy[id]).toBeCloseTo(52);
    for (let tick = 0; tick < 100; tick += 1) stepWorld(world, inputMap(id, {}));
    expect(world.players.energy[id]).toBeCloseTo(60);
  });

  it('pushes a fast descending player onto a slope and records landing speed', () => {
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 8,
      originX: 0,
      originY: 0,
      originZ: 8,
      heightScale: 1,
      heights: Uint16Array.from([0, 4, 0, 4]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 4, y: 3, z: 4 });
    world.players.velocity[id * 3 + 1] = -80;
    stepWorld(world, inputMap(id, {}));
    expect(world.players.position[id * 3 + 1]).toBeCloseTo(2);
    // Landing removes the velocity into the surface and keeps the tangent part.
    const { normal } = sampleTerrain(slope, 4, 4);
    const [vx, vy, vz] = [
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 1] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    ];
    expect(vx * normal.x + vy * normal.y + vz * normal.z).toBeCloseTo(0);
    expect(Math.hypot(vx, vy, vz)).toBeGreaterThan(30);
    expect(world.players.landingSpeed[id]).toBeGreaterThanOrEqual(80);
  });

  it('runs up a 60 degree slope at run speed instead of stalling', () => {
    // Torque steers velocity toward the run speed at runForce/mass, and that steering is
    // also what stops a player. A separate friction term fought the run force uphill and
    // left the player crawling at 1 m/s into the spawn hill.
    const rise = Math.tan((60 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    // Facing uphill (+z): yaw 0 makes forward (sin, cos) = (0, 1).
    for (let tick = 0; tick < Math.ceil(2 / FIXED_DT); tick += 1) {
      stepWorld(world, inputMap(id, { moveZ: 1 }));
    }
    const speed = Math.hypot(
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 1] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeGreaterThan(14);
    expect(speed).toBeLessThanOrEqual(15.01);
    expect(world.players.position[id * 3 + 2]).toBeGreaterThan(510);
  });

  it('reaches full run speed on a slope that tilts sideways from the heading (diagonal slope)', () => {
    // Codex round 15: tiltOntoSurface treated cv as a unit vector, which only holds when
    // the slope does not tilt sideways from the heading. On a diagonal slope the result
    // fell short of the true surface tangent, and applyGround's "remove velocity into
    // the surface" clamp bled off the shortfall every tick, so a runner topped out well
    // under the nominal 15 m/s run speed (13.99 m/s before this fix).
    const diagonal: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([0, 1000, 1000, 2000]),
    };
    const world = createWorld(diagonal, 1);
    const start = sampleTerrain(diagonal, 500, 500);
    const id = addPlayer(world, { x: 500, y: start.height, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < 100; tick += 1) stepWorld(world, inputMap(id, { moveZ: 1 }));
    const speed = Math.hypot(
      world.players.velocity[id * 3] ?? 0,
      world.players.velocity[id * 3 + 1] ?? 0,
      world.players.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeGreaterThan(14.9);
  });

  it('keeps its speed while skiing slowly on flat ground with no move input', () => {
    // Skiing removes the ground's grip. Below run speed a skier may still run, but only
    // when a move key is held; with none held nothing may brake them.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    world.players.wasJumpHeld[id] = 1;
    world.players.velocity[id * 3 + 2] = 5;
    for (let tick = 0; tick < 15; tick += 1) stepWorld(world, inputMap(id, { jump: true }));
    expect(world.players.velocity[id * 3 + 2]).toBeCloseTo(5, 6);
    expect(world.players.ski[id]).toBe(1);
  });

  it('gains speed every tick while skiing down a 20 degree slope for 3 seconds', () => {
    const rise = Math.tan((20 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    world.players.wasJumpHeld[id] = 1;
    let previous = 0;
    for (let tick = 0; tick < Math.ceil(3 / FIXED_DT); tick += 1) {
      stepWorld(world, inputMap(id, { jump: true }));
      const speed = Math.hypot(
        world.players.velocity[id * 3] ?? 0,
        world.players.velocity[id * 3 + 2] ?? 0,
      );
      expect(speed + 1e-9).toBeGreaterThanOrEqual(previous);
      previous = speed;
    }
    // 3 s at g*sin(20 deg) = 6.84 m/s^2 stays under horizResistSpeed (33), so speed is
    // monotonic. Above 33 the resistance term can win a tick and the assertion is invalid.
    expect(previous).toBeGreaterThan(15);
  });

  it('fires one jump impulse and refuses it above 80 degrees', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    stepWorld(world, inputMap(id, { jump: true }));
    const first = world.players.velocity[id * 3 + 1] ?? 0;
    stepWorld(world, inputMap(id, { jump: true }));
    expect(world.players.velocity[id * 3 + 1]).toBeLessThan(first);

    const cliff: Heightfield = {
      gridSize: 2,
      squareSize: 8,
      originX: 0,
      originY: 0,
      originZ: 8,
      heightScale: 1,
      heights: Uint16Array.from([64, 64, 0, 0]),
    };
    const steep = createWorld(cliff, 1);
    const steepId = addPlayer(steep, { x: 4, y: 32, z: 4 });
    steep.players.onGround[steepId] = 1;
    steep.players.wasGrounded[steepId] = 1;
    stepWorld(steep, inputMap(steepId, { jump: true }));
    // Refused jump: no upward impulse. Slope gravity may pull the value below zero.
    expect(steep.players.velocity[steepId * 3 + 1]).toBeLessThanOrEqual(0);
    expect(steep.players.ski[steepId]).toBe(1);
  });

  it('scales the jump impulse down between minJumpSpeed and maxJumpSpeed and refuses it above', () => {
    const gainFrom = (vy: number): number => {
      const world = createWorld(flat, 1);
      const id = addPlayer(world, { x: 10, y: 0, z: 10 });
      world.players.onGround[id] = 1;
      world.players.wasGrounded[id] = 1;
      world.players.velocity[id * 3 + 1] = vy;
      stepWorld(world, inputMap(id, { jump: true }));
      return (world.players.velocity[id * 3 + 1] ?? 0) - vy;
    };
    const full = gainFrom(0);
    expect(full).toBeCloseTo(8.3, 6);
    const partial = gainFrom(25);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(full);
    // Above maxJumpSpeed the jump is refused; only the run steering toward rest remains.
    expect(gainFrom(31)).toBeLessThanOrEqual(0);
  });

  it("scales the jump off the vertical speed at the start of the tick, not after this tick's own accel", () => {
    // Round 14: on a steep uphill slope (69 degrees, below the 70 degree runSurfaceAngle) a
    // grounded player near maxJumpSpeed runs applyGround (slope gravity) and applyRun
    // (steering) before applyJump. Those can nudge vy up or down before the jump reads it,
    // so the scale/refusal must use the speed from the start of the tick, not whatever this
    // tick's own gravity and steering already did to vy.
    const rise = Math.tan((69 * Math.PI) / 180) * 1000;
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]),
    };
    const vyAfter = (jump: boolean): number => {
      const world = createWorld(slope, 1);
      const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
      world.players.onGround[id] = 1;
      world.players.wasGrounded[id] = 1;
      world.players.velocity[id * 3 + 1] = 30.1;
      stepWorld(world, inputMap(id, { jump }));
      return world.players.velocity[id * 3 + 1] ?? 0;
    };
    const withJump = vyAfter(true);
    const withoutJump = vyAfter(false);
    expect(withJump).toBeCloseTo(withoutJump, 9);
  });

  it('hard caps horizontal speed at 68 m/s for 100 ticks', () => {
    const slope: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: Uint16Array.from([1000, 1000, 0, 0]),
    };
    const world = createWorld(slope, 1);
    const id = addPlayer(world, { x: 500, y: 500, z: 500 });
    world.players.velocity[id * 3 + 2] = -80; // downhill: row 1 (z = 0) is the low edge
    world.players.wasGrounded[id] = 1;
    world.players.wasJumpHeld[id] = 1;
    for (let tick = 0; tick < 100; tick += 1) stepWorld(world, inputMap(id, { jump: true }));
    expect(
      Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0),
    ).toBeLessThanOrEqual(68);
  });
});

describe('force fields block enemy movement, pass friendly movement (failure matrix row 17)', () => {
  function withForceField(ownerTeam: number): ReturnType<typeof createWorld> {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: ownerTeam, position: { x: 5, y: 0, z: 20 } },
      {
        kind: BaseObjectKind.ForceField,
        team: ownerTeam,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
    ]);
    stepPower(world);
    return world;
  }

  it('an enemy player pushing straight into a powered force field is stopped at it', () => {
    const world = withForceField(2);
    const id = addPlayer(world, { x: 4.5, y: 0, z: 0 }, 1); // team 1, the enemy of the field's team 2
    const forward: PlayerInput = { ...idle, yaw: Math.PI / 2, moveZ: 1 }; // yaw 90 deg faces +X, moveZ pushes forward into the field at x=5
    for (let tick = 0; tick < 30; tick += 1) stepWorld(world, new Map([[id, forward]]));
    expect(world.players.position[id * 3] ?? 0).toBeLessThan(5);
  });

  it('a friendly player walks through the same powered force field unimpeded', () => {
    const world = withForceField(1); // field belongs to team 1, same as the player
    const id = addPlayer(world, { x: 4.5, y: 0, z: 0 }, 1);
    const forward: PlayerInput = { ...idle, yaw: Math.PI / 2, moveZ: 1 };
    for (let tick = 0; tick < 30; tick += 1) stepWorld(world, new Map([[id, forward]]));
    expect(world.players.position[id * 3] ?? 0).toBeGreaterThan(5);
  });

  it('an unpowered force field blocks no one', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      {
        kind: BaseObjectKind.ForceField,
        team: 2,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
    ]);
    // No generator for team 2: stepPower leaves the field unpowered.
    stepPower(world);
    const id = addPlayer(world, { x: 4.5, y: 0, z: 0 }, 1);
    const forward: PlayerInput = { ...idle, yaw: Math.PI / 2, moveZ: 1 };
    for (let tick = 0; tick < 30; tick += 1) stepWorld(world, new Map([[id, forward]]));
    expect(world.players.position[id * 3] ?? 0).toBeGreaterThan(5);
  });
});

describe('swept collision stops a player crossing a thin force field/wall in one tick (Codex round 1, finding 4)', () => {
  const radius = 0.6; // LIGHT_ARMOR boundingBox [1.2, 1.2, 2.3] -> max(boxX, boxY) / 2
  const fieldX = 0.5;

  function withFastPlayer(): { world: ReturnType<typeof createWorld>; id: number } {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    // Injected directly rather than accelerated up to over many ticks: plain running caps at
    // maxForwardSpeed (15 m/s, 0.48 m per 32 ms tick -- less than the player's own collision
    // radius, so it can never tunnel). horizMaxSpeed (68 m/s) is what a real high-speed
    // scenario (skiing a slope, a jet-assisted dive) can reach, and this is close enough to
    // it to cover well over a full collision radius in a single tick, same as those would.
    world.players.velocity[id * 3] = 60;
    return { world, id };
  }

  it('a player moving fast enough to cross a 0.1 m force field in one tick is still blocked', () => {
    // Reference: an identical run with no field at all. The tick's own travel is how far a
    // player at this speed covers in one 32 ms tick -- proof this is a genuine tunneling
    // scenario (comfortably more than one collision radius past the field) that the OLD
    // final-position-only overlap check would have completely missed.
    const reference = withFastPlayer();
    stepWorld(reference.world, new Map([[reference.id, idle]]));
    const unblockedX = reference.world.players.position[reference.id * 3] ?? 0;
    expect(unblockedX).toBeGreaterThan(fieldX + radius * 2);

    const { world, id } = withFastPlayer();
    createBaseObjects(world, [
      {
        kind: BaseObjectKind.ForceField,
        team: 2, // enemy of the player's team 1
        position: { x: fieldX, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 0.1, y: 4, z: 6 },
      },
    ]);
    // createBaseObjects defaults a fresh object to powered=1 (stepPower's own real generator
    // check is a Task 4 concern this test doesn't need); the field is real and blocking from
    // the moment it exists.
    stepWorld(world, new Map([[id, idle]]));
    const blockedX = world.players.position[id * 3] ?? 0;
    expect(blockedX).toBeLessThan(fieldX + radius);
    expect(blockedX).toBeLessThan(unblockedX - radius);
  });
});

describe('MIN_PUSH_DEPTH: floating-point-noise-level interior contact (M4 regression)', () => {
  // A wide quad wall perpendicular to X, tall and deep enough that the player's chest sphere
  // hits its face regardless of the exact y/z it arrives at.
  function wallAt(x: number): InteriorTriangles {
    const positions = new Float32Array([
      x,
      -10,
      -10,
      x,
      10,
      -10,
      x,
      10,
      10,
      x,
      -10,
      -10,
      x,
      10,
      10,
      x,
      -10,
      10,
    ]);
    return { positions };
  }
  const wallPlacement: InteriorPlacement = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
  };
  // yaw 90 deg faces +X (see the force-field tests above for the same convention).
  const forward: PlayerInput = { ...idle, yaw: Math.PI / 2, moveZ: 1 };
  const radius = 0.6; // LIGHT_ARMOR boundingBox [1.2, 1.2, 2.3] -> max(boxX, boxY) / 2

  it('a floating-point-noise-level push does not zero velocity, but a real one still stops the player', () => {
    // Reference run: no interiors at all, so `resolveInteriors` is a no-op every tick, and the
    // position/velocity after tick 61 are exactly what the physics alone integrates to -- the
    // same numbers `resolveInteriors` would see as `body` on tick 61 of a world that only gains
    // a wall on that final tick. This is what lets the two cases below place a wall at an exact,
    // predetermined penetration depth instead of hoping a live run happens to graze one.
    const reference = createWorld(flat, 1);
    const refId = addPlayer(reference, { x: 0, y: 0, z: 0 }, 1);
    for (let tick = 0; tick < 61; tick += 1) stepWorld(reference, new Map([[refId, forward]]));
    const refX = reference.players.position[refId * 3] ?? 0;
    const refVX = reference.players.velocity[refId * 3] ?? 0;
    expect(refVX).toBeGreaterThan(1); // sanity: the player is actually running by tick 61

    // Noise case: the wall's face sits 1e-6 m inside the chest sphere on tick 61 -- the same
    // order of magnitude as the floating-point residue a real Katabatic mesh produced in
    // production (see MIN_PUSH_DEPTH's own comment in movement.ts). Before that fix, dividing
    // the velocity correction by this push's own ~1e-6 m length amplified the noise into a
    // spurious, large velocity change; MIN_PUSH_DEPTH must treat this as "not touching" instead.
    const noiseDepth = 1e-6;
    const noiseWorld = createWorld(flat, 1);
    const noiseId = addPlayer(noiseWorld, { x: 0, y: 0, z: 0 }, 1);
    for (let tick = 0; tick < 60; tick += 1) stepWorld(noiseWorld, new Map([[noiseId, forward]]));
    noiseWorld.interiors = [
      buildInteriorCollider(wallAt(refX + radius - noiseDepth), wallPlacement),
    ];
    stepWorld(noiseWorld, new Map([[noiseId, forward]]));
    const noiseVX = noiseWorld.players.velocity[noiseId * 3] ?? 0;
    expect(noiseVX).toBeGreaterThan(refVX * 0.5);

    // Real case: the same wall, but with a genuine 0.5 m penetration -- MIN_PUSH_DEPTH must not
    // suppress real collision response, or the fix would just trade one bug for another.
    const realDepth = 0.5;
    const realWorld = createWorld(flat, 1);
    const realId = addPlayer(realWorld, { x: 0, y: 0, z: 0 }, 1);
    for (let tick = 0; tick < 60; tick += 1) stepWorld(realWorld, new Map([[realId, forward]]));
    realWorld.interiors = [buildInteriorCollider(wallAt(refX + radius - realDepth), wallPlacement)];
    stepWorld(realWorld, new Map([[realId, forward]]));
    const realVX = realWorld.players.velocity[realId * 3] ?? 0;
    const realX = realWorld.players.position[realId * 3] ?? 0;
    expect(realX).toBeLessThan(refX);
    expect(realVX).toBeLessThan(refVX * 0.5);
  });
});
