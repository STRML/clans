import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyDamage,
  createWorld,
  LIGHT_ARMOR,
  stepPower,
  stepWorld,
  type Heightfield,
  type PlayerInput,
} from './index.js';
import { applyBaseObjectDamage, BaseObjectKind, createBaseObjects } from './baseObjects.js';
import { stepRepairPacks } from './repair.js';
import { applyTurretDamage, createTurrets, TurretBarrelId } from './turrets.js';
import { applyVehicleDamage, VehicleKind } from './vehicles.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const FIXED_DT = 32 / 1000;
const REPAIR_RATE = LIGHT_ARMOR.repairRate;
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
const aimingAt = (from: { x: number; z: number }, to: { x: number; z: number }): number =>
  Math.atan2(to.x - from.x, to.z - from.z);

function wallAcrossX(height: number): Heightfield {
  const size = 11;
  const heights = new Uint16Array(size * size);
  for (let row = 0; row < size; row += 1) heights[row * size + 5] = height;
  return {
    gridSize: size,
    squareSize: 2,
    originX: -10,
    originY: 0,
    originZ: 0,
    heightScale: 1,
    heights,
  };
}

describe('stepRepairPacks', () => {
  it('does nothing for a player without the Repair Pack equipped', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt];
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBe(before);
  });

  it('heals a damaged, aimed-at, in-range teammate by repairRate per tick', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt] ?? 0;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBeCloseTo(before - REPAIR_RATE);
  });

  it('failure matrix row 13: stops the instant the target leaves the 10 m beam range', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 11, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt];
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 11, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBe(before);
  });

  it('heals a damaged base object within range', () => {
    const world = createWorld(flat, 1);
    // y=1, not 0: the healer's beam origin sits at eye height (player y + 1.6, eyeOrigin's
    // own MUZZLE_HEIGHT convention); a generator at y=0 sits 1.6 m below that beam, just
    // outside BASE_OBJECT_HIT_RADIUS (1.5 m), so the beam would never register a hit.
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 1, z: 0 } },
    ]);
    // 2.5 spends the shield (capacity 50/30 = 1.667) and lets 0.833 through to health --
    // comfortably under maxHealth (1.5), so the generator is damaged but not destroyed. The
    // plan's own text used 20 here, which overkills a Generator's 1.5 maxHealth outright and
    // destroys it -- since issue #50 a wreck is rebuildable rather than unhealable, but this
    // test pins the plain damaged-asset heal, so the overkill stays out on purpose.
    applyBaseObjectDamage(world, 0, 2.5);
    expect(world.baseObjects.destroyed[0]).toBe(0);
    const before = world.baseObjects.damage[0] ?? 0;
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.baseObjects.damage[0]).toBeLessThan(before);
  });

  it('heals a damaged vehicle within range (Codex review round 1, finding 7)', () => {
    // The spec ("adds repairRate per tick to any damaged asset, vehicle, or player") already
    // required this; findRepairTarget had a player/baseObject/turret candidate search but no
    // vehicle one at all, so a Repair Pack aimed at a damaged vehicle silently did nothing.
    const world = createWorld(flat, 1);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 1;
    world.vehicles.energy[0] = 0; // no shield left to absorb the hit -- lands on damage directly
    world.vehicles.position.set([5, 1.6, 0], 0); // beam origin is eye height (see the comment above)
    applyVehicleDamage(world, 0, 0.3, -1);
    expect(world.vehicles.destroyed[0]).toBe(0);
    const before = world.vehicles.damage[0] ?? 0;
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.vehicles.damage[0]).toBeLessThan(before);
  });

  it('does not revive a destroyed vehicle', () => {
    const world = createWorld(flat, 1);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 1;
    world.vehicles.energy[0] = 0;
    world.vehicles.position.set([5, 1.6, 0], 0);
    applyVehicleDamage(world, 0, 1000, -1);
    expect(world.vehicles.destroyed[0]).toBe(1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.vehicles.destroyed[0]).toBe(1);
  });

  it('issue #50: rebuilds a friendly destroyed generator and restores team power', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 1, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: -5, y: 1, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    // Without a living generator the whole team is unpowered -- the exact perma-offline
    // state issue #50 set out to make recoverable.
    stepPower(world);
    expect(world.baseObjects.powered[1]).toBe(0);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    const input = new Map<number, PlayerInput>([
      [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
    ]);
    // The wreck's overkill damage is clamped to maxHealth on the first heal tick, so the
    // rebuild takes maxHealth/rate ticks: 1.5 / 0.0033 = ~455, not the raw 1000 overkill.
    for (let tick = 0; tick < 400; tick += 1) stepRepairPacks(world, input, FIXED_DT);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    for (let tick = 0; tick < 60; tick += 1) stepRepairPacks(world, input, FIXED_DT);
    expect(world.baseObjects.destroyed[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBe(0);
    // stepWorld's own stepPower cadence picks the rebuild up: one extra tick restores the
    // station's powered bit without any manual bookkeeping.
    stepWorld(world, input);
    expect(world.baseObjects.powered[1]).toBe(1);
  });

  it('issue #50: rebuilds a friendly destroyed inventory station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 5, y: 1, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 3);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    const input = new Map<number, PlayerInput>([
      [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
    ]);
    // 1.0 maxHealth / 0.0033 per tick = ~303 ticks of sustained beam work; the station only
    // returns to service at full rebuild, the same threshold the generator test pins.
    for (let tick = 0; tick < 290; tick += 1) stepRepairPacks(world, input, FIXED_DT);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    for (let tick = 0; tick < 20; tick += 1) stepRepairPacks(world, input, FIXED_DT);
    expect(world.baseObjects.destroyed[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBe(0);
  });

  it('cannot repair an enemy damaged generator', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 5, y: 1, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 2.5);
    const before = world.baseObjects.damage[0] ?? 0;
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.baseObjects.damage[0]).toBe(before);
  });

  it('cannot rebuild an enemy destroyed generator', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 5, y: 1, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    // 1000 overkill minus the 50/30 = 1.667 shield capacity: the wreck's raw stored damage,
    // which must stay untouched by a hostile beam (no clamp, no heal).
    const before = world.baseObjects.damage[0] ?? 0;
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.baseObjects.destroyed[0]).toBe(1);
    expect(world.baseObjects.damage[0]).toBe(before);
  });

  it('cannot repair a friendly generator through terrain', () => {
    const world = createWorld(wallAcrossX(10), 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 4, y: 1, z: 0 } },
    ]);
    applyBaseObjectDamage(world, 0, 2.5);
    const before = world.baseObjects.damage[0];
    const healer = addPlayer(world, { x: -4, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: -4, z: 0 }, { x: 4, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.baseObjects.damage[0]).toBe(before);
  });

  it('repairs a friendly destroyed sentry turret, restoring it only below its disabled level', () => {
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: 5, y: 1.6, z: 0 } },
    ]);
    applyTurretDamage(world, 0, 1000);
    expect(world.turrets.destroyed[0]).toBe(1);
    // Damage is capped at maxHealth, so repair time is determined by the turret's actual
    // health rather than by the amount of overkill in the destroying shot.
    expect(world.turrets.damage[0]).toBeCloseTo(1.2);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    const input = new Map([
      [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
    ]);
    for (let tick = 0; tick < 109; tick += 1) stepRepairPacks(world, input, FIXED_DT);
    expect(world.turrets.damage[0]).toBeGreaterThanOrEqual(0.84);
    expect(world.turrets.destroyed[0]).toBe(1);
    stepRepairPacks(world, input, FIXED_DT);
    expect(world.turrets.damage[0]).toBeLessThan(0.84);
    expect(world.turrets.destroyed[0]).toBe(0);
  });

  it('cannot repair an enemy turret', () => {
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 2, position: { x: 5, y: 1.6, z: 0 } },
    ]);
    applyTurretDamage(world, 0, 0.3);
    const before = world.turrets.damage[0];
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.turrets.damage[0]).toBe(before);
  });

  it('repairs a large turret at its elevated visible mount instead of its ground anchor', () => {
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.PlasmaBarrelLarge, team: 1, position: { x: 5, y: 0, z: 0 } },
    ]);
    world.turrets.energy[0] = 0;
    applyTurretDamage(world, 0, 0.3);
    const before = world.turrets.damage[0] ?? 0;
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.turrets.damage[0]).toBeCloseTo(before - REPAIR_RATE);
  });

  it('cannot repair a friendly turret through terrain', () => {
    const world = createWorld(wallAcrossX(10), 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: 4, y: 1.6, z: 0 } },
    ]);
    applyTurretDamage(world, 0, 0.3);
    const before = world.turrets.damage[0];
    const healer = addPlayer(world, { x: -4, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: -4, z: 0 }, { x: 4, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.turrets.damage[0]).toBe(before);
  });

  it('issue #51 residual: cannot repair a damaged teammate through terrain', () => {
    // The same wall/geometry pair the base-object and turret through-terrain tests above use.
    // findDamagedPlayerCandidate was the last candidate search with no line-of-sight gate, so
    // before this fix the beam healed through a ridge the other two kinds already respected.
    const world = createWorld(wallAcrossX(10), 1);
    const healer = addPlayer(world, { x: -4, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 4, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt];
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: -4, z: 0 }, { x: 4, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBe(before);
  });

  it('issue #51 residual: repairs that teammate in the open, so the gate is occlusion only', () => {
    // Identical healer/target placement on flat terrain: the rejection above must come from
    // the terrain blocking the beam, not from any range, aim or team change that came with it.
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: -4, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 4, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt] ?? 0;
    stepRepairPacks(
      world,
      new Map([
        [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: -4, z: 0 }, { x: 4, z: 0 }) }],
      ]),
      FIXED_DT,
    );
    expect(world.players.damage[hurt]).toBeCloseTo(before - REPAIR_RATE);
  });

  it('never reduces damage below zero', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.0001, -1, LIGHT_ARMOR);
    for (let tick = 0; tick < 10; tick += 1) {
      stepRepairPacks(
        world,
        new Map([
          [healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }],
        ]),
        FIXED_DT,
      );
    }
    expect(world.players.damage[hurt]).toBe(0);
  });
});
