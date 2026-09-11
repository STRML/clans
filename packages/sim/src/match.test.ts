import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  ammoIndex,
  ArmorId,
  BaseObjectKind,
  createBaseObjects,
  createFlags,
  createTurrets,
  createWorld,
  FlagState,
  GameOverReason,
  hashWorld,
  MATCH_STATE_SLICES,
  ProjectileImpactReason,
  ProjectileType,
  resetMatch,
  TurretBarrelId,
  TurretState,
  WeaponId,
  WeaponState,
  type Heightfield,
  type World,
} from './index.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

// A non-default match length: a reset that forgot to restore the clock is visible against a
// freshly created world's default rather than coincidentally agreeing with it.
const SHORT_LIMIT_TICKS = 600;

const FLAG_STANDS = [
  { team: 1, position: { x: 0, y: 0, z: 0 } },
  { team: 2, position: { x: 400, y: 0, z: 0 } },
];
const BASE_PLACEMENTS = [
  { kind: BaseObjectKind.Generator, team: 1, position: { x: -40, y: 0, z: 0 } },
  { kind: BaseObjectKind.Generator, team: 2, position: { x: 440, y: 0, z: 0 } },
  { kind: BaseObjectKind.StationInventory, team: 1, position: { x: -60, y: 0, z: 20 } },
  { kind: BaseObjectKind.StationVehiclePad, team: 2, position: { x: 460, y: 0, z: 20 } },
];
const TURRET_PLACEMENTS = [
  { barrel: TurretBarrelId.PlasmaBarrelLarge, team: 1, position: { x: -20, y: 0, z: -20 } },
  { barrel: TurretBarrelId.SentryTurretBarrel, team: 2, position: { x: 420, y: 0, z: -20 } },
];
const PLAYER_SEATS = [
  { spawn: { x: 0, y: 0, z: 0 }, team: 1 },
  { spawn: { x: 10, y: 0, z: 10 }, team: 1 },
  { spawn: { x: 400, y: 0, z: 0 }, team: 2 },
  { spawn: { x: 390, y: 0, z: 10 }, team: 2 },
];

/** A world built exactly the way the server builds one: map placement first, then flags, base
 *  objects, turrets, and a full roster. Every comparison below is against a second one of
 *  these, so "reset" has to mean "field for field what a fresh match starts with". */
function buildWorld(): World {
  const world = createWorld(terrain, 7, 8);
  createFlags(world, FLAG_STANDS, SHORT_LIMIT_TICKS);
  createBaseObjects(world, BASE_PLACEMENTS);
  createTurrets(world, TURRET_PLACEMENTS);
  for (const seat of PLAYER_SEATS) addPlayer(world, seat.spawn, seat.team);
  return world;
}

/**
 * Every piece of match state the reset claims, as plain JSON -- deliberately WIDER than
 * hashWorld, which by its own POLICY comment only covers what a wire round trip reproduces.
 * The reset's completeness contract is wider than that: a stale respawn timer, a mounted
 * player still pointing at a vehicle that no longer exists, or a leftover event queue is a
 * real bug even though none of them can move a hash. Deliberately excluded: the map (terrain,
 * interiors, force-field geometry), configuration (`timeLimitTicks`), the RNG stream, store
 * free-lists, and `ProjectileStore.impactSequence` (an identity counter the reset carries
 * across matches on purpose -- see match.ts's projectiles slice).
 */
function observableMatchState(world: World): unknown {
  const p = world.players;
  const f = world.flags;
  const b = world.baseObjects;
  const t = world.turrets;
  const v = world.vehicles;
  const pr = world.projectiles;
  return {
    tick: world.tick,
    gameOver: world.gameOver,
    winnerTeam: world.winnerTeam,
    gameOverReason: world.gameOverReason,
    teamScores: Array.from(world.teamScores),
    players: {
      count: p.count,
      active: Array.from(p.active),
      team: Array.from(p.team),
      position: Array.from(p.position),
      spawn: Array.from(p.spawn),
      velocity: Array.from(p.velocity),
      yaw: Array.from(p.yaw),
      energy: Array.from(p.energy),
      onGround: Array.from(p.onGround),
      ski: Array.from(p.ski),
      wasGrounded: Array.from(p.wasGrounded),
      wasJumpHeld: Array.from(p.wasJumpHeld),
      landingSpeed: Array.from(p.landingSpeed),
      damage: Array.from(p.damage),
      godMode: Array.from(p.godMode),
      alive: Array.from(p.alive),
      respawnAt: Array.from(p.respawnAt),
      score: Array.from(p.score),
      weaponSlot: Array.from(p.weaponSlot),
      weaponState: Array.from(p.weaponState),
      weaponTimer: Array.from(p.weaponTimer),
      spunUp: Array.from(p.spunUp),
      grenadeCooldown: Array.from(p.grenadeCooldown),
      ammo: Array.from(p.ammo),
      grenades: Array.from(p.grenades),
      respawnSeq: Array.from(p.respawnSeq),
      armor: Array.from(p.armor),
      hasRepairPack: Array.from(p.hasRepairPack),
      hasEnergyPack: Array.from(p.hasEnergyPack),
      carriedWeapons: Array.from(p.carriedWeapons),
      mountedVehicleId: Array.from(p.mountedVehicleId),
      wasUseHeld: Array.from(p.wasUseHeld),
    },
    flags: {
      team: Array.from(f.team),
      state: Array.from(f.state),
      position: Array.from(f.position),
      standPosition: Array.from(f.standPosition),
      carrierId: Array.from(f.carrierId),
      returnAt: Array.from(f.returnAt),
    },
    baseObjects: {
      count: b.count,
      kind: Array.from(b.kind),
      team: Array.from(b.team),
      position: Array.from(b.position),
      usePosition: Array.from(b.usePosition),
      damage: Array.from(b.damage),
      destroyed: Array.from(b.destroyed),
      energy: Array.from(b.energy),
      powered: Array.from(b.powered),
    },
    turrets: {
      count: t.count,
      barrel: Array.from(t.barrel),
      team: Array.from(t.team),
      position: Array.from(t.position),
      damage: Array.from(t.damage),
      destroyed: Array.from(t.destroyed),
      energy: Array.from(t.energy),
      powered: Array.from(t.powered),
      targetId: Array.from(t.targetId),
      targetKind: Array.from(t.targetKind),
      state: Array.from(t.state),
      timer: Array.from(t.timer),
    },
    vehicles: {
      count: v.count,
      freeIds: [...v.freeIds],
      pendingFreeIds: v.pendingFreeIds.map((entry) => ({ ...entry })),
      active: Array.from(v.active),
      kind: Array.from(v.kind),
      team: Array.from(v.team),
      position: Array.from(v.position),
      velocity: Array.from(v.velocity),
      yaw: Array.from(v.yaw),
      pitch: Array.from(v.pitch),
      roll: Array.from(v.roll),
      angVel: Array.from(v.angVel),
      energy: Array.from(v.energy),
      damage: Array.from(v.damage),
      destroyed: Array.from(v.destroyed),
      driverId: Array.from(v.driverId),
      padId: Array.from(v.padId),
      spawnTime: Array.from(v.spawnTime),
      reservedPilotId: Array.from(v.reservedPilotId),
      weaponTimer: Array.from(v.weaponTimer),
      onGround: Array.from(v.onGround),
      wasJumpHeld: Array.from(v.wasJumpHeld),
      lastAttackerId: Array.from(v.lastAttackerId),
    },
    projectiles: {
      count: pr.count,
      freeIds: [...pr.freeIds],
      pendingFreeIds: pr.pendingFreeIds.map((entry) => ({ ...entry })),
      active: Array.from(pr.active),
      type: Array.from(pr.type),
      weaponId: Array.from(pr.weaponId),
      ownerId: Array.from(pr.ownerId),
      team: Array.from(pr.team),
      sourceTurretId: Array.from(pr.sourceTurretId),
      sourceVehicleId: Array.from(pr.sourceVehicleId),
      position: Array.from(pr.position),
      velocity: Array.from(pr.velocity),
      expiresAtTick: Array.from(pr.expiresAtTick),
      armed: Array.from(pr.armed),
      lastImpacts: pr.lastImpacts.map((impact) => ({ ...impact })),
    },
    eventQueues: {
      pendingDeaths: world.pendingDeaths.map((entry) => ({ ...entry })),
      pendingFireEvents: world.pendingFireEvents.map((entry) => ({ ...entry })),
      lastFireEvents: world.lastFireEvents.map((entry) => ({ ...entry })),
      pendingAmmoRefunds: world.pendingAmmoRefunds.map((entry) => ({ ...entry })),
      pendingTurretFireEvents: world.pendingTurretFireEvents.map((entry) => ({ ...entry })),
      pendingVehicleFireEvents: world.pendingVehicleFireEvents.map((entry) => ({ ...entry })),
      lastVehicleFireEvents: world.lastVehicleFireEvents.map((entry) => ({ ...entry })),
      pendingVehicleDestroyed: world.pendingVehicleDestroyed.map((entry) => ({ ...entry })),
    },
  };
}

/** One representative way to dirty each slice of match state. The slices are the thing under
 *  test, so every entry here must touch state its own slice is responsible for and nothing
 *  else. */
const SLICE_FIXTURES: Record<string, (world: World) => void> = {
  clock: (world) => {
    world.tick = 12_345;
  },
  outcome: (world) => {
    world.gameOver = true;
    world.winnerTeam = 2;
    world.gameOverReason = GameOverReason.TimeLimit;
  },
  teamScores: (world) => {
    world.teamScores[1] = 700;
    world.teamScores[2] = 300;
  },
  players: (world) => {
    const p = world.players;
    for (let id = 0; id < p.count; id += 1) {
      p.position.set([id + 0.5, 3, -2], id * 3);
      p.velocity.set([1, -2, 3], id * 3);
      p.yaw[id] = 1.25;
      p.energy[id] = 1;
      p.onGround[id] = 1;
      p.ski[id] = 1;
      p.wasGrounded[id] = 1;
      p.wasJumpHeld[id] = 1;
      p.wasUseHeld[id] = 1;
      p.landingSpeed[id] = 12;
      p.damage[id] = 0.75;
      p.godMode[id] = 1;
      p.alive[id] = 0;
      p.respawnAt[id] = world.tick + 90;
      p.score[id] = -30;
      p.weaponSlot[id] = WeaponId.Chaingun;
      p.weaponState[id] = WeaponState.Firing;
      p.weaponTimer[id] = 0.4;
      p.spunUp[id] = 1;
      p.grenadeCooldown[id] = 1.5;
      p.ammo[ammoIndex(id, WeaponId.Chaingun)] = 3;
      p.grenades[id] = 0;
      p.respawnSeq[id] = 9;
      p.armor[id] = ArmorId.Heavy;
      p.hasRepairPack[id] = 1;
      p.hasEnergyPack[id] = 1;
      p.carriedWeapons[id] = 0b1_1111;
      p.mountedVehicleId[id] = 2;
    }
  },
  flags: (world) => {
    world.flags.state[0] = FlagState.Carried;
    world.flags.carrierId[0] = 1;
    world.flags.position.set([31, 2, -4], 0);
    world.flags.state[1] = FlagState.Dropped;
    world.flags.carrierId[1] = -1;
    world.flags.position.set([250, 0, 40], 3);
    world.flags.returnAt[1] = world.tick + 1_400;
  },
  baseObjects: (world) => {
    for (let id = 0; id < world.baseObjects.count; id += 1) {
      world.baseObjects.damage[id] = 0.5;
      world.baseObjects.energy[id] = 0;
      world.baseObjects.powered[id] = 0;
      if (id === 0) world.baseObjects.destroyed[id] = 1;
    }
  },
  turrets: (world) => {
    const t = world.turrets;
    for (let id = 0; id < t.count; id += 1) {
      t.damage[id] = 1.1;
      t.destroyed[id] = 1;
      t.energy[id] = 0;
      t.powered[id] = 1;
      t.targetId[id] = 2;
      t.targetKind[id] = 1;
      t.state[id] = TurretState.Reload;
      t.timer[id] = 0.6;
    }
  },
  vehicles: (world) => {
    const v = world.vehicles;
    v.count = 1;
    v.freeIds.push(5);
    v.pendingFreeIds.push({ id: 7, ticksRemaining: 2 });
    v.active[0] = 1;
    v.kind[0] = 1;
    v.team[0] = 1;
    v.position.set([1, 2, 3], 0);
    v.velocity.set([4, 5, 6], 0);
    v.yaw[0] = 0.5;
    v.pitch[0] = 0.1;
    v.roll[0] = -0.1;
    v.angVel.set([1, -1, 0.5], 0);
    v.energy[0] = 3;
    v.damage[0] = 0.4;
    v.destroyed[0] = 1;
    v.driverId[0] = 0;
    v.padId[0] = 1;
    v.spawnTime[0] = 2.5;
    v.reservedPilotId[0] = 0;
    v.weaponTimer[0] = 0.3;
    v.onGround[0] = 1;
    v.wasJumpHeld[0] = 1;
    v.lastAttackerId[0] = 0;
  },
  projectiles: (world) => {
    const pr = world.projectiles;
    pr.count = 1;
    pr.freeIds.push(4);
    pr.pendingFreeIds.push({ id: 3, ticksRemaining: 1 });
    pr.active[0] = 1;
    pr.type[0] = ProjectileType.Linear;
    pr.weaponId[0] = WeaponId.Spinfusor;
    pr.ownerId[0] = 0;
    pr.team[0] = 1;
    pr.sourceTurretId[0] = 1;
    pr.sourceVehicleId[0] = 2;
    pr.position.set([9, 9, 9], 0);
    pr.velocity.set([0, 0, -50], 0);
    pr.expiresAtTick[0] = 999;
    pr.armed[0] = 1;
    pr.lastImpacts.push({
      x: 1,
      y: 2,
      z: 3,
      weaponId: WeaponId.Spinfusor,
      type: ProjectileType.Linear,
      reason: ProjectileImpactReason.World,
      seq: pr.impactSequence + 1,
    });
  },
  eventQueues: (world) => {
    world.pendingDeaths.push({ id: 0, attackerId: 2 });
    world.pendingFireEvents.push({
      playerId: 0,
      weaponId: WeaponId.Spinfusor,
      isAltFire: false,
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      shooterVelocity: { x: 0, y: 0, z: 0 },
      energyScale: 1,
      hitPlayerId: -1,
      hitPoint: null,
      projectileId: -1,
      resolved: false,
    });
    world.lastFireEvents.push({
      playerId: 1,
      weaponId: WeaponId.Blaster,
      isAltFire: false,
      origin: { x: 1, y: 1, z: 1 },
      direction: { x: 0, y: 0, z: 1 },
      shooterVelocity: { x: 0, y: 0, z: 0 },
      energyScale: 1,
      hitPlayerId: 2,
      hitPoint: { x: 2, y: 1, z: 2 },
      projectileId: 7,
      resolved: true,
    });
    world.pendingAmmoRefunds.push({ playerId: 0, weaponId: WeaponId.Chaingun, isAltFire: false });
    world.pendingTurretFireEvents.push({
      turretId: 0,
      barrel: TurretBarrelId.PlasmaBarrelLarge,
      team: 1,
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    });
    world.pendingVehicleFireEvents.push({
      vehicleId: 0,
      team: 1,
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      ownerId: 0,
    });
    world.lastVehicleFireEvents.push({
      vehicleId: 0,
      team: 1,
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      ownerId: 0,
    });
    world.pendingVehicleDestroyed.push({ id: 0, position: { x: 1, y: 2, z: 3 }, team: 1 });
  },
};

describe('resetMatch', () => {
  it('declares a fixture for every slice of match state it owns', () => {
    // The whole point of MATCH_STATE_SLICES being data rather than prose: a slice cannot be
    // declared without a behavioral test of what dirtying it means.
    expect(Object.keys(SLICE_FIXTURES).sort()).toEqual(
      MATCH_STATE_SLICES.map((slice) => slice.name).sort(),
    );
  });

  for (const [name, dirty] of Object.entries(SLICE_FIXTURES)) {
    it(`resets the ${name} slice, and the fixture for it is real`, () => {
      const world = buildWorld();
      dirty(world);
      // Proves the fixture actually dirties observable state: without this, a fixture that
      // touched nothing would "pass" for a reset that reset nothing.
      expect(observableMatchState(world)).not.toEqual(observableMatchState(buildWorld()));
      resetMatch(world);
      expect(observableMatchState(world)).toEqual(observableMatchState(buildWorld()));
    });
  }

  it('returns a player who has played a whole match to a fresh player', () => {
    const world = buildWorld();
    const p = world.players;
    const id = 0;
    p.damage[id] = 1.4;
    p.score[id] = 220;
    p.respawnSeq[id] = 4;
    p.position.set([50, 12, 60], id * 3);
    p.alive[id] = 0;
    p.armor[id] = ArmorId.Heavy;
    p.hasRepairPack[id] = 1;
    resetMatch(world);
    expect(p.alive[id]).toBe(1);
    expect(p.damage[id]).toBe(0);
    expect(p.energy[id]).toBe(p.energy[1]); // back to the armor's full bar
    expect(p.score[id]).toBe(0);
    expect(p.respawnSeq[id]).toBe(0);
    expect(p.respawnAt[id]).toBe(-1);
    expect(p.armor[id]).toBe(ArmorId.Light);
    expect(p.hasRepairPack[id]).toBe(0);
    expect([p.position[id * 3], p.position[id * 3 + 1], p.position[id * 3 + 2]]).toEqual([
      p.spawn[id * 3],
      p.spawn[id * 3 + 1],
      p.spawn[id * 3 + 2],
    ]);
  });

  it("hashWorld after a reset matches a freshly created world's, at the same tick", () => {
    // The strongest available completeness proof: hashWorld covers every field a wire round
    // trip reproduces, so anything dirty that survives the reset and is hash-visible shows up
    // here even if no slice fixture noticed it. Both worlds come from the same builder, so
    // they agree on placement and configuration; only one of them played a match first.
    const fresh = buildWorld();
    const played = buildWorld();
    for (const dirty of Object.values(SLICE_FIXTURES)) dirty(played);
    played.tick = 40_000;
    expect(hashWorld(played)).not.toBe(hashWorld(fresh));
    resetMatch(played);
    expect(played.tick).toBe(fresh.tick);
    expect(hashWorld(played)).toBe(hashWorld(fresh));
  });

  it('keeps configuration, the map, the roster, and the projectile sequence', () => {
    const world = buildWorld();
    const activeBefore = Array.from(world.players.active);
    const teams = Array.from(world.players.team);
    const stands = Array.from(world.flags.standPosition);
    const barrels = Array.from(world.turrets.barrel);
    const placements = Array.from(world.baseObjects.position);
    world.projectiles.impactSequence = 41;
    resetMatch(world);
    expect(world.timeLimitTicks).toBe(SHORT_LIMIT_TICKS);
    expect(Array.from(world.players.team)).toEqual(teams);
    expect(Array.from(world.players.active)).toEqual(activeBefore);
    expect(Array.from(world.flags.standPosition)).toEqual(stands);
    expect(Array.from(world.turrets.barrel)).toEqual(barrels);
    expect(Array.from(world.baseObjects.position)).toEqual(placements);
    // A new match whose counter restarted at 0 could make a late record from the previous
    // match look like a new one to any consumer comparing ProjectileImpact.seq numbers.
    expect(world.projectiles.impactSequence).toBe(41);
    expect(world.projectiles.count).toBe(0);
  });
});
