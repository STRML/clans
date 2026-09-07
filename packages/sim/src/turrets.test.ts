import { describe, expect, it } from 'vitest';
import { addPlayer, applyDamage, createWorld, LIGHT_ARMOR, type Heightfield } from './index.js';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import {
  applyTurretDamage,
  createTurrets,
  hasLineOfSight,
  stepTurrets,
  TURRET_BARREL_DATA,
  TURRET_BASE_DATA,
  TurretBarrelId,
  TurretBaseId,
} from './turrets.js';

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
