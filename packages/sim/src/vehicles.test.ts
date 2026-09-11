import { describe, expect, it } from 'vitest';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import {
  addPlayer,
  buildInteriorCollider,
  createWorld,
  deserializeVehicle,
  LIGHT_ARMOR,
  removePlayer,
  serializeActiveVehicles,
  serializeVehicle,
  stepProjectiles,
  type Heightfield,
  type PlayerInput,
  type World,
} from './index.js';
import {
  activeVehicleCountForTeam,
  applyVehicleDamage,
  canSendVehicleUse,
  createVehicleStore,
  resolveVehicleCollision,
  spawnVehicleAtPad,
  requestVehicleAtPad,
  VEHICLE_BUILD_TIME,
  stepShrike,
  stepVehiclePhysics,
  vehiclePadAt,
  stepVehicles,
  stepWildcat,
  VEHICLE_DATA,
  VehicleKind,
  vehicleCapForTeam,
} from './vehicles.js';
import { playerHitbox } from './damage.js';

function vehiclePos(
  world: ReturnType<typeof createWorld>,
  vId: number,
): { x: number; y: number; z: number } {
  return {
    x: world.vehicles.position[vId * 3] ?? 0,
    y: world.vehicles.position[vId * 3 + 1] ?? 0,
    z: world.vehicles.position[vId * 3 + 2] ?? 0,
  };
}

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function poweredPad(world: ReturnType<typeof createWorld>, team = 1): number {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationVehiclePad, team, position: { x: 5, y: 0, z: 0 } },
  ]);
  stepPower(world);
  return 1; // the pad's BaseObjectStore id, second createBaseObjects placement
}

describe('spawnVehicleAtPad', () => {
  it('spawns a Shrike at the pad position when powered', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const id = spawnVehicleAtPad(world, padId, VehicleKind.Shrike);
    expect(id).not.toBeNull();
    expect(world.vehicles.kind[id as number]).toBe(VehicleKind.Shrike);
    expect(world.vehicles.damage[id as number]).toBe(0);
  });

  it('refuses to spawn at an unpowered pad', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world); // no generator -> stays unpowered
    expect(spawnVehicleAtPad(world, 0, VehicleKind.Wildcat)).toBeNull();
  });

  it('rejects an out-of-range kind without allocating or poisoning a slot (Codex review round 1, finding 1)', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const invalidKind = 255 as VehicleKind;
    // Before this fix, spawnVehicleAtPad allocated the slot and marked it active BEFORE
    // dereferencing VEHICLE_DATA[kind], so an invalid kind threw partway through, leaving an
    // active-but-half-initialized vehicle the next stepVehicles call would crash on.
    expect(() => spawnVehicleAtPad(world, padId, invalidKind)).not.toThrow();
    expect(spawnVehicleAtPad(world, padId, invalidKind)).toBeNull();
    expect(world.vehicles.count).toBe(0);
    expect(activeVehicleCountForTeam(world, 1)).toBe(0);
    // A subsequent legitimate spawn must still work -- proves no slot was burned or left
    // half-initialized by the rejected attempt.
    const id = spawnVehicleAtPad(world, padId, VehicleKind.Shrike);
    expect(id).not.toBeNull();
    expect(() => stepVehicles(world, new Map(), 1 / 32)).not.toThrow();
  });

  it('spawning a second vehicle at the same pad destroys the first', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const first = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    const second = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    expect(world.vehicles.destroyed[first]).toBe(1);
    expect(second).not.toBe(first);
    expect(world.vehicles.destroyed[second]).toBe(0);
  });

  it('a destroyed vehicle id is not reallocated within the same tick it was freed', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const first = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    spawnVehicleAtPad(world, padId, VehicleKind.Wildcat);
    // Even though `first` is destroyed, its id must still read back as destroyed=1, not
    // silently vanish or get reused, until at least one stepVehicles call passes.
    expect(world.vehicles.active[first]).toBe(1);
    expect(world.vehicles.destroyed[first]).toBe(1);
  });

  it('spawns a Wildcat at hover rest height above the pad deck, not inside it (user report)', () => {
    // The real Katabatic pads sit on SOLID terrain with their walkable svpad deck metres
    // above the pad object's origin (measured: pad y 77.80, deck top 80.10, terrain
    // 75.07). The old padPos.y + 2 placed the craft inside the deck mesh and the hover
    // spring -- which saw only the terrain -- dragged it down through and off the pad.
    const world = createWorld(flat, 1);
    const padId = poweredPad(world); // pad at (5, 0, 0)
    world.interiors = [
      buildInteriorCollider(
        {
          positions: new Float32Array([
            -50, 3, -50, 50, 3, 50, 50, 3, -50, -50, 3, -50, -50, 3, 50, 50, 3, 50,
          ]),
        },
        { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } },
      ),
    ];
    const id = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    // Deck top at y=3, hover rest height 3.0: spawn 6.0, sphere bottom 4.22 clear of the mesh.
    expect(world.vehicles.position[id * 3 + 1]).toBeCloseTo(6, 1);
    for (let tick = 0; tick < 60; tick += 1) stepVehicles(world, new Map(), 1 / 32);
    // The spring holds the craft ON the deck (equilibrium sags 0.667 m under gravity, inside
    // the 2.25-3.75 stab band) instead of being dragged through it or popped sideways off.
    const y = world.vehicles.position[id * 3 + 1] as number;
    expect(y).toBeGreaterThan(3 + 2.25);
    expect(y).toBeLessThan(3 + 3.75);
    expect(world.vehicles.destroyed[id]).toBe(0);
    expect(world.vehicles.damage[id]).toBe(0);
  });
});

describe('vehicleCapForTeam / activeVehicleCountForTeam', () => {
  it('one pad means a cap of one', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    expect(vehicleCapForTeam(world, 1)).toBe(1);
    expect(activeVehicleCountForTeam(world, 1)).toBe(0);
    spawnVehicleAtPad(world, padId, VehicleKind.Shrike);
    expect(activeVehicleCountForTeam(world, 1)).toBe(1);
  });

  it('an unpowered pad does not count toward the cap', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    expect(vehicleCapForTeam(world, 1)).toBe(0);
  });
});

describe('VEHICLE_DATA', () => {
  it('matches the spec Vehicle numbers table exactly', () => {
    expect(VEHICLE_DATA[VehicleKind.Shrike].mass).toBe(150);
    expect(VEHICLE_DATA[VehicleKind.Shrike].maxDamage).toBe(1.4);
    expect(VEHICLE_DATA[VehicleKind.Shrike].maxEnergy).toBe(280);
    expect(VEHICLE_DATA[VehicleKind.Shrike].energyPerDamagePoint).toBe(160);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].mass).toBe(400);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].maxDamage).toBe(0.6);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].maxEnergy).toBe(150);
    expect(VEHICLE_DATA[VehicleKind.Wildcat].energyPerDamagePoint).toBe(75);
  });
});

const idleInput: PlayerInput = {
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
  use: false,
};

function shrikeWorld(): { world: ReturnType<typeof createWorld>; id: number } {
  const world = createWorld(flat, 1);
  world.vehicles = createVehicleStore();
  world.vehicles.active[0] = 1;
  world.vehicles.count = 1;
  world.vehicles.kind[0] = VehicleKind.Shrike;
  world.vehicles.energy[0] = VEHICLE_DATA[VehicleKind.Shrike].maxEnergy;
  world.vehicles.position.set([0, 100, 0], 0); // well above the flat terrain (ground height 0)
  return { world, id: 0 };
}

describe('stepShrike', () => {
  it('an idle Shrike hovers without passive gravity', () => {
    const { world, id } = shrikeWorld();
    for (let tick = 0; tick < 200; tick += 1) stepShrike(world, id, idleInput, 1 / 32);
    expect(world.vehicles.position[id * 3 + 1]).toBeCloseTo(100);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(0);
  });

  it('forward thrust (moveZ) accelerates the Shrike along its heading', () => {
    const { world, id } = shrikeWorld();
    const forward: PlayerInput = { ...idleInput, moveZ: 1 };
    for (let tick = 0; tick < 60; tick += 1) stepShrike(world, id, forward, 1 / 32);
    const speed = Math.hypot(
      world.vehicles.velocity[id * 3] ?? 0,
      world.vehicles.velocity[id * 3 + 2] ?? 0,
    );
    expect(speed).toBeGreaterThan(5);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(0);
  });

  it('neutral jet thrust points upward independently of pitch', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.pitch[id] = 0.8;
    const before = world.vehicles.velocity[id * 3 + 1] ?? 0;
    stepShrike(world, id, { ...idleInput, jet: true, pitch: 0.8 }, 1 / 32);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeGreaterThan(before);
    expect(world.vehicles.velocity[id * 3]).toBeCloseTo(0);
    expect(world.vehicles.velocity[id * 3 + 2]).toBeCloseTo(0);
  });

  it('an empty-energy Shrike remains level while neutral jet is held', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.energy[id] = 0;
    for (let tick = 0; tick < 60; tick += 1)
      stepShrike(world, id, { ...idleInput, jet: true }, 1 / 32);
    expect(world.vehicles.position[id * 3 + 1]).toBeCloseTo(100);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(0);
  });

  it('directional jet thrust follows the current heading', () => {
    const boosted = shrikeWorld();
    const unboosted = shrikeWorld();
    boosted.world.vehicles.pitch[boosted.id] = 0.6;
    unboosted.world.vehicles.pitch[unboosted.id] = 0.6;
    stepShrike(
      boosted.world,
      boosted.id,
      { ...idleInput, moveZ: 1, jet: true, pitch: 0.6 },
      1 / 32,
    );
    stepShrike(unboosted.world, unboosted.id, { ...idleInput, moveZ: 1, pitch: 0.6 }, 1 / 32);
    expect(boosted.world.vehicles.velocity[boosted.id * 3 + 2]).toBeGreaterThan(
      unboosted.world.vehicles.velocity[unboosted.id * 3 + 2] ?? 0,
    );
    expect(boosted.world.vehicles.energy[boosted.id]).toBeLessThan(
      unboosted.world.vehicles.energy[unboosted.id] ?? 0,
    );
  });

  it('released vertical velocity settles even above the auto-stabilizer speed', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.velocity.set([80, 4, 0], id * 3);
    for (let tick = 0; tick < 200; tick += 1) stepShrike(world, id, idleInput, 1 / 32);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(0);
    expect(world.vehicles.velocity[id * 3]).toBeGreaterThan(15);
  });

  it.each([false, true])('levels out downward momentum while flying forward (jet=%s)', (jet) => {
    const { world, id } = shrikeWorld();
    world.vehicles.velocity.set([0, -4, 40], id * 3);
    for (let tick = 0; tick < 100; tick += 1)
      stepShrike(world, id, { ...idleInput, moveZ: 1, jet }, 1 / 32);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(0);
    expect(world.vehicles.velocity[id * 3 + 2]).toBeGreaterThan(15);
  });

  it('settles on mouse heading without repeated overshoot or spiralling', () => {
    const { world, id } = shrikeWorld();
    const target = { ...idleInput, yaw: 1, pitch: 0.4 };
    const yaws: number[] = [];
    for (let i = 0; i < 250; i++) {
      stepShrike(world, id, target, 1 / 32);
      yaws.push(world.vehicles.yaw[id]!);
    }
    expect(Math.max(...yaws)).toBeLessThanOrEqual(1.01);
    expect(world.vehicles.yaw[id]).toBeCloseTo(1, 2);
    expect(world.vehicles.pitch[id]).toBeCloseTo(0.4, 2);
    expect(Math.abs(world.vehicles.angVel[id * 3]!)).toBeLessThan(0.01);
    expect(Math.abs(world.vehicles.roll[id]!)).toBeLessThan(0.01);
  });

  it('mouse yaw (input.yaw) steers the Shrike via steeringForce, not a snap', () => {
    const { world, id } = shrikeWorld();
    const turning: PlayerInput = { ...idleInput, yaw: 0.5 };
    stepShrike(world, id, turning, 1 / 32);
    // One tick of steeringForce should nudge, not teleport, yaw.
    expect(Math.abs(world.vehicles.yaw[id] ?? 0)).toBeGreaterThan(0);
    expect(Math.abs(world.vehicles.yaw[id] ?? 0)).toBeLessThan(0.5);
  });

  it('afterburner (jet input) drains energy at jetEnergyDrain and refuses below minJetEnergy', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.energy[id] = 27; // below minJetEnergy (28)
    const boosting: PlayerInput = { ...idleInput, jet: true };
    stepShrike(world, id, boosting, 1 / 32);
    expect(world.vehicles.energy[id]).toBe(27); // refused, not drained -- also not recharged
    // this tick since jet was held (see applyShrikeAfterburner's else branch).
  });

  it('below maxAutoSpeed the auto-stabilizer damps angular velocity toward level', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.angVel.set([2, 0, 0], id * 3); // spinning fast in pitch
    world.vehicles.velocity.set([1, 0, 0], id * 3); // well under maxAutoSpeed (15)
    stepShrike(world, id, idleInput, 1 / 32);
    expect(Math.abs(world.vehicles.angVel[id * 3] ?? 0)).toBeLessThan(2);
  });
});

function wildcatWorld(): { world: ReturnType<typeof createWorld>; id: number } {
  const world = createWorld(flat, 1);
  world.vehicles = createVehicleStore();
  world.vehicles.active[0] = 1;
  world.vehicles.count = 1;
  world.vehicles.kind[0] = VehicleKind.Wildcat;
  world.vehicles.energy[0] = VEHICLE_DATA[VehicleKind.Wildcat].maxEnergy;
  world.vehicles.position.set([0, 2.75, 0], 0); // flat terrain at height 0; 2.75 m up is inside the hover band
  return { world, id: 0 };
}

describe('stepWildcat', () => {
  it('falls through an empty terrain square instead of hovering on phantom terrain', () => {
    const { world, id } = wildcatWorld();
    world.terrain = { ...world.terrain, emptySquares: new Set([0]) };
    world.vehicles.position.set([5, -5, 5], id * 3);
    stepWildcat(world, id, idleInput, 1 / 32);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeLessThan(0);
    expect(world.vehicles.onGround[id]).toBe(0);
    resolveVehicleCollision(world, id, { x: 5, y: -5, z: 5 }, 1 / 32);
    expect(world.vehicles.position[id * 3 + 1]).toBeLessThan(-5);
  });

  it('holds hover height on the spring: settles between stabLenMin and stabLenMax above terrain', () => {
    const { world, id } = wildcatWorld();
    for (let tick = 0; tick < 200; tick += 1) stepWildcat(world, id, idleInput, 1 / 32);
    const heightAboveGround = world.vehicles.position[id * 3 + 1] ?? 0;
    expect(heightAboveGround).toBeGreaterThan(2.0);
    expect(heightAboveGround).toBeLessThan(4.0);
  });

  it('forward thrust (moveZ) accelerates along heading at mainThrustForce', () => {
    const { world, id } = wildcatWorld();
    const forward: PlayerInput = { ...idleInput, moveZ: 1 };
    for (let tick = 0; tick < 60; tick += 1) stepWildcat(world, id, forward, 1 / 32);
    expect(Math.abs(world.vehicles.velocity[id * 3 + 2] ?? 0)).toBeGreaterThan(0.5);
  });

  it('strafe (moveX) accelerates sideways at strafeThrustForce, weaker than forward thrust', () => {
    const { world, id } = wildcatWorld();
    const strafing: PlayerInput = { ...idleInput, moveX: 1 };
    for (let tick = 0; tick < 32; tick += 1) stepWildcat(world, id, strafing, 1 / 32);
    const strafeSpeed = Math.abs(world.vehicles.velocity[id * 3] ?? 0);
    const forwardWorld = wildcatWorld();
    const forward: PlayerInput = { ...idleInput, moveZ: 1 };
    for (let tick = 0; tick < 32; tick += 1)
      stepWildcat(forwardWorld.world, forwardWorld.id, forward, 1 / 32);
    const forwardSpeed = Math.abs(
      forwardWorld.world.vehicles.velocity[forwardWorld.id * 3 + 2] ?? 0,
    );
    expect(strafeSpeed).toBeLessThan(forwardSpeed);
  });

  it('boost (jet input) multiplies forward thrust and drains jetEnergyDrain', () => {
    const { world, id } = wildcatWorld();
    const boosting: PlayerInput = { ...idleInput, moveZ: 1, jet: true };
    const before = world.vehicles.energy[id] ?? 0;
    stepWildcat(world, id, boosting, 1 / 32);
    expect(world.vehicles.energy[id]).toBeLessThan(before);
  });

  it('jump applies a one-shot vertical impulse gated by boost energy, refused below minJetEnergy', () => {
    const { world, id } = wildcatWorld();
    world.vehicles.onGround[id] = 1;
    world.vehicles.energy[id] = 14; // below minJetEnergy (15)
    const before = world.vehicles.velocity[id * 3 + 1] ?? 0;
    const jumping: PlayerInput = { ...idleInput, jump: true };
    stepWildcat(world, id, jumping, 1 / 32);
    // No jump impulse applied -- only the hover spring/gravity integration moved velocity.
    expect(world.vehicles.velocity[id * 3 + 1]).not.toBe(before + 8.3);
  });

  it('a grounded jump above minJetEnergy applies the impulse and drains energy', () => {
    const { world, id } = wildcatWorld();
    world.vehicles.onGround[id] = 1;
    const before = world.vehicles.energy[id] ?? 0;
    const jumping: PlayerInput = { ...idleInput, jump: true };
    stepWildcat(world, id, jumping, 1 / 32);
    expect(world.vehicles.energy[id]).toBeLessThan(before);
  });

  it('holding jump applies only one impulse, not one per tick (Codex review round 1, finding 8)', () => {
    const { world, id } = wildcatWorld();
    world.vehicles.onGround[id] = 1;
    const jumping: PlayerInput = { ...idleInput, jump: true };
    stepWildcat(world, id, jumping, 1 / 32);
    const afterFirstTick = world.vehicles.velocity[id * 3 + 1] ?? 0;
    // onGround stays 1 across ticks while the hover spring's own contact range holds the
    // Wildcat near the ground -- holding jump for several more ticks, still grounded, must
    // not add a second (or third...) impulse on top of the first.
    world.vehicles.onGround[id] = 1;
    stepWildcat(world, id, jumping, 1 / 32);
    world.vehicles.onGround[id] = 1;
    stepWildcat(world, id, jumping, 1 / 32);
    // Gravity/the hover spring still act every tick, so velocity keeps changing regardless --
    // the assertion is that it never gets ANOTHER +8.3 m/s (WILDCAT_JUMP_IMPULSE_PER_MASS)
    // spike layered on top of tick 1's impulse.
    const afterHolding = world.vehicles.velocity[id * 3 + 1] ?? 0;
    expect(afterHolding).toBeLessThan(afterFirstTick + 8.3);
  });

  it('a held 90-degree steering input settles on the heading without overshoot or wobble (user report)', () => {
    // The pre-fix controller damped angVel by GYRO_DRAG/100 (zeta ~ 0.05): a held 90-degree
    // turn overshot the target by 77 degrees and then limit-cycled 65 degrees UNDER it, so
    // the craft never held a heading. Critical damping (c = 2*sqrt(K)) must both hold the
    // turn to within a degree and end parked on the target heading.
    const { world, id } = wildcatWorld();
    world.vehicles.velocity.set([0, 0, 15], id * 3);
    const target = Math.PI / 2;
    let peak = 0;
    for (let tick = 1; tick <= 600; tick += 1) {
      stepWildcat(world, id, { ...idleInput, moveZ: 1, yaw: target }, 1 / 32);
      peak = Math.max(peak, world.vehicles.yaw[id] ?? 0);
    }
    expect(peak).toBeLessThanOrEqual(target + 0.02);
    expect(world.vehicles.yaw[id] ?? 0).toBeGreaterThan(target - 0.005);
  });
});

describe('resolveVehicleCollision', () => {
  it('a Shrike flown into terrain stops at the surface, not through it', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.position.set([0, -1, 0], id * 3); // below the flat terrain (ground height 0)
    resolveVehicleCollision(world, id, { x: 0, y: 5, z: 0 }, 1 / 32);
    expect(world.vehicles.position[id * 3 + 1]).toBeGreaterThanOrEqual(0);
  });

  it('a high-speed terrain impact applies collision damage above collDamageThresholdVel', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.position.set([0, -1, 0], id * 3);
    resolveVehicleCollision(world, id, { x: 0, y: 5, z: 0 }, 1 / 32); // ~192 m/s synthetic impact
    expect(world.vehicles.damage[id]).toBeGreaterThan(0);
  });

  it('a fast skim spends no shield; a harder landing spends shield before hull', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.position.set([5, 5.4, 0], id * 3);
    world.vehicles.velocity.set([160, -3.2, 0], id * 3);
    resolveVehicleCollision(world, id, { x: 0, y: 5.5, z: 0 }, 1 / 32);
    expect(world.vehicles.energy[id]).toBe(280);
    expect(world.vehicles.damage[id]).toBe(0);
    expect(world.vehicles.velocity[id * 3]).toBe(160);
    // 20 m/s downward: 0.6 damage, entirely absorbed by the full shield.
    world.vehicles.position.set([5, 5.4, 0], id * 3);
    resolveVehicleCollision(world, id, { x: 5, y: 6.025, z: 0 }, 1 / 32);
    expect(world.vehicles.energy[id]).toBeCloseTo(184);
    expect(world.vehicles.damage[id]).toBe(0);
    world.vehicles.energy[id] = 0;
    world.vehicles.position.set([5, 5.4, 0], id * 3);
    resolveVehicleCollision(world, id, { x: 5, y: 6.025, z: 0 }, 1 / 32);
    expect(world.vehicles.damage[id]).toBeCloseTo(0.6);
    expect(world.vehicles.destroyed[id]).toBe(0);
  });

  it('a low-speed landing (below collDamageThresholdVel and groundImpactMinSpeed) takes no damage', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.position.set([0, 5, 0], id * 3); // inside checkRadius (5.5) of the ground
    resolveVehicleCollision(world, id, { x: 0, y: 5.1, z: 0 }, 1 / 32); // ~3.2 m/s
    expect(world.vehicles.damage[id]).toBe(0);
  });
});

describe('vehicle-versus-player collision (issue #57)', () => {
  const dt = 1 / 32;

  /** A piloted Shrike at (0,100,0) and a pedestrian victim `victimZ` meters along +z, with
   *  the vehicle closing at `speed` m/s. The driver sits at the vehicle's own center --
   *  exactly where seatDriver locks a real driver -- so the mounted-player skip is what
   *  keeps every test's own pilot unscathed. */
  function ramWorld(victimZ: number, speed: number) {
    const world = createWorld(flat, 1);
    world.vehicles = createVehicleStore();
    const driver = addPlayer(world, { x: 0, y: 100, z: 0 }, 1);
    const victim = addPlayer(world, { x: 0, y: 100, z: victimZ }, 2);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 1;
    world.vehicles.position.set([0, 100, 0], 0);
    world.vehicles.velocity.set([0, 0, speed], 0);
    world.vehicles.energy[0] = VEHICLE_DATA[VehicleKind.Shrike].maxEnergy;
    world.vehicles.driverId[0] = driver;
    world.players.mountedVehicleId[driver] = 0;
    return { world, driver, victim };
  }

  /** The victim's contact geometry for the ramWorld layout: a unit normal from the vehicle
   *  center to the victim's hit-sphere center, and the closing speed along it. */
  function contactOf(world: World, victim: number, speed: number) {
    const box = playerHitbox(world, victim, LIGHT_ARMOR);
    const len = Math.hypot(box.center.y - 100, box.center.z);
    const ny = (box.center.y - 100) / len;
    const nz = box.center.z / len;
    return { ny, nz, closing: speed * nz };
  }

  it('a strike applies the collDamage rule and the two-body impulse to the victim', () => {
    const { world, victim } = ramWorld(5, 30);
    const { ny, nz, closing } = contactOf(world, victim, 30);
    resolveVehicleCollision(world, 0, { x: 0, y: 100, z: -30 * dt }, dt);
    // (closing - collDamageThresholdVel) * collDamageMultiplier -- the same per-kind rule
    // applyCollisionDamage already applies to the VEHICLE for terrain/interior impacts,
    // now landing on the struck player. 30 m/s is past the 23 m/s threshold but nowhere
    // near a Light's 0.66 maxDamage: wounded, not killed.
    const data = VEHICLE_DATA[VehicleKind.Shrike];
    const damage = (closing - data.collDamageThresholdVel) * data.collDamageMultiplier;
    expect(world.players.damage[victim]).toBeCloseTo(damage, 6);
    expect(world.players.alive[victim]).toBe(1);
    // Two-body elastic impulse 2*mV*mP/(mV+mP)*closing, expressed as a velocity change by
    // dividing by the victim's own mass (applyKickback's Torque applyImpulse convention).
    const dv =
      (((2 * data.mass * LIGHT_ARMOR.mass) / (data.mass + LIGHT_ARMOR.mass)) * closing) /
      LIGHT_ARMOR.mass;
    expect(world.players.velocity[victim * 3 + 1]).toBeCloseTo(dv * ny, 6);
    expect(world.players.velocity[victim * 3 + 2]).toBeCloseTo(dv * nz, 6);
    // The vehicle's own collision pass consumes shield off the same closing speed: 280
    // energy at 160 per point absorbs this entirely, so hull damage stays 0.
    expect(world.vehicles.damage[0]).toBe(0);
    expect(world.vehicles.energy[0]).toBeCloseTo(
      data.maxEnergy - data.energyPerDamagePoint * damage,
      6,
    );
    expect(world.pendingDeaths).toEqual([]);
  });

  it('a lethal roadkill attributes to the driver and scores a kill', () => {
    const { world, driver, victim } = ramWorld(5, 60);
    resolveVehicleCollision(world, 0, { x: 0, y: 100, z: -60 * dt }, dt);
    expect(world.players.alive[victim]).toBe(0);
    expect(world.pendingDeaths).toEqual([{ id: victim, attackerId: driver }]);
    expect(world.players.score[driver]).toBe(10);
    // The mounted skip, under the most hostile possible geometry: the driver sits at the
    // vehicle's own center, deep inside checkRadius. Without the skip every strike would
    // roadkill the pilot too.
    expect(world.players.alive[driver]).toBe(1);
    expect(world.players.damage[driver]).toBe(0);
  });

  it('a slow vehicle shoves a pedestrian without damaging (below collDamageThresholdVel)', () => {
    const { world, victim } = ramWorld(5, 10);
    const { nz, closing } = contactOf(world, victim, 10);
    resolveVehicleCollision(world, 0, { x: 0, y: 100, z: -10 * dt }, dt);
    expect(world.players.damage[victim]).toBe(0);
    expect(world.players.alive[victim]).toBe(1);
    // Impulse still fires below the damage threshold -- contact response, not damage.
    const dv =
      ((2 * VEHICLE_DATA[VehicleKind.Shrike].mass) /
        (VEHICLE_DATA[VehicleKind.Shrike].mass + LIGHT_ARMOR.mass)) *
      closing;
    expect(world.players.velocity[victim * 3 + 2]).toBeCloseTo(dv * nz, 6);
  });

  it('an unpiloted vehicle rolling into someone attributes to nobody (-1)', () => {
    const { world, victim } = ramWorld(5, 60);
    world.vehicles.driverId[0] = -1;
    resolveVehicleCollision(world, 0, { x: 0, y: 100, z: -60 * dt }, dt);
    expect(world.players.alive[victim]).toBe(0);
    expect(world.pendingDeaths).toEqual([{ id: victim, attackerId: -1 }]);
    for (let id = 0; id < world.players.count; id += 1) {
      expect(world.players.score[id]).toBe(0);
    }
  });

  it('a parked vehicle overlapping players stays inert: no strike without vehicle motion', () => {
    // The dismount scenario: seatDriver left the player at the vehicle's own center, the
    // Wildcat idles on its pad, and the player even falls back INTO the sphere (downward
    // velocity along the contact normal). Relative closing alone would re-fire the strike
    // every tick and the player would never come to rest (e2e vehicles.spec.ts's
    // three-identical-position poll caught exactly that) -- the collision event belongs
    // to the vehicle's own motion, so zero vehicle motion means zero interaction.
    const { world, victim } = ramWorld(0.5, 0);
    world.players.velocity[victim * 3 + 1] = -8; // falling back into the sphere
    resolveVehicleCollision(world, 0, { x: 0, y: 100, z: 0 }, dt);
    expect(world.players.damage[victim]).toBe(0);
    expect(world.players.velocity[victim * 3 + 1]).toBe(-8);
    expect(world.players.velocity[victim * 3 + 2]).toBe(0);
    expect(world.vehicles.damage[0]).toBe(0);
    expect(world.pendingDeaths).toEqual([]);
  });
});

describe('vehicle-kill scoring and attribution (issue #57)', () => {
  it('a player-sourced destroying hit credits 5 for an enemy vehicle', () => {
    const { world, id } = shrikeWorld();
    const attacker = addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    world.vehicles.team[id] = 1;
    world.vehicles.energy[id] = 0; // no shield left to absorb the hit first
    applyVehicleDamage(world, id, VEHICLE_DATA[VehicleKind.Shrike].maxDamage, attacker);
    expect(world.vehicles.destroyed[id]).toBe(1);
    expect(world.pendingVehicleDestroyed).toHaveLength(1);
    expect(world.players.score[attacker]).toBe(5);
  });

  it('a crash-finishing blow still credits the last player who damaged the vehicle', () => {
    const { world, id } = shrikeWorld();
    const attacker = addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    world.vehicles.team[id] = 1;
    world.vehicles.energy[id] = 0; // no shield left to absorb the hit first
    applyVehicleDamage(world, id, 1.0, attacker); // 1.0 of the 1.4 maxDamage
    applyVehicleDamage(world, id, 10, -1); // the tree finishes it, unattributed
    expect(world.vehicles.destroyed[id]).toBe(1);
    expect(world.players.score[attacker]).toBe(5);
  });

  it("destroying your own team's vehicle costs 5", () => {
    const { world, id } = shrikeWorld();
    const attacker = addPlayer(world, { x: 50, y: 0, z: 0 }, 1);
    world.vehicles.team[id] = 1;
    world.vehicles.energy[id] = 0; // no shield left to absorb the hit first
    applyVehicleDamage(world, id, VEHICLE_DATA[VehicleKind.Shrike].maxDamage, attacker);
    expect(world.players.score[attacker]).toBe(-5);
  });

  it('crash/turret-only destruction (attackerId -1) credits nobody', () => {
    const { world, id } = shrikeWorld();
    const bystander = addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    world.vehicles.energy[id] = 0; // no shield left to absorb the hit first
    applyVehicleDamage(world, id, VEHICLE_DATA[VehicleKind.Shrike].maxDamage, -1);
    expect(world.vehicles.destroyed[id]).toBe(1);
    expect(world.players.score[bystander]).toBe(0);
  });

  it("a respawned pad vehicle does not inherit the previous occupant's attacker", () => {
    const world = createWorld(flat, 1);
    const pad = poweredPad(world, 1);
    const attacker = addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    const first = spawnVehicleAtPad(world, pad, VehicleKind.Shrike) as number;
    world.vehicles.energy[first] = 0; // no shield left to absorb the hit first
    applyVehicleDamage(world, first, 1.0, attacker); // the attacker leaves their mark on id N
    applyVehicleDamage(world, first, 10, -1); // a crash finishes it (last-damager credit: +5)
    expect(world.players.score[attacker]).toBe(5);
    // Cycle stepVehicles past VEHICLE_ID_REUSE_DELAY_TICKS so the destroyed id falls back
    // into freeIds, then re-spawn the same pad: allocate MUST hand back that same numeric
    // id -- slot reuse is exactly the hazard, a fresh id would make this test vacuous.
    for (let tick = 0; tick < 5; tick += 1) stepVehicles(world, new Map(), 1 / 32);
    const second = spawnVehicleAtPad(world, pad, VehicleKind.Shrike) as number;
    expect(second).toBe(first);
    world.vehicles.energy[second] = 0; // no shield left to absorb the hit first
    applyVehicleDamage(world, second, VEHICLE_DATA[VehicleKind.Shrike].maxDamage, -1);
    expect(world.vehicles.destroyed[second]).toBe(1);
    // The reused id must not carry the previous occupant's attacker: this crash-only
    // destruction credits nobody, so the score stays at exactly the first vehicle's kill.
    expect(world.vehicles.lastAttackerId[second]).toBe(-1);
    expect(world.players.score[attacker]).toBe(5);
  });
});

describe('crash ejection is not overwritten by seat locking (Codex review round 1, finding 2)', () => {
  it('a driver ejected by a mid-tick collision destruction keeps the ejection impulse, is not re-seated', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    world.vehicles.energy[vId] = 0; // no shield left to absorb the hit first
    world.vehicles.position.set([0, 3, 0], vId * 3); // just above the flat terrain (height 0)
    // clampShrikeSpeed caps this to a 100 m/s fall over one tick -- well past both
    // collDamageThresholdVel (23) and groundImpactMinSpeed (10), so this single tick's
    // ground impact alone exceeds the Shrike's maxDamage (1.4) and destroys it.
    world.vehicles.velocity.set([0, -1e6, 0], vId * 3);
    const playerId = addPlayer(world, { x: 0, y: 3, z: 0 }, 1);
    world.vehicles.driverId[vId] = playerId;
    world.players.mountedVehicleId[playerId] = vId;
    stepVehicles(world, new Map(), 1 / 32);
    expect(world.vehicles.destroyed[vId]).toBe(1);
    expect(world.vehicles.driverId[vId]).toBe(-1);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
    // ejectPilot (vehicles/vehicle.cs:237-260) applies a real, nonzero impulse. Before this
    // fix, stepOneVehicle called seatDriver AGAIN afterward with the driverId captured
    // BEFORE physics ran, re-pinning the just-ejected player onto the vehicle's own wreck
    // position and zeroing this impulse straight back out.
    const playerSpeed = Math.hypot(
      world.players.velocity[playerId * 3] ?? 0,
      world.players.velocity[playerId * 3 + 1] ?? 0,
      world.players.velocity[playerId * 3 + 2] ?? 0,
    );
    expect(playerSpeed).toBeGreaterThan(0);
  });
});

describe('a dead driver is treated as unpiloted (Codex review round 2, finding 2)', () => {
  it('self-heals a dangling vehicle-side mount if the driver is no longer alive', () => {
    // Under this milestone's own rules a mounted player can only die via ejectPilot, which
    // already clears both sides of this relationship atomically -- so this specific state
    // (alive: 0 while still the vehicle's own driverId) cannot occur through any live code
    // path today. Set up directly, bypassing normal mount/damage flow, to prove
    // stepOneVehicle's defensive symmetry actually works regardless -- the same
    // defense-in-depth damage.ts's respawnPlayer already documents for the player side of
    // this exact relationship.
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.vehicles.driverId[vId] = playerId;
    world.players.mountedVehicleId[playerId] = vId;
    world.players.alive[playerId] = 0;
    stepVehicles(world, new Map(), 1 / 32);
    expect(world.vehicles.driverId[vId]).toBe(-1);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
  });
});

const useInput = (use: boolean): PlayerInput => ({ ...idleInput, use });

describe('stepVehicles: mount/dismount', () => {
  it('a player within MOUNT_RANGE pressing use mounts the vehicle', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = {
      x: world.vehicles.position[vId * 3] ?? 0,
      y: world.vehicles.position[vId * 3 + 1] ?? 0,
      z: world.vehicles.position[vId * 3 + 2] ?? 0,
    };
    const playerId = addPlayer(world, { x: pos.x + 2, y: pos.y, z: pos.z }, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    expect(world.players.mountedVehicleId[playerId]).toBe(vId);
    expect(world.vehicles.driverId[vId]).toBe(playerId);
  });

  it('boards without E, stays dismounted through held/released E, and boards on reentry', () => {
    const world = createWorld(flat, 1);
    const vId = spawnVehicleAtPad(world, poweredPad(world), VehicleKind.Wildcat)!;
    const playerId = addPlayer(world, vehiclePos(world, vId), 1);
    const step = (use: boolean) =>
      stepVehicles(world, new Map([[playerId, useInput(use)]]), 1 / 32);
    step(false);
    expect(world.players.mountedVehicleId[playerId]).toBe(vId);
    step(true);
    step(true);
    step(false);
    step(false);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
    world.players.position.set([100, 100, 100], playerId * 3);
    step(false);
    const pos = vehiclePos(world, vId);
    world.players.position.set([pos.x, pos.y, pos.z], playerId * 3);
    step(false);
    expect(world.players.mountedVehicleId[playerId]).toBe(vId);
  });

  it('never automatically boards a dead player', () => {
    const world = createWorld(flat, 1);
    const vId = spawnVehicleAtPad(world, poweredPad(world), VehicleKind.Wildcat)!;
    const playerId = addPlayer(world, vehiclePos(world, vId), 1);
    world.players.alive[playerId] = 0;
    stepVehicles(world, new Map([[playerId, useInput(false)]]), 1 / 32);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
    expect(world.vehicles.driverId[vId]).toBe(-1);
  });

  it('a player outside MOUNT_RANGE pressing use does not mount', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const playerId = addPlayer(world, { x: 100, y: 0, z: 100 }, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
    expect(world.vehicles.driverId[vId]).toBe(-1);
  });

  it('use is edge-triggered: holding it does not remount immediately after a mount', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = {
      x: world.vehicles.position[vId * 3] ?? 0,
      y: world.vehicles.position[vId * 3 + 1] ?? 0,
      z: world.vehicles.position[vId * 3 + 2] ?? 0,
    };
    const playerId = addPlayer(world, { x: pos.x, y: pos.y, z: pos.z }, 1);
    const held = new Map([[playerId, useInput(true)]]);
    stepVehicles(world, held, 1 / 32); // mounts
    stepVehicles(world, held, 1 / 32); // still held -- must NOT dismount (no edge)
    expect(world.players.mountedVehicleId[playerId]).toBe(vId);
  });

  it('releasing and pressing use again while mounted dismounts', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = {
      x: world.vehicles.position[vId * 3] ?? 0,
      y: world.vehicles.position[vId * 3 + 1] ?? 0,
      z: world.vehicles.position[vId * 3 + 2] ?? 0,
    };
    const playerId = addPlayer(world, { x: pos.x, y: pos.y, z: pos.z }, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    stepVehicles(world, new Map([[playerId, useInput(false)]]), 1 / 32);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
    expect(world.vehicles.driverId[vId]).toBe(-1);
  });

  it('two players pressing use on the same vehicle the same tick mount exactly one', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = {
      x: world.vehicles.position[vId * 3] ?? 0,
      y: world.vehicles.position[vId * 3 + 1] ?? 0,
      z: world.vehicles.position[vId * 3 + 2] ?? 0,
    };
    const a = addPlayer(world, { x: pos.x, y: pos.y, z: pos.z }, 1);
    const b = addPlayer(world, { x: pos.x + 1, y: pos.y, z: pos.z }, 1);
    stepVehicles(
      world,
      new Map([
        [a, useInput(true)],
        [b, useInput(true)],
      ]),
      1 / 32,
    );
    const mounted = [a, b].filter((id) => world.players.mountedVehicleId[id] === vId);
    expect(mounted).toHaveLength(1);
  });

  it('a pad-respawn destroying a piloted vehicle dismounts the pilot without damage', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const first = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = {
      x: world.vehicles.position[first * 3] ?? 0,
      y: world.vehicles.position[first * 3 + 1] ?? 0,
      z: world.vehicles.position[first * 3 + 2] ?? 0,
    };
    const playerId = addPlayer(world, { x: pos.x, y: pos.y, z: pos.z }, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    spawnVehicleAtPad(world, padId, VehicleKind.Shrike); // destroys `first`, pilot aboard
    stepVehicles(world, new Map(), 1 / 32);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
    expect(world.players.damage[playerId]).toBe(0);
  });
});

describe('removePlayer clears dangling driverId', () => {
  it('removing a driving player leaves the vehicle unpiloted, not dangling', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = {
      x: world.vehicles.position[vId * 3] ?? 0,
      y: world.vehicles.position[vId * 3 + 1] ?? 0,
      z: world.vehicles.position[vId * 3 + 2] ?? 0,
    };
    const playerId = addPlayer(world, { x: pos.x, y: pos.y, z: pos.z }, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    removePlayer(world, playerId);
    expect(world.vehicles.driverId[vId]).toBe(-1);
  });
});

describe('Shrike blaster', () => {
  it('a mounted driver holding fire produces a VehicleFireEvent at the fire cadence', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    const pos = vehiclePos(world, vId);
    const playerId = addPlayer(world, pos, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32); // mount
    world.pendingVehicleFireEvents.length = 0;
    stepVehicles(world, new Map([[playerId, { ...idleInput, fire: true }]]), 1 / 32);
    expect(world.pendingVehicleFireEvents.length).toBeGreaterThan(0);
    expect(world.pendingVehicleFireEvents[0]?.vehicleId).toBe(vId);
  });

  it('a blaster shot that destroys an enemy vehicle credits the driver through the kill-scoring path', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    const driver = addPlayer(world, vehiclePos(world, vId), 1);
    // The target: an unpiloted enemy Shrike 10 m along +x, shields gone and hull already
    // chewed to 0.1 below the killing blow -- one attributed blaster hit finishes it.
    const target = 1;
    world.vehicles.active[target] = 1;
    world.vehicles.count = 2;
    world.vehicles.kind[target] = VehicleKind.Shrike;
    world.vehicles.team[target] = 2;
    world.vehicles.position.set([vehiclePos(world, vId).x + 10, 2, 0], target * 3);
    world.vehicles.energy[target] = 0;
    world.vehicles.damage[target] = VEHICLE_DATA[VehicleKind.Shrike].maxDamage - 0.1;
    stepVehicles(world, new Map([[driver, useInput(true)]]), 1 / 32); // mount
    // Aim the blaster along +x: headingOf(pi/2, 0) = (1, 0, 0). Both the vehicle's own yaw
    // and the driver's steering target agree, so the shot's heading is exactly +x.
    world.vehicles.yaw[vId] = Math.PI / 2;
    world.pendingVehicleFireEvents.length = 0;
    stepVehicles(
      world,
      new Map([[driver, { ...idleInput, fire: true, yaw: Math.PI / 2 }]]),
      1 / 32,
    );
    expect(world.pendingVehicleFireEvents).toHaveLength(1);
    expect(world.pendingVehicleFireEvents[0]?.ownerId).toBe(driver);
    stepProjectiles(world, 1 / 32); // materialize + the same-tick tracer step into the target
    expect(world.vehicles.destroyed[target]).toBe(1);
    expect(world.pendingVehicleDestroyed).toHaveLength(1);
    // The 0.125 direct hit lands on a hull 0.1 from maxDamage: destroyed, and the kill is
    // credited through applyVehicleDamage -> applyVehicleKillScore via the shot's ownerId.
    expect(world.players.score[driver]).toBe(5);
  });

  it('fires immediately then every requested 0.2 s without accumulating 32 ms tick rounding', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    const playerId = addPlayer(world, vehiclePos(world, vId), 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32); // mount
    world.pendingVehicleFireEvents.length = 0;
    const held = new Map([[playerId, { ...idleInput, fire: true }]]);

    for (let tick = 0; tick < 100; tick += 1) stepVehicles(world, held, 32 / 1000);

    // t=0 plus sixteen 200 ms intervals over the following 3.2 seconds. A
    // fresh full timer each shot would quantize to seven 32 ms ticks and emit
    // only fifteen shots here.
    expect(world.pendingVehicleFireEvents).toHaveLength(17);
  });

  it('a Wildcat driver holding fire produces no fire event -- the Wildcat has no weapon', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = vehiclePos(world, vId);
    const playerId = addPlayer(world, pos, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    world.pendingVehicleFireEvents.length = 0;
    stepVehicles(world, new Map([[playerId, { ...idleInput, fire: true }]]), 1 / 32);
    expect(world.pendingVehicleFireEvents.length).toBe(0);
  });

  it('a Shrike blaster shot refuses to fire below minEnergy', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    const pos = vehiclePos(world, vId);
    const playerId = addPlayer(world, pos, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    world.vehicles.energy[vId] = 4; // below minEnergy (5)
    world.pendingVehicleFireEvents.length = 0;
    stepVehicles(world, new Map([[playerId, { ...idleInput, fire: true }]]), 1 / 32);
    expect(world.pendingVehicleFireEvents.length).toBe(0);
  });
});

describe('applyVehicleDamage: shield, clamp, destruction', () => {
  it('spends shield energy before damage, matching the base-object/turret shield rule', () => {
    const world = createWorld(flat, 1);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Wildcat;
    world.vehicles.energy[0] = 75; // exactly energyPerDamagePoint (75) -- absorbs one full point
    applyVehicleDamage(world, 0, 1, -1);
    expect(world.vehicles.energy[0]).toBe(0);
    expect(world.vehicles.damage[0]).toBe(0);
  });

  it('clamps damage at maxDamage and destroys exactly once past it', () => {
    const world = createWorld(flat, 1);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Wildcat;
    world.vehicles.energy[0] = 0;
    applyVehicleDamage(world, 0, 10, -1); // wildly past maxDamage (0.6)
    expect(world.vehicles.damage[0]).toBe(0.6);
    expect(world.vehicles.destroyed[0]).toBe(1);
    const eventsAfterFirst = world.pendingVehicleDestroyed.length;
    applyVehicleDamage(world, 0, 10, -1); // already destroyed -- must be a no-op
    expect(world.pendingVehicleDestroyed.length).toBe(eventsAfterFirst);
  });

  it('destroying a piloted vehicle ejects the pilot once with 0.4 crash damage', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = vehiclePos(world, vId);
    const playerId = addPlayer(world, pos, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    world.vehicles.energy[vId] = 0;
    applyVehicleDamage(world, vId, 10, -1);
    expect(world.players.mountedVehicleId[playerId]).toBe(-1);
    expect(world.players.damage[playerId]).toBeCloseTo(0.4, 5);
    const damageAfterFirstEject = world.players.damage[playerId];
    applyVehicleDamage(world, vId, 10, -1); // already destroyed -- ejection must not repeat
    expect(world.players.damage[playerId]).toBe(damageAfterFirstEject);
  });
});

describe('vehiclePadAt', () => {
  it('finds a powered pad belonging to the player own team within VEHICLE_PAD_USE_RADIUS', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const padPos = {
      x: world.baseObjects.position[padId * 3] ?? 0,
      y: world.baseObjects.position[padId * 3 + 1] ?? 0,
      z: world.baseObjects.position[padId * 3 + 2] ?? 0,
    };
    const playerId = addPlayer(world, padPos, 1);
    expect(vehiclePadAt(world, playerId)).toBe(padId);
  });

  it('returns null outside the use radius', () => {
    const world = createWorld(flat, 1);
    poweredPad(world);
    const playerId = addPlayer(world, { x: 500, y: 0, z: 500 }, 1);
    expect(vehiclePadAt(world, playerId)).toBeNull();
  });

  it('returns null for an enemy team pad', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world, 1);
    const padPos = {
      x: world.baseObjects.position[padId * 3] ?? 0,
      y: world.baseObjects.position[padId * 3 + 1] ?? 0,
      z: world.baseObjects.position[padId * 3 + 2] ?? 0,
    };
    const playerId = addPlayer(world, padPos, 2); // enemy team
    expect(vehiclePadAt(world, playerId)).toBeNull();
  });

  it('returns null for an unpowered pad', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(vehiclePadAt(world, playerId)).toBeNull();
  });
});

describe('canSendVehicleUse', () => {
  it('true when already mounted, so a press can dismount', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = vehiclePos(world, vId);
    const playerId = addPlayer(world, pos, 1);
    stepVehicles(world, new Map([[playerId, useInput(true)]]), 1 / 32);
    expect(canSendVehicleUse(world, playerId)).toBe(true);
  });

  it('true when an unoccupied vehicle is within mount range', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    const pos = vehiclePos(world, vId);
    const playerId = addPlayer(world, pos, 1);
    expect(canSendVehicleUse(world, playerId)).toBe(true);
  });

  it('false when neither mounted nor near an unoccupied vehicle', () => {
    const world = createWorld(flat, 1);
    const playerId = addPlayer(world, { x: 500, y: 0, z: 500 }, 1);
    expect(canSendVehicleUse(world, playerId)).toBe(false);
  });

  it('false near a vehicle already occupied by someone else', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const vId = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
    const pos = vehiclePos(world, vId);
    const driver = addPlayer(world, pos, 1);
    stepVehicles(world, new Map([[driver, useInput(true)]]), 1 / 32);
    const bystander = addPlayer(world, { x: pos.x + 1, y: pos.y, z: pos.z }, 1);
    expect(canSendVehicleUse(world, bystander)).toBe(false);
  });
});

describe('vehicle id retention and reuse', () => {
  it('a destroyed vehicle id becomes reusable after the retention delay elapses', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const first = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    // Re-spawning at the same pad destroys `first` and queues its id for freeing.
    spawnVehicleAtPad(world, padId, VehicleKind.Wildcat);
    for (let tick = 0; tick < 10; tick += 1) stepVehicles(world, new Map(), 1 / 32);
    const third = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    // The freed id was reused rather than growing the store further.
    expect(third).toBe(first);
  });

  it("repeatedly destroying and respawning at one pad never exhausts VehicleStore's capacity", () => {
    // VehicleStore's own capacity is 8 (see the plan's numbers table) -- without freeing
    // destroyed ids, the 9th cumulative spawn at this single pad would return null forever,
    // silently disabling the pad for the rest of the match.
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    for (let spawn = 0; spawn < 20; spawn += 1) {
      const id = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat);
      expect(id).not.toBeNull();
      for (let tick = 0; tick < 5; tick += 1) stepVehicles(world, new Map(), 1 / 32);
    }
  });

  it('pendingVehicleDestroyed does not grow unbounded across many combat destructions', () => {
    // A one-tick transient signal (hash.ts's own POLICY comment: same convention as
    // pendingDeaths/pendingFireEvents) -- stepVehicles clears it at the start of every call,
    // so repeated destructions over a long match never accumulate into an unbounded array.
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    for (let spawn = 0; spawn < 10; spawn += 1) {
      const id = spawnVehicleAtPad(world, padId, VehicleKind.Wildcat) as number;
      world.vehicles.energy[id] = 0;
      applyVehicleDamage(world, id, 10, -1); // destroys it via combat, pushes an event
      stepVehicles(world, new Map(), 1 / 32);
    }
    expect(world.pendingVehicleDestroyed.length).toBeLessThanOrEqual(1);
  });

  it('a combat-destroyed vehicle stays serialized as destroyed for the whole retention window, then stops shipping (issue #26)', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const id = spawnVehicleAtPad(world, padId, VehicleKind.Shrike) as number;
    world.vehicles.energy[id] = 0;
    applyVehicleDamage(world, id, 10, -1);
    // Inside the window the slot is still active, still serialized, and still reads
    // destroyed=1 -- exactly the visibility the VEHICLE_ID_REUSE_DELAY_TICKS delay exists
    // to preserve (failure matrix row 18).
    stepVehicles(world, new Map(), 1 / 32);
    expect(world.vehicles.active[id]).toBe(1);
    expect(serializeActiveVehicles(world).some((v) => v.id === id && v.destroyed === 1)).toBe(true);
    stepVehicles(world, new Map(), 1 / 32);
    expect(world.vehicles.active[id]).toBe(1);
    // The flush that frees the id deactivates it in the same breath: the wreck's entry
    // stops shipping instead of persisting for the rest of the match (issue #26).
    stepVehicles(world, new Map(), 1 / 32);
    expect(world.vehicles.active[id]).toBe(0);
    expect(serializeActiveVehicles(world).some((v) => v.id === id)).toBe(false);
    expect(world.vehicles.freeIds).toContain(id);
  });

  it('allocation cannot hand out a destroyed id until its flush has deactivated it, and the reuse reactivates it (issue #26)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 5, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: -5, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const first = spawnVehicleAtPad(world, 1, VehicleKind.Shrike) as number;
    expect(first).toBe(0);
    world.vehicles.energy[first] = 0;
    applyVehicleDamage(world, first, 10, -1);
    // Still retained and still active mid-window: the other pad's spawn must take a
    // fresh id, not the wreck's.
    expect(spawnVehicleAtPad(world, 2, VehicleKind.Wildcat)).not.toBe(first);
    expect(world.vehicles.freeIds).not.toContain(first);
    for (let tick = 0; tick < 3; tick += 1) stepVehicles(world, new Map(), 1 / 32);
    expect(world.vehicles.active[first]).toBe(0);
    expect(world.vehicles.freeIds).toContain(first);
    const respawned = spawnVehicleAtPad(world, 2, VehicleKind.Shrike) as number;
    expect(respawned).toBe(first);
    expect(world.vehicles.active[first]).toBe(1);
    expect(world.vehicles.destroyed[first]).toBe(0);
  });
});

describe('vehicle wall impacts', () => {
  it('slides along a wall at speed without treating tangential travel as crash damage', () => {
    const { world, id } = shrikeWorld();
    world.interiors = [
      buildInteriorCollider(
        {
          positions: new Float32Array([
            0, 0, -100, 0, 200, -100, 0, 200, 100, 0, 0, -100, 0, 200, 100, 0, 0, 100,
          ]),
        },
        { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } },
      ),
    ];
    world.vehicles.position.set([5.4, 100, 5], id * 3);
    world.vehicles.velocity.set([-3.2, 0, 160], id * 3);
    resolveVehicleCollision(world, id, { x: 5.5, y: 100, z: 0 }, 1 / 32);
    expect(world.vehicles.energy[id]).toBe(280);
    expect(world.vehicles.damage[id]).toBe(0);
    expect(world.vehicles.velocity[id * 3]).toBeCloseTo(0);
    expect(world.vehicles.velocity[id * 3 + 2]).toBe(160);
    // A swept crossing stops outside the wall and a genuinely hard normal hit destroys it.
    world.vehicles.position.set([-1, 100, 5], id * 3);
    resolveVehicleCollision(world, id, { x: 6, y: 100, z: 0 }, 1 / 32);
    expect(world.vehicles.position[id * 3]).toBeCloseTo(5.5);
    expect(world.vehicles.destroyed[id]).toBe(1);
  });
});

describe('vehicle interior support', () => {
  it('keeps an idle Shrike on a raised platform without accumulating impact velocity', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 0, y: 10, z: 0 } },
    ]);
    stepPower(world);
    world.interiors = [
      buildInteriorCollider(
        {
          positions: new Float32Array([
            -50, 10, -50, 50, 10, 50, 50, 10, -50, -50, 10, -50, -50, 10, 50, 50, 10, 50,
          ]),
        },
        { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } },
      ),
    ];
    const id = spawnVehicleAtPad(world, 1, VehicleKind.Shrike)!;
    world.vehicles.position.set([0, 15.5, 0], id * 3);
    for (let tick = 0; tick < 320; tick++) stepVehicles(world, new Map(), 1 / 32);
    expect(world.vehicles.active[id]).toBe(1);
    expect(world.vehicles.destroyed[id]).toBe(0);
    expect(world.vehicles.damage[id]).toBe(0);
    expect(world.vehicles.energy[id]).toBe(VEHICLE_DATA[VehicleKind.Shrike].maxEnergy);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(0);
    // Contact cancels the inward component, preserving travel along the platform.
    world.vehicles.position.set([0, 15.4, 0], id * 3);
    world.vehicles.velocity.set([3, -4, 5], id * 3);
    resolveVehicleCollision(world, id, { x: 0, y: 15.5, z: 0 }, 1 / 32);
    expect(Array.from(world.vehicles.velocity.slice(id * 3, id * 3 + 3))).toEqual([3, 0, 5]);
  });
});

describe('vehicle fabrication', () => {
  it('cancels a disconnected purchaser reservation before their player ID can be reused', () => {
    const world = createWorld(flat, 1);
    const pad = poweredPad(world);
    const player = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.position.set(
      world.baseObjects.usePosition.slice(pad * 3, pad * 3 + 3),
      player * 3,
    );
    const id = requestVehicleAtPad(world, player, pad, VehicleKind.Shrike)!;
    removePlayer(world, player);
    const replacement = addPlayer(world, { x: 100, y: 0, z: 100 }, 1);
    for (let i = 0; i < 210; i++) stepVehicles(world, new Map([[replacement, idleInput]]), 1 / 32);
    expect(world.vehicles.reservedPilotId[id]).toBe(-1);
    expect(world.vehicles.driverId[id]).toBe(-1);
    expect(world.players.mountedVehicleId[replacement]).toBe(-1);
  });

  it('reserves the purchaser, rejects duplicate orders, and teleports them after fabrication', () => {
    const world = createWorld(flat, 1);
    const pad = poweredPad(world);
    const player = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.position.set(
      world.baseObjects.usePosition.slice(pad * 3, pad * 3 + 3),
      player * 3,
    );
    const id = requestVehicleAtPad(world, player, pad, VehicleKind.Shrike)!;
    expect(id).not.toBeNull();
    expect(world.vehicles.spawnTime[id]).toBe(VEHICLE_BUILD_TIME);
    expect(requestVehicleAtPad(world, player, pad, VehicleKind.Wildcat)).toBeNull();
    for (let i = 0; i < 180; i++) stepVehicles(world, new Map([[player, idleInput]]), 1 / 32);
    expect(world.players.mountedVehicleId[player]).toBe(-1);
    for (let i = 0; i < 29; i++) stepVehicles(world, new Map([[player, idleInput]]), 1 / 32);
    expect(world.players.mountedVehicleId[player]).toBe(id);
    expect(world.vehicles.driverId[id]).toBe(player);
    expect(Array.from(world.players.position.slice(player * 3, player * 3 + 3))).toEqual(
      Array.from(world.vehicles.position.slice(id * 3, id * 3 + 3)),
    );
  });
});

// --- The four remaining base kinds (issue #57) -------------------------------------------
// Bomber (vehicle_bomber.cs, FlyingVehicleData), Havoc (vehicle_havoc.cs, FlyingVehicleData),
// Tank (vehicle_tank.cs, HoverVehicleData) and MobilePointBase (vehicle_mpb.cs,
// WheeledVehicleData). Every constant these tests pin is the real script value cited in
// vehicles.ts's own VEHICLE_DATA/params tables; each motion assertion is written so that
// swapping in a sibling kind's constant fails it.

const LATER_KINDS = [
  VehicleKind.Bomber,
  VehicleKind.Havoc,
  VehicleKind.Tank,
  VehicleKind.MobilePointBase,
] as const;

const DT = 1 / 32;

/** A world with one vehicle of `kind` standing (or hovering) over the flat terrain, the same
 *  shape shrikeWorld/wildcatWorld use for the two existing kinds. Terrain height 0. */
function kindWorld(kind: VehicleKind, y: number): { world: World; id: number } {
  const world = createWorld(flat, 1);
  world.vehicles = createVehicleStore();
  world.vehicles.active[0] = 1;
  world.vehicles.count = 1;
  world.vehicles.kind[0] = kind;
  world.vehicles.energy[0] = VEHICLE_DATA[kind].maxEnergy;
  world.vehicles.position.set([0, y, 0], 0);
  return { world, id: 0 };
}

function speedOf(world: World, id: number): number {
  const base = id * 3;
  return Math.hypot(
    world.vehicles.velocity[base] ?? 0,
    world.vehicles.velocity[base + 1] ?? 0,
    world.vehicles.velocity[base + 2] ?? 0,
  );
}

describe('the four later kinds: spawn, board, wreck', () => {
  it.each(LATER_KINDS)('%s spawns at a powered pad of its team and takes a pilot', (kind) => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const id = spawnVehicleAtPad(world, padId, kind);
    expect(id).not.toBeNull();
    const vId = id as number;
    expect(world.vehicles.kind[vId]).toBe(kind);
    expect(world.vehicles.team[vId]).toBe(1);
    expect(world.vehicles.destroyed[vId]).toBe(0);
    expect(world.vehicles.damage[vId]).toBe(0);
    expect(world.vehicles.energy[vId]).toBe(VEHICLE_DATA[kind].maxEnergy);
    expect(world.vehicles.driverId[vId]).toBe(-1);
    // Spawned above the pad's walkable surface, not inside it (the lift is per-kind -- see
    // spawnLiftFor).
    const y = world.vehicles.position[vId * 3 + 1] ?? 0;
    expect(y).toBeGreaterThan(0);

    const pilot = addPlayer(world, { x: 5, y, z: 0 }, 1);
    stepVehicles(world, new Map([[pilot, useInput(true)]]), DT);
    expect(world.vehicles.driverId[vId]).toBe(pilot);
    expect(world.players.mountedVehicleId[pilot]).toBe(vId);
    // Seat-locked to the vehicle's own transform, the contract seatDriver maintains.
    expect(Array.from(world.players.position.slice(pilot * 3, pilot * 3 + 3))).toEqual(
      Array.from(world.vehicles.position.slice(vId * 3, vId * 3 + 3)),
    );
  });

  it.each(LATER_KINDS)('%s takes damage, is destroyed once, and frees its slot', (kind) => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const id = spawnVehicleAtPad(world, padId, kind) as number;
    const data = VEHICLE_DATA[kind];
    // Enough to spend the whole shield and then the hull: energy/energyPerDamagePoint of the
    // hit is soaked by the shield, the remainder lands on damage (applyVehicleDamage). One
    // point over maxDamage, because a blow that lands within float rounding of exactly
    // maxDamage leaves damage a hair under it and does not destroy -- the clamp only fires
    // when the sum exceeds maxDamage.
    applyVehicleDamage(
      world,
      id,
      data.maxEnergy / data.energyPerDamagePoint + data.maxDamage + 1,
      -1,
    );
    expect(world.vehicles.energy[id]).toBe(0);
    expect(world.vehicles.damage[id]).toBeCloseTo(data.maxDamage, 10);
    expect(world.vehicles.destroyed[id]).toBe(1);
    expect(world.pendingVehicleDestroyed).toHaveLength(1);
    expect(world.pendingVehicleDestroyed[0]?.id).toBe(id);
    expect(world.pendingVehicleDestroyed[0]?.team).toBe(1);
    // The wreck stays visible for the retention window, then the id is reusable: the same
    // lifecycle contract the two existing kinds already live under (issue #26).
    expect(serializeActiveVehicles(world).some((v) => v.id === id && v.destroyed === 1)).toBe(true);
    for (let tick = 0; tick < 3; tick += 1) stepVehicles(world, new Map(), DT);
    expect(world.vehicles.active[id]).toBe(0);
    expect(world.vehicles.freeIds).toContain(id);
    expect(spawnVehicleAtPad(world, padId, kind)).toBe(id);
  });

  it.each(LATER_KINDS)('%s survives a snapshot round trip as its own kind (wire byte)', (kind) => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const id = spawnVehicleAtPad(world, padId, kind) as number;
    const target = createWorld(flat, 1);
    deserializeVehicle(target, serializeVehicle(world, id));
    expect(target.vehicles.active[id]).toBe(1);
    expect(target.vehicles.kind[id]).toBe(kind);
  });

  it('each kind carries its own script camera parameters', () => {
    // vehicles/<script>.cs, lines cited in VEHICLE_DATA's own entries.
    expect(VEHICLE_DATA[VehicleKind.Bomber].cameraMaxDist).toBe(22); // vehicle_bomber.cs:205
    expect(VEHICLE_DATA[VehicleKind.Bomber].cameraOffset).toBe(5); // vehicle_bomber.cs:206
    expect(VEHICLE_DATA[VehicleKind.Bomber].cameraLag).toBe(1.0); // vehicle_bomber.cs:207
    expect(VEHICLE_DATA[VehicleKind.Havoc].cameraMaxDist).toBe(17); // vehicle_havoc.cs:66
    expect(VEHICLE_DATA[VehicleKind.Havoc].cameraOffset).toBe(2); // vehicle_havoc.cs:67
    expect(VEHICLE_DATA[VehicleKind.Havoc].cameraLag).toBe(8.5); // vehicle_havoc.cs:68
    expect(VEHICLE_DATA[VehicleKind.Tank].cameraMaxDist).toBe(20); // vehicle_tank.cs:223
    expect(VEHICLE_DATA[VehicleKind.Tank].cameraOffset).toBe(3); // vehicle_tank.cs:224
    expect(VEHICLE_DATA[VehicleKind.Tank].cameraLag).toBe(1.5); // vehicle_tank.cs:225
    expect(VEHICLE_DATA[VehicleKind.MobilePointBase].cameraMaxDist).toBe(20); // vehicle_mpb.cs:132
    expect(VEHICLE_DATA[VehicleKind.MobilePointBase].cameraOffset).toBe(6); // vehicle_mpb.cs:133
    expect(VEHICLE_DATA[VehicleKind.MobilePointBase].cameraLag).toBe(1.5); // vehicle_mpb.cs:134
  });
});

describe('flying class: Bomber and Havoc', () => {
  it.each([
    // kind, one tick of forward speed. Derived from that flyer's own maneuveringForce/mass,
    // then its minDrag, then the auto-stabilizer's autoLinearForce/mass -- all three script
    // numbers (vehicle_bomber.cs:232,218,225; vehicle_havoc.cs:93,80,86).
    [VehicleKind.Bomber, 0.390609056122449],
    [VehicleKind.Havoc, 0.31340392561983466],
  ])('%s accelerates at its own maneuveringForce/mass', (kind, expected) => {
    const { world, id } = kindWorld(kind, 100);
    stepVehiclePhysics(world, id, { ...idleInput, moveZ: 1 }, DT);
    // The Shrike's 3000/150, or the other flyer's pair, both land outside this tolerance.
    expect(world.vehicles.velocity[id * 3 + 2]).toBeCloseTo(expected, 6);
  });

  it.each([
    [VehicleKind.Bomber, 85], // maxForwardSpeed, vehicle_bomber.cs:238
    [VehicleKind.Havoc, 71], // maxForwardSpeed, vehicle_havoc.cs:99
  ])('%s thrust stops at its own maxForwardSpeed (%s m/s)', (kind, maxForwardSpeed) => {
    const { world, id } = kindWorld(kind, 100);
    world.vehicles.velocity.set([0, 0, 200], id * 3);
    stepVehiclePhysics(world, id, idleInput, DT);
    expect(speedOf(world, id)).toBeCloseTo(maxForwardSpeed, 6);
  });

  it.each([VehicleKind.Bomber, VehicleKind.Havoc])(
    '%s is self-supporting: an idle one holds altitude with no gravity',
    (kind) => {
      const { world, id } = kindWorld(kind, 100);
      for (let tick = 0; tick < 200; tick += 1) stepVehiclePhysics(world, id, idleInput, DT);
      expect(world.vehicles.position[id * 3 + 1]).toBeCloseTo(100);
      expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(0);
    },
  );

  it('the Havoc needs more jet energy than the Bomber before its afterburner lights', () => {
    // minJetEnergy 55 (vehicle_havoc.cs:103) vs 40 (vehicle_bomber.cs:242): the same 50-point
    // pool refuses the Havoc's afterburner and flies the Bomber's.
    const havoc = kindWorld(VehicleKind.Havoc, 100);
    havoc.world.vehicles.energy[havoc.id] = 50;
    stepVehiclePhysics(havoc.world, havoc.id, { ...idleInput, jet: true }, DT);
    expect(havoc.world.vehicles.velocity[havoc.id * 3 + 1]).toBe(0);

    const bomber = kindWorld(VehicleKind.Bomber, 100);
    bomber.world.vehicles.energy[bomber.id] = 50;
    stepVehiclePhysics(bomber.world, bomber.id, { ...idleInput, jet: true }, DT);
    expect(bomber.world.vehicles.velocity[bomber.id * 3 + 1]).toBeGreaterThan(0);
    expect(bomber.world.vehicles.energy[bomber.id]).toBeLessThan(50);
  });
});

describe('hover class: Tank', () => {
  it('settles on its own stab band, not the Wildcat hover height', () => {
    // stabLenMin 3.25 / stabLenMax 4 / stabSpringConstant 50 (vehicle_tank.cs:274-276), so
    // the spring's equilibrium sits the Tank at 3.625 - GRAVITY/50 = 3.225 m above terrain.
    const { world, id } = kindWorld(VehicleKind.Tank, 3.625);
    for (let tick = 0; tick < 200; tick += 1) stepVehiclePhysics(world, id, idleInput, DT);
    expect(world.vehicles.position[id * 3 + 1]).toBeCloseTo(3.225, 2);
    expect(world.vehicles.onGround[id]).toBe(1);
  });

  it('thrusts at its own mainThrustForce (50 m/s^2), not the Wildcat thrust', () => {
    const { world, id } = kindWorld(VehicleKind.Tank, 3.625);
    stepVehiclePhysics(world, id, { ...idleInput, moveZ: 1 }, DT);
    // The hover class applies its script forces as accelerations directly, so one tick of
    // mainThrustForce 50 (vehicle_tank.cs:266) is exactly 50 * DT -- the Wildcat's own
    // mainThrustForce 30 would give 0.9375 instead.
    expect(world.vehicles.velocity[id * 3 + 2]).toBeCloseTo(50 * DT, 6);
  });

  it('caps at its own top speed and boosts by turboFactor 1.7', () => {
    const { world, id } = kindWorld(VehicleKind.Tank, 3.625);
    world.vehicles.velocity.set([0, 0, 100], id * 3);
    stepVehiclePhysics(world, id, { ...idleInput, moveZ: 1 }, DT);
    // Horizontal only: the hover spring is still working vertically at the same time.
    expect(Math.abs(world.vehicles.velocity[id * 3 + 2] as number)).toBeCloseTo(13, 6);
    world.vehicles.velocity.set([0, 0, 100], id * 3);
    stepVehiclePhysics(world, id, { ...idleInput, moveZ: 1, jet: true }, DT);
    expect(Math.abs(world.vehicles.velocity[id * 3 + 2] as number)).toBeCloseTo(13 * 1.7, 6);
  });

  it('steers at its own steeringForce, turning a held 90-degree input slower than the Wildcat', () => {
    const tank = kindWorld(VehicleKind.Tank, 3.625);
    const wildcat = kindWorld(VehicleKind.Wildcat, 2.75);
    const target = { ...idleInput, yaw: Math.PI / 2 };
    for (let tick = 0; tick < 32; tick += 1) {
      stepVehiclePhysics(tank.world, tank.id, target, DT);
      stepVehiclePhysics(wildcat.world, wildcat.id, target, DT);
    }
    const tankYaw = tank.world.vehicles.yaw[tank.id] ?? 0;
    const wildcatYaw = wildcat.world.vehicles.yaw[wildcat.id] ?? 0;
    // steeringForce 15 (vehicle_tank.cs:282) vs the Wildcat's 30: same critical damping
    // shape, so the Tank's one-second response is measurably the slower of the two, and
    // neither snaps to the target.
    expect(tankYaw).toBeGreaterThan(0);
    expect(tankYaw).toBeLessThan(wildcatYaw);
    expect(wildcatYaw).toBeLessThan(Math.PI / 2);
  });

  it('has no jump: a held jump neither lifts it nor drains its boost energy', () => {
    const { world, id } = kindWorld(VehicleKind.Tank, 3.625);
    world.vehicles.onGround[id] = 1;
    world.vehicles.velocity.set([0, 0, 0], id * 3);
    stepVehiclePhysics(world, id, { ...idleInput, jump: true }, DT);
    // Only the spring's own sag from the rest height below: no +8.3 impulse, and the
    // Wildcat's grounded jump would have spent jetEnergyDrain doing it.
    expect(world.vehicles.velocity[id * 3 + 1]).toBeCloseTo(-20 * DT, 6);
    expect(world.vehicles.energy[id]).toBe(VEHICLE_DATA[VehicleKind.Tank].maxEnergy);
  });
});

describe('wheeled class: MobilePointBase', () => {
  it('rests on its wheels at the measured ride height instead of hovering', () => {
    const world = createWorld(flat, 1);
    const padId = poweredPad(world);
    const id = spawnVehicleAtPad(world, padId, VehicleKind.MobilePointBase) as number;
    // Spawned at its own ground contact height (the model's wheels reach 2.83 m below the
    // origin), so the very first tick is already resting contact: no drop, no bounce.
    const spawnY = world.vehicles.position[id * 3 + 1] as number;
    expect(spawnY).toBeCloseTo(2.83, 6);
    for (let tick = 0; tick < 60; tick += 1) stepVehicles(world, new Map(), DT);
    expect(world.vehicles.position[id * 3 + 1]).toBeCloseTo(spawnY, 6);
    expect(world.vehicles.onGround[id]).toBe(1);
    expect(world.vehicles.destroyed[id]).toBe(0);
    expect(world.vehicles.damage[id]).toBe(0);
  });

  it('drives at engineTorque/tireRadius/mass, not a hover class thrust', () => {
    const { world, id } = kindWorld(VehicleKind.MobilePointBase, 2.83);
    const accel = (7.0 * 745) / 1.6 / 2000; // engineTorque 5215 (mpb:170), tireRadius 1.6 (:181), mass 2000 (:150)
    for (let tick = 0; tick < 60; tick += 1) {
      stepVehiclePhysics(world, id, { ...idleInput, moveZ: 1 }, DT);
    }
    expect(world.vehicles.velocity[id * 3 + 2]).toBeCloseTo(accel * 60 * DT, 6);
    // A hover craft thrusting for the same 60 ticks is several times quicker off the line.
    expect(accel * 60 * DT).toBeLessThan(30 * DT * 60);
  });

  it('caps at maxWheelSpeed 20 and brakes to a stop when the throttle is released', () => {
    const { world, id } = kindWorld(VehicleKind.MobilePointBase, 2.83);
    world.vehicles.velocity.set([0, 0, 50], id * 3);
    stepVehiclePhysics(world, id, { ...idleInput, moveZ: 1 }, DT);
    expect(world.vehicles.velocity[id * 3 + 2]).toBeCloseTo(20, 6);
    // breakTorque 5215 (:171) over the same wheel: 1.63 m/s^2, so a full stop takes 12+ s
    // from the cap -- 20 s here is comfortably clear of it.
    for (let tick = 0; tick < 640; tick += 1) stepVehiclePhysics(world, id, idleInput, DT);
    expect(Math.abs(world.vehicles.velocity[id * 3 + 2] ?? 1)).toBeLessThan(1e-6);
  });

  it('does not turn on the spot: yaw follows only at speed, at maxSteeringAngle 0.3', () => {
    const stationary = kindWorld(VehicleKind.MobilePointBase, 2.83);
    stepVehiclePhysics(stationary.world, stationary.id, { ...idleInput, yaw: 1 }, DT);
    expect(stationary.world.vehicles.yaw[stationary.id]).toBe(0);

    const moving = kindWorld(VehicleKind.MobilePointBase, 2.83);
    moving.world.vehicles.velocity.set([0, 0, 20], moving.id * 3);
    stepVehiclePhysics(moving.world, moving.id, { ...idleInput, moveZ: 1, yaw: 1 }, DT);
    // speed * tan(maxSteeringAngle) / wheelbase, wheelbase = 2 * tireRadius: the MPB's own
    // three script numbers (maxSteeringAngle 0.3, :139; tireRadius 1.6, :181). The Tank's
    // maxSteeringAngle (0.5) or the hover class's wheel-free steering both differ.
    const expected = (20 * Math.tan(0.3) * DT) / (2 * 1.6);
    expect(moving.world.vehicles.yaw[moving.id]).toBeCloseTo(expected, 6);
    expect(moving.world.vehicles.yaw[moving.id]).toBeLessThan(0.1);
  });

  it('falls under gravity when there is no support under it', () => {
    const { world, id } = kindWorld(VehicleKind.MobilePointBase, 100);
    stepVehiclePhysics(world, id, idleInput, DT);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeLessThan(0);
    expect(world.vehicles.onGround[id]).toBe(0);
  });

  it('takes ground-impact damage on a hard landing and none on a soft one', () => {
    // minImpactSpeed 12 m/s, speedDamageScale 0.06 (vehicle_mpb.cs:162-163). Shield energy is
    // zeroed so the hit lands on the hull where the assertion can see it.
    const hard = kindWorld(VehicleKind.MobilePointBase, 2.9);
    hard.world.vehicles.energy[hard.id] = 0;
    hard.world.vehicles.velocity.set([0, -25, 0], hard.id * 3);
    stepVehiclePhysics(hard.world, hard.id, idleInput, DT);
    stepVehiclePhysics(hard.world, hard.id, idleInput, DT);
    // 25 m/s plus one tick of gravity, less minImpactSpeed, scaled by 0.06.
    expect(hard.world.vehicles.damage[hard.id]).toBeCloseTo((25 + 20 * DT - 12) * 0.06, 6);
    expect(hard.world.vehicles.destroyed[hard.id]).toBe(0);

    const soft = kindWorld(VehicleKind.MobilePointBase, 2.9);
    soft.world.vehicles.energy[soft.id] = 0;
    soft.world.vehicles.velocity.set([0, -4, 0], soft.id * 3);
    stepVehiclePhysics(soft.world, soft.id, idleInput, DT);
    stepVehiclePhysics(soft.world, soft.id, idleInput, DT);
    expect(soft.world.vehicles.damage[soft.id]).toBe(0);
  });
});

describe('class dispatch: stepVehiclePhysics routes each kind to its own model', () => {
  it('a Tank falls to its hover band while a Bomber beside it holds altitude', () => {
    const tank = kindWorld(VehicleKind.Tank, 8);
    const bomber = kindWorld(VehicleKind.Bomber, 8);
    for (let tick = 0; tick < 400; tick += 1) {
      stepVehiclePhysics(tank.world, tank.id, idleInput, DT);
      stepVehiclePhysics(bomber.world, bomber.id, idleInput, DT);
    }
    expect(tank.world.vehicles.position[tank.id * 3 + 1]).toBeCloseTo(3.225, 2);
    expect(bomber.world.vehicles.position[bomber.id * 3 + 1]).toBeCloseTo(8, 6);
  });
});
