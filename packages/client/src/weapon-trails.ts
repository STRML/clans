import {
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  type ProjectileImpact,
} from '@clans/sim';

// Shot cues: what the local player should be told about a shot the moment it lands, as opposed
// to what the world renders of it (weapons-view.ts, which draws the disc's interpolated flight,
// the detonation and the launch flash). Audio is the same split and lands in audio.ts.
//
// The impact record itself carries no shooter: ProjectileImpact is position, weaponId, type,
// reason and seq (sim/types.ts), and the wire's payload is the same five fields (#52) -- so
// every filter below has to be judged from the OBSERVER's own pose. For the local player's own
// disc that is exactly "within range of the shooter", and for someone else's it is the other
// half of the same cue: a disc landing this close is aimed at you or at whatever you are
// standing next to, and either way "where did that land" is the question it answers.

/** How close to the local player an impact has to land to be worth pointing at. Ours: the
 *  Spinfusor's own blast radius is 7.5 m and the Mortar's 20 m (WEAPON_DATA, weapons.ts), so 25
 *  m is "close enough to be about you or about something you are looking at" -- past it the cue
 *  stops being information and becomes a permanent distraction, since a 31-bot match lands
 *  discs somewhere within a few hundred metres every couple of seconds. */
export const SPAWN_INDICATOR_RADIUS_M = 25;
/** How long one cue lives. Ours: long enough to read a cue that landed outside the centre of
 *  the screen, short enough that it cannot still be on screen when the next disc from the same
 *  weapon lands -- the Spinfusor's fireTime is 1.25 s (WEAPON_DATA), so a cue that outlived
 *  1.2 s would stack two of them on the same spot. */
export const SPAWN_INDICATOR_LIFETIME_MS = 1200;

/** The local player's own pose, the frame every cue is measured in: the feet position the
 *  camera sits above and the look yaw app.ts's aimCamera turns into Three's rotation.y = yaw +
 *  PI. Structurally the same shape remote.ts's RemotePose hands out, so a caller holding one
 *  buffer per player passes the local one unchanged. `yaw` is not wrapped (input.ts accumulates
 *  it), which the trigonometry below does not care about. */
export interface LocalPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** One live "that disc landed over there" cue. The bearing is measured once, at the moment the
 *  impact arrives, on purpose: a cue that re-aimed itself from a live yaw would swing around the
 *  screen while the player turns to look at it, which is the opposite of a marker that fades
 *  where it was put. The impact's world position is kept alongside it so a caller that wants to
 *  keep drawing it (a world-space tracer, a debug overlay) does not have to keep the record. */
export interface SpawnIndicator {
  x: number;
  y: number;
  z: number;
  /** Bearing from the local player to the contact point, relative to where the player was
   *  facing when it landed: radians in [-PI, PI], 0 dead ahead, +PI/2 to the player's right
   *  (the sign convention is CSS's, so a caller places it with `rotate(${bearing}rad)` on a ring
   *  whose 0 is up). */
  bearing: number;
  /** Metres from the player's feet to the contact point, as of the landing. */
  distance: number;
  /** Caller-clock ms this cue expires. */
  expiresAtMs: number;
  /** 1 on the landing frame, ramping linearly to 0 at the lifetime's end. */
  strength: number;
}

/** Bearing to a point, relative to where `pose` faces. Forward is (sin yaw, 0, cos yaw) and
 *  right is (-cos yaw, 0, sin yaw) (movement.ts's own derivation: forward x up), so the bearing
 *  is atan2 of the offset's right and forward components -- 0 dead ahead, +PI/2 to the right,
 *  +/-PI directly behind. */
export function relativeBearing(pose: LocalPose, x: number, z: number): number {
  const sin = Math.sin(pose.yaw);
  const cos = Math.cos(pose.yaw);
  const dx = x - pose.x;
  const dz = z - pose.z;
  const forward = dx * sin + dz * cos;
  const right = dz * sin - dx * cos;
  return Math.atan2(right, forward);
}

/** The cue one impact record deserves, or null for every impact it does not. A pure function:
 *  the same record, pose and clock always give the same answer, which is what makes the radius
 *  and bearing arithmetic testable without a scene or a socket. */
export function spawnIndicatorFor(
  impact: ProjectileImpact,
  pose: LocalPose,
  nowMs: number,
): SpawnIndicator | null {
  // The Spinfusor's own projectile, which both halves of the filter name: a weaponId offset by
  // the turret barrel (+100) or the Shrike's blaster (+150, projectiles.ts) is somebody else's
  // gun and not the disc this cue is about.
  if (impact.weaponId !== WeaponId.Spinfusor || impact.type !== ProjectileType.Linear) return null;
  // The two reasons impactEffectFor detonates for: a Direct or World stop is where the disc
  // ended, while a Bounce keeps flying (and a disc has no elasticity to bounce with anyway) and
  // a Timeout is the silent lifetime removal that never draws an explosion to point at.
  if (
    impact.reason !== ProjectileImpactReason.Direct &&
    impact.reason !== ProjectileImpactReason.World
  )
    return null;
  const dx = impact.x - pose.x;
  const dy = impact.y - pose.y;
  const dz = impact.z - pose.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > SPAWN_INDICATOR_RADIUS_M) return null;
  return {
    x: impact.x,
    y: impact.y,
    z: impact.z,
    bearing: relativeBearing(pose, impact.x, impact.z),
    distance,
    expiresAtMs: nowMs + SPAWN_INDICATOR_LIFETIME_MS,
    strength: 1,
  };
}

/** Folds one frame's authoritative impact records into the live cue list: appends a cue for
 *  every record `spawnIndicatorFor` accepts, ages the rest and drops the expired. Mutates in
 *  place the way weapons-view.ts's `spawnProjectileImpacts` pushes into the caller's effects
 *  array -- the list is the caller's own, so a caller that never wants cues simply never calls
 *  this. `impacts` must be the same exactly-once record stream the visual FX and the audio use
 *  (networked: the drained event stream; solo: world.projectiles.lastImpacts per tick), so a cue
 *  and the explosion it points at cannot disagree about how many discs landed. */
export function syncSpawnIndicators(
  indicators: SpawnIndicator[],
  impacts: readonly ProjectileImpact[],
  pose: LocalPose,
  nowMs: number,
): void {
  for (const impact of impacts) {
    const indicator = spawnIndicatorFor(impact, pose, nowMs);
    if (indicator) indicators.push(indicator);
  }
  let live = 0;
  for (const indicator of indicators) {
    indicator.strength = Math.max(0, indicator.expiresAtMs - nowMs) / SPAWN_INDICATOR_LIFETIME_MS;
    if (indicator.strength > 0) indicators[live++] = indicator;
  }
  indicators.length = live;
}

/** The ring the cues draw on: one full-screen container around the screen centre whose children
 *  are rotated by each cue's bearing (0 = up = dead ahead, positive clockwise to the player's
 *  right, CSS's own convention). `#spawn-indicator-ring` styles itself entirely in hud.css; the
 *  per-cue child is a wedge positioned by `renderSpawnIndicators`, which owns every style write
 *  so the DOM shape and the sync loop above stay one system. */
export function createSpawnIndicatorLayer(): HTMLDivElement {
  const layer = document.createElement('div');
  layer.id = 'spawn-indicator-ring';
  return layer;
}

/** One cue, drawn: reuse children by index (the same pooling every view sync here uses) so a
 *  frame that adds or drops cues never churns nodes. Position comes from the bearing, weight
 *  from the strength ramp; a cue the player has turned to face is still drawn at the bearing it
 *  was born with, exactly as spawnIndicatorFor decided. */
export function renderSpawnIndicators(layer: HTMLElement, indicators: SpawnIndicator[]): void {
  while (layer.childElementCount < indicators.length) {
    const cue = document.createElement('div');
    cue.className = 'spawn-indicator-cue';
    layer.appendChild(cue);
  }
  for (let i = layer.childElementCount - 1; i >= indicators.length; i -= 1) {
    layer.children[i]?.remove();
  }
  for (let i = 0; i < indicators.length; i += 1) {
    const cue = indicators[i]!;
    const el = layer.children[i] as HTMLElement | undefined;
    if (!el) break;
    el.style.transform = `rotate(${cue.bearing}rad)`;
    el.style.opacity = cue.strength.toFixed(3);
    el.setAttribute('aria-hidden', 'true');
  }
}
