import {
  FIXED_DT,
  GRAVITY,
  GRENADE_DATA,
  ProjectileImpactReason,
  ProjectileType,
  WEAPON_DATA,
  type FireEvent,
  type ProjectileImpact,
  type Vec3,
} from '@clans/sim';

/**
 * The two ends of a hit.
 *
 * Tribes 2's base scripts give the SHOOTER nothing: no marker, no damage numbers, no readout of
 * the target's health (the classic mod added an on-hit sound, `cg_hard4.wav`, and that is a mod
 * asset this project does not ship). What the base scripts do have runs on the VICTIM's machine
 * -- `Armor::damageObject` in the base scripts' player.cs flashes the victim's screen red
 * (:2790-2795, plus :2834 where a killing blow maxes it) and plays their pain cry (:2849 into
 * playPain, :2976-2983). So this module is the T2-native victim half plus the shooter
 * confirmation Sam asked for, in the one place both halves can be reasoned about.
 *
 * What the shooter half does NOT cover, all of it for want of a field on the wire or on the
 * record, and all of it worth a confirmation in a later pass:
 *  - Whose player was hit. The impact record carries no victim, so a hit on a teammate confirms
 *    exactly like a hit on an enemy -- the flash and the marker cannot be told apart, and the
 *    classic mod's own cue had the same blindness.
 *  - A mounted player's shots. VehicleFireEvent is not fed here (a vehicle shot's weapon id sits
 *    at VEHICLE_WEAPON_ID_OFFSET with its own table's speed and inherit), so a Shrike blaster
 *    hit confirms nothing today.
 *  - The Laser Rifle. It is hitscan: no projectile, no impact record. Its hits are the shooter's
 *    own FireEvent's hitPlayerId, which the client cannot trust in a networked match -- the
 *    local prediction has no other player's position to hit.
 */

/** T2's own accumulation: `%flash = %targetObject.getDamageFlash() + (%amount * 2)`, clamped at
 *  0.75 (base/scripts/player.cs:2790-2795). `amount` is in the same units T2 uses -- damage
 *  against a full health bar -- which is what this sim's damage already is (armor.ts's
 *  maxDamage 0.66 light, weapons.ts's Spinfusor radiusDamage 0.5): a disc hit maxes the flash,
 *  a Chaingun round (0.0825) raises it by a sixth. */
export const DAMAGE_FLASH_MAX = 0.75;
export const DAMAGE_FLASH_PER_DAMAGE = 2;
/** T2 bleeds 0.007 off the flash on every player update while any is left (playerUpdate.cpp's
 *  `Player::updateMove`, :831-834), and that update runs on the 32 ms move tick this game's
 *  FIXED_DT is the equivalent of -- so this is the same bleed per second, and a full 0.75
 *  flash clears in ~3.4 s. That is the point of the value: T2's flash is a "you are being hit"
 *  tint that a sustained burst keeps pinned up, not a 100 ms blink. */
export const DAMAGE_FLASH_DECAY_PER_TICK = 0.007;
export const DAMAGE_FLASH_DECAY_PER_S = DAMAGE_FLASH_DECAY_PER_TICK / FIXED_DT;

/** One damage event's worth of flash, T2's own arithmetic (DAMAGE_FLASH_MAX and above). */
export function addedDamageFlash(current: number, amount: number): number {
  return Math.min(current + amount * DAMAGE_FLASH_PER_DAMAGE, DAMAGE_FLASH_MAX);
}

/** One step of T2's own bleed, floored at zero. */
export function decayedDamageFlash(current: number, dtSeconds: number): number {
  return Math.max(current - DAMAGE_FLASH_DECAY_PER_S * dtSeconds, 0);
}

/**
 * The victim's red screen tint, as a value the HUD can render: T2 draws it as the camera's own
 * alpha blend -- `qp->cameraInfo.alphaBlend = damageFlash` with alphaColor (1, 0, 0)
 * (FearPlayerPSC.cpp:1378-1384) -- so the value IS the tint's opacity, capped 0.75.
 *
 * Fed the local player's health, because health is the only place a client sees its own damage:
 * the sim writes it into `players.damage` (damage.ts's applyDamage) and the networked client
 * reads the authoritative value back into the same field every snapshot (netclient.ts's
 * reconcile). The health LOST between two samples is therefore exactly the damage a T2
 * `damageObject` call would have flashed for.
 *
 * Two things T2's own call site has that this cannot see: the damage type's `damageScale`
 * (player.cs:2787-2789; damage types are not on the wire) and an overkill's true amount
 * (applyDamage clamps `damage` at maxDamage, so a lethal hit reads as the health that was left
 * -- the flash is capped either way). Healing and respawns RAISE health; T2 does not reduce the
 * flash for either, and neither does this.
 */
export interface DamageFlash {
  /** Feed the local player's current health once a frame; returns the flash to render. */
  sample(health: number, dtSeconds: number): number;
}

export function createDamageFlash(): DamageFlash {
  let previousHealth: number | null = null;
  let value = 0;
  return {
    sample(health: number, dtSeconds: number): number {
      if (previousHealth !== null && health < previousHealth) {
        value = addedDamageFlash(value, previousHealth - health);
      }
      previousHealth = health;
      value = decayedDamageFlash(value, dtSeconds);
      return value;
    },
  };
}

/** How close an impact has to land to a shot's own flight path to be that shot's hit. Ours: the
 *  wire's impact record names neither the projectile nor the shooter (#52 carries position,
 *  weapon, type, reason and a sequence number), so a client attributes hits geometrically --
 *  and 2 m is comfortably wider than a player's own capsule plus the gap between this client's
 *  predicted shot and the server's copy of it, while staying short of a second player standing
 *  beside the one that was hit. Its residual false positive is the mirror of that: somebody
 *  else's shot landing on the line of one of this player's own live shots confirms too. The
 *  window is small (the same weapon, a line that has to still be live, an impact inside the
 *  radius) because the record names no shooter, which is the only thing that would close it. */
export const HIT_ATTRIBUTION_RADIUS_M = 2;
/** How long past its own flight lifetime a shot stays attributable, ours: the record for a hit
 *  it landed still has to cross the network (the server resolves the shot on the input it
 *  received a round trip after this client predicted it) before the client can match it. */
export const HIT_ATTRIBUTION_MARGIN_MS = 750;

/** A shot the local player fired that could still produce an impact record, in the sim's own
 *  launch terms -- projectiles.ts's spawnStored (:305-311 for the velocity, :346 for the row
 *  it writes) -- so a later impact can be matched against the trajectory the body actually
 *  flew rather than against a fresh guess at it. */
interface ShotRecord {
  /** The weapon and body type the impact record will report. The thrown hand grenade rides the
   *  firing weapon's own id with a Grenade type (weapons.ts's altFire event), which is why the
   *  type is half of a shot's identity: the Spinfusor's disc and its grenade differ by nothing
   *  else. */
  weaponId: number;
  type: number;
  origin: Vec3;
  velocity: Vec3;
  /** Wall clock after which this shot cannot be the one that landed. */
  expiresAtMs: number;
}

/** The sim's own launch-velocity formula, spawnStored's velocityFor (projectiles.ts:305-311). */
function velocityFor(direction: Vec3, speed: number, shooterVel: Vec3, velInherit: number): Vec3 {
  return {
    x: direction.x * speed + shooterVel.x * velInherit,
    y: direction.y * speed + shooterVel.y * velInherit,
    z: direction.z * speed + shooterVel.z * velInherit,
  };
}

/** Where the shot's own body is `seconds` after it left the muzzle: its launch velocity, plus
 *  the fall projectiles.ts integrates into Grenade-type ordnance and into nothing else
 *  (integrateGrenade's `velocity.y - GRAVITY * dt`; a disc or a bullet flies the straight line
 *  its velocity describes). The sim's own integration is semi-implicit Euler, which trails this
 *  closed form by `0.5 * GRAVITY * dt * t` -- 0.19 m on a one-second mortar flight, well inside
 *  HIT_ATTRIBUTION_RADIUS_M. The hand grenade's drag (GRENADE_DATA.drag 0.1, integrated the
 *  same way) is the one term this does not model: a hand grenade's long throw can therefore
 *  miss attribution, which costs a confirmation, never invents one. */
function shotPositionAt(shot: ShotRecord, seconds: number): Vec3 {
  const drop = shot.type === ProjectileType.Grenade ? 0.5 * GRAVITY * seconds * seconds : 0;
  return {
    x: shot.origin.x + shot.velocity.x * seconds,
    y: shot.origin.y + shot.velocity.y * seconds - drop,
    z: shot.origin.z + shot.velocity.z * seconds,
  };
}

/** The record one of this player's own fire events leaves behind, or null for a shot that can
 *  never produce an impact record: the Laser Rifle is hitscan (WEAPON_DATA's `projectile: null`),
 *  resolves inside spawnFromEvent, and reaches other clients as a LaserFired event instead. */
function shotRecordFor(event: FireEvent, nowMs: number): ShotRecord | null {
  if (event.isAltFire) {
    return {
      weaponId: event.weaponId,
      type: ProjectileType.Grenade,
      origin: { ...event.origin },
      velocity: velocityFor(event.direction, GRENADE_DATA.speed, event.shooterVelocity, 1),
      expiresAtMs: nowMs + GRENADE_DATA.lifetime * 1000 + HIT_ATTRIBUTION_MARGIN_MS,
    };
  }
  const data = WEAPON_DATA[event.weaponId];
  if (!data || data.projectile === null) return null;
  return {
    weaponId: event.weaponId,
    type: data.projectile,
    origin: { ...event.origin },
    velocity: velocityFor(event.direction, data.speed, event.shooterVelocity, data.velInherit),
    expiresAtMs: nowMs + data.lifetime * 1000 + HIT_ATTRIBUTION_MARGIN_MS,
  };
}

/** Whether this shot accounts for that impact: the record's own identity (the weapon and body
 *  type the shot was fired with) and a contact point inside HIT_ATTRIBUTION_RADIUS_M of where
 *  the shot's body is at that point's own flight time.
 *
 *  Flight time is measured off the contact point's distance rather than off the clock: it costs
 *  nothing, and it stays exact for a shot whose record arrives a round trip after the server
 *  resolved it -- a wall-clock estimate would have to model the lag, and would drift with it.
 *  It is exact for every straight-flying shot, and for the arcs it reads the same closed form
 *  shotPositionAt does. */
function shotAccountsFor(shot: ShotRecord, impact: ProjectileImpact, nowMs: number): boolean {
  if (nowMs > shot.expiresAtMs) return false;
  if (shot.weaponId !== impact.weaponId || shot.type !== impact.type) return false;
  const speed = Math.hypot(shot.velocity.x, shot.velocity.y, shot.velocity.z);
  if (speed <= 0) return false;
  const seconds =
    Math.hypot(impact.x - shot.origin.x, impact.y - shot.origin.y, impact.z - shot.origin.z) /
    speed;
  const at = shotPositionAt(shot, seconds);
  return Math.hypot(at.x - impact.x, at.y - impact.y, at.z - impact.z) <= HIT_ATTRIBUTION_RADIUS_M;
}

/** Where a confirmed hit is announced: the shooter's own cue and the reticle's marker. Both
 *  belong to app-level presentation (audio.ts's engine and hud.ts's reticle), so the frame
 *  hands them in rather than this module reaching for either. */
export interface HitFeedbackSink {
  /** Play the confirmation cue -- audio.ts's hitConfirm. */
  hitSound(): void;
  /** Open the reticle's hit marker -- hud.ts's showHitMarker, at the frame's own timestamp. */
  hitMarker(atMs: number): void;
}

export interface HitFeedback {
  /** One shot the local player just fired, straight from the sim's own fire event (it carries
   *  the origin, launch direction, the shooter's own velocity and the weapon). Call it once per
   *  tick the frame simulated: world.lastFireEvents is overwritten per stepWeapons call, so a
   *  multi-step frame that only looked at its last tick would lose every earlier tick's shots.
   *
   *  Nothing here fires a shot: a recorded shot is consumed by the first impact it accounts for,
   *  and expires on its own lifetime otherwise. */
  shot(event: FireEvent, nowMs: number): void;
  /** Annunciate the impacts among `impacts` that landed on a player off one of this player's
   *  own shots, in arrival order. Pass each record exactly once -- the same contract
   *  playImpactAudio's own callers document -- and note that a record delivered twice still
   *  confirms once: the shot behind it was consumed by the first one. */
  confirm(impacts: readonly ProjectileImpact[], nowMs: number): void;
}

export function createHitFeedback(sink: HitFeedbackSink): HitFeedback {
  const shots: ShotRecord[] = [];
  return {
    shot(event: FireEvent, nowMs: number): void {
      const record = shotRecordFor(event, nowMs);
      if (record) shots.push(record);
    },
    confirm(impacts: readonly ProjectileImpact[], nowMs: number): void {
      for (const impact of impacts) {
        // ProjectileImpactReason.Direct is the sim's own verdict that the swept segment struck
        // a valid player target (types.ts's enum comment; findDirectHit/resolveLinearHit in
        // projectiles.ts) -- World, Bounce and Timeout are terrain, a ricochet and a lifetime
        // removal. That is the "did it land on a player" half of the question; who fired the
        // shot is the half this file's geometry answers.
        if (impact.reason !== ProjectileImpactReason.Direct) continue;
        const index = shots.findIndex((shot) => shotAccountsFor(shot, impact, nowMs));
        if (index < 0) continue;
        shots.splice(index, 1);
        sink.hitSound();
        sink.hitMarker(nowMs);
      }
      for (let i = shots.length - 1; i >= 0; i -= 1) {
        if (nowMs > shots[i]!.expiresAtMs) shots.splice(i, 1);
      }
    },
  };
}
