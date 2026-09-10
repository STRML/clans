import { armorFor, type ArmorData } from './armor.js';
import { activeForceFieldBlockers, ENERGY_PACK_RECHARGE_BONUS } from './baseObjects.js';
import { applyDamage, applyFallDamage } from './damage.js';
import {
  raycastInteriors,
  resolveSphereAgainstInteriors,
  type InteriorInstance,
} from './interiors.js';
import { sampleTerrain, type TerrainSample } from './terrain.js';
import type { PlayerInput, PlayerStore, World } from './types.js';

// Vanilla T2 mission gravity. The engine applies it as acc.z += mGravity * mGravityMod *
// TickSec (Player::updateMove, game/player.cc in github.com/tribes2/engine).
export const GRAVITY = 20;
// Contact tolerance for "is the player standing on the surface".
const GROUND_EPSILON = 0.001;
// Ours, deliberately. The engine has NO snap-down: ground contact comes from findContact's
// 3 cm traction probe below the feet (sTractionDistance = 0.03, player.cc) plus the swept
// collision in updatePos, and a fast skier over a crest genuinely leaves the ground there.
// This sim samples a heightfield once per 32 ms tick, so with no snap a skier on any convex
// slope would detach every single tick and slope gravity would never act -- floatier than
// the engine's continuous collision, not more faithful. GROUND_SNAP is how far below the
// feet the surface may fall in one tick and still count as ground. At the Light armor's
// 68 m/s cap that means slopes falling away steeper than ~25 degrees detach -- crest air
// survives, rolling hills stay glued. (The engine's maxStepHeight = 1 is the analogous
// step-UP budget in updatePos, not a snap-down; the numeric match is coincidence.)
const GROUND_SNAP = 1.0;
const IDLE: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  jet: false,
  fire: false,
  altFire: false,
  slot: 0,
  packActive: false,
  use: false,
};

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

/** Torque picks one speed for the move: the larger of the per-axis caps, each scaled by its
 * key -- updateMove's `getMax(maxForwardSpeed * move->y, maxSideSpeed * mFabs(move->x))`
 * (backward branch uses maxBackwardSpeed). The underwater variants of these caps exist in
 * the datablock and updateMove, but the sim has no water volume, so they are unmodeled. */
function desiredSpeed(input: PlayerInput, armor: ArmorData): number {
  const forwardCap = input.moveZ < 0 ? armor.maxBackwardSpeed : armor.maxForwardSpeed;
  return Math.max(Math.abs(input.moveX) * armor.maxSideSpeed, Math.abs(input.moveZ) * forwardCap);
}

/**
 * Tilt a horizontal heading onto the surface without turning it: drop the part of the
 * surface normal that points sideways from the heading, then remove that (properly
 * normalized) from the heading. This is updateMove's construction, transposed from its
 * cross-product form (`nn = pv x (0,0,1); cv = n - nn * mDot(nn, n); pv -= cv *
 * mDot(pv, cv)`): `side` here is nn, `sideShare` is mDot(nn, n), and cv matches.
 * cv is not a unit vector once the surface slopes sideways from the heading too (a
 * diagonal slope), so the removal has to divide by cv's own length squared -- skipping
 * that division left the result short of the surface tangent on a diagonal slope, and
 * the ground contact in applyGround then bled off the shortfall as into-surface velocity,
 * so a runner never reached the nominal run speed. Like the engine, the tilted direction
 * is then scaled to moveSpeed to become the run target `pv`.
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
 * updateMove builds the same thing as `runAcc = pv - (mVelocity + acc)`, where `acc` is
 * this tick's along-slope gravity, then clamps runAcc to `(runForce / mMass) * TickSec`.
 * Adding gravity before steering (the sim's split across applyGround/applyRun) is algebraic
 * reordering of that single expression, not a different model. The "groundFriction = 40"
 * this file once carried is gone for good: no such field exists in the engine. The engine's
 * recover-state boost (recoverRunForceScale, 1.2 in T2's scripts) is unmodeled because the
 * sim has no knockdown state.
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

/**
 * Two updateMove/updatePos behaviors folded into one call. (1) The run-surface projection:
 * updateMove removes the into-surface part of gravity (`vd = -mDot(acc, n); if (vd > 0)
 * acc += n * (vd + 0.002)`) so only the along-slope component remains -- the g*ny*n
 * terms below are exactly `gravity - (gravity·n)n`. (2) The collision solver's velocity
 * response: updatePos computes `bd = -mDot(mVelocity, n)` and adds `n * (bd +
 * sNormalElasticity)` with sNormalElasticity = 0.01, i.e. into-surface velocity is deleted
 * (with a sub-percept 0.01 m/s pushout the sim omits). Doing the removal here, before
 * slope gravity is added, matches the engine's per-tick net effect for a grounded body.
 */
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

function applyAir(body: Body, dt: number): void {
  body.vy -= GRAVITY * dt;
  // Engine-faithful: airborne, gravity is the ONLY force. updateMove's drag line
  // (`mVelocity -= mVelocity * mDrag * TickSec`) is dead in air because shapeBase.cc keeps
  // mDrag at 0 on land (it is re-derived as datablock->drag * waterViscosity * coverage
  // only in water). Horizontal momentum persists unconditionally, which is why ski hops
  // and jetting carry speed; excess-speed decay belongs to applyResistance alone. There is
  // no terminal fall velocity in the engine -- up-resistance is upward-only.
}

/**
 * Torque's jump impulse: jumpForce/mass upward, scaled down linearly once the body already
 * rises faster than minJumpSpeed, and refused above maxJumpSpeed (updateMove's jump block:
 * `zSpeedScale = mVelocity.z; if (zSpeedScale <= maxJumpSpeed) { ... }` -- scale 1 at or
 * below minJumpSpeed, then `1 - (v - min)/(max - min)`). The engine reads mVelocity.z at
 * the START of the tick (acc is not applied until after), so the scale/refusal here reading
 * startVy -- captured before this tick's gravity and run steering -- is the same rule, and
 * a jump on the refusal edge isn't decided by an accel this same tick applied before it.
 * Engine's canJump also requires mEnergy >= minJumpEnergy and no jumpDelay; T2's scripts set
 * minJumpEnergy = 0 / jumpEnergyDrain = 0 / jumpDelay = 0, so both gates are vacuous and the
 * sim (which checks neither) matches retail behavior. One deliberate deviation: the engine
 * applies the impulse along the jump-surface normal's z (plus a horizontal component when
 * the move direction points away from the face), so slope jumps are weaker and directional;
 * this sim hops straight up at full strength on any jumpable slope -- part of the approved
 * ski-hop feel, kept. Returns true when it fired.
 */
function applyJump(body: Body, armor: ArmorData, startVy: number): boolean {
  if (startVy > armor.maxJumpSpeed) return false;
  const range = armor.maxJumpSpeed - armor.minJumpSpeed;
  const scale = startVy > armor.minJumpSpeed ? (armor.maxJumpSpeed - startVy) / range : 1;
  body.vy += (armor.jumpForce / armor.mass) * scale;
  return true;
}

// Deliberate demo tuning for the jet's horizontal authority -- but no longer invented
// wholesale: T2's own scripts carry jet-steering knobs this datablock predates --
// `maxJetHorizontalPercentage = 0.8` (all three armors, player.cs) matches this fraction,
// and `maxJetForwardSpeed = 30/22/16` (Light/Medium/Heavy) is the script's cap for the
// speed jet steering may push toward. The leaked engine's Player has no jet code at all
// (it is the 2001 V12 drop; updateMove only mentions jetting in a comment), so the exact
// retail application is unverifiable -- this function's model (thrust toward
// desiredSpeed, doubled for pure strafing) is the approved feel and stays.
const JET_STEERING_FRACTION = 0.8;

function applyJetSteering(body: Body, input: PlayerInput, armor: ArmorData, dt: number): void {
  const magnitude = Math.hypot(input.moveX, input.moveZ);
  if (magnitude === 0) return;
  const sin = Math.sin(input.yaw),
    cos = Math.cos(input.yaw);
  const x = (input.moveZ * sin - input.moveX * cos) / magnitude;
  const z = (input.moveZ * cos + input.moveX * sin) / magnitude;
  // Add only the requested component. Never steer the entire velocity toward a run
  // target, which would erase skiing momentum perpendicular to the input.
  // Give sustained strafing more authority than the grounded side-speed cap.
  const steeringSpeed = desiredSpeed(input, armor) * (input.moveX !== 0 ? 2 : 1);
  const room = Math.max(0, steeringSpeed - (body.vx * x + body.vz * z));
  const acceleration = Math.min(
    room,
    (armor.jetForce / armor.mass) * JET_STEERING_FRACTION * dt * Math.min(1, magnitude),
  );
  body.vx += x * acceleration;
  body.vz += z * acceleration;
}

/** Recharge each tick, then return whether enough energy was available to fire the jet.
 * The recharge-then-consume order and per-tick amounts are ShapeBase::updateEnergy's
 * (`mEnergy += mRechargeRate`, capped at maxEnergy, shapeBase.cc:1011) followed by the jet's
 * own drain. T2 uses ONE trigger for jump and jet: holding it on the ground hops, and the
 * same held key jets -- thrust applies grounded too, which this models by not gating the
 * jet on airborne state (the engine leak has no jet code to copy; this is the behavioral
 * model). */
function applyJet(
  players: PlayerStore,
  id: number,
  body: Body,
  input: PlayerInput,
  armor: ArmorData,
  dt: number,
): boolean {
  // ShapeBase-style recharge runs every tick, before movement consumes energy. #55: the
  // Energy Pack adds its bonus to the same per-tick recharge (never to the jet drain or
  // the cap) -- docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md,
  // "Movement" step 3: "Original `energypack.cs` adds 0.15 recharge per tick".
  const energy = Math.min(
    armor.maxEnergy,
    (players.energy[id] ?? 0) +
      armor.rechargeRate +
      (players.hasEnergyPack[id] ? ENERGY_PACK_RECHARGE_BONUS : 0),
  );
  players.energy[id] = energy;
  if (input.jet && energy > armor.minJetEnergy) {
    body.vy += (armor.jetForce / armor.mass) * dt;
    players.energy[id] = Math.max(0, energy - armor.jetEnergyDrain);
    return true;
  }
  return false;
}

function applyResistance(body: Body, armor: ArmorData, dt: number): void {
  const horizontal = Math.hypot(body.vx, body.vz);
  // Verbatim port of updateMove's "apply horizontal air resistance" block (game/player.cc,
  // tribes2/engine): cap hvel at horizMaxSpeed, then converge the portion above
  // horizResistSpeed by `horizResistFactor * TickSec` per tick, scaling BOTH axes by
  // resisted/hvel so the direction never changes. Applied grounded and airborne alike,
  // always after this tick's gravity/run/jump/jet acceleration -- same placement as the
  // engine. It converges toward horizResistSpeed; it is NOT a hard clamp (a body at
  // 80 m/s lands at 68 - factor*dt*(68-33) after one tick, not 68).
  if (horizontal > armor.horizResistSpeed) {
    const capped = Math.min(horizontal, armor.horizMaxSpeed);
    const resisted = capped - armor.horizResistFactor * dt * (capped - armor.horizResistSpeed);
    const scale = resisted / horizontal;
    body.vx *= scale;
    body.vz *= scale;
  }
  if (body.vy > armor.upResistSpeed) {
    const capped = Math.min(body.vy, armor.upMaxSpeed);
    body.vy = capped - armor.upResistFactor * dt * (capped - armor.upResistSpeed);
  }
}

interface Contact {
  grounded: boolean;
  landingSpeed: number;
}

/** Integrate, then resolve terrain contact: land, snap down, or stay airborne. The
 * gap <= 0 branch is updatePos's collision response (position clamped to the surface,
 * into-surface velocity removed via applyGround's dt=0 pass); the GROUND_SNAP branch below
 * is the sim's own stand-in for the engine's continuous collision keeping a runner/skier
 * glued over convex slopes -- see the comment at GROUND_SNAP for why it exists and what it
 * costs in fidelity. */
function integrate(
  world: World,
  body: Body,
  wasGrounded: boolean,
  leftGround: boolean,
  dt: number,
): Contact {
  const impactSpeed = Math.max(0, -body.vy);
  const previousY = body.y;
  body.x += body.vx * dt;
  body.y += body.vy * dt;
  body.z += body.vz * dt;
  const landing = sampleGround(world, body, Math.max(previousY, body.y));
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

/** Use an interior floor as ground too, so running, friction, and jumping work indoors.
 * Probe from the previous feet height during integration to catch crossed floors. */
function sampleGround(world: World, body: Body, probeY = body.y): TerrainSample {
  const terrain = sampleTerrain(world.terrain, body.x, body.z);
  if (world.interiors.length === 0) return terrain;
  const hit = raycastInteriors(
    world.interiors,
    { x: body.x, y: probeY + GROUND_EPSILON, z: body.z },
    { x: 0, y: -1, z: 0 },
    Math.max(0, probeY - body.y) + GROUND_SNAP + GROUND_EPSILON,
  );
  if (!hit || Math.abs(hit.normal.y) < GROUND_EPSILON) return terrain;
  if (!terrain.empty && terrain.height <= probeY + GROUND_EPSILON && terrain.height > hit.point.y)
    return terrain;
  const sign = hit.normal.y < 0 ? -1 : 1;
  return {
    ...terrain,
    height: hit.point.y,
    empty: false,
    normal: { x: hit.normal.x * sign, y: hit.normal.y * sign, z: hit.normal.z * sign },
  };
}

function classify(world: World, body: Body, input: PlayerInput, armor: ArmorData): TickContext {
  const sample = sampleGround(world, body);
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
  else applyAir(body, dt);
  if (ctx.mayRun) applyRun(body, input, ctx.sample.normal, armor, dt);
  // The jump comes after the run steering, as in Torque, so the steering toward a
  // horizontal target cannot eat part of the impulse on the tick it fires. It scales and
  // refuses off startVy (captured before ground/run this tick) so this tick's own gravity
  // and steering can't push a jump on the refusal edge into being wrongly refused or scaled.
  const jumped = mayJump && applyJump(body, armor, startVy);
  const jetted = applyJet(players, id, body, input, armor, dt);
  if (jetted && !ctx.grounded) applyJetSteering(body, input, armor, dt);
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

// A real Katabatic interior mesh's closest-point-on-triangle math (interiors.ts) can return a
// push whose depth is nonzero only by floating-point residue -- e.g. 1e-15 m, from a sphere
// that grazes a triangle edge without meaningfully penetrating it. That never showed up
// against the unit-test fixtures' simple boxes, but a real interior with thousands of
// triangles (sbunk2.glb alone has 6,956) produces one on almost every tick somewhere nearby.
// Applying that push's own direction to the velocity correction below divides a body-velocity
// dot product by that same near-zero length, and floating-point division amplifies the noise
// into a real, large velocity change -- confirmed live: a Light player running at 13.66 m/s
// near Katabatic's own sbunk2 interior had its forward velocity zeroed outright on the tick a
// 3e-15 m push landed, then stayed zeroed (airborne, no ground contact) for the rest of a
// movement.spec.ts e2e run. A push below this floor is treated as "not actually touching
// anything" and skipped entirely, position correction included -- moving a player by 1e-15 m
// has no visible effect anyway, so there is nothing to lose by ignoring it.
const MIN_PUSH_DEPTH = 1e-4; // 0.1 mm -- real contact is always far larger than this.

/**
 * Codex round 1, finding 4: both resolveInteriors and resolveForceFields below only ever
 * tested the player's FINAL, already-integrated position for overlap -- never the segment
 * it crossed to get there. At up to horizMaxSpeed (68 m/s Light-armor skiing), a single
 * 32 ms tick covers up to 2.2 m, comfortably more than a thin wall or a force field's own
 * near-zero-thickness collision plane (baseObjects.ts's forceFieldQuad is a flat quad), so a
 * player moving fast enough could cross one entirely within a tick without either endpoint
 * ever overlapping it -- tunneling straight through.
 *
 * Reuses the exact swept-segment raycast projectiles.ts already runs against the same
 * `InteriorInstance` colliders (its own `worldHitAlongSegment`/`raycastInteriors` call), just
 * from the player's own previous->current chest position instead of a shot's. Chest, not the
 * raw body/feet position, to match the reference point the final-position overlap check below
 * already uses -- a feet-height sweep would skim the very bottom edge of a field/wall whose
 * placement (like the existing force-field tests') centers its vertical extent above ground
 * level. Like projectiles, this sweeps a zero-radius ray, not the full two-sphere capsule the
 * final-position check below uses -- ours: cheap enough for a browser demo, and precise enough
 * to stop a fast player at a thin wall or field, which is this finding's actual complaint. A
 * shot that only grazes a corner with the capsule's radius (not the chest's center point)
 * still falls through to the final-position overlap check afterward, same as it always did.
 */
function sweepChest(
  colliders: readonly InteriorInstance[],
  prevChest: Vec3,
  chest: Vec3,
  previousBody: Vec3,
): { point: Vec3; normal: Vec3 } | null {
  const dx = chest.x - prevChest.x,
    dy = chest.y - prevChest.y,
    dz = chest.z - prevChest.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return null;
  const direction: Vec3 = { x: dx / length, y: dy / length, z: dz / length };
  // Extend the ray a tiny distance backward. A previous collision can leave the chest
  // exactly on a triangle plane; rayTriangle intentionally rejects t=0, so without this
  // overlap the next upward tick starts on the roof and tunnels straight through it.
  const SWEEP_EPSILON = 1e-4;
  const origin = {
    x: prevChest.x - direction.x * SWEEP_EPSILON,
    y: prevChest.y - direction.y * SWEEP_EPSILON,
    z: prevChest.z - direction.z * SWEEP_EPSILON,
  };
  const hit = raycastInteriors(colliders, origin, direction, length + SWEEP_EPSILON);
  if (!hit) return null;
  // Interior triangle winding is not guaranteed to point toward the player. Orient the
  // contact normal against this movement so all callers get the same inward-facing normal.
  const facing =
    hit.normal.x * direction.x + hit.normal.y * direction.y + hit.normal.z * direction.z;
  let sign = facing > 0 ? -1 : 1;
  // At a surface tie, movement direction alone cannot tell which side of the solid contains
  // the player. Use the previous body origin (below the chest for a player) when it has a
  // meaningful component along the hit normal. This keeps a downward tick inside an upward
  // wound ceiling; wall contacts with no such component retain motion-based orientation.
  if (hit.distance <= SWEEP_EPSILON * 2) {
    const side = {
      x: previousBody.x - hit.point.x,
      y: previousBody.y - hit.point.y,
      z: previousBody.z - hit.point.z,
    };
    const sideFacing = hit.normal.x * side.x + hit.normal.y * side.y + hit.normal.z * side.z;
    if (Math.abs(sideFacing) > SWEEP_EPSILON) sign = sideFacing < 0 ? -1 : 1;
  }
  return {
    point: hit.point,
    normal: { x: hit.normal.x * sign, y: hit.normal.y * sign, z: hit.normal.z * sign },
  };
}

/** Stops the body at a chest-height swept-segment hit (if any) -- converting the hit point
 *  back from chest space to the body's own feet-referenced x/y/z via `chestOffsetY` -- and
 *  cancels the velocity component driving it further into the surface, the same into-surface
 *  cancellation resolveInteriors's own final-position push-out already does below, just from
 *  the sweep's hit normal instead of a penetration-depth push direction. */
function stopAtSweepHit(
  body: Body,
  hit: { point: Vec3; normal: Vec3 } | null,
  chestOffsetY: number,
  radius: number,
): void {
  if (!hit) return;
  // The ray hits the chest center path, while the player is a sphere/capsule. Leave one
  // radius of clearance on the interior side of the surface; stopping at the hit point
  // embeds the chest sphere in a ceiling and makes the next tick start on the plane again.
  const clearance = radius + 1e-4;
  body.x = hit.point.x + hit.normal.x * clearance;
  body.y = hit.point.y + hit.normal.y * clearance - chestOffsetY;
  body.z = hit.point.z + hit.normal.z * clearance;
  const into = body.vx * hit.normal.x + body.vy * hit.normal.y + body.vz * hit.normal.z;
  if (into < 0) {
    body.vx -= into * hit.normal.x;
    body.vy -= into * hit.normal.y;
    body.vz -= into * hit.normal.z;
  }
}

/** Ours: a two-sphere approximation of the player capsule (feet, chest) rather than a full
 *  swept capsule — the sim already treats a player as one sphere for hit detection
 *  (damage.ts's playerHitbox), so this reuses the same "close enough for a browser demo"
 *  bar rather than introducing a second, more precise player shape only interiors use. */
function resolveInteriors(world: World, body: Body, armor: ArmorData, previous: Vec3): void {
  if (world.interiors.length === 0) return;
  const [boxX, boxY, height] = armor.boundingBox;
  const radius = Math.max(boxX, boxY) / 2;
  const chestOffsetY = height - radius;
  const prevChest = { x: previous.x, y: previous.y + chestOffsetY, z: previous.z };
  const chestBeforePush = { x: body.x, y: body.y + chestOffsetY, z: body.z };
  stopAtSweepHit(
    body,
    sweepChest(world.interiors, prevChest, chestBeforePush, previous),
    chestOffsetY,
    radius,
  );
  const feet = { x: body.x, y: body.y + radius, z: body.z };
  const chest = { x: body.x, y: body.y + chestOffsetY, z: body.z };
  const push =
    resolveSphereAgainstInteriors(world.interiors, chest, radius) ??
    resolveSphereAgainstInteriors(world.interiors, feet, radius);
  const len = push ? Math.hypot(push.x, push.y, push.z) : 0;
  if (!push || len < MIN_PUSH_DEPTH) return;
  body.x += push.x;
  body.y += push.y;
  body.z += push.z;
  const into = (body.vx * push.x + body.vy * push.y + body.vz * push.z) / len;
  if (into < 0) {
    body.vx -= (into * push.x) / len;
    body.vy -= (into * push.y) / len;
    body.vz -= (into * push.z) / len;
  }
}

/** Reuses `resolveInteriors`'s own two-sphere push-out against whichever of the player's
 *  team's opposing force fields are currently powered -- `activeForceFieldBlockers` already
 *  excludes the player's own team's fields, so there is nothing else to filter here. A
 *  friendly field never appears in the list this queries, which is what makes "always passes
 *  your own team" true by construction rather than by an extra team check in this function --
 *  failure matrix row 17. */
function resolveForceFields(
  world: World,
  id: number,
  body: Body,
  armor: ArmorData,
  previous: Vec3,
): void {
  const team = world.players.team[id] ?? 0;
  const blockers = activeForceFieldBlockers(world, team);
  if (blockers.length === 0) return;
  const [boxX, boxY, height] = armor.boundingBox;
  const radius = Math.max(boxX, boxY) / 2;
  const chestOffsetY = height - radius;
  const prevChest = { x: previous.x, y: previous.y + chestOffsetY, z: previous.z };
  const chestBeforePush = { x: body.x, y: body.y + chestOffsetY, z: body.z };
  stopAtSweepHit(
    body,
    sweepChest(blockers, prevChest, chestBeforePush, previous),
    chestOffsetY,
    radius,
  );
  const chest = { x: body.x, y: body.y + chestOffsetY, z: body.z };
  const push = resolveSphereAgainstInteriors(blockers, chest, radius);
  // Same floating-point-noise floor resolveInteriors applies above -- see MIN_PUSH_DEPTH's
  // own comment. This function has no velocity correction to corrupt, but a push this small
  // moves the player by less than a nanometer anyway, so skipping it changes nothing visible.
  if (!push || Math.hypot(push.x, push.y, push.z) < MIN_PUSH_DEPTH) return;
  body.x += push.x;
  body.y += push.y;
  body.z += push.z;
}

function stepPlayer(
  world: World,
  id: number,
  input: PlayerInput,
  armor: ArmorData,
  dt: number,
): void {
  const players = world.players;
  // A mounted player's position is not simulated here at all -- no gravity, no run/jet/jump,
  // no interior/force-field collision pass. stepVehicles (vehicles.ts) is the only system
  // that writes a mounted player's position/velocity, seat-locked to their vehicle, after it
  // moves the vehicle itself (M5 plan, Global Constraints). Every other per-player system
  // this file's caller runs for every active id (weapon timers, etc.) is unaffected -- this
  // guard is scoped to movement.ts alone.
  if (players.mountedVehicleId[id] !== -1) return;
  const body = readBody(players, id);
  const previous: Vec3 = { x: body.x, y: body.y, z: body.z };
  players.yaw[id] = input.yaw;
  const ctx = classify(world, body, input, armor);
  const forces = applyForces(players, id, body, input, ctx, armor, dt);
  applyResistance(body, armor, dt);
  const contact = integrate(world, body, ctx.grounded, forces.jumped || forces.jetted, dt);
  resolveInteriors(world, body, armor, previous);
  resolveForceFields(world, id, body, armor, previous);
  // Falling out of the world is a real death, not a parallel "just move them back" shortcut
  // (Codex review round 9, PR #9, P1): the old position-only reset skipped pendingDeaths
  // entirely, so stepFlags never saw the death, a carried flag never dropped, and damage/
  // ammo/loadout/respawnSeq were never touched -- letting a flag carrier fall out of the map
  // to instantly and safely relocate a stolen flag. Routing through applyDamage with lethal
  // env damage (attackerId -1, matching fall damage's own convention) reuses the same
  // already-hardened pendingDeaths -> stepFlags -> dueForRespawn -> respawnPlayer pipeline
  // every other death goes through, so a kill-plane fall now costs the standard 5 s respawn
  // delay instead of an instant reposition.
  if (body.y < world.killY) {
    // Codex review round 13, PR #9, finding 4: round 9 left `body` uncommitted here on the
    // theory that the previous tick's position was a better flag-drop point than the
    // out-of-bounds one this tick computed. That's backwards -- stepWorld runs stepFlags
    // right after stepPlayers, in this same call, and stepFlags reads world.players.position
    // for a dying carrier's drop point (flags.ts). Leaving the newly-integrated position
    // uncommitted meant it read the PREVIOUS tick's position, not where the player actually
    // died, contrary to the spec's failure matrix ("flag drops at death position"). Commit
    // the real death position (and velocity) before triggering the death, so applyDamage's
    // pendingDeaths entry and everything stepFlags does with it downstream sees where the
    // player actually was.
    writeBody(players, id, body);
    applyDamage(world, id, armor.maxDamage, -1, armor);
    return;
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
    stepPlayer(world, id, input, armorFor(world, id), dt);
  }
}
