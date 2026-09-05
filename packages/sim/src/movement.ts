import { LIGHT_ARMOR, type ArmorData } from './armor.js';
import { sampleTerrain, type TerrainSample } from './terrain.js';
import type { PlayerInput, PlayerStore, World } from './types.js';

export const GRAVITY = 20;
// Contact tolerance for "is the player standing on the surface".
const GROUND_EPSILON = 0.001;
// A grounded player who did not jump or jet may drop this far in one tick and stay
// grounded. Without it a skier leaves the surface every tick the slope falls away.
const GROUND_SNAP = 1.0;
const IDLE: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };

interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

const degrees = (radians: number): number => (radians * 180) / Math.PI;
const clampAbs = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));
const approachZero = (value: number, amount: number): number =>
  value <= amount ? 0 : value - amount;

function readBody(players: PlayerStore, id: number): Body {
  const base = id * 3;
  return {
    x: players.position[base] ?? 0,
    y: players.position[base + 1] ?? 0,
    z: players.position[base + 2] ?? 0,
    vx: players.velocity[base] ?? 0,
    vy: players.velocity[base + 1] ?? 0,
    vz: players.velocity[base + 2] ?? 0,
  };
}

function writeBody(players: PlayerStore, id: number, body: Body): void {
  players.position.set([body.x, body.y, body.z], id * 3);
  players.velocity.set([body.vx, body.vy, body.vz], id * 3);
}

/** Add acceleration on one local axis. Never pushes past the cap; always allows braking. */
function accelerateAxis(velocity: number, acceleration: number, cap: number): number {
  if (Math.abs(velocity) <= cap) return clampAbs(velocity + acceleration, cap);
  return Math.sign(acceleration) === Math.sign(velocity) ? velocity : velocity + acceleration;
}

/** Run force in the player's local frame with T2's per-axis speed caps. */
function applyRun(body: Body, input: PlayerInput, armor: ArmorData, dt: number): void {
  const length = Math.hypot(input.moveX, input.moveZ);
  if (length === 0) return;
  const acceleration = (armor.runForce / armor.mass) * dt;
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  const side = body.vx * cos - body.vz * sin;
  const forward = body.vx * sin + body.vz * cos;
  const forwardCap = input.moveZ < 0 ? armor.maxBackwardSpeed : armor.maxForwardSpeed;
  const nextSide = accelerateAxis(side, (input.moveX / length) * acceleration, armor.maxSideSpeed);
  const nextForward = accelerateAxis(forward, (input.moveZ / length) * acceleration, forwardCap);
  body.vx = nextSide * cos + nextForward * sin;
  body.vz = nextForward * cos - nextSide * sin;
}

/** Ground friction when standing still on the surface without skiing. */
function applyFriction(body: Body, armor: ArmorData, dt: number): void {
  const speed = Math.hypot(body.vx, body.vz);
  if (speed === 0) return;
  const next = approachZero(speed, armor.groundFriction * dt);
  body.vx *= next / speed;
  body.vz *= next / speed;
}

/** Remove any velocity into the surface, then add the slope component of gravity. */
function applyGround(body: Body, sample: TerrainSample, dt: number): void {
  const { x: nx, y: ny, z: nz } = sample.normal;
  const along = body.vx * nx + body.vy * ny + body.vz * nz;
  if (along < 0) {
    body.vx -= along * nx;
    body.vy -= along * ny;
    body.vz -= along * nz;
  }
  body.vx += GRAVITY * ny * nx * dt;
  body.vy -= GRAVITY * (1 - ny * ny) * dt;
  body.vz += GRAVITY * ny * nz * dt;
}

function applyAir(body: Body, armor: ArmorData, dt: number): void {
  body.vy -= GRAVITY * dt;
  const airDrag = Math.max(0, 1 - armor.drag * dt);
  body.vx *= airDrag;
  body.vz *= airDrag;
}

/** Returns true when the jet fired this tick. Recharges only while the jet key is up. */
function applyJet(
  players: PlayerStore,
  id: number,
  body: Body,
  input: PlayerInput,
  armor: ArmorData,
  dt: number,
): boolean {
  const energy = players.energy[id] ?? 0;
  if (input.jet && energy > armor.minJetEnergy) {
    body.vy += (armor.jetForce / armor.mass) * dt;
    players.energy[id] = Math.max(0, energy - armor.jetEnergyDrain);
    return true;
  }
  if (!input.jet) players.energy[id] = Math.min(armor.maxEnergy, energy + armor.rechargeRate);
  return false;
}

function applyResistance(body: Body, armor: ArmorData, dt: number): void {
  const horizontal = Math.hypot(body.vx, body.vz);
  if (horizontal > armor.horizMaxSpeed) {
    const scale = armor.horizMaxSpeed / horizontal;
    body.vx *= scale;
    body.vz *= scale;
  } else if (horizontal > armor.horizResistSpeed) {
    const decay = 1 - armor.horizResistFactor * dt;
    body.vx *= decay;
    body.vz *= decay;
  }
  const vertical = Math.abs(body.vy);
  if (vertical > armor.upMaxSpeed) {
    body.vy = Math.sign(body.vy) * armor.upMaxSpeed;
  } else if (vertical > armor.upResistSpeed) {
    body.vy *= 1 - armor.upResistFactor * dt;
  }
}

interface Contact {
  grounded: boolean;
  landingSpeed: number;
}

/** Integrate, then resolve terrain contact: land, snap down, or stay airborne. */
function integrate(
  world: World,
  body: Body,
  wasGrounded: boolean,
  leftGround: boolean,
  dt: number,
): Contact {
  const impactSpeed = Math.max(0, -body.vy);
  body.x += body.vx * dt;
  body.y += body.vy * dt;
  body.z += body.vz * dt;
  const landing = sampleTerrain(world.terrain, body.x, body.z);
  const gap = body.y - landing.height;
  if (gap <= 0) {
    body.y = landing.height;
    applyGround(body, landing, 0);
    return { grounded: true, landingSpeed: wasGrounded ? -1 : impactSpeed };
  }
  if (wasGrounded && !leftGround && gap <= GROUND_SNAP) {
    body.y = landing.height;
    return { grounded: true, landingSpeed: -1 };
  }
  return { grounded: false, landingSpeed: -1 };
}

interface TickContext {
  sample: TerrainSample;
  grounded: boolean;
  slope: number;
  forcedSki: boolean;
  skiing: boolean;
  mayRun: boolean;
}

function classify(world: World, body: Body, input: PlayerInput, armor: ArmorData): TickContext {
  const sample = sampleTerrain(world.terrain, body.x, body.z);
  const grounded = body.y <= sample.height + GROUND_EPSILON;
  const slope = degrees(Math.acos(Math.max(-1, Math.min(1, sample.normal.y))));
  const forcedSki = slope > armor.runSurfaceAngle;
  const skiing = grounded && (input.jump || forcedSki);
  const belowRunSpeed = Math.hypot(body.vx, body.vz) < armor.maxForwardSpeed;
  const mayRun = grounded && !forcedSki && (!input.jump || belowRunSpeed);
  return { sample, grounded, slope, forcedSki, skiing, mayRun };
}

const isIdleOnGround = (ctx: TickContext, input: PlayerInput): boolean =>
  ctx.grounded && !ctx.skiing && input.moveX === 0 && input.moveZ === 0;

interface Forces {
  jumped: boolean;
  jetted: boolean;
}

function applyForces(
  players: PlayerStore,
  id: number,
  body: Body,
  input: PlayerInput,
  ctx: TickContext,
  armor: ArmorData,
  dt: number,
): Forces {
  if (ctx.mayRun) applyRun(body, input, armor, dt);
  if (isIdleOnGround(ctx, input)) applyFriction(body, armor, dt);
  const jumpEdge = input.jump && (!players.wasJumpHeld[id] || !players.wasGrounded[id]);
  const jumped = ctx.grounded && jumpEdge && ctx.slope <= armor.jumpSurfaceAngle;
  if (jumped) body.vy = Math.max(body.vy, armor.jumpForce / armor.mass);
  if (ctx.grounded) applyGround(body, ctx.sample, dt);
  else applyAir(body, armor, dt);
  const jetted = applyJet(players, id, body, input, armor, dt);
  return { jumped, jetted };
}

function writeState(
  players: PlayerStore,
  id: number,
  body: Body,
  contact: Contact,
  input: PlayerInput,
  skiing: boolean,
): void {
  writeBody(players, id, body);
  if (contact.landingSpeed >= 0) players.landingSpeed[id] = contact.landingSpeed;
  players.onGround[id] = contact.grounded ? 1 : 0;
  players.ski[id] = skiing ? 1 : 0;
  players.wasGrounded[id] = contact.grounded ? 1 : 0;
  players.wasJumpHeld[id] = input.jump ? 1 : 0;
}

function stepPlayer(
  world: World,
  id: number,
  input: PlayerInput,
  armor: ArmorData,
  dt: number,
): void {
  const players = world.players;
  const body = readBody(players, id);
  players.yaw[id] = input.yaw;
  const ctx = classify(world, body, input, armor);
  const forces = applyForces(players, id, body, input, ctx, armor, dt);
  applyResistance(body, armor, dt);
  const contact = integrate(world, body, ctx.grounded, forces.jumped || forces.jetted, dt);
  writeState(players, id, body, contact, input, ctx.skiing);
}

export function stepPlayers(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  for (let id = 0; id < world.players.count; id += 1) {
    const input = inputs.get(id) ?? { ...IDLE, yaw: world.players.yaw[id] ?? 0 };
    stepPlayer(world, id, input, LIGHT_ARMOR, dt);
  }
}
