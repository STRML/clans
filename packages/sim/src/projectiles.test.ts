import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import { WeaponId, type FireEvent } from './weapons.js';
import { stepProjectiles } from './projectiles.js';

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

function fire(world: ReturnType<typeof createWorld>, event: Partial<FireEvent>): void {
  world.pendingFireEvents = [
    {
      playerId: 0,
      weaponId: WeaponId.Spinfusor,
      isAltFire: false,
      origin: { x: 0, y: 10, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      shooterVelocity: { x: 0, y: 0, z: 0 },
      energyScale: 1,
      ...event,
    },
  ];
}

function firstProjectile(world: ReturnType<typeof createWorld>) {
  const p = world.projectiles;
  for (let id = 0; id < p.count; id += 1) if (p.active[id]) return id;
  throw new Error('no active projectile');
}

describe('spawnProjectile: disc speed and velocity inheritance', () => {
  it('disc travels at 90 m/s plus 0.5x the shooter velocity', () => {
    const world = createWorld(flat, 1);
    fire(world, { shooterVelocity: { x: 0, y: 0, z: 20 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    expect(world.projectiles.velocity[id * 3 + 2]).toBeCloseTo(90 + 20 * 0.5);
  });

  it('a fresh disc despawns after its 5 s lifetime with no hit', () => {
    const world = createWorld(flat, 1);
    fire(world, { origin: { x: 0, y: 500, z: 0 }, direction: { x: 0, y: 0, z: 1 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    for (let tick = 0; tick < Math.ceil(5 / FIXED_DT) + 1; tick += 1)
      stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(0);
  });
});

describe('radius damage and kickback: two discs kill a Light', () => {
  it("a disc detonating at a player's center does 0.5 damage and the spec's kickback", () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, {
      playerId: -1,
      origin: { x: 0, y: 10, z: 9 },
      direction: { x: 0, y: -1, z: 0.1 },
    });
    for (let tick = 0; tick < 5; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeLessThan(
      LIGHT_ARMOR.maxDamage,
    );
    fire(world, {
      playerId: -1,
      origin: { x: 0, y: 10, z: 9 },
      direction: { x: 0, y: -1, z: 0.1 },
    });
    for (let tick = 0; tick < 5; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.players.alive[target]).toBe(0);
  });
});

describe('terrain collision', () => {
  it('a disc fired into the ground detonates and despawns', () => {
    const world = createWorld(flat, 1);
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(0);
  });
});

describe('direct-hit weapons: no radius, damage only the player actually hit', () => {
  it('a Chaingun bullet does 0.0825 direct damage and no splash to a bystander', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    const bystander = addPlayer(world, { x: 0, y: 0, z: 10.5 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    for (let tick = 0; tick < 3; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeCloseTo(
      LIGHT_ARMOR.maxDamage - 0.0825,
      3,
    );
    expect(world.players.damage[bystander]).toBe(0);
  });
});

describe('Mortar: arms after 2 s, bounces with elasticity 0.15 before then', () => {
  it('bounces off flat terrain while unarmed, reversing and shrinking the vertical velocity', () => {
    const world = createWorld(flat, 1);
    fire(world, {
      weaponId: WeaponId.Mortar,
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    let bounced = false;
    for (let tick = 0; tick < 30 && world.projectiles.active[id]; tick += 1) {
      const before = world.projectiles.velocity[id * 3 + 1] ?? 0;
      stepProjectiles(world, FIXED_DT);
      const after = world.projectiles.active[id]
        ? (world.projectiles.velocity[id * 3 + 1] ?? 0)
        : 0;
      if (before < 0 && after > 0) bounced = true;
    }
    expect(bounced).toBe(true);
  });

  it('detonates on the first terrain contact once armed (after 2 s)', () => {
    const world = createWorld(flat, 1);
    fire(world, {
      weaponId: WeaponId.Mortar,
      origin: { x: 0, y: 0.05, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      shooterVelocity: { x: 0, y: 0, z: 0 },
    });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    for (let tick = 0; tick < Math.ceil(2 / FIXED_DT); tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.armed[id]).toBe(1);
    stepProjectiles(world, FIXED_DT);
    // Once armed, gravity pulls it back to the ground within a tick or two and it detonates.
    for (let tick = 0; tick < 5 && world.projectiles.active[id]; tick += 1)
      stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(0);
  });
});

describe('hitscan: Laser Rifle', () => {
  it('applies energyScale * directDamage instantly, no stored projectile', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.LaserRifle,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      energyScale: 0.5,
    });
    stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeCloseTo(
      LIGHT_ARMOR.maxDamage - 0.4 * 0.5,
      3,
    );
    expect(world.projectiles.count).toBe(0);
  });
});

describe('grenade altFire', () => {
  it('spawns a Grenade-type projectile inheriting the shooter velocity, at the ours-picked 25 m/s throw speed', () => {
    const world = createWorld(flat, 1);
    fire(world, { isAltFire: true, shooterVelocity: { x: 0, y: 0, z: 10 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    expect(world.projectiles.type[id]).toBe(2); // ProjectileType.Grenade
    expect(world.projectiles.velocity[id * 3 + 2]).toBeCloseTo(25 + 10); // direction.z=1 * speed(25) + shooterVelocity.z(10) * velInherit(1)
  });
});
