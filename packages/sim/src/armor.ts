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
}

export const LIGHT_ARMOR: ArmorData = {
  mass: 90,
  maxDamage: 0.66,
  maxEnergy: 60,
  rechargeRate: 0.256,
  jetForce: 26.21 * 90,
  jetEnergyDrain: 0.8,
  minJetEnergy: 1,
  runForce: 55.2 * 90,
  maxForwardSpeed: 15,
  maxBackwardSpeed: 13,
  maxSideSpeed: 13,
  jumpForce: 8.3 * 90,
  jumpDelay: 0,
  minJumpSpeed: 20,
  maxJumpSpeed: 30,
  horizMaxSpeed: 68,
  horizResistSpeed: 33,
  horizResistFactor: 0.35,
  upMaxSpeed: 80,
  upResistSpeed: 25,
  upResistFactor: 0.3,
  drag: 0.275,
  boundingBox: [1.2, 1.2, 2.3],
  runSurfaceAngle: 70,
  jumpSurfaceAngle: 80,
  speedDamageScale: 0.004,
  discAmmo: 15,
  chaingunAmmo: 100,
  mortarAmmo: 0,
  grenadeCount: 5,
  maxWeapons: 3,
  laserRifleAllowed: true,
  mortarAllowed: false,
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
  jumpSurfaceAngle: 80,
  speedDamageScale: 0.004,
  discAmmo: 15,
  chaingunAmmo: 200,
  mortarAmmo: 200,
  grenadeCount: 8,
  maxWeapons: 5,
  laserRifleAllowed: false,
  mortarAllowed: true,
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
