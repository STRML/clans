import type { World } from './types.js';
import { ammoIndex, WeaponId } from './weapons.js';

const FNV_PRIME = 0x01000193;

/**
 * Folds one number into the running hash. Positions and velocities are rounded to the
 * millimetre before mixing: the wire format quantizes them to f32, and at the map's
 * largest coordinates f32 round trip error stays under 0.001 m, so this rounding survives
 * an encode/decode cycle without changing the hash. The same rounding is harmless for the
 * plain integers mixed below (ids, states, team numbers) -- scaling an exact integer by 1000
 * is still an exact, deterministic function of it.
 */
function mix(hash: number, value: number): number {
  // All four bytes of the millimetre integer: positions reach 1024 m (20 bits).
  const bits = Math.round(value * 1000) | 0;
  let h = hash;
  for (let shift = 0; shift < 32; shift += 8) {
    h = (h ^ ((bits >>> shift) & 0xff)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

function num(arr: Float64Array | Uint8Array | Uint16Array | Int16Array, i: number): number {
  return arr[i] ?? 0;
}

/**
 * Mixes in every field of PlayerStore that is both real simulation state AND reproducible
 * from a correct wire round trip (see hashWorld's POLICY comment below for the full rule).
 * Deliberately excluded: count/freeIds (store bookkeeping, not per-player), active (already
 * gates which ids this function is called for), spawn (movement.ts no longer reads it at
 * all -- see damage.ts's respawnPlayer comment -- it is bookkeeping netclient.ts mirrors
 * locally, not state stepWorld's own outputs depend on), landingSpeed (written on a landing
 * tick, consumed synchronously by that same call's applyFallDamage, and never read again --
 * two worlds that differ only in landingSpeed produce identical FUTURE behavior), and
 * respawnAt (round 15, PR #9, finding 3a -- see the comment at its former call site: not
 * reproducible from the wire even in principle, so it fails this function's own contract).
 * Through round 11 this stopped at weaponSlot; round 12 added ammo/grenades/weaponState/
 * weaponTimer/spunUp/grenadeCooldown; round 13 added onGround, ski, wasGrounded,
 * wasJumpHeld, godMode, alive, respawnAt (later removed, see above), score, and respawnSeq
 * (later masked to its wire width, see below) -- all of it real per-player state that
 * movement.ts, damage.ts, and weapons.ts mutate every tick or every death/respawn. A hash
 * that never mixed these in could report two worlds identical when e.g. one player was dead
 * and the other alive, or one carried a 10-point scoring lead the other didn't, silently
 * defeating the determinism check the spec's Testing section documents. Codex review round
 * 13 (PR #9), finding 2.
 */
function mixPlayer(hash: number, players: World['players'], id: number): number {
  const base = id * 3;
  let h = mix(hash, id);
  h = mix(h, num(players.team, id));
  h = mix(h, num(players.position, base));
  h = mix(h, num(players.position, base + 1));
  h = mix(h, num(players.position, base + 2));
  h = mix(h, num(players.velocity, base));
  h = mix(h, num(players.velocity, base + 1));
  h = mix(h, num(players.velocity, base + 2));
  h = mix(h, num(players.yaw, id));
  h = mix(h, num(players.energy, id));
  h = mix(h, num(players.onGround, id));
  h = mix(h, num(players.ski, id));
  h = mix(h, num(players.wasGrounded, id));
  h = mix(h, num(players.wasJumpHeld, id));
  h = mix(h, num(players.wasUseHeld, id));
  h = mix(h, num(players.damage, id));
  h = mix(h, num(players.godMode, id));
  h = mix(h, num(players.alive, id));
  // respawnAt is deliberately NOT mixed in (round 15, PR #9, finding 3a -- reverting round
  // 13's addition). It fails hashWorld's own contract (see this function's and hashWorld's
  // doc comments): a correct wire round trip is not expected to reproduce it. For an ALIVE
  // player, deserializePlayer already forces it to -1 (round 13's own follow-up fix), so
  // hashing it for a live player mixes in a constant, no information at all. For a DEAD
  // player it is deliberately NOT on the wire in the first place -- the client reconstructs
  // its own respawn-countdown estimate via a separate, local-stamping mechanism (see
  // netclient.ts's death-detection code, round 1's fix) rather than via decode, so a decoded
  // dead player's respawnAt was never meant to be reconstructible from wire data alone.
  // Hashing it just manufactured a false mismatch between two worlds that agree on
  // everything the wire actually carries.
  h = mix(h, num(players.score, id));
  h = mix(h, num(players.weaponSlot, id));
  h = mix(h, num(players.ammo, ammoIndex(id, WeaponId.Spinfusor)));
  h = mix(h, num(players.ammo, ammoIndex(id, WeaponId.Chaingun)));
  h = mix(h, num(players.ammo, ammoIndex(id, WeaponId.Mortar)));
  h = mix(h, num(players.grenades, id));
  h = mix(h, num(players.weaponState, id));
  h = mix(h, num(players.weaponTimer, id));
  h = mix(h, num(players.spunUp, id));
  h = mix(h, num(players.grenadeCooldown, id));
  // Masked to the wire's own truncation (round 15, PR #9, finding 3b). respawnSeq is a
  // Uint16 in the sim, but protocol/snapshot.ts deliberately truncates it to a single wire
  // byte (round 8's choice -- see PlayerStore.respawnSeq's doc comment in types.ts, and
  // netclient.ts's respawn-detection logic, which is already built to tolerate the
  // resulting mod-256 wraparound). Hashing the untruncated value made hashWorld demand more
  // precision than a correct encode/decode round trip can actually reproduce, a false
  // mismatch the wire was never designed to avoid.
  h = mix(h, num(players.respawnSeq, id) & 0xff);
  h = mix(h, num(players.armor, id));
  h = mix(h, num(players.hasRepairPack, id));
  return h;
}

/**
 * Mixes in every field of ProjectileStore that is real simulation state -- everything
 * except count/freeIds/pendingFreeIds (store bookkeeping) and active (already gates which
 * ids this loop visits). Through round 12 this stopped at ownerId and never touched
 * expiresAtTick or armed, both of which projectiles.ts mutates every tick and both of which
 * decide observable behavior (when a projectile despawns, whether a grenade can still be
 * armed to detonate on contact) -- exactly the kind of state a client/server divergence
 * could disagree on while every mixed field still matched. Codex review round 13 (PR #9),
 * finding 2. Issue #13 closes the same gap for `team`, `sourceTurretId`, and its M5
 * sibling `sourceVehicleId`: team filters the shot's own worldHitAlongSegment pass, and
 * the two source ids exclude the firing structure/vehicle from the shot's structure
 * hit-test (projectiles.ts), so worlds differing in exactly one of them resolve hits
 * differently from the very next tick.
 */
function mixProjectiles(hash: number, world: World): number {
  let h = hash;
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    const base = id * 3;
    h = mix(h, id);
    h = mix(h, num(world.projectiles.type, id));
    h = mix(h, num(world.projectiles.weaponId, id));
    h = mix(h, num(world.projectiles.position, base));
    h = mix(h, num(world.projectiles.position, base + 1));
    h = mix(h, num(world.projectiles.position, base + 2));
    h = mix(h, num(world.projectiles.velocity, base));
    h = mix(h, num(world.projectiles.velocity, base + 1));
    h = mix(h, num(world.projectiles.velocity, base + 2));
    h = mix(h, num(world.projectiles.ownerId, id));
    h = mix(h, num(world.projectiles.team, id));
    h = mix(h, num(world.projectiles.sourceTurretId, id));
    h = mix(h, num(world.projectiles.sourceVehicleId, id));
    h = mix(h, num(world.projectiles.expiresAtTick, id));
    h = mix(h, num(world.projectiles.armed, id));
  }
  return h;
}

/**
 * Mixes in every field of FlagStore. Through round 12 this stopped at position and never
 * touched returnAt (the dropped-flag return timer flags.ts counts down every tick) or
 * standPosition (where a dropped/returned flag heads back to) -- both real per-flag state
 * that could diverge silently. Codex review round 13 (PR #9), finding 2.
 */
function mixFlags(hash: number, world: World): number {
  let h = hash;
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const base = id * 3;
    h = mix(h, id);
    h = mix(h, num(world.flags.team, id));
    h = mix(h, num(world.flags.state, id));
    h = mix(h, num(world.flags.carrierId, id));
    h = mix(h, num(world.flags.position, base));
    h = mix(h, num(world.flags.position, base + 1));
    h = mix(h, num(world.flags.position, base + 2));
    h = mix(h, num(world.flags.standPosition, base));
    h = mix(h, num(world.flags.standPosition, base + 1));
    h = mix(h, num(world.flags.standPosition, base + 2));
    h = mix(h, num(world.flags.returnAt, id));
  }
  return h;
}

function mixBaseObjects(hash: number, world: World): number {
  let h = hash;
  const store = world.baseObjects;
  for (let id = 0; id < store.count; id += 1) {
    h = mix(h, id);
    h = mix(h, num(store.kind, id));
    h = mix(h, num(store.team, id));
    h = mix(h, num(store.damage, id));
    h = mix(h, num(store.destroyed, id));
    h = mix(h, num(store.energy, id));
    h = mix(h, num(store.powered, id));
  }
  return h;
}

function mixTurrets(hash: number, world: World): number {
  let h = hash;
  const store = world.turrets;
  for (let id = 0; id < store.count; id += 1) {
    h = mix(h, id);
    h = mix(h, num(store.barrel, id));
    h = mix(h, num(store.team, id));
    h = mix(h, num(store.damage, id));
    h = mix(h, num(store.destroyed, id));
    h = mix(h, num(store.energy, id));
    h = mix(h, num(store.powered, id));
    h = mix(h, num(store.targetId, id));
    // M5, Task 8: disambiguates targetId's own referent (player vs. vehicle) -- two worlds
    // whose turret has the same targetId but a different targetKind (one aimed at a player,
    // the other at a vehicle sharing that same numeric id) must hash differently, the exact
    // class of gap issue #13 already found in this function omitting `timer`.
    h = mix(h, num(store.targetKind, id));
    h = mix(h, num(store.state, id));
    // Issue #13: the fire-cycle countdown advanceFireCycle/fireAt (turrets.ts) decrement and
    // reset every tick -- two worlds whose turret timers differ fire their next shot on
    // different ticks, so a divergence in exactly this field must move the hash. Not
    // wire-carried (TurretSnapshotData has no timer; decoded turrets are consumed as DTOs
    // by the client's presentation, never round-tripped into a World), which puts it in the
    // same carve-out class hashWorld's POLICY comment already grants expiresAtTick.
    h = mix(h, num(store.timer, id));
  }
  return h;
}

/** Mixes in every VehicleStore field that affects future simulation -- deliberately
 *  exhaustive, not a curated subset (M5 plan, Task 9): mixTurrets shipped in M4 missing
 *  `timer` (issue #13, fixed here) precisely because an earlier pass excluded a
 *  field on the assumption it "should" be redundant with something else. `energy` in
 *  particular is not optional: it is exactly the kind of state applyVehicleDamage's
 *  shield-then-health rule can diverge on between two otherwise-identical worlds, the same
 *  role it already plays in mixBaseObjects/mixTurrets. */
function mixVehicle(hash: number, vehicles: World['vehicles'], id: number): number {
  const base = id * 3;
  let h = mix(hash, id);
  h = mix(h, num(vehicles.kind, id));
  h = mix(h, num(vehicles.team, id));
  h = mix(h, num(vehicles.position, base));
  h = mix(h, num(vehicles.position, base + 1));
  h = mix(h, num(vehicles.position, base + 2));
  h = mix(h, num(vehicles.velocity, base));
  h = mix(h, num(vehicles.velocity, base + 1));
  h = mix(h, num(vehicles.velocity, base + 2));
  h = mix(h, num(vehicles.yaw, id));
  h = mix(h, num(vehicles.pitch, id));
  h = mix(h, num(vehicles.roll, id));
  h = mix(h, num(vehicles.angVel, base));
  h = mix(h, num(vehicles.angVel, base + 1));
  h = mix(h, num(vehicles.angVel, base + 2));
  h = mix(h, num(vehicles.energy, id));
  h = mix(h, num(vehicles.damage, id));
  h = mix(h, num(vehicles.destroyed, id));
  h = mix(h, num(vehicles.driverId, id));
  h = mix(h, num(vehicles.padId, id));
  h = mix(h, num(vehicles.weaponTimer, id));
  h = mix(h, num(vehicles.spawnTime, id));
  h = mix(h, num(vehicles.reservedPilotId, id));
  h = mix(h, num(vehicles.onGround, id));
  // Round 1 (this PR), sibling of finding 8's wasJumpHeld fix: real state that decides next
  // tick's jump behavior, same class movement.ts's own wasJumpHeld already earns a slot in
  // mixPlayer for.
  h = mix(h, num(vehicles.wasJumpHeld, id));
  // Issue #57: score-affecting state, the same class as driverId -- two worlds identical
  // except for who will be credited when this vehicle dies MUST hash differently, since
  // applyVehicleKillScore diverges their players.score the tick the vehicle is destroyed.
  h = mix(h, num(vehicles.lastAttackerId, id));
  return h;
}

/**
 * POLICY (Codex review round 15, PR #9, finding 3c -- closing out five straight review
 * rounds of "hashWorld is missing/including field X"): the spec's Testing section states
 * hashWorld's actual contract as "hash of world state matches across encode and decode" --
 * nothing broader. hashWorld therefore covers exactly the state a correct wire encode-then-
 * decode round trip is expected to reproduce, no more and no less:
 *
 *   - Transient one-tick communication arrays on World -- pendingDeaths, pendingFireEvents,
 *     pendingAmmoRefunds, and (by the same convention) ProjectileStore.pendingFreeIds -- are
 *     documented in the plan's Global Constraints as "not networked": internal-only
 *     communication between systems within a single stepWorld call. None of them belong
 *     here, and none of them are mixed in above.
 *   - mixPlayer mixes every PlayerStore field EXCEPT respawnAt (not wire-reproducible even
 *     in principle -- see mixPlayer's own comment) and hashes respawnSeq truncated to its
 *     wire width (`& 0xff`), matching what the wire actually carries rather than the sim's
 *     full-precision internal value.
 *   - The accepted carve-out class: fields hashed here that are NOT wire-carried, joined by
 *     nothing ever reconstructing that store FROM wire data to hashWorld against. As of the
 *     issue #13 fix it covers mixProjectiles' expiresAtTick (a raw internal tick counter,
 *     meaningless across a client/server boundary with different tick numbering --
 *     protocol/snapshot.ts's ProjectileSnapshotData doc comment explains why it is not
 *     sent), mixProjectiles' team/sourceTurretId/sourceVehicleId (#13: ProjectileSnapshotData
 *     carries none of the three, and decoded projectiles are consumed directly as DTOs by
 *     weapons-view.ts), and mixTurrets' timer (same story: TurretSnapshotData has no timer
 *     and decoded turrets feed only the client's presentation). None of these violates the
 *     "matches across encode and decode" contract, because that contract is simply never
 *     exercised for a store nobody reconstructs from the wire.
 *
 * A future finding that this hash is missing some field, or hashing some field the wire
 * doesn't carry, should be checked against this policy before being treated as a bug: if the
 * field is transient one-tick bookkeeping, or isn't reconstructible from the wire even in
 * principle, leaving it out (or masking it to the wire's precision) is correct, not a gap.
 */
export function hashWorld(world: World): number {
  let hash = 0x811c9dc5;
  hash = mix(hash, world.tick);
  hash = mix(hash, world.gameOver ? 1 : 0);
  hash = mix(hash, world.winnerTeam);
  hash = mix(hash, world.gameOverReason);
  // Set once, by createWorld or createFlags, not touched again after -- but still a real
  // per-match value that flags.ts's stepFlags compares world.tick against every tick to
  // decide whether the match ends, so two otherwise-identical worlds with different time
  // limits would end on different ticks: a real divergence the hash used to miss entirely.
  // Codex review round 13 (PR #9), finding 2.
  hash = mix(hash, world.timeLimitTicks);
  hash = mix(hash, num(world.teamScores, 1));
  hash = mix(hash, num(world.teamScores, 2));
  const p = world.players;
  for (let id = 0; id < p.count; id += 1) {
    if (!p.active[id]) continue;
    hash = mixPlayer(hash, p, id);
  }
  hash = mixProjectiles(hash, world);
  hash = mixFlags(hash, world);
  hash = mixBaseObjects(hash, world);
  hash = mixTurrets(hash, world);
  const v = world.vehicles;
  for (let id = 0; id < v.count; id += 1) {
    if (!v.active[id]) continue;
    hash = mixVehicle(hash, v, id);
  }
  // pendingTurretFireEvents/pendingVehicleFireEvents are deliberately not mixed — same
  // one-tick-transient convention pendingFireEvents already follows per the POLICY comment
  // above.
  return hash >>> 0;
}
