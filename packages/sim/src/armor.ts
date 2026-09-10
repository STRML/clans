export interface ArmorData {
  mass: number;
  maxDamage: number;
  maxEnergy: number;
  rechargeRate: number;
  jetForce: number;
  jetEnergyDrain: number;
  minJetEnergy: number;
  runForce: number;
  maxForwardSpeed: number;
  maxBackwardSpeed: number;
  maxSideSpeed: number;
  jumpForce: number;
  jumpDelay: number;
  minJumpSpeed: number;
  maxJumpSpeed: number;
  horizMaxSpeed: number;
  horizResistSpeed: number;
  horizResistFactor: number;
  upMaxSpeed: number;
  upResistSpeed: number;
  upResistFactor: number;
  drag: number;
  boundingBox: readonly [number, number, number];
  runSurfaceAngle: number;
  jumpSurfaceAngle: number;
  speedDamageScale: number;
  discAmmo: number;
  chaingunAmmo: number;
  mortarAmmo: number;
  grenadeCount: number;
  maxWeapons: number;
  laserRifleAllowed: boolean;
  mortarAllowed: boolean;
  /** Repair Pack heal rate per tick -- the spec's Armor numbers table gives 0.0033 for every
   *  armor identically (`packs/repairpack.cs`'s DefaultRepairBeam is not armor-specific). Added
   *  here in Task 6, which is the first system that reads it (repair.ts's stepRepairPacks). */
  repairRate: number;
}

/**
 * Provenance (issue #3): every number in these three datablocks is the vanilla value from
 * Tribes 2's shipped scripts (`GameData/base/scripts/player.cs`, LightMaleHumanArmor /
 * MediumMaleHumanArmor / HeavyMaleHumanArmor datablocks; community mirror
 * github.com/jdknight/t2ds), cross-checked against the leaked engine's own PlayerData
 * defaults in `game/player.cc` of github.com/tribes2/engine (the 2001 V12-engine drop T2
 * shipped from). Where a value is *not* vanilla it is called out at the field. The
 * integration that consumes these fields is `Player::updateMove`/`updatePos` in that same
 * engine drop; movement.ts carries the matching citations per function.
 */
export const LIGHT_ARMOR: ArmorData = {
  mass: 90,
  maxDamage: 0.66,
  maxEnergy: 60,
  // Per-tick energy recharge, not per second: ShapeBase::updateEnergy does
  // `mEnergy += mRechargeRate` once per 32 ms tick (shapeBase.cc:1011), capped at maxEnergy.
  rechargeRate: 0.256,
  jetForce: 26.21 * 90,
  jetEnergyDrain: 0.8,
  minJetEnergy: 1,
  runForce: 55.2 * 90,
  maxForwardSpeed: 15,
  maxBackwardSpeed: 13,
  maxSideSpeed: 13,
  // Vanilla jumpForce/jumpDelay/minJumpSpeed/maxJumpSpeed (player.cs LightMaleHumanArmor).
  // jumpDelay 0 means no engine-side cooldown (Player::canJump's !mJumpDelay passes every
  // tick), so holding jump re-fires on each ground contact -- the ski hop. minJumpEnergy and
  // jumpEnergyDrain are 0 in the script, so Player::canJump's energy gate is trivially true
  // and jumps are free; the sim mirrors that by never gating a jump on energy.
  jumpForce: 8.3 * 90,
  jumpDelay: 0,
  minJumpSpeed: 20,
  maxJumpSpeed: 30,
  // Air resistance acts on velocity, not force: Player::updateMove's "apply horizontal air
  // resistance" block caps hvel at horizMaxSpeed, then converges the excess above
  // horizResistSpeed by `factor * TickSec` per tick (up to upMaxSpeed for vz). The formula
  // in movement.ts's applyResistance is that block verbatim. Resistance also runs while
  // grounded, and only upward: falling has no terminal velocity in the engine.
  horizMaxSpeed: 68,
  horizResistSpeed: 33,
  horizResistFactor: 0.35,
  upMaxSpeed: 80,
  upResistSpeed: 25,
  upResistFactor: 0.3,
  // Vanilla `drag = 0.275` (player.cs), but the engine multiplies it into water coverage
  // only -- shapeBase.cc sets `mDrag = 0` every tick and re-derives it as
  // `mDataBlock->drag * sWaterViscosity * mWaterCoverage` (shapeBase.cc:1724/1735). On
  // land and in air mDrag is 0 and updateMove's `mVelocity -= mVelocity * mDrag * TickSec`
  // is a no-op, so a water-less map must NOT apply this field per tick; the sim keeps the
  // vanilla number for fidelity and (correctly) never consumes it.
  drag: 0.275,
  boundingBox: [1.2, 1.2, 2.3],
  // findContact compares the flattest contact normal against cos(runSurfaceAngle) /
  // cos(jumpSurfaceAngle) (player.cc, engine defaults 80/78; T2 scripts set 70/80 for
  // Light and Medium -- Medium's script sets 75 and then overrides to 80 on its next
  // line, so 80 wins). Heavy is the one armor whose script value differs: 75.
  runSurfaceAngle: 70,
  jumpSurfaceAngle: 80,
  // Vanilla 0.004 (player.cs). T2's own fall-impact threshold is minImpactSpeed = 45 for
  // every armor; this sim's ArmorData has no minImpactSpeed and damage.ts's applyFallDamage
  // currently substitutes minJumpSpeed (20/15/20) as the threshold -- a known deviation
  // owned by damage.ts, recorded here so nobody reads this field as covering it.
  speedDamageScale: 0.004,
  discAmmo: 15,
  chaingunAmmo: 100,
  mortarAmmo: 0,
  grenadeCount: 5,
  maxWeapons: 3,
  laserRifleAllowed: true,
  mortarAllowed: false,
  repairRate: 0.0033,
};

export enum ArmorId {
  Light = 0,
  Medium = 1,
  Heavy = 2,
}

export const MEDIUM_ARMOR: ArmorData = {
  mass: 130,
  maxDamage: 1.1,
  maxEnergy: 80,
  rechargeRate: 0.256,
  jetForce: 25.22 * 130,
  jetEnergyDrain: 1.0,
  minJetEnergy: 1,
  runForce: 46 * 130,
  maxForwardSpeed: 12,
  maxBackwardSpeed: 10,
  maxSideSpeed: 10,
  jumpForce: 8.3 * 130,
  jumpDelay: 0,
  minJumpSpeed: 15,
  maxJumpSpeed: 25,
  horizMaxSpeed: 60,
  horizResistSpeed: 28,
  horizResistFactor: 0.32,
  upMaxSpeed: 70,
  upResistSpeed: 30,
  upResistFactor: 0.23,
  drag: 0.3,
  boundingBox: [1.45, 1.45, 2.4],
  runSurfaceAngle: 70,
  jumpSurfaceAngle: 80,
  speedDamageScale: 0.004,
  discAmmo: 15,
  chaingunAmmo: 150,
  mortarAmmo: 0,
  grenadeCount: 6,
  maxWeapons: 4,
  laserRifleAllowed: false,
  mortarAllowed: false,
  repairRate: 0.0033,
};

export const HEAVY_ARMOR: ArmorData = {
  mass: 180,
  maxDamage: 1.32,
  maxEnergy: 110,
  rechargeRate: 0.256,
  jetForce: 22.47 * 180,
  jetEnergyDrain: 1.1,
  minJetEnergy: 1,
  runForce: 40.25 * 180,
  maxForwardSpeed: 7,
  maxBackwardSpeed: 5,
  maxSideSpeed: 5,
  jumpForce: 8.3 * 180,
  jumpDelay: 0,
  minJumpSpeed: 20,
  maxJumpSpeed: 30,
  horizMaxSpeed: 52,
  horizResistSpeed: 23,
  horizResistFactor: 0.29,
  upMaxSpeed: 60,
  upResistSpeed: 35,
  upResistFactor: 0.18,
  drag: 0.33,
  boundingBox: [1.63, 1.63, 2.6],
  runSurfaceAngle: 70,
  // Issue #3 fix: was 80, but the vanilla HeavyMaleHumanArmor datablock is the one armor
  // that differs from the others here -- `jumpSurfaceAngle = 75` (player.cs, no later
  // override, unlike Medium's 75-then-80). A Heavy on slopes between 75 and 80 degrees
  // now refuses to jump (canJump's surface test), exactly as the retail Heavy does.
  jumpSurfaceAngle: 75,
  // Issue #3 fix: was 0.004 (copied from Light/Medium), but the vanilla Heavy datablock
  // is `speedDamageScale = 0.006` (player.cs HeavyMaleHumanArmor) -- Heavies take more
  // speed-scaled fall damage, not the Light rate.
  speedDamageScale: 0.006,
  discAmmo: 15,
  chaingunAmmo: 200,
  mortarAmmo: 200,
  grenadeCount: 8,
  maxWeapons: 5,
  laserRifleAllowed: false,
  mortarAllowed: true,
  repairRate: 0.0033,
};

export const ARMORS: Record<ArmorId, ArmorData> = {
  [ArmorId.Light]: LIGHT_ARMOR,
  [ArmorId.Medium]: MEDIUM_ARMOR,
  [ArmorId.Heavy]: HEAVY_ARMOR,
};

/** The single place every system looks up a player's armor. Never read `LIGHT_ARMOR` (or any
 *  other constant) directly for a per-player calculation again -- see the M4 plan's Global
 *  Constraints. */
export function armorFor(world: { players: { armor: Uint8Array } }, id: number): ArmorData {
  return ARMORS[(world.players.armor[id] ?? ArmorId.Light) as ArmorId];
}
