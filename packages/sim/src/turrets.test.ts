import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyDamage,
  createWorld,
  LIGHT_ARMOR,
  ProjectileImpactReason,
  stepProjectiles,
  stepWorld,
  type Heightfield,
  type PlayerInput,
  type World,
} from './index.js';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import {
  applyTurretDamage,
  createTurrets,
  distanceToTurretHitShape,
  hasLineOfSight,
  rayTurretHitShapeDistance,
  stepTurrets,
  TURRET_BARREL_DATA,
  TURRET_BASE_DATA,
  turretHitbox,
  turretHitShape,
  TurretBarrelId,
  TurretBaseId,
} from './turrets.js';
import {
  buildInteriorCollider,
  type InteriorPlacement,
  type InteriorTriangles,
} from './interiors.js';
import { VEHICLE_DATA, VehicleKind } from './vehicles.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

/** An 11x11 grid spanning world x,z in [-10, 10] (squareSize 2, origin at the -10,-10
 *  corner), flat at height 0 except a `BUMP`-metre ridge across both the middle row and the
 *  middle column. Elevating both axes' centre band, not just one, makes the fixture robust
 *  to whichever of `terrain.ts`'s two grid axes actually indexes world X versus world Z —
 *  the segment this test cares about (turret to target, both at world z=0) crosses the
 *  ridge either way.
 *
 *  `originY` fixed to 0 (the plan's own draft used -10, a bug): terrain.ts's sampleTerrain
 *  adds originY to every raw height as a vertical baseline, so with originY=-10 a
 *  bumpHeight=10 ridge sits at absolute height 0 while the flat floor sits at -10 — with the
 *  turret/target y positions this file uses (2 and 0, both well above -10), that ridge falls
 *  entirely below the sightline and never blocks it. originY=0 puts the ridge at its intended
 *  absolute height (10), which the LOS line from y=2 to y=0 actually crosses. */
function hillBetween(bumpHeight: number): Heightfield {
  const size = 11;
  const heights = new Uint16Array(size * size);
  const mid = 5;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      heights[row * size + col] = row === mid || col === mid ? bumpHeight : 0;
    }
  }
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

/** A single 10 m wall crossing world x=0 at every z. Verified against terrain.ts's real
 *  axis convention (sampleTerrain: gridX = (x-originX)/squareSize indexes col, gridY =
 *  (originZ-z)/squareSize indexes row, terrainIndex = row*gridSize+col) — col already maps
 *  to X, so `heights[row*size+wallCol]` set for every row places the wall at worldX=0 for
 *  every worldZ the grid spans, exactly as this fixture intends. No swap needed. */
function wallAcrossX(bumpHeight: number): Heightfield {
  const size = 11;
  const wallCol = 5; // worldX = originX + wallCol * squareSize = -10 + 10 = 0.
  const heights = new Uint16Array(size * size);
  for (let row = 0; row < size; row += 1) heights[row * size + wallCol] = bumpHeight;
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
const FIXED_DT = 32 / 1000;
const ticksFor = (seconds: number): number => Math.ceil(seconds / FIXED_DT);

function poweredTurret(world: ReturnType<typeof createWorld>, barrel: TurretBarrelId): number {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
  ]);
  createTurrets(world, [{ barrel, team: 1, position: { x: 0, y: 0, z: 0 } }]);
  stepPower(world);
  return 0;
}

describe('TURRET_BARREL_DATA / TURRET_BASE_DATA', () => {
  it('PlasmaBarrelLarge matches the spec table and plasmaBarrelLarge.cs', () => {
    const p = TURRET_BARREL_DATA[TurretBarrelId.PlasmaBarrelLarge];
    expect(p.speed).toBe(50);
    expect(p.radiusDamage).toBe(0.5);
    expect(p.radius).toBe(10);
    expect(p.kickback).toBe(500);
    expect(p.fireTime).toBe(0.3);
    expect(p.reloadTime).toBe(0.8);
    expect(p.attackRadius).toBe(120);
  });
  it('AABarrelLarge matches aaBarrelLarge.cs', () => {
    const a = TURRET_BARREL_DATA[TurretBarrelId.AABarrelLarge];
    expect(a.speed).toBe(150);
    expect(a.directDamage).toBe(0.25);
    expect(a.fireTime).toBe(0.15);
    expect(a.reloadTime).toBe(0.2);
    expect(a.attackRadius).toBe(200);
    expect(a.vehiclesOnly).toBe(true);
  });
  it('SentryTurretBarrel matches the spec table and sentryTurret.cs', () => {
    const s = TURRET_BARREL_DATA[TurretBarrelId.SentryTurretBarrel];
    expect(s.directDamage).toBe(0.1);
    expect(s.speed).toBe(200);
    expect(s.fireTime).toBe(0.13);
    expect(s.reloadTime).toBe(0.4);
  });
  it('TurretBaseLarge maxHealth/energyPerDamagePoint match the spec table', () => {
    const base = TURRET_BASE_DATA[TurretBaseId.Large];
    expect(base.maxHealth).toBe(2.25);
    expect(base.energyPerDamagePoint).toBe(50);
    expect(base.thetaMin).toBe(15);
    expect(base.thetaMax).toBe(140);
  });
  it('Sentry base maxHealth matches the spec table', () => {
    expect(TURRET_BASE_DATA[TurretBaseId.Sentry].maxHealth).toBe(1.2);
  });
});

describe('stepTurrets: acquisition and firing', () => {
  it('an unpowered turret never fires', () => {
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.PlasmaBarrelLarge, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    // No generator created: stepPower would leave it unpowered, but this test skips even
    // calling stepPower to prove the default (a freshly created turret with no power source
    // reachable) is "unpowered", not "powered by default".
    stepPower(world);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('a powered turret acquires and fires at an enemy within range', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.PlasmaBarrelLarge);
    addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    let fired = false;
    for (let tick = 0; tick < ticksFor(1); tick += 1) {
      stepTurrets(world, FIXED_DT);
      if (world.pendingTurretFireEvents.length > 0) fired = true;
    }
    expect(fired).toBe(true);
  });

  it('never fires at a teammate', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.PlasmaBarrelLarge);
    addPlayer(world, { x: 50, y: 0, z: 0 }, 1);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('ignores a target beyond the engagement range (min of sensor radius and attackRadius)', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.PlasmaBarrelLarge);
    // TurretBaseLarge sensor radius is 80 m — tighter than PlasmaBarrelLarge's 120 m attackRadius.
    addPlayer(world, { x: 90, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('AABarrelLarge never acquires a target this milestone (real T2 targets vehicles only)', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.AABarrelLarge);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('failure matrix row 12: a target that dies this tick is dropped, no next-tick fire at the corpse', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.SentryTurretBarrel);
    const enemy = addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT); // acquires
    expect(world.turrets.targetId[turret]).toBe(enemy);
    applyDamage(world, enemy, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).not.toBe(enemy);
  });

  it('fire/reload timing matches SentryTurretBarrel: 0.13 s fire, 0.40 s reload', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.SentryTurretBarrel);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    let fires = 0;
    for (let tick = 0; tick < ticksFor(1); tick += 1) {
      stepTurrets(world, FIXED_DT);
      fires += world.pendingTurretFireEvents.length;
    }
    // One full cycle is fireTime + reloadTime = 0.53 s; in 1 s that is at least one and at
    // most two shots, never a shot every tick.
    expect(fires).toBeGreaterThanOrEqual(1);
    expect(fires).toBeLessThanOrEqual(2);
    expect(world.turrets.state[turret]).not.toBeUndefined();
  });
});

describe('hasLineOfSight (spec: real T2 sensor detectsUsingLOS = true, turret.cs:142)', () => {
  it('true between two points with nothing but flat ground between them', () => {
    const world = createWorld(hillBetween(0), 1);
    expect(hasLineOfSight(world, { x: -8, y: 2, z: 0 }, { x: 8, y: 0, z: 0 })).toBe(true);
  });
  it('false when a 10 m ridge sits between them at world z=0', () => {
    const world = createWorld(hillBetween(10), 1);
    expect(hasLineOfSight(world, { x: -8, y: 2, z: 0 }, { x: 8, y: 0, z: 0 })).toBe(false);
  });
});

describe('stepTurrets: line of sight (failure matrix row 16)', () => {
  it('a hill between the turret and an otherwise-in-range player blocks acquisition', () => {
    const world = createWorld(hillBetween(10), 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    // 16 m apart, well inside SentryTurretBarrel's 60 m engagement range — only the hill
    // stands in the way.
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });
  it('the same layout with no hill acquires and fires normally', () => {
    const world = createWorld(hillBetween(0), 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    let fired = false;
    for (let tick = 0; tick < ticksFor(1); tick += 1) {
      stepTurrets(world, FIXED_DT);
      if (world.pendingTurretFireEvents.length > 0) fired = true;
    }
    expect(fired).toBe(true);
  });
  it('a target that moves to a position with no line of sight is dropped, not fired through', () => {
    const world = createWorld(wallAcrossX(10), 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    const turret = 0;
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    // Placed close to the turret first, on the same side of the x=0 wall, so the initial
    // acquisition tick has clear line of sight and a real target to later drop.
    const enemy = addPlayer(world, { x: -6, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).toBe(enemy);
    world.players.position.set([8, 0, 0], enemy * 3); // crosses x=0 to the far side of the wall
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).not.toBe(enemy);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });
});

describe('stepTurrets: interior and force-field occlusion (issue #49)', () => {
  /** A single quad wall crossing world x=0, spanning y 0..4 and z -4..4 — the interior
   *  twin of this file's terrain wallAcrossX fixture (same verified axis mapping: grid
   *  columns map to world X, so a wall "across X" is a YZ-plane quad at x=0). */
  function wallInterior(): InteriorTriangles {
    const positions = new Float32Array([0, 0, -4, 0, 4, -4, 0, 4, 4, 0, 0, -4, 0, 4, 4, 0, 0, 4]);
    return { positions };
  }
  const wallPlacement: InteriorPlacement = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
  };

  it('an interior wall between the turret and an in-range enemy blocks acquisition', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallInterior(), wallPlacement)];
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    // 16 m apart, well inside the sentry's engagement range — only the wall stands in the
    // way: the eye-to-target sightline crosses x=0 at y≈1, inside the wall's 0..4 span.
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[0]).toBe(-1);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('an enemy force field between the turret and an in-range enemy blocks acquisition', () => {
    const world = createWorld(flat, 1);
    // Team 2's generator powers team 2's field; team 1's own generator powers the turret.
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 0, z: 20 } },
      {
        kind: BaseObjectKind.ForceField,
        team: 2,
        position: { x: 0, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[0]).toBe(-1);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('the same layout behind a FRIENDLY field still acquires and fires (fields are team-passable)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
      {
        kind: BaseObjectKind.ForceField,
        team: 1,
        position: { x: 0, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    // The built geometry now straddles the sightline exactly like the blocked case — an
    // enemy field there blinds the turret, so this also proves an exposed target is still
    // acquired once the only thing in the way is a field of its own team.
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[0]).toBe(0);
    expect(world.pendingTurretFireEvents).toHaveLength(1);
  });

  it('a target that walks behind an interior wall is dropped, not fired through (retention)', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallInterior(), wallPlacement)];
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    // Placed close to the turret, on the same side of the x=0 wall, so the acquisition
    // tick has clear sight and a real target to later drop.
    const enemy = addPlayer(world, { x: -6, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[0]).toBe(enemy);
    world.players.position.set([8, 0, 0], enemy * 3); // crosses x=0 to the wall's far side
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[0]).not.toBe(enemy);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('an AA barrel does not acquire a vehicle parked behind an interior wall', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallInterior(), wallPlacement)];
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.AABarrelLarge, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 2;
    // The eye-to-vehicle sightline from (-8, 2, 0) to (8, 5, 0) crosses x=0 at y=3.5 —
    // inside the wall's 0..4 span — so the vehicle is as invisible as a player would be.
    world.vehicles.position.set([8, 5, 0], 0);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[0]).toBe(-1);
  });

  it('the turret never occludes itself: the sightline grazes its own hitbox and still engages', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.PlasmaBarrelLarge, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    stepPower(world);
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT);
    // Geometry, not charity: the measured assembly's head column is a 1.314 m radius about
    // the placement axis from y 0.354 to 2.219 (the Arms/Sleeve's circumscribed bounds), and
    // the eye->target sightline from (-8, 2, 0) to (8, 0, 0) enters it at x -6.686, y 1.836
    // -- well inside the envelope. A turret that could occlude itself could never see past
    // its own barrel; acquisition (and the fresh turret's same-tick fire) must succeed
    // because the occlusion test never consults the turret's own assembly.
    expect(world.turrets.targetId[0]).toBe(0);
    expect(world.pendingTurretFireEvents).toHaveLength(1);
  });
});

describe('applyTurretDamage', () => {
  it('destroys at maxHealth and clears the current target', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.SentryTurretBarrel);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT);
    applyTurretDamage(world, turret, 1000);
    expect(world.turrets.destroyed[turret]).toBe(1);
    stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });
});

describe('AA barrel vehicle targeting (M5, failure matrix row 15)', () => {
  it('a powered AA barrel with line of sight to an enemy vehicle in range acquires it', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.AABarrelLarge);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 2; // enemy
    world.vehicles.position.set([50, 5, 0], 0); // within the 200 m attackRadius
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).toBe(0);
    expect(world.turrets.targetKind[turret]).toBe(1);
  });

  it('the AA barrel does not target a friendly vehicle', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.AABarrelLarge);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 1; // friendly
    world.vehicles.position.set([50, 5, 0], 0);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).toBe(-1);
  });

  it('ignores a vehicle outside attackRadius', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.AABarrelLarge);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 2;
    world.vehicles.position.set([500, 5, 0], 0); // past the 200 m attackRadius
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).toBe(-1);
  });

  it('a hill between the AA barrel and an in-range vehicle blocks acquisition (row 16)', () => {
    const world = createWorld(hillBetween(10), 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } },
    ]);
    createTurrets(world, [
      { barrel: TurretBarrelId.AABarrelLarge, team: 1, position: { x: -8, y: 2, z: 0 } },
    ]);
    stepPower(world);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 2;
    world.vehicles.position.set([8, 0, 0], 0); // beyond the ridge at world x=0
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[0]).toBe(-1);
  });

  it('fires on the acquired vehicle: a pending fire event points at it, not a player', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.AABarrelLarge);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 2;
    world.vehicles.position.set([50, 5, 0], 0);
    stepTurrets(world, FIXED_DT); // a fresh turret starts Ready, so acquire+fire land the same tick
    expect(world.pendingTurretFireEvents).toHaveLength(1);
    expect(world.turrets.targetId[turret]).toBe(0);
    expect(world.turrets.targetKind[turret]).toBe(1);
  });

  it('re-acquires a vehicle target that is destroyed mid-engagement', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.AABarrelLarge);
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Shrike;
    world.vehicles.team[0] = 2;
    world.vehicles.position.set([50, 5, 0], 0);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).toBe(0);
    world.vehicles.destroyed[0] = 1;
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).toBe(-1);
  });
});

// --- AA seeker flight (issue #57) -----------------------------------------------------------

/** The seeker tests' generator sits 30 m from its turret on purpose: the missile spawns at
 *  the turret's own position, and a generator co-located there would put every shot's
 *  origin inside the generator's own 1.5 m hit sphere (raySphereDistance's "origin already
 *  inside the sphere" case) -- each shot would detonate at distance 0 against its own base
 *  instead of ever reaching the Shrike. */
function poweredAATurret(world: World): number {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: -30, y: 0, z: 0 } },
  ]);
  createTurrets(world, [
    { barrel: TurretBarrelId.AABarrelLarge, team: 1, position: { x: 0, y: 0, z: 0 } },
  ]);
  stepPower(world);
  return 0;
}

/** An enemy Shrike coasting at 15 m altitude with a -z velocity. Unpiloted: stepVehicles
 *  runs it on idle input, whose only effect is the Shrike's own horizontal drag decaying
 *  the coast -- a target that keeps moving the whole engagement, like a real flyby. */
function coastingShrike(world: World, z: number, vz: number): void {
  world.vehicles.active[0] = 1;
  world.vehicles.count = 1;
  world.vehicles.kind[0] = VehicleKind.Shrike;
  world.vehicles.team[0] = 2;
  world.vehicles.spawnTime[0] = 0;
  world.vehicles.position.set([40, 15, z], 0);
  world.vehicles.velocity.set([0, 0, vz], 0);
  world.vehicles.energy[0] = VEHICLE_DATA[VehicleKind.Shrike].maxEnergy;
}

describe('AA seeker flight (issue #57)', () => {
  it('an AA missile runs down a crossing Shrike in a full stepWorld engagement', () => {
    const world = createWorld(flat, 1);
    poweredAATurret(world);
    coastingShrike(world, 30, -30);
    // The Shrike's full 280 energy absorbs each 0.25 direct hit as 40 shield points (160
    // energyPerDamagePoint) and vehicle recharge adds at most 0.8 a tick, so the FIRST
    // connection shows up as a one-tick energy drop -- not as hull damage. The shot's
    // straight fly-out misses this crossing target by meters; only a homing hit connects.
    let prevEnergy = world.vehicles.energy[0] ?? 0;
    let impactTick = -1;
    for (let tick = 0; tick < ticksFor(4.5); tick += 1) {
      stepWorld(world, new Map<number, PlayerInput>());
      const energy = world.vehicles.energy[0] ?? 0;
      if (energy < prevEnergy - 10) {
        impactTick = tick;
        break;
      }
      prevEnergy = energy;
    }
    expect(impactTick).toBeGreaterThanOrEqual(0);
    // ...and that drop is an authoritative impact record against the vehicle...
    expect(
      world.projectiles.lastImpacts.some(
        (impact) => impact.reason === ProjectileImpactReason.World,
      ),
    ).toBe(true);
    // ...from an AA barrel still steering at its locked vehicle target.
    expect(world.turrets.targetId[0]).toBe(0);
    expect(world.turrets.targetKind[0]).toBe(1);
  });

  it('the shot flies straight through the 1 s seekTime, then bends toward the locked Shrike', () => {
    const world = createWorld(flat, 1);
    const turret = poweredAATurret(world);
    coastingShrike(world, 0, -20); // dead +x of the turret, so the launch has no z velocity
    stepTurrets(world, FIXED_DT); // a fresh turret starts Ready: acquire + fire same tick
    stepProjectiles(world, FIXED_DT); // materialize + the tracer's own first step
    expect(world.turrets.targetId[turret]).toBe(0);
    expect(world.projectiles.active[0]).toBe(1);
    const id = 0;
    const base = id * 3;
    expect(world.projectiles.velocity[base + 2]).toBe(0); // aimed dead at the Shrike
    // Pull the Shrike 40 m off the shot's line mid-flight, the way a crossing target moves.
    world.vehicles.position.set([40, 15, 40], 0);
    const seekTicks = Math.round(1.0 / FIXED_DT);
    for (let tick = 1; tick < seekTicks - 2; tick += 1) {
      stepTurrets(world, FIXED_DT);
      stepProjectiles(world, FIXED_DT);
      // Still inside the seekTime straight fly-out: z velocity remains exactly launch's 0.
      expect(world.projectiles.velocity[base + 2]).toBe(0);
    }
    for (let tick = 0; tick < 20; tick += 1) {
      stepTurrets(world, FIXED_DT);
      stepProjectiles(world, FIXED_DT);
    }
    // Homing: the velocity bends toward the displaced target, with speed preserved.
    const speed = Math.hypot(
      world.projectiles.velocity[base] ?? 0,
      world.projectiles.velocity[base + 1] ?? 0,
      world.projectiles.velocity[base + 2] ?? 0,
    );
    expect(speed).toBeCloseTo(TURRET_BARREL_DATA[TurretBarrelId.AABarrelLarge].speed, 6);
  });

  it('a seeker whose turret lost the lock flies straight (the barrel is the lock, no re-scan)', () => {
    const world = createWorld(flat, 1);
    const turret = poweredAATurret(world);
    coastingShrike(world, 0, -20);
    stepTurrets(world, FIXED_DT);
    stepProjectiles(world, FIXED_DT);
    const base = 0 * 3;
    world.vehicles.position.set([40, 15, 40], 0);
    world.vehicles.destroyed[0] = 1; // a destroyed wreck drops out of acquisition AND hit-tests
    const seekTicks = Math.round(1.0 / FIXED_DT);
    for (let tick = 0; tick < seekTicks + 20; tick += 1) {
      stepTurrets(world, FIXED_DT);
      stepProjectiles(world, FIXED_DT);
      expect(world.turrets.targetId[turret]).toBe(-1); // never re-acquires the wreck
    }
    // Past seekTime with no lock: the missile flies dead straight, z velocity untouched.
    expect(world.projectiles.velocity[base + 2]).toBe(0);
  });
});

describe('issue #54: the collision shape is the measured assembly, not a sphere', () => {
  /** The plasma (Large) barrel's measurement, quoted in turrets.ts's TURRET_HIT_SHAPE_DATA
   *  comment: `turret_base_large.glb`'s BaseMain box corner (1.1194, 2.0712) sits 2.3543 m
   *  from the placement axis, its Arms corner (0.5310, 1.2007) 1.3130 m, its lowest node
   *  -0.0004 and its PostCap tops 1.3260; `turret_fusion_large.glb`'s Muzzlepoint lands
   *  1.7573 m out from the socket at (0, 1.8265, -0.4001), and its barrel mesh's maximum
   *  perpendicular radius (the breech block) is 0.4363. Every constant is rounded outward to
   *  the millimetre. */
  function largeShape() {
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.PlasmaBarrelLarge, team: 2, position: { x: 0, y: 0, z: 0 } },
    ]);
    return turretHitShape(world, 0);
  }

  it('a shot into the pedestal stops at the measured 2.3543 m base-body radius', () => {
    // BaseMain, the base's widest intact part: a 2.2388 x 2.4822 slab whose far corner is
    // (1.1194, 2.0712) -> 2.3543 m from the placement axis, carried as 2.355.
    expect(
      rayTurretHitShapeDistance({ x: 0, y: 0.5, z: -8 }, { x: 0, y: 0, z: 1 }, largeShape()),
    ).toBeCloseTo(8 - 2.355, 6);
  });

  it('a shot over the assembly misses it, where the replaced sphere hit', () => {
    // Nothing in the intact GLBs reaches the Sleeve's 2.2179 m top in the authored rest pose,
    // and the barrel capsule's own cap tops out at 1.8427 + 0.4363 = 2.2790. (A barrel pitched
    // up the mount's 15..140 deg theta band reaches higher -- see TURRET_HIT_SHAPE_DATA's
    // residual note -- but the sim carries no mount state, so the rest pose is the shape.)
    // The replaced sphere (centre y +1.3, radius 2) reached y 3.30 and stopped this ray at
    // z -1.053 instead.
    expect(
      rayTurretHitShapeDistance({ x: 0, y: 3, z: -8 }, { x: 0, y: 0, z: 1 }, largeShape()),
    ).toBeNull();
  });

  it('a shot beside the barrel at barrel height misses, where the replaced sphere hit', () => {
    // x 1.5 at y 1.83: the head column's 1.314 m measured radius ends before it, and the
    // pedestal only reaches y 1.327. The replaced sphere's reach at y 1.83 was
    // sqrt(2^2 - 0.53^2) = 1.928 m, so it blocked this shot 0.5 m clear of any geometry.
    expect(
      rayTurretHitShapeDistance({ x: 1.5, y: 1.83, z: -8 }, { x: 0, y: 0, z: 1 }, largeShape()),
    ).toBeNull();
  });

  it('a shot into the barrel registers a hit on the barrel capsule', () => {
    // Down the barrel's own axis from +z: the muzzle marker sits at z 1.3571, so the capsule's
    // front cap starts at 1.3571 + 0.4363 = 1.7934. The replaced sphere's entry was 1.9234,
    // 0.13 m in front of the barrel.
    expect(
      rayTurretHitShapeDistance({ x: 0, y: 1.8427, z: 8 }, { x: 0, y: 0, z: -1 }, largeShape()),
    ).toBeCloseTo(8 - 1.7934, 6);
  });

  it('splash measures to the shape, not to the ground anchor', () => {
    const shape = largeShape();
    // A blast 0.5 m past the muzzle cap at barrel height is 0.5 m from the turret, not the
    // 2.57 m the anchor-based falloff used to read.
    expect(distanceToTurretHitShape(shape, { x: 0, y: 1.8427, z: 2.2934 })).toBeCloseTo(0.5, 6);
    expect(distanceToTurretHitShape(shape, { x: 0, y: 0.5, z: 0 })).toBe(0);
    // Outside the pedestal's own radius, at its widest: 3 m from the axis is 3 - 2.355.
    expect(distanceToTurretHitShape(shape, { x: 3, y: 0.5, z: 0 })).toBeCloseTo(3 - 2.355, 6);
  });

  it('repair targeting reads the same shape through its circumscribed sphere', () => {
    // The bound is the pedestal cylinder's own circumsphere: centre (0 + 1.327 - 0.001)/2 =
    // 0.663, radius sqrt(2.355^2 + 0.664^2) = 2.4468. The shape's furthest point -- the
    // muzzle cap at (0, 1.8427, 1.3571 + 0.4363) -- is 2.2349 from that centre, so the sphere
    // covers every volume, the same way repair.ts's ray-sphere search needs it to.
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.PlasmaBarrelLarge, team: 2, position: { x: 0, y: 5, z: 0 } },
    ]);
    const hitbox = turretHitbox(world, 0);
    expect(hitbox.center).toEqual({ x: 0, y: 5.663, z: 0 });
    expect(hitbox.radius).toBeCloseTo(2.4468, 4);
    expect(hitbox.headY).toBe(Infinity);
  });

  it('the sentry is one measured cylinder, and a shot over it misses', () => {
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    const shape = turretHitShape(world, 0);
    // `turret_sentry.glb` draws the whole sentry: Base's corner (0.4550, -0.4329) is 0.6280 m
    // from the placement axis, the intact assembly spans y -0.2597..0.3898, and its widest
    // head part (Body, r 0.4975) turns about a post axis 0.0386 m off the placement axis, so
    // the one cylinder covers every yaw and no head/barrel volume is needed.
    expect(shape.data.head).toBeNull();
    expect(shape.data.barrel).toBeNull();
    expect(
      rayTurretHitShapeDistance({ x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: 1 }, shape),
    ).toBeCloseTo(8 - 0.629, 6);
    // y 0.5 is above the 0.3898 top; the replaced sphere (centre y -0.07, radius 0.65)
    // reached y 0.58 and stopped this ray at z -0.312.
    expect(
      rayTurretHitShapeDistance({ x: 0, y: 0.5, z: -8 }, { x: 0, y: 0, z: 1 }, shape),
    ).toBeNull();
  });
});
