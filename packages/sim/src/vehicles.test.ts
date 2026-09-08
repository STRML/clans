import { describe, expect, it } from 'vitest';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import {
  addPlayer,
  buildInteriorCollider,
  createWorld,
  removePlayer,
  type Heightfield,
  type PlayerInput,
} from './index.js';
import {
  activeVehicleCountForTeam,
  applyVehicleDamage,
  canSendVehicleUse,
  createVehicleStore,
  resolveVehicleCollision,
  spawnVehicleAtPad,
  stepShrike,
  vehiclePadAt,
  stepVehicles,
  stepWildcat,
  VEHICLE_DATA,
  VehicleKind,
  vehicleCapForTeam,
} from './vehicles.js';

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
  it('an idle Shrike with no input falls under gravity like any unpowered body', () => {
    const { world, id } = shrikeWorld();
    stepShrike(world, id, idleInput, 1 / 32);
    expect(world.vehicles.velocity[id * 3 + 1]).toBeLessThan(0);
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

  it('a low-speed landing (below collDamageThresholdVel and groundImpactMinSpeed) takes no damage', () => {
    const { world, id } = shrikeWorld();
    world.vehicles.position.set([0, 5, 0], id * 3); // inside checkRadius (5.5) of the ground
    resolveVehicleCollision(world, id, { x: 0, y: 5.1, z: 0 }, 1 / 32); // ~3.2 m/s
    expect(world.vehicles.damage[id]).toBe(0);
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
