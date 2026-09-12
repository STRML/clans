import { describe, expect, it } from 'vitest';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import {
  addPlayer,
  createWorld,
  deserializeVehicle,
  serializeVehicle,
  type Heightfield,
  type PlayerInput,
} from './index.js';
import {
  applyVehicleDamage,
  isProtectedSeat,
  spawnVehicleAtPad,
  stepVehicles,
  TURRET_MUZZLE_OFFSETS,
  VEHICLE_DATA,
  VEHICLE_WEAPON_DATA,
  VehicleKind,
  VehicleWeaponId,
  vehicleMountPosition,
  type VehicleWeaponSpec,
} from './vehicles.js';
import { TURRET_BARREL_DATA, TurretBarrelId, stepTurrets, TurretState } from './turrets.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

const DT = 32 / 1000;
const IDLE: PlayerInput = {
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

function input(overrides: Partial<PlayerInput>): PlayerInput {
  return { ...IDLE, ...overrides };
}

/** A generator plus `pads` vehicle pads for team 1, returned as their base-object ids. */
function poweredPads(world: ReturnType<typeof createWorld>, pads = 1): number[] {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    ...Array.from({ length: pads }, (_, i) => ({
      kind: BaseObjectKind.StationVehiclePad,
      team: 1,
      position: { x: 20 * (i + 1), y: 0, z: 0 },
    })),
  ]);
  stepPower(world);
  return Array.from({ length: pads }, (_, i) => i + 1);
}

function vehiclePos(
  world: ReturnType<typeof createWorld>,
  id: number,
): { x: number; y: number; z: number } {
  return {
    x: world.vehicles.position[id * 3] ?? 0,
    y: world.vehicles.position[id * 3 + 1] ?? 0,
    z: world.vehicles.position[id * 3 + 2] ?? 0,
  };
}

/** A player standing right beside `vId`, mounted into the given seat (0 = pilot). */
function boardPlayer(world: ReturnType<typeof createWorld>, vId: number, seat: 0 | 1): number {
  const pos = vehiclePos(world, vId);
  const id = addPlayer(world, { x: pos.x + 1, y: pos.y + 1, z: pos.z }, 1);
  stepVehicles(world, new Map([[id, input({ use: true })]]), DT); // seat 0 or 1, nearest first
  for (let tick = 0; tick < 4 && seat === 1; tick += 1) {
    // The first boarder takes the pilot seat; a second boarder then takes seat 1. Boarding
    // needs the use bit's own edge, so the press is released between attempts.
    stepVehicles(world, new Map([[id, input({})]]), DT);
  }
  return id;
}

describe('vehicle armament: what each kind carries', () => {
  it('matches the scripts: Shrike 1, Wildcat 0, Bomber 2, Havoc 0, Tank 2, MPB 0', () => {
    const counts = Object.fromEntries(
      Object.entries(VEHICLE_DATA).map(([kind, data]) => [kind, data.weapons.length]),
    );
    expect(counts[VehicleKind.Shrike]).toBe(1);
    expect(counts[VehicleKind.Wildcat]).toBe(0);
    expect(counts[VehicleKind.Bomber]).toBe(2);
    expect(counts[VehicleKind.Havoc]).toBe(0); // vehicle_havoc.cs has an empty WEAPONS section
    expect(counts[VehicleKind.Tank]).toBe(2);
    expect(counts[VehicleKind.MobilePointBase]).toBe(0); // arrives with the deployed turret
  });

  it('puts each weapon on the mount node its own script names', () => {
    const specOf = (kind: VehicleKind, weapon: VehicleWeaponId): VehicleWeaponSpec => {
      const spec = VEHICLE_DATA[kind].weapons.find((w) => w.weapon === weapon);
      expect(spec).toBeDefined();
      return spec as VehicleWeaponSpec;
    };
    // The Shrike's blaster rides node 10 (vehicle_shrike.cs:252) and belongs to the pilot.
    const blaster = specOf(VehicleKind.Shrike, VehicleWeaponId.ShrikeBlaster);
    expect(blaster.mountNode).toBe(10);
    expect(blaster.seat).toBe(0);
    // The Tank's two barrels ride the vehicle's turret socket (node 10, vehicle.cs:465) but
    // are distinct barrels ON that turret: mountPoint 1 (chaingun) and 0 (mortar).
    const chaingun = specOf(VehicleKind.Tank, VehicleWeaponId.AssaultChaingun);
    const mortar = specOf(VehicleKind.Tank, VehicleWeaponId.AssaultMortar);
    expect([chaingun.mountNode, mortar.mountNode]).toEqual([10, 10]);
    expect([chaingun.barrelNode, mortar.barrelNode]).toEqual([1, 0]);
    expect(chaingun.seat).toBe(1); // the turreteer, vehicle.cs:701
    expect(mortar.seat).toBe(1);
    expect(TURRET_MUZZLE_OFFSETS[1]?.x).not.toBe(TURRET_MUZZLE_OFFSETS[0]?.x);
    // The Bomber's gun is barrel 0 of the belly turret; its bombs hang on node 10 with the
    // script's own authored offset (vehicle_bomber.cs:684).
    const gun = specOf(VehicleKind.Bomber, VehicleWeaponId.BomberTurretGun);
    const bomb = specOf(VehicleKind.Bomber, VehicleWeaponId.BomberBomb);
    expect(gun.barrelNode).toBe(0);
    expect(bomb.mountNode).toBe(10);
    expect(bomb.offset).toEqual({ x: 2, y: -4, z: -0.5 });
    expect(gun.seat).toBe(1); // the bombardier, vehicle.cs:601
  });

  it('carries the scripts’ own cadences and energy costs', () => {
    const chaingun = VEHICLE_WEAPON_DATA[VehicleWeaponId.AssaultChaingun];
    // vehicle_tank.cs:502 Fire loops back to Fire, so a held trigger repeats every 0.1 s.
    expect(chaingun.repeatsWhileHeld).toBe(true);
    expect(chaingun.fireTime + chaingun.reloadTime).toBeCloseTo(0.2, 6);
    expect(chaingun.fireTime).toBeCloseTo(0.1, 6);
    expect(chaingun.minEnergy).toBe(15);
    // vehicle_tank.cs:626 hands Fire off to Reload, so every mortar shell costs both
    // timeouts: 1.0 s Fire + 1.0 s Reload (a 1.0 s cadence would be the chaingun's mistake).
    const mortar = VEHICLE_WEAPON_DATA[VehicleWeaponId.AssaultMortar];
    expect(mortar.repeatsWhileHeld).toBe(false);
    expect(mortar.fireTime + mortar.reloadTime).toBeCloseTo(2.0, 6);
    expect(mortar.minEnergy).toBe(77);
    expect(mortar.armTime).toBeCloseTo(0.25, 6);
    expect(mortar.radius).toBe(25);
    // The bomb is DROPPED: vehicle_bomber.cs:646 muzzleVelocity 0.1 with full inheritance.
    const bomb = VEHICLE_WEAPON_DATA[VehicleWeaponId.BomberBomb];
    expect(bomb.speed).toBe(0.1);
    expect(bomb.velInherit).toBe(1);
    expect(bomb.armTime).toBeCloseTo(2.0, 6);
    expect(bomb.radiusDamage).toBe(1.1);
    // The Bomber's fusion bolt: vehicle_bomber.cs:409/415/419.
    const gun = VEHICLE_WEAPON_DATA[VehicleWeaponId.BomberTurretGun];
    expect(gun.directDamage).toBe(0.35);
    expect(gun.speed).toBe(200);
    // The MPB's deployed missile barrel: turningSpeed 90 deg/s (missileBarrelLarge.cs:167).
    expect(TURRET_BARREL_DATA[TurretBarrelId.MissileBarrelLarge].seekTurnRate).toBeCloseTo(
      Math.PI / 2,
      6,
    );
  });
});

describe('vehicle armament: the gunner fires the turret', () => {
  it('a Tank gunner shoots the chaingun from the turret mount node, not the hull origin', () => {
    const world = createWorld(flat, 1);
    const [pad] = poweredPads(world);
    const vId = spawnVehicleAtPad(world, pad as number, VehicleKind.Tank) as number;
    const driver = boardPlayer(world, vId, 0);
    const gunner = boardPlayer(world, vId, 1);
    expect(world.vehicles.driverId[vId]).toBe(driver);
    expect(world.vehicles.passengerId[vId]).toBe(gunner);

    world.pendingVehicleFireEvents.length = 0;
    stepVehicles(world, new Map([[gunner, input({ fire: true, yaw: 0 })]]), DT);
    expect(world.pendingVehicleFireEvents).toHaveLength(1);
    const event = world.pendingVehicleFireEvents[0]!;
    expect(event.weapon).toBe(VehicleWeaponId.AssaultChaingun);
    expect(event.mountNode).toBe(10);
    expect(event.ownerId).toBe(gunner);
    // Geometry: the shot leaves the turret socket plus the barrel's own offset, so it is
    // nowhere near the hull origin and is closest to Mount10's own measured position. A wrong
    // mount node (say Mount1) would put the origin on the other side of the hull.
    const hull = vehiclePos(world, vId);
    const mount10 = vehicleMountPosition(world, vId, 10);
    const origin = event.origin;
    const distTo = (a: { x: number; y: number; z: number }): number =>
      Math.hypot(origin.x - a.x, origin.y - a.y, origin.z - a.z);
    expect(distTo(hull)).toBeGreaterThan(1);
    expect(distTo(mount10)).toBeLessThan(distTo(hull));
    // And the driver's own trigger does nothing: the Tank's guns are the gunner's.
    world.pendingVehicleFireEvents.length = 0;
    stepVehicles(world, new Map([[driver, input({ fire: true })]]), DT);
    expect(world.pendingVehicleFireEvents).toHaveLength(0);
  });

  it('fires the chaingun many times a second but the mortar once per two seconds', () => {
    const world = createWorld(flat, 1);
    const [pad] = poweredPads(world);
    const vId = spawnVehicleAtPad(world, pad as number, VehicleKind.Tank) as number;
    boardPlayer(world, vId, 0);
    const gunner = boardPlayer(world, vId, 1);
    expect(world.vehicles.passengerId[vId]).toBe(gunner);

    const held = (alt: boolean): number => {
      world.vehicles.energy[vId] = VEHICLE_DATA[VehicleKind.Tank].maxEnergy;
      world.vehicles.weaponTimer[vId] = 0;
      world.vehicles.weaponTimerAlt[vId] = 0;
      world.pendingVehicleFireEvents.length = 0;
      let shots = 0;
      for (let tick = 0; tick < 32; tick += 1) {
        stepVehicles(
          world,
          new Map([[gunner, input(alt ? { altFire: true } : { fire: true })]]),
          DT,
        );
        shots += world.pendingVehicleFireEvents.length;
        world.pendingVehicleFireEvents.length = 0;
      }
      return shots;
    };
    const chaingunShots = held(false);
    const mortarShots = held(true);
    // A 0.1 s cadence over exactly 1.0 s of held fire is 10 or 11 shots; the mortar's own
    // 2.0 s cycle is a single shell. Anything that swapped or dropped either cadence fails.
    expect(chaingunShots).toBeGreaterThanOrEqual(9);
    expect(chaingunShots).toBeLessThanOrEqual(11);
    expect(mortarShots).toBe(1);
  });
});

describe('vehicle crew seats', () => {
  it('gives each kind the seat count and protected mounts its own script sets', () => {
    // Each row is the script's own `numMountPoints` and `isProtectedMountPoint[i]`, cited at
    // the field in vehicles.ts. Locked here because the seat count decides how many players a
    // hull can carry and how far a boarding search may reach into its nodes, so a silent edit
    // would change what a match can do. The citations were re-checked against the vendored
    // scripts while writing this: three of them had drifted (the Shrike's by six lines, the
    // Tank's by six and the MPB's seat fields pointed at its camera block), which is exactly
    // the kind of error a test over the table cannot catch and a reader can.
    const layout: { kind: VehicleKind; seats: number; protectedSeats: boolean[] }[] = [
      { kind: VehicleKind.Shrike, seats: 1, protectedSeats: [true] },
      { kind: VehicleKind.Wildcat, seats: 1, protectedSeats: [true] },
      { kind: VehicleKind.Bomber, seats: 3, protectedSeats: [true, true, true] },
      { kind: VehicleKind.Havoc, seats: 6, protectedSeats: [true, true, true, true, true, true] },
      { kind: VehicleKind.Tank, seats: 2, protectedSeats: [true, true] },
      { kind: VehicleKind.MobilePointBase, seats: 1, protectedSeats: [true] },
    ];
    for (const { kind, seats, protectedSeats } of layout) {
      expect(VEHICLE_DATA[kind].numMountPoints, `kind ${String(kind)} seats`).toBe(seats);
      expect(VEHICLE_DATA[kind].protectedMountPoints, `kind ${String(kind)} mounts`).toEqual(
        protectedSeats,
      );
    }
  });

  it('carries a second occupant, and the wire round-trips them', () => {
    const world = createWorld(flat, 1);
    const [pad] = poweredPads(world);
    const vId = spawnVehicleAtPad(world, pad as number, VehicleKind.Tank) as number;
    const driver = boardPlayer(world, vId, 0);
    const gunner = boardPlayer(world, vId, 1);
    expect(world.players.mountedVehicleId[driver]).toBe(vId);
    expect(world.players.mountedVehicleId[gunner]).toBe(vId);
    expect(isProtectedSeat(world, driver)).toBe(true);
    expect(isProtectedSeat(world, gunner)).toBe(true);

    const data = serializeVehicle(world, vId);
    expect(data.driverId).toBe(driver);
    expect(data.passengerId).toBe(gunner);
    const other = createWorld(flat, 1);
    deserializeVehicle(other, data);
    expect(other.vehicles.driverId[vId]).toBe(driver);
    expect(other.vehicles.passengerId[vId]).toBe(gunner);
  });

  it('a single-seat kind never takes a second occupant', () => {
    const world = createWorld(flat, 1);
    const [pad] = poweredPads(world);
    const vId = spawnVehicleAtPad(world, pad as number, VehicleKind.Shrike) as number;
    const driver = boardPlayer(world, vId, 0);
    expect(world.vehicles.driverId[vId]).toBe(driver);
    const second = boardPlayer(world, vId, 1);
    expect(world.vehicles.passengerId[vId]).toBe(-1);
    expect(world.players.mountedVehicleId[second]).toBe(-1);
  });

  it('clears every seat when the vehicle is destroyed', () => {
    const world = createWorld(flat, 1);
    const [pad] = poweredPads(world);
    const vId = spawnVehicleAtPad(world, pad as number, VehicleKind.Tank) as number;
    const driver = boardPlayer(world, vId, 0);
    const gunner = boardPlayer(world, vId, 1);
    // Kill it through the real damage path (crash/collision damage calls this too).
    world.vehicles.energy[vId] = 0;
    applyVehicleDamage(world, vId, VEHICLE_DATA[VehicleKind.Tank].maxDamage, -1);
    stepVehicles(world, new Map(), DT);
    expect(world.vehicles.destroyed[vId]).toBe(1);
    expect(world.vehicles.driverId[vId]).toBe(-1);
    expect(world.vehicles.passengerId[vId]).toBe(-1);
    expect(world.players.mountedVehicleId[driver]).toBe(-1);
    expect(world.players.mountedVehicleId[gunner]).toBe(-1);
  });
});

describe('Mobile Point Base deployment', () => {
  function deployedMpb(): {
    world: ReturnType<typeof createWorld>;
    vId: number;
    pilot: number;
  } {
    const world = createWorld(flat, 1);
    const [pad] = poweredPads(world);
    const vId = spawnVehicleAtPad(world, pad as number, VehicleKind.MobilePointBase) as number;
    const pilot = boardPlayer(world, vId, 0);
    // Leave the driver's seat: real T2 schedules `deployVehicle` 500 ms later, then waits for
    // the hull to stop (vehicle.cs:815, :832). The press needs its own edge, so release first.
    stepVehicles(world, new Map([[pilot, input({})]]), DT);
    stepVehicles(world, new Map([[pilot, input({ use: true })]]), DT);
    stepVehicles(world, new Map([[pilot, input({})]]), DT);
    expect(world.vehicles.driverId[vId]).toBe(-1);
    for (let tick = 0; tick < 40; tick += 1) {
      stepVehicles(world, new Map(), DT);
      stepTurrets(world, DT);
    }
    return { world, vId, pilot };
  }

  it('deploying raises the script’s own station and MobileTurretBase, and undeploying removes them', () => {
    const { world, vId, pilot } = deployedMpb();
    expect(world.vehicles.deployed[vId]).toBe(1);
    // The station: a working inventory station at the hull's own Mount2 node (vehicle.cs:851).
    const stationId = world.vehicles.stationObjectId[vId] as number;
    expect(stationId).toBeGreaterThanOrEqual(0);
    expect(world.baseObjects.kind[stationId]).toBe(BaseObjectKind.StationInventory);
    expect(world.baseObjects.team[stationId]).toBe(world.vehicles.team[vId]);
    expect(world.baseObjects.powered[stationId]).toBe(1); // self-powered, vehicle.cs:853
    const station = [
      world.baseObjects.position[stationId * 3],
      world.baseObjects.position[stationId * 3 + 1],
      world.baseObjects.position[stationId * 3 + 2],
    ];
    const mount2 = vehicleMountPosition(world, vId, 2);
    expect(station[2]).toBeCloseTo(mount2.z, 6);
    // The turret: the MPB's own MissileBarrelLarge on the vehicle's Mount1 node.
    const turretId = world.vehicles.turretId[vId] as number;
    expect(turretId).toBeGreaterThanOrEqual(0);
    expect(world.turrets.barrel[turretId]).toBe(TurretBarrelId.MissileBarrelLarge);
    expect(world.turrets.mountVehicleId[turretId]).toBe(vId);
    expect(world.turrets.powered[turretId]).toBe(1);
    expect(world.turrets.state[turretId]).toBe(TurretState.Ready);

    // Re-mounting takes the base down again (vehicle.cs:762-792).
    stepVehicles(world, new Map([[pilot, input({})]]), DT);
    stepVehicles(world, new Map([[pilot, input({ use: true })]]), DT);
    stepVehicles(world, new Map([[pilot, input({})]]), DT);
    stepTurrets(world, DT);
    expect(world.vehicles.deployed[vId]).toBe(0);
    expect(world.baseObjects.destroyed[stationId]).toBe(1);
    expect(world.turrets.mountVehicleId[turretId]).toBe(-1);
    expect(world.turrets.destroyed[turretId]).toBe(1);
  });

  it('cantAbandon keeps an abandoned MPB alive while an ordinary kind despawns', () => {
    const world = createWorld(flat, 1);
    const pads = poweredPads(world, 4);
    const mpb = spawnVehicleAtPad(world, pads[0] as number, VehicleKind.MobilePointBase) as number;
    const wildcat = spawnVehicleAtPad(world, pads[1] as number, VehicleKind.Wildcat) as number;
    const spareMpb = spawnVehicleAtPad(world, pads[2] as number, VehicleKind.Wildcat) as number;
    const spareWildcat = spawnVehicleAtPad(world, pads[3] as number, VehicleKind.Wildcat) as number;
    // Both pilots leave, then each mounts a DIFFERENT vehicle -- which is what arms the
    // abandoned one's real 15 s timer (player.cs:2101-2105).
    const mpbPilot = boardPlayer(world, mpb, 0);
    stepVehicles(world, new Map([[mpbPilot, input({})]]), DT);
    stepVehicles(world, new Map([[mpbPilot, input({ use: true })]]), DT);
    const wildcatPilot = boardPlayer(world, wildcat, 0);
    stepVehicles(world, new Map([[wildcatPilot, input({})]]), DT);
    stepVehicles(world, new Map([[wildcatPilot, input({ use: true })]]), DT);
    expect(world.vehicles.driverId[mpb]).toBe(-1);
    expect(world.vehicles.driverId[wildcat]).toBe(-1);

    // Each pilot now mounts a third vehicle, arming the timer on the one just left. Teleport
    // the pilots onto their next rides so the mount range check passes.
    for (const [pilot, target] of [
      [mpbPilot, spareMpb],
      [wildcatPilot, spareWildcat],
    ] as Array<[number, number]>) {
      const pos = vehiclePos(world, target);
      world.players.position.set([pos.x, pos.y + 1, pos.z], pilot * 3);
      // The dismount left the anti-reboard guard set (wasUseHeld's bit 1), so the press needs
      // a release first to be a fresh edge.
      stepVehicles(world, new Map([[pilot, input({})]]), DT);
      stepVehicles(world, new Map([[pilot, input({ use: true })]]), DT);
    }
    expect(world.vehicles.abandonTimer[mpb]).toBeGreaterThan(0);
    expect(world.vehicles.abandonTimer[wildcat]).toBeGreaterThan(0);

    for (let tick = 0; tick < Math.ceil(16 / DT); tick += 1) {
      stepVehicles(world, new Map(), DT);
      stepTurrets(world, DT);
    }
    expect(world.vehicles.destroyed[wildcat]).toBe(1); // no cantAbandon: reclaimed
    expect(world.vehicles.destroyed[mpb]).toBe(0); // cantAbandon: stays put (vehicle_mpb.cs:135)
  });
});
