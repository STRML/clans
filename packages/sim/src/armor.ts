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
};
