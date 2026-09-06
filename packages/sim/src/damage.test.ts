import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import {
  addPlayer,
  createWorld,
  setGodMode,
  stepWorld,
  type Heightfield,
  type PlayerInput,
} from './index.js';
import {
  applyDamage,
  applyFallDamage,
  applyKickback,
  dueForRespawn,
  playerHitbox,
  radiusFalloff,
  raySphereDistance,
  respawnPlayer,
  RESPAWN_TICKS,
} from './damage.js';
import { createFlags, FlagState, stepFlags } from './flags.js';

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
};

describe('radiusFalloff', () => {
  it('is full at the center and zero at the radius', () => {
    expect(radiusFalloff(0, 10)).toBe(1);
    expect(radiusFalloff(10, 10)).toBe(0);
    expect(radiusFalloff(5, 10)).toBeCloseTo(0.5);
    expect(radiusFalloff(20, 10)).toBe(0);
  });
});

describe('applyDamage and death', () => {
  it('kills at maxDamage and starts a 5 s respawn timer', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage - 0.01, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(1);
    applyDamage(world, id, 0.02, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
    expect(world.players.respawnAt[id]).toBe(RESPAWN_TICKS);
    expect(world.pendingDeaths).toEqual([{ id, attackerId: -1 }]);
    expect(dueForRespawn(world)).toEqual([]);
    world.tick = RESPAWN_TICKS;
    expect(dueForRespawn(world)).toEqual([id]);
  });

  it('two disc splashes at center kill a Light (0.5 + 0.5 > 0.66 maxDamage)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
  });

  it('scores +10 for a kill, -10 for a team kill, -10 for a suicide, nothing for env damage', () => {
    const world = createWorld(flat, 1);
    const victim = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: 5, y: 0, z: 5 }, 2);
    const ally = addPlayer(world, { x: 10, y: 0, z: 10 }, 1);
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.score[enemy]).toBe(0);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, enemy, LIGHT_ARMOR);
    expect(world.players.score[enemy]).toBe(10);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, ally, LIGHT_ARMOR);
    expect(world.players.score[ally]).toBe(-10);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, victim, LIGHT_ARMOR);
    expect(world.players.score[victim]).toBe(-10);
  });

  it('ignores damage against an already-dead or inactive player', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    const damageBefore = world.players.damage[id];
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(damageBefore);
  });
});

describe('Codex review round 8, finding 2: overkill damage must not push players.damage past maxDamage', () => {
  it('a single hit far larger than maxDamage clamps damage at maxDamage, not the raw accumulated total', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    // Two overlapping splash hits (or a point-blank multi-weapon combo) landing the same tick
    // is plausible in play; three times maxDamage in one shot makes the bug unmissable.
    applyDamage(world, id, LIGHT_ARMOR.maxDamage * 3, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
    // Health is computed elsewhere as armor.maxDamage - damage; had damage been left
    // unclamped, health would have gone negative on the wire and in the HUD (e.g. "-52%")
    // instead of clamping at 0%.
    expect(world.players.damage[id]).toBe(LIGHT_ARMOR.maxDamage);
  });

  it('a lethal hit followed by more damage keeps damage clamped at maxDamage across calls', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage + 5, -1, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(LIGHT_ARMOR.maxDamage);
    // The player is dead now, so this second hit is a no-op (already covered by the
    // already-dead test above) -- included here only to confirm the clamp doesn't somehow
    // let a second overkill hit push damage even further past maxDamage.
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(LIGHT_ARMOR.maxDamage);
  });
});

describe('godMode (Codex review round 3, finding 1)', () => {
  it('applyDamage no-ops while godMode is set, the same way it already no-ops for an inactive or dead player', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    setGodMode(world, id, true);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(0);
    expect(world.players.alive[id]).toBe(1);
    expect(world.pendingDeaths).toEqual([]);
  });

  it('turning godMode back off lets damage apply again', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    setGodMode(world, id, true);
    setGodMode(world, id, false);
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
  });

  it('a flag carrier in god mode keeps the flag and the attacker keeps no score for lethal damage -- the reactive post-hoc zeroing this replaces ran too late to stop the flag drop and score event stepWorld already produced in the same call', () => {
    const world = createWorld(flat, 1);
    const carrier = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const attacker = addPlayer(world, { x: 5, y: 0, z: 5 }, 2);
    createFlags(world, [{ team: 2, position: { x: 0, y: 0, z: 0 } }]);
    world.flags.state[0] = FlagState.Carried;
    world.flags.carrierId[0] = carrier;
    setGodMode(world, carrier, true);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, attacker, LIGHT_ARMOR);
    stepFlags(world, 32 / 1000); // this is what drops a carried flag on a pending death
    expect(world.flags.state[0]).toBe(FlagState.Carried);
    expect(world.flags.carrierId[0]).toBe(carrier);
    expect(world.players.score[attacker]).toBe(0);
  });
});

describe('applyFallDamage', () => {
  it('does nothing at or below minJumpSpeed', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyFallDamage(world, id, LIGHT_ARMOR.minJumpSpeed, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(0);
  });
  it('scales the excess over minJumpSpeed by speedDamageScale', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyFallDamage(world, id, LIGHT_ARMOR.minJumpSpeed + 10, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBeCloseTo(10 * LIGHT_ARMOR.speedDamageScale);
  });
  it('a hard landing from stepWorld applies fall damage exactly once per landing', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 60, z: 0 });
    // Air resistance (upResistFactor past upResistSpeed) means a 60 m drop takes ~81 ticks
    // to land, not the naive sqrt(2*60/GRAVITY)/dt ~= 60 ticks a no-drag fall would need.
    for (let tick = 0; tick < 90; tick += 1) stepWorld(world, new Map([[id, idle]]));
    expect(world.players.damage[id]).toBeGreaterThan(0);
    const afterLanding = world.players.damage[id];
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, new Map([[id, idle]]));
    expect(world.players.damage[id]).toBe(afterLanding);
  });
});

describe('respawnPlayer and dueForRespawn', () => {
  it('resets damage, aliveness, and position', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    respawnPlayer(world, id, { x: 42, y: 0, z: 7 });
    expect(world.players.alive[id]).toBe(1);
    expect(world.players.damage[id]).toBe(0);
    expect(world.players.position[id * 3]).toBe(42);
    expect(world.players.respawnAt[id]).toBe(-1);
  });

  it('restores energy and clears ground/jump-edge state left over from before death (Codex review round 2, finding 4)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    // Simulate dying mid-jet with a jump held while airborne, on the way down from an earlier
    // jump: everything respawnPlayer used to leave untouched.
    world.players.energy[id] = 0;
    world.players.onGround[id] = 1;
    world.players.wasGrounded[id] = 1;
    world.players.wasJumpHeld[id] = 1;
    respawnPlayer(world, id, { x: 0, y: 0, z: 0 });
    expect(world.players.energy[id]).toBe(LIGHT_ARMOR.maxEnergy);
    expect(world.players.onGround[id]).toBe(0);
    expect(world.players.wasGrounded[id]).toBe(0);
    expect(world.players.wasJumpHeld[id]).toBe(0);
  });

  it('updates players.spawn to the new respawn point, so a later fall-out returns there instead of the original spawn (Codex review round 4, finding 7)', () => {
    // A terrain hole (emptySquares), not just a low y: on solid ground movement.ts's own
    // ground-contact resolution snaps a falling player back onto the surface before the
    // kill-plane check ever runs, so exercising that check for real needs a square with
    // nothing under it at all -- see movement.ts's integrate/classify (empty -> no snap).
    const holeFlat: Heightfield = { ...flat, emptySquares: new Set([0]) };
    const world = createWorld(holeFlat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    respawnPlayer(world, id, { x: 42, y: 5, z: 7 });
    expect(world.players.spawn[id * 3]).toBe(42);
    expect(world.players.spawn[id * 3 + 1]).toBe(5);
    expect(world.players.spawn[id * 3 + 2]).toBe(7);
    // Send the player far below the kill plane and step the sim: movement.ts's fall-out
    // handling (resetToSpawn) reads players.spawn, not the original addPlayer position.
    world.players.position.set([42, world.killY - 100, 7], id * 3);
    stepWorld(world, new Map([[id, idle]]));
    expect(world.players.position[id * 3]).toBe(42);
    expect(world.players.position[id * 3 + 1]).toBe(5);
    expect(world.players.position[id * 3 + 2]).toBe(7);
  });

  it('increments respawnSeq on every respawn, starting from 0 (Codex review round 8, PR #9)', () => {
    // health/alive alone cannot tell a full-health-to-full-health respawn apart from
    // "nothing happened" when the dead snapshot is skipped -- see netclient.ts's
    // syncRespawnState. respawnSeq is the explicit counter that closes that gap; it has to
    // increment on every single call, unconditionally, or a respawn could still go unseen.
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.respawnSeq[id]).toBe(0);
    respawnPlayer(world, id, { x: 0, y: 0, z: 0 });
    expect(world.players.respawnSeq[id]).toBe(1);
    respawnPlayer(world, id, { x: 0, y: 0, z: 0 });
    respawnPlayer(world, id, { x: 0, y: 0, z: 0 });
    expect(world.players.respawnSeq[id]).toBe(3);
  });
});

describe('playerHitbox and raySphereDistance', () => {
  it('hits a player standing on the ray and reports the correct distance', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    const distance = raySphereDistance(
      { x: 0, y: hitbox.center.y, z: 0 },
      { x: 1, y: 0, z: 0 },
      hitbox,
    );
    expect(distance).not.toBeNull();
    expect(distance ?? 0).toBeCloseTo(10 - hitbox.radius, 1);
  });
  it('misses a ray that passes outside the hit sphere', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    expect(raySphereDistance({ x: 0, y: 100, z: 0 }, { x: 1, y: 0, z: 0 }, hitbox)).toBeNull();
  });
  it('is an immediate hit at distance 0 when the ray origin already starts inside the sphere (Codex review round 2, finding 6)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    // The origin sits exactly at the sphere's center, well inside its radius -- the old
    // discriminant math resolved this to t < 0 and reported a miss.
    expect(raySphereDistance(hitbox.center, { x: 1, y: 0, z: 0 }, hitbox)).toBe(0);
  });
  it('still misses when the sphere sits behind the ray origin instead of surrounding it', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: -10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    // t < 0 here comes from the sphere being entirely behind the origin (c > 0), which is a
    // real miss and must stay one -- only the c <= 0 (origin inside) case should flip to 0.
    expect(
      raySphereDistance({ x: 0, y: hitbox.center.y, z: 0 }, { x: 1, y: 0, z: 0 }, hitbox),
    ).toBeNull();
  });
});

describe('Codex review round 7, finding 3: Laser Rifle headshots must be geometrically reachable', () => {
  it('headY sits within the hit sphere it is ray-tested against, not above its own top', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    // Before the fix, LIGHT_ARMOR's headY (y + 1.955) sat above the sphere's own top
    // (center.y + radius = y + 1.75) -- no ray could ever land high enough to count as a
    // headshot. headY must now fall inside [center.y - radius, center.y + radius].
    expect(hitbox.headY).toBeLessThanOrEqual(hitbox.center.y + hitbox.radius);
    expect(hitbox.headY).toBeGreaterThan(hitbox.center.y - hitbox.radius);
    expect(hitbox.headY).toBeCloseTo(hitbox.center.y + hitbox.radius * 0.7, 10);
  });
});

describe('applyKickback', () => {
  it('scales the velocity change by magnitude/mass and the falloff', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyKickback(world, id, { x: 0, y: 1, z: 0 }, 1750, 1, LIGHT_ARMOR);
    expect(world.players.velocity[id * 3 + 1]).toBeCloseTo(1750 / LIGHT_ARMOR.mass);
  });
  it('does nothing at zero falloff', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyKickback(world, id, { x: 0, y: 1, z: 0 }, 1750, 0, LIGHT_ARMOR);
    expect(world.players.velocity[id * 3 + 1]).toBe(0);
  });
});
