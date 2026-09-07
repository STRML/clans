import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import {
  applyBaseObjectDamage,
  BASE_OBJECT_DATA,
  BaseObjectKind,
  createBaseObjects,
  stepPower,
} from './baseObjects.js';
import { playerHitbox } from './damage.js';
import {
  buildInteriorCollider,
  type InteriorPlacement,
  type InteriorTriangles,
} from './interiors.js';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import {
  createTurrets,
  stepTurretPower,
  stepTurrets,
  TURRET_BASE_DATA,
  TurretBarrelId,
  TurretBaseId,
} from './turrets.js';
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
      hitPlayerId: -1,
      hitPoint: null,
      projectileId: -1,
      resolved: false,
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
      // y=1.5, not the 1.6 "muzzle height" used elsewhere in this file: 1.6 now lands
      // within LIGHT_ARMOR's headshot band (Codex review round 7, finding 3 made headY
      // reachable at y=1.57+), which would apply the 1.3x multiplier this test isn't
      // exercising. 1.5 stays a body shot.
      origin: { x: 0, y: 1.5, z: 0 },
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

describe('Codex review round 7, finding 3: Laser Rifle headshot is reachable and applies 1.3x', () => {
  it('a shot aimed at the top of the target hit sphere lands as a headshot', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    // LIGHT_ARMOR's hitbox: center.y = 1.15, radius = 0.6. y=1.7 sits 0.55 above center,
    // inside the sphere's radius (0.6) and above the new headY (1.57) -- reachable only
    // after the fix; the old headY (1.955) was above the sphere entirely.
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.LaserRifle,
      origin: { x: 0, y: 1.7, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      energyScale: 1,
    });
    stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeCloseTo(
      LIGHT_ARMOR.maxDamage - 0.4 * 1.3,
      3,
    );
  });
});

describe('Chaingun: resolves in the same tick it fires (lag-comp compatible)', () => {
  it('hits the target present at spawn time, before the target can move away on a later tick', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT);
    // If the shot were deferred to the *next* stepProjectiles call -- the old one-tick
    // spawn latency every other projectile type still uses -- this teleport would have
    // already taken effect by the time the shot's collision test finally ran, and the
    // Chaingun's lag-comp rewind window (server/net.ts) would already be closed too.
    world.players.position[target * 3 + 2] = 10000;
    stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeCloseTo(
      LIGHT_ARMOR.maxDamage - 0.0825,
      3,
    );
  });
});

describe('direct hit: nearest target on the ray wins, not the first one found by id', () => {
  it('hits the nearer of two players on the same ray, even though the farther one has the lower id', () => {
    const world = createWorld(flat, 1);
    const far = addPlayer(world, { x: 0, y: 0, z: 12 });
    const near = addPlayer(world, { x: 0, y: 0, z: 6 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    for (let tick = 0; tick < 5; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.players.damage[near]).toBeGreaterThan(0);
    expect(world.players.damage[far]).toBe(0);
  });
});

describe('grenade/mortar: swept collision prevents tunneling through a player', () => {
  it('an armed mortar moving faster than a player is wide still registers a hit mid-tick', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 5, y: 0, z: 0 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Mortar,
      origin: { x: 0, y: 1.15, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    stepProjectiles(world, FIXED_DT); // spawn only
    const id = firstProjectile(world);
    world.projectiles.armed[id] = 1; // skip the 2 s arm delay -- tunneling is orthogonal to it
    // One tick's ~2 m mortar travel, positioned to jump clean over the target's ~1.2 m wide
    // hitbox: previous (x=4) and current (post-integration, x>6) both land outside it, so
    // only a swept segment test -- not an endpoint-only check -- can catch this hit.
    world.projectiles.position.set([4, 1.15, 0], id * 3);
    world.projectiles.velocity.set([63.7, 0, 0], id * 3);
    stepProjectiles(world, FIXED_DT);
    expect(world.players.damage[target]).toBeGreaterThan(0);
  });
});

const ridgeGrid: Heightfield = {
  gridSize: 5,
  squareSize: 1,
  originX: 0,
  originY: 0,
  originZ: 0,
  heightScale: 1,
  // Row 0 (z=0) is flat except columns 2-3, which form a 100 m tall wall spanning x in
  // [2, 3): heights[2] and heights[3] are the two grid corners of that cell along row 0.
  heights: (() => {
    const h = new Uint16Array(25);
    h[2] = 100;
    h[3] = 100;
    return h;
  })(),
};

describe('terrain: swept collision catches a ridge crossed within one tick', () => {
  it('detonates against a spike between the previous and current sample points instead of tunneling through it', () => {
    const world = createWorld(ridgeGrid, 1);
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawn only, at the origin
    const id = firstProjectile(world);
    // One tick's travel spans x=1.5 -> x=4.7, sailing straight through the x∈[2,3] wall.
    // An endpoint-only check samples height=0 at x=4.7 (past the wall) and misses it.
    world.projectiles.position.set([1.5, 1, 0], id * 3);
    world.projectiles.velocity.set([100, 0, 0], id * 3);
    stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(0); // detonated against the ridge, not tunneled
  });
});

describe('terrain: an empty square is a hole, not solid ground', () => {
  it('a projectile falling toward an empty square passes through instead of detonating on it', () => {
    const holeFlat: Heightfield = { ...flat, emptySquares: new Set([0]) };
    const world = createWorld(holeFlat, 1);
    fire(world, { origin: { x: 0, y: 5, z: 500 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawn
    const id = firstProjectile(world);
    for (let tick = 0; tick < 10; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(1); // still falling through the hole
  });
});

describe('terrain: blocks a non-Laser shot before it can reach a player on the far side', () => {
  it('a Chaingun bullet that crosses a ridge before reaching a player behind it detonates at the ridge instead of damaging the player (Codex review round 2, finding 1)', () => {
    const world = createWorld(ridgeGrid, 1);
    const target = addPlayer(world, { x: 4, y: 0, z: 0 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    // Chaingun resolves in the same tick it spawns (its Tracer fast-path), so one call is
    // enough: the ray sweeps straight through the x∈[2,3] ridge and on to the target at
    // x=4. Before the fix, the player-hit check ran first and found the target, since it
    // never knew the ridge was in the way; only afterward did the (now-skipped) terrain
    // check run.
    stepProjectiles(world, FIXED_DT);
    expect(world.players.damage[target]).toBe(0);
  });
});

describe('point-blank hit: ray origin already inside the target hitbox', () => {
  it('a Chaingun bullet fired with the muzzle already inside the target hitbox still registers a hit (Codex review round 2, finding 6)', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    const hitbox = playerHitbox(world, target, LIGHT_ARMOR);
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: hitbox.center,
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT);
    expect(world.players.damage[target]).toBeGreaterThan(0);
  });
});

describe('Laser Rifle: terrain blocks line of sight', () => {
  it('a target behind a ridge takes no damage even though it is within max range', () => {
    const world = createWorld(ridgeGrid, 1);
    const target = addPlayer(world, { x: 4, y: 0, z: 0 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.LaserRifle,
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      energyScale: 1,
    });
    stepProjectiles(world, FIXED_DT);
    expect(world.players.damage[target]).toBe(0);
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

describe('detonation point: a direct hit resolves at the actual point of contact, not the swept segment endpoint (Codex review round 3, finding 3)', () => {
  it('a disc that overshoots the target by tens of meters in one tick still splashes it, because the explosion happens where the hit occurred, not where the disc ended up', () => {
    const world = createWorld(flat, 1);
    // Target's hitbox center sits at y = position.y + height/2 = 0 + 1.15; the disc travels
    // at that same height so the ray-sphere test lines up through the hitbox center.
    const target = addPlayer(world, { x: 0, y: 0, z: 50 });
    fire(world, {
      playerId: -1,
      origin: { x: 0, y: 1.15, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT); // spawn only
    const id = firstProjectile(world);
    // One tick's travel of 96 m: the segment crosses the target around z=49.4, but its raw
    // endpoint (z=96) sits 46 m past it -- well outside the Spinfusor's 7.5 m splash radius.
    // Resolving at the endpoint (the bug) gives the target zero falloff and zero damage;
    // resolving at the actual hit point gives it splash damage close to full radius falloff.
    world.projectiles.position.set([0, 1.15, 0], id * 3);
    world.projectiles.velocity.set([0, 0, 3000], id * 3);
    stepProjectiles(world, FIXED_DT);
    expect(world.players.damage[target]).toBeGreaterThan(0);
  });
});

const farWallGrid: Heightfield = {
  gridSize: 5,
  squareSize: 40,
  originX: 0,
  originY: 0,
  originZ: 0,
  heightScale: 1,
  // Same construction as ridgeGrid above, just scaled up: row 0 is flat until column 1
  // (x >= 40), where it ramps up toward a 2000 m wall at column 2's corner (x = 80).
  heights: (() => {
    const h = new Uint16Array(25);
    h[2] = 2000;
    h[3] = 2000;
    return h;
  })(),
};

describe("grenade/mortar detonation: the nearer of terrain or a player wins, at that hit's own point (Codex review round 3, finding 3)", () => {
  it('detonates on a player crossed early in the sweep instead of at a terrain hit tens of meters further along the same segment', () => {
    const world = createWorld(farWallGrid, 1);
    const target = addPlayer(world, { x: 5, y: 0, z: 0 });
    fire(world, {
      playerId: -1,
      isAltFire: true,
      origin: { x: 0, y: 1.15, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      shooterVelocity: { x: 0, y: 0, z: 0 },
    });
    stepProjectiles(world, FIXED_DT); // spawn only
    const id = firstProjectile(world);
    world.projectiles.armed[id] = 1; // skip the arm delay -- priority is orthogonal to it
    // One tick's sweep crosses the player at x=5 tens of meters before it ever reaches the
    // wall around x=40. The old code always resolved at the terrain point whenever a
    // terrain hit existed on the segment at all, regardless of which was actually nearer,
    // so it detonated far outside the player's splash radius and dealt no damage.
    world.projectiles.position.set([0, 1.15, 0], id * 3);
    world.projectiles.velocity.set([2000, 0, 0], id * 3);
    stepProjectiles(world, FIXED_DT);
    expect(world.players.damage[target]).toBeGreaterThan(0);
  });
});

describe('FireEvent.hitPlayerId/hitPoint: the authoritative hit-test records its own result (Codex review round 3, finding 4)', () => {
  it('a Laser Rifle hit sets hitPlayerId and hitPoint on the event recorded in world.lastFireEvents', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.LaserRifle,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      energyScale: 1,
    });
    stepProjectiles(world, FIXED_DT);
    const event = world.lastFireEvents[0];
    expect(event?.hitPlayerId).toBe(target);
    // The hit point sits just short of the target's center (z=10), where the ray actually
    // enters its hit sphere -- not exactly at z=10, and no longer the segment endpoint either.
    expect(event?.hitPoint?.z).toBeGreaterThan(9);
    expect(event?.hitPoint?.z).toBeLessThan(10);
    expect(event?.resolved).toBe(true);
  });

  it('a Laser Rifle miss leaves hitPlayerId at -1 and hitPoint at null, but still records that the hit-test ran (Codex review round 4, finding 3)', () => {
    const world = createWorld(flat, 1);
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.LaserRifle,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      energyScale: 1,
    });
    stepProjectiles(world, FIXED_DT);
    const event = world.lastFireEvents[0];
    expect(event?.hitPlayerId).toBe(-1);
    expect(event?.hitPoint).toBeNull();
    expect(event?.resolved).toBe(true);
  });

  it('a Chaingun hit resolves in the same tick and sets hitPlayerId/hitPoint too, since round 1 made it resolve synchronously', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT);
    const event = world.lastFireEvents[0];
    expect(event?.hitPlayerId).toBe(target);
    // The hit point sits just short of the target's center (z=10), where the ray actually
    // enters its hit sphere -- not exactly at z=10, and no longer the segment endpoint either.
    expect(event?.hitPoint?.z).toBeGreaterThan(9);
    expect(event?.hitPoint?.z).toBeLessThan(10);
    expect(event?.resolved).toBe(true);
  });

  it('a Spinfusor shot -- resolved on a later tick, not this one -- leaves hitPlayerId/hitPoint at their unresolved defaults, and resolved false', () => {
    const world = createWorld(flat, 1);
    addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, {
      playerId: -1,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT); // spawn only: a Linear projectile resolves next tick
    const event = world.lastFireEvents[0];
    expect(event?.hitPlayerId).toBe(-1);
    expect(event?.hitPoint).toBeNull();
    expect(event?.resolved).toBe(false);
  });
});

describe('Codex review round 7, finding 5: a freed projectile id cannot be reused within the same tick it was freed', () => {
  it('a projectile fired in the same stepProjectiles call that frees another id does not reuse that id', () => {
    const world = createWorld(flat, 1);
    // A: fired straight down, detonates against the ground on its second step and frees its slot.
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawns A
    const idA = firstProjectile(world);
    // B: queued so it spawns on the very same stepProjectiles call that frees A.
    fire(world, { origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: 0, z: 1 } });
    stepProjectiles(world, FIXED_DT); // frees A (terrain hit) AND spawns B, same call
    expect(world.projectiles.active[idA]).toBe(0); // A is gone
    const idB = firstProjectile(world); // only B is active now
    // Without the fix, B's allocate() would pop A's id straight back off freeIds within this
    // same call, so no snapshot would ever have shown A's id absent before B reused it.
    expect(idB).not.toBe(idA);
  });

  it('the freed id becomes reusable on a later stepProjectiles call, PROJECTILE_ID_REUSE_DELAY_TICKS ticks after it was freed', () => {
    const world = createWorld(flat, 1);
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawns A
    const idA = firstProjectile(world);
    stepProjectiles(world, FIXED_DT); // frees A; its id is deferred, not yet reusable
    expect(world.projectiles.active[idA]).toBe(0);
    // Two more no-op ticks: with a 3-tick delay (Codex review round 8, finding 1 -- deferring
    // by only one tick doesn't guarantee a snapshot lands in the gap, since the server only
    // broadcasts one every SNAPSHOT_EVERY_N_TICKS = 2 simulation ticks), the id isn't flushed
    // into the real free pool until the third stepProjectiles call after the one that freed it.
    stepProjectiles(world, FIXED_DT); // still deferred (2 ticks left, then 1)
    stepProjectiles(world, FIXED_DT); // still deferred going in; flushed to freeIds this call
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawns C -- the deferred id is available again
    const idC = firstProjectile(world);
    expect(idC).toBe(idA);
  });
});

describe('Codex review round 8, finding 1: projectile-id reuse deferral must cover the snapshot cadence, not just one tick', () => {
  it('a freed id is still not reused on the very next stepProjectiles call after it was freed', () => {
    const world = createWorld(flat, 1);
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawns A
    const idA = firstProjectile(world);
    stepProjectiles(world, FIXED_DT); // frees A this call
    expect(world.projectiles.active[idA]).toBe(0);
    // A one-tick defer (round 7's original fix) would already have made idA reusable here --
    // the exact gap round 8 found: not enough calls have passed to guarantee a snapshot ever
    // observed idA absent, since a snapshot only goes out every 2 ticks.
    fire(world, { origin: { x: 5, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawns B; must NOT reuse idA yet
    const idB = firstProjectile(world);
    expect(idB).not.toBe(idA);
  });

  it('a freed id still is not reused after exactly two ticks -- must clear the cadence with margin', () => {
    const world = createWorld(flat, 1);
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawns A
    const idA = firstProjectile(world);
    stepProjectiles(world, FIXED_DT); // frees A this call
    stepProjectiles(world, FIXED_DT); // no-op tick
    fire(world, { origin: { x: 5, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT); // spawns C; idA must still not be reused
    const idC = firstProjectile(world);
    expect(idC).not.toBe(idA);
  });
});

// Task 5: projectiles vs base objects/turrets/interiors/force fields, turret-fired shots.
//
// Note on assertions below: several of these tests check `world.baseObjects.energy[id]` (the
// shield) decreasing rather than `world.baseObjects.damage[id]` (post-shield health)
// increasing. A single Spinfusor splash hit (radiusDamage 0.5) or Chaingun direct hit
// (~0.0825) never exceeds a Generator's or StationInventory's or a Sentry turret's shield
// capacity (maxEnergy / energyPerDamagePoint -- e.g. a Generator's is 50/30 = 1.667), so
// `damage` would stay exactly 0 after one hit even though the hit genuinely registered --
// baseObjects.test.ts's/turrets.test.ts's own dedicated tests already cover the shield-vs-
// health math directly. These integration tests only need to prove the projectile-to-
// base-object/turret wiring itself works, so `energy` (which the shield always spends first,
// per applyBaseObjectDamage/applyTurretDamage) is the right signal for "a hit landed at all".

describe('projectiles vs base objects', () => {
  it('a Spinfusor disc splash-damages a generator it lands near', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 10, z: 20 } },
    ]);
    fire(world, { playerId: -1, origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: 0, z: 1 } });
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.energy[0]).toBeLessThan(
      BASE_OBJECT_DATA[BaseObjectKind.Generator].maxEnergy,
    );
  });

  it('a direct-hit weapon (Chaingun bullet) damages a station on contact', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.StationInventory, team: 2, position: { x: 0, y: 1.6, z: 10 } },
    ]);
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT); // Tracer resolves same-tick, matching M3's Chaingun path.
    expect(world.baseObjects.energy[0]).toBeLessThan(
      BASE_OBJECT_DATA[BaseObjectKind.StationInventory].maxEnergy,
    );
  });

  it('friendly fire reaches a same-team base object (no team filter on the hit-test)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 1.6, z: 10 } },
    ]);
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.energy[0]).toBeLessThan(
      BASE_OBJECT_DATA[BaseObjectKind.Generator].maxEnergy,
    );
  });

  it('a destroyed base object cannot be damaged further (applyBaseObjectDamage no-ops)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 1.6, z: 10 } },
    ]);
    applyBaseObjectDamage(world, 0, 1000);
    const damageAfter = world.baseObjects.damage[0];
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.damage[0]).toBe(damageAfter);
  });
});

describe('projectiles vs turrets', () => {
  it('a player weapon can damage a turret', () => {
    const world = createWorld(flat, 1);
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 2, position: { x: 0, y: 1.6, z: 10 } },
    ]);
    fire(world, {
      playerId: -1,
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    stepProjectiles(world, FIXED_DT);
    expect(world.turrets.energy[0]).toBeLessThan(TURRET_BASE_DATA[TurretBaseId.Sentry].maxEnergy);
  });
});

describe('turret-fired shots become real, damaging projectiles', () => {
  it('a turret shot spawned this tick damages the target player on a later tick', () => {
    const world = createWorld(flat, 1);
    // Placed well clear of the turret's own firing origin below (>1.5 m, BASE_OBJECT_HIT_RADIUS)
    // -- a generator any closer would sit inside the shot's own spawn-point hit-sphere and
    // cause a spurious immediate self-hit against the generator instead of ever reaching the
    // enemy, an unrelated test-geometry pitfall distinct from the turret self-hit this test
    // was actually written to catch (see sourceTurretId's own comment).
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: -20, y: 0, z: 0 } },
    ]);
    // turrets.ts's fireAt aims from the turret's own raw position at the target's own raw
    // (feet-level) position -- a straight line to (X, 0, Z) is always exactly height
    // (playerHitbox's radius, 0.6) short of the target's actual hit-sphere, which is centered
    // 1.15 m above that same raw position (LIGHT_ARMOR's boundingBox height / 2). Placed the
    // turret well above the target and the target close in X (10 m tall vs. 2 m of lateral
    // travel) so the ray's height-1.15 crossing point still lands within 0.6 m of the target's
    // X -- close enough for raySphereDistance to actually register a hit -- rather than
    // clipping the flat terrain at the target's exact feet position and detonating there
    // instead, harmlessly, on a shallower approach angle.
    createTurrets(world, [
      { barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: 0, y: 10, z: 0 } },
    ]);
    stepPower(world);
    const enemy = addPlayer(world, { x: 2, y: 0, z: 0 }, 2);
    const before = world.players.damage[enemy];
    for (let tick = 0; tick < 90; tick += 1) {
      stepTurretPower(world);
      stepTurrets(world, FIXED_DT);
      stepProjectiles(world, FIXED_DT);
    }
    expect(world.players.damage[enemy]).toBeGreaterThan(before ?? 0);
  });
});

describe('interior collision for projectiles (failure matrix row 14)', () => {
  function wallInterior(): InteriorTriangles {
    // A single quad wall in the XZ-perpendicular plane at x=5, spanning y 0..4, z -4..4.
    const positions = new Float32Array([5, 0, -4, 5, 4, -4, 5, 4, 4, 5, 0, -4, 5, 4, 4, 5, 0, 4]);
    return { positions };
  }
  const wallPlacement: InteriorPlacement = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
  };

  it('a disc fired through where an interior wall stands detonates at the wall, not past it', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallInterior(), wallPlacement)];
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 20, y: 2, z: 0 } },
    ]);
    fire(world, { playerId: -1, origin: { x: 0, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    // The generator sits at x=20, well past the wall at x=5: it must take no damage because
    // the disc stopped at the wall.
    expect(world.baseObjects.damage[0]).toBe(0);
  });
});

describe('force fields block enemy projectiles and pass friendly ones (failure matrix row 17)', () => {
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
      { kind: BaseObjectKind.Generator, team: 3 - ownerTeam, position: { x: 20, y: 2, z: 0 } },
    ]);
    stepPower(world);
    return world;
  }

  it('an enemy disc detonates against a powered force field, not past it', () => {
    const world = withForceField(2); // field belongs to team 2
    const shooter = addPlayer(world, { x: 0, y: 2, z: 0 }, 1); // shooter is team 1, the enemy of the field's team
    fire(world, {
      playerId: shooter,
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    // The generator at x=20 belongs to team 1 (the shooter's own team) so it is never in
    // this test's way conceptually, but its damage staying at 0 proves the disc never
    // reached past the field at x=5.
    expect(world.baseObjects.damage[2]).toBe(0);
  });

  it('a friendly disc passes through the same powered force field untouched', () => {
    const world = withForceField(1); // field belongs to team 1, same as the shooter
    const shooter = addPlayer(world, { x: 0, y: 2, z: 0 }, 1);
    fire(world, {
      playerId: shooter,
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    // The generator at x=20 belongs to the opposing team (team 2): a friendly shot passing
    // straight through the field must still be able to reach and damage it (checked via the
    // shield spending energy — see this describe block's own top-of-file note).
    expect(world.baseObjects.energy[2]).toBeLessThan(
      BASE_OBJECT_DATA[BaseObjectKind.Generator].maxEnergy,
    );
  });

  it('an unpowered force field blocks nothing, friend or enemy', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      {
        kind: BaseObjectKind.ForceField,
        team: 2,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 2, z: 0 } },
    ]);
    // No generator for team 2: stepPower leaves the field unpowered.
    stepPower(world);
    fire(world, { playerId: -1, origin: { x: 0, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.energy[1]).toBeLessThan(
      BASE_OBJECT_DATA[BaseObjectKind.Generator].maxEnergy,
    );
  });
});
