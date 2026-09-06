import { LIGHT_ARMOR, type ArmorData } from './armor.js';
import { applyFallDamage } from './damage.js';
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

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Torque picks one speed for the move: the larger of the per-axis caps, each scaled by its key. */
function desiredSpeed(input: PlayerInput, armor: ArmorData): number {
  const forwardCap = input.moveZ < 0 ? armor.maxBackwardSpeed : armor.maxForwardSpeed;
  return Math.max(Math.abs(input.moveX) * armor.maxSideSpeed, Math.abs(input.moveZ) * forwardCap);
}

/**
 * Tilt a horizontal heading onto the surface without turning it: drop the part of the
 * surface normal that points sideways from the heading, then remove that (properly
 * normalized) from the heading. This is Torque's construction in Player::updateMove.
 * cv is not a unit vector once the surface slopes sideways from the heading too (a
 * diagonal slope), so the removal has to divide by cv's own length squared -- skipping
 * that division left the result short of the surface tangent on a diagonal slope, and
 * the ground contact in applyGround then bled off the shortfall as into-surface velocity,
 * so a runner never reached the nominal run speed.
 */
function tiltOntoSurface(heading: Vec3, normal: Vec3): Vec3 {
  const sideLength = Math.hypot(heading.z, heading.x);
  const side = { x: -heading.z / sideLength, y: 0, z: heading.x / sideLength };
  const sideShare = side.x * normal.x + side.z * normal.z;
  const cv = {
    x: normal.x - side.x * sideShare,
    y: normal.y,
    z: normal.z - side.z * sideShare,
  };
  const cvLengthSq = cv.x * cv.x + cv.y * cv.y + cv.z * cv.z || 1;
  const along = (heading.x * cv.x + heading.z * cv.z) / cvLengthSq;
  return { x: heading.x - cv.x * along, y: -cv.y * along, z: heading.z - cv.z * along };
}

/** The velocity the player wants: the move direction along the surface at the armor's cap. */
function desiredVelocity(input: PlayerInput, normal: Vec3, armor: ArmorData): Vec3 {
  const speed = desiredSpeed(input, armor);
  if (speed === 0) return { x: 0, y: 0, z: 0 };
  // Forward is (sin yaw, 0, cos yaw). Right is forward x up = (-cos yaw, 0, sin yaw), so
  // positive moveX (the D key) strafes to the camera's right.
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  const heading = {
    x: input.moveZ * sin - input.moveX * cos,
    y: 0,
    z: input.moveZ * cos + input.moveX * sin,
  };
  const tilted = tiltOntoSurface(heading, normal);
  const scale = speed / Math.hypot(tilted.x, tilted.y, tilted.z);
  return { x: tilted.x * scale, y: tilted.y * scale, z: tilted.z * scale };
}

/**
 * Torque's run model: steer the velocity toward the desired velocity, at most runForce/mass
 * per second. With no move key the desired velocity is zero, and that pull is what stops a
 * runner; there is no separate ground friction. It runs after slope gravity, so a runner
 * holds the cap downhill and an idle player settles on any slope below runSurfaceAngle.
 */
function applyRun(
  body: Body,
  input: PlayerInput,
  normal: Vec3,
  armor: ArmorData,
  dt: number,
): void {
  const target = desiredVelocity(input, normal, armor);
  let ax = target.x - body.vx;
  let ay = target.y - body.vy;
  let az = target.z - body.vz;
  const wanted = Math.hypot(ax, ay, az);
  const maxAcc = (armor.runForce / armor.mass) * dt;
  if (wanted > maxAcc) {
    const scale = maxAcc / wanted;
    ax *= scale;
    ay *= scale;
    az *= scale;
  }
  body.vx += ax;
  body.vy += ay;
  body.vz += az;
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

/**
 * Torque's jump impulse: jumpForce/mass upward, scaled down linearly once the body already
 * rises faster than minJumpSpeed, and refused above maxJumpSpeed. The scale and refusal read
 * the vertical speed from the start of the tick (startVy), not the speed after this tick's
 * gravity and run steering already ran, so a jump on the edge of the refusal threshold isn't
 * decided by an accel this same tick applied before the jump. Returns true when it fired.
 */
function applyJump(body: Body, armor: ArmorData, startVy: number): boolean {
  if (startVy > armor.maxJumpSpeed) return false;
  const range = armor.maxJumpSpeed - armor.minJumpSpeed;
  const scale = startVy > armor.minJumpSpeed ? (armor.maxJumpSpeed - startVy) / range : 1;
  body.vy += (armor.jumpForce / armor.mass) * scale;
  return true;
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
  if (landing.empty) return { grounded: false, landingSpeed: -1 };
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
  const grounded = !sample.empty && body.y <= sample.height + GROUND_EPSILON;
  const slope = degrees(Math.acos(Math.max(-1, Math.min(1, sample.normal.y))));
  const forcedSki = slope > armor.runSurfaceAngle;
  const skiing = grounded && (input.jump || forcedSki);
  // A skier below run speed may still run, but only while a move key is held: with no key
  // the run steering would pull them to a stop, and skiing exists to remove that pull.
  const belowRunSpeed = Math.hypot(body.vx, body.vy, body.vz) < armor.maxForwardSpeed;
  const moving = input.moveX !== 0 || input.moveZ !== 0;
  const mayRun = grounded && !forcedSki && (!input.jump || (belowRunSpeed && moving));
  return { sample, grounded, slope, forcedSki, skiing, mayRun };
}

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
  const jumpEdge = input.jump && (!players.wasJumpHeld[id] || !players.wasGrounded[id]);
  const mayJump = ctx.grounded && jumpEdge && ctx.slope <= armor.jumpSurfaceAngle;
  const startVy = body.vy;
  if (ctx.grounded) applyGround(body, ctx.sample, dt);
  else applyAir(body, armor, dt);
  if (ctx.mayRun) applyRun(body, input, ctx.sample.normal, armor, dt);
  // The jump comes after the run steering, as in Torque, so the steering toward a
  // horizontal target cannot eat part of the impulse on the tick it fires. It scales and
  // refuses off startVy (captured before ground/run this tick) so this tick's own gravity
  // and steering can't push a jump on the refusal edge into being wrongly refused or scaled.
  const jumped = mayJump && applyJump(body, armor, startVy);
  const jetted = applyJet(players, id, body, input, armor, dt);
  return { jumped, jetted };
}

function writeState(
  world: World,
  id: number,
  body: Body,
  contact: Contact,
  input: PlayerInput,
  ctx: TickContext,
  armor: ArmorData,
): void {
  const players = world.players;
  writeBody(players, id, body);
  if (contact.landingSpeed >= 0) {
    players.landingSpeed[id] = contact.landingSpeed;
    applyFallDamage(world, id, contact.landingSpeed, armor);
  }
  players.onGround[id] = contact.grounded ? 1 : 0;
  players.ski[id] = ctx.skiing ? 1 : 0;
  // The jump edge compares against the grounded state at the start of this tick, not the
  // contact result, so the tick after a landing still sees the air-to-ground transition
  // and a held jump fires on landing (the T2 ski hop).
  players.wasGrounded[id] = ctx.grounded ? 1 : 0;
  players.wasJumpHeld[id] = input.jump ? 1 : 0;
}

/**
 * Codex round 10 (PR #4): this used to only reset the local `body` (position, velocity)
 * before writeState ran, which then unconditionally overwrote onGround/ski/wasGrounded
 * from the stale ctx/contact computed for the tick the player fell out on, and left
 * energy exactly where the fall interrupted it rather than restoring it. A fall-out is a
 * respawn like any other, and should leave the player in the same fresh state addPlayer
 * (world.ts's resetPlayerToSpawn) produces, not a mix of a reset position and everything
 * else mid-fall. Written directly to the SoA arrays (not `body`) because the caller
 * returns immediately after this, skipping writeState entirely for this tick.
 */
function resetToSpawn(players: PlayerStore, id: number, armor: ArmorData): void {
  const base = id * 3;
  players.position.set(
    [players.spawn[base] ?? 0, players.spawn[base + 1] ?? 0, players.spawn[base + 2] ?? 0],
    base,
  );
  players.velocity.set([0, 0, 0], base);
  players.yaw[id] = 0;
  players.energy[id] = armor.maxEnergy;
  players.onGround[id] = 0;
  players.ski[id] = 0;
  players.wasGrounded[id] = 0;
  players.wasJumpHeld[id] = 0;
  players.landingSpeed[id] = 0;
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
  if (body.y < world.killY) {
    resetToSpawn(players, id, armor);
    return; // already fully reset; writeState below would overwrite it with this tick's stale fall state
  }
  writeState(world, id, body, contact, input, ctx, armor);
}

export function stepPlayers(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  world.pendingDeaths = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const input = inputs.get(id) ?? { ...IDLE, yaw: world.players.yaw[id] ?? 0 };
    stepPlayer(world, id, input, LIGHT_ARMOR, dt);
  }
}
