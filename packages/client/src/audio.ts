import {
  ArmorId,
  ProjectileImpactReason,
  ProjectileType,
  TURRET_WEAPON_ID_OFFSET,
  TurretBarrelId,
  VEHICLE_WEAPON_DATA,
  VEHICLE_WEAPON_ID_OFFSET,
  WeaponId,
  WeaponState,
  type ProjectileImpact,
  type Vec3,
  type VehicleWeaponId,
} from '@clans/sim';

// T2 AudioProfile volume is 1.0. This only leaves mix headroom.
export const AUDIO_MASTER_GAIN = 0.6;
export const FOOTSTEP_INTERVAL_S = 0.35;
/** Issue #56: how far a positioned cue drops when terrain blocks its straight path to the
 *  listener. Ours -- the t2-mapper volume ships no occlusion profile; turrets and repair
 *  already treat terrain LOS as the occluder of record (hasLineOfSight), so audio uses the
 *  same answer instead of a second geometry model. */
export const OCCLUSION_ATTENUATION = 0.3;
/** Issue #57: the Spinfusor's launch, and why the local gunshot needs its own mix path.
 *
 *  Two defects, both measured here rather than assumed.
 *
 *  1. `play` never connected the one-shot's source into its gain (see the edge it now makes).
 *     Every cue that goes through it -- all five weapons' fire, footsteps, skis, flag cues,
 *     impacts, explosions, station cues, voices -- was created, given a buffer, started, and
 *     never heard. Only `loop` connected, so the cues that DID play were the loops: the jet,
 *     the repair beam, station/generator hums, engines, and every projectile's flight loop.
 *     A disc launch therefore sounded like its own flight whoosh with no front to it, which
 *     is exactly how the Spinfusor was reported. The suite missed it because it asserts node
 *     counts, gain values and the recording each cue chose -- never the source->gain edge.
 *  2. With the edge restored, the disc's flight loop is the one cue that can still bury the
 *     launch, and it is the worst case in the set for it. Committed recordings, measured with
 *     `ffmpeg -af volumedetect` (mean_volume, dBFS):
 *
 *         spinfusor-fire.m4a       -12.0     spinfusor-projectile.m4a   -10.1
 *         blaster-fire.m4a         -14.6     blaster-projectile.m4a     -17.9
 *         chaingun-fire.m4a         -8.4     chaingun-projectile.m4a    -15.6
 *         mortar-fire.m4a           -10.2    mortar-projectile.m4a      -12.5
 *
 *     The disc's loop is the hottest sample the game ships and the disc is its slowest
 *     projectile, so PROJECTILE's own 5 m minDistance holds that loop at full mix level from
 *     the instant it leaves the muzzle -- 2 dB above the launch's own mean, sustained for the
 *     whole flight. No other weapon has that shape; the Blaster's loop is 7.8 dB quieter than
 *     the Spinfusor's and sits 3.3 dB under its own launch.
 *
 *  So: the local player's own shot is mixed as a first-person cue (SELF_FIRE_*), and the
 *  flight loops a launch leaves behind duck under it for its launch window (LAUNCH_DUCK_*). */
/** Full mix level for the local player's own gunshot. `weaponFire` is that gun by contract
 *  (app.ts's playWeaponFireAudio drops every other player's fire events), and the camera sits
 *  at the player's eye while the sim's muzzle sits at MUZZLE_HEIGHT (weapons.ts: 1.6 m), so a
 *  self shot originates ~0.4 m from the listener. It plays unpositioned and un-occluded, the
 *  same rule the jet loop, the repair beam and the Chaingun's state cues already follow: a
 *  shot leaving your own muzzle is not a world cue, and mixing it as one let #56's
 *  terrain/interior LOS test duck it by OCCLUSION_ATTENUATION (-10.5 dB) for the whole shot. */
export const SELF_FIRE_GAIN = 1;
/** The launch punch, as an envelope on top of the recording's own attack: 4 ms to
 *  SELF_FIRE_GAIN, then a 60 ms glide to SELF_FIRE_SUSTAIN. `spinfusor-fire.m4a` is already a
 *  hard transient (peak -3.6 dB at 20 ms, -3.8 dB at 40 ms, -20 dB by 740 ms), so the
 *  envelope's job is not to create the punch but to keep that 20 ms front above the body the
 *  flight loop used to bury: the attack skips the codec's leading pre-echo, and the sustain
 *  drops the remaining ~1 s of body to 55% (-5.2 dB) instead of sitting flat at full level. */
export const SELF_FIRE_ATTACK_S = 0.004;
export const SELF_FIRE_SUSTAIN = 0.55;
export const SELF_FIRE_DECAY_S = 0.06;
/** How close to the listener a shot must originate to count as the listener's own gun. The
 *  eye-to-muzzle offset is 0.4 m; the margin covers a fire event recorded on an earlier
 *  simulated tick than the frame that plays it (two ticks at the sim's top speed is ~2.8 m).
 *  A cue the listener's own position cannot account for keeps the world mix -- falloff,
 *  occlusion, panning -- which is the conservative answer and the one #56's tests pin. */
export const SELF_FIRE_RADIUS_M = 3;
/** How long a launch owns the muzzle, and how far under the launch the flight loops it
 *  started are held for that window. -9.1 dB keeps the launch transient ~15 dB above its own
 *  whoosh while it plays, and is short enough that the whoosh is back at full level by the
 *  time the disc is 4-5 m out -- which is the sound of the disc leaving. */
export const LAUNCH_DUCK_S = 0.18;
export const LAUNCH_DUCK_FACTOR = 0.35;
/** The loop-key prefix setProjectileSound builds. The launch duck's scope: a projectile's
 *  flight loop is the one cue that can bury the shot that launched it. */
const PROJECTILE_LOOP_PREFIX = 'projectile:';

interface AudioLike {
  position?: Vec3;
  /** Issue #56: optional terrain-occlusion test for positioned cues, supplied by the app
   *  (world + camera). Absent (tests, headless callers), nothing is ever occluded. */
  occlusionAt?(position: Vec3): boolean;
  context: Pick<
    AudioContext,
    | 'currentTime'
    | 'destination'
    | 'createGain'
    | 'createBufferSource'
    | 'createPanner'
    | 'decodeAudioData'
    | 'listener'
    | 'resume'
    | 'close'
    | 'state'
  >;
}
interface Loop {
  setLevel?(level: number): void;
  /** Issue #56: repositions the loop's panner as its source moves. A hum whose base object
   *  never moves is not called again; vehicle engines are, every frame. */
  setPosition?(position: Vec3): void;
  stop(): void;
}
type SoundId =
  | 'armor-thrust'
  | 'armor-ski-soft'
  | 'armor-footstep'
  | 'medium-footstep'
  | 'medium-footstep-metal'
  | 'heavy-footstep'
  | 'heavy-footstep-metal'
  | 'station-hum'
  | 'generator-hum'
  | 'inventory-pad-on'
  | 'vehicle-screen-on'
  | 'vehicle-screen-off'
  | 'station-denied'
  | 'turret-sentry-impact'
  | 'turret-plasma-impact'
  | 'spinfusor-fire'
  | 'chaingun-fire'
  | 'chaingun-activate'
  | 'chaingun-spinup'
  | 'chaingun-spindown'
  | 'mortar-fire'
  | 'sniper-fire'
  | 'blaster-fire'
  | 'mortar-explode'
  | 'grenade-explode'
  | 'spinfusor-impact'
  | 'spinfusor-projectile'
  | 'mortar-projectile'
  | 'blaster-impact'
  | 'blaster-projectile'
  | 'chaingun-impact'
  | 'chaingun-projectile'
  | 'sniper-impact'
  | 'shrike-blaster-projectile'
  | 'vehicle-explosion'
  | 'flag-capture'
  | 'flag-snatch'
  | 'flag-drop'
  | 'flag-taken'
  | 'flag-lost'
  | 'flag-return'
  | 'outrider-engine'
  | 'shrike-engine'
  | 'shrike-blaster'
  // Issue #51: the Repair Pack's own two recordings. `repair-beam` is the beam loop --
  // repairpack.cs's RepairPackFireSound (`fx/packs/repair_use`, CloseLooping3d) on the repair
  // gun's Repair state (`stateSound[4]`) -- and `repair-activate` is the pack Activate state's
  // one-shot (RepairPackActivateSound, `fx/packs/packs.repairPackOn`, `stateSound[1]`). Both
  // are committed in packages/assets/src/audio-sources.ts under these exact names.
  | 'repair-beam'
  | 'repair-activate'
  | 'voice-target-destroyed'
  | 'voice-flag-take'
  | 'voice-thanks'
  | 'voice-defend-flag'
  | 'voice-repair-me'
  | 'voice-enemy-warning'
  | 'voice-yes'
  | 'voice-no'
  | 'voice-nice';

/** Original audio.vl2 samples copied by packages/assets. Exported so the test suite can pin
 *  every cue to the file packages/assets/src/audio-sources.ts must publish under
 *  `<BASE_URL>katabatic/audio/` -- a cue whose file is not in that manifest is silent, which
 *  is exactly how the repair beam stayed mute (issue #51). */
export const SOUND_FILE: Record<SoundId, string> = {
  'armor-thrust': 'armor-thrust.m4a',
  'armor-ski-soft': 'armor-ski-soft.m4a',
  'armor-footstep': 'armor-footstep.m4a',
  'medium-footstep': 'medium-footstep.m4a',
  'medium-footstep-metal': 'medium-footstep-metal.m4a',
  'heavy-footstep': 'heavy-footstep.m4a',
  'heavy-footstep-metal': 'heavy-footstep-metal.m4a',
  'station-hum': 'station-hum.m4a',
  'generator-hum': 'generator-hum.m4a',
  'inventory-pad-on': 'inventory-pad-on.m4a',
  'vehicle-screen-on': 'vehicle-screen-on.m4a',
  'vehicle-screen-off': 'vehicle-screen-off.m4a',
  'station-denied': 'station-denied.m4a',
  'turret-sentry-impact': 'turret-sentry-impact.m4a',
  'turret-plasma-impact': 'turret-plasma-impact.m4a',
  'spinfusor-fire': 'spinfusor-fire.m4a',
  'chaingun-fire': 'chaingun-fire.m4a',
  'chaingun-activate': 'chaingun-activate.m4a',
  'chaingun-spinup': 'chaingun-spinup.m4a',
  'chaingun-spindown': 'chaingun-spindown.m4a',
  'mortar-fire': 'mortar-fire.m4a',
  'sniper-fire': 'sniper-fire.m4a',
  'blaster-fire': 'blaster-fire.m4a',
  'mortar-explode': 'mortar-explode.m4a',
  'grenade-explode': 'grenade-explode.m4a',
  'spinfusor-impact': 'spinfusor-impact.m4a',
  'spinfusor-projectile': 'spinfusor-projectile.m4a',
  'mortar-projectile': 'mortar-projectile.m4a',
  'blaster-impact': 'blaster-impact.m4a',
  'blaster-projectile': 'blaster-projectile.m4a',
  'repair-beam': 'repair-beam.m4a',
  'repair-activate': 'repair-activate.m4a',
  'chaingun-impact': 'chaingun-impact.m4a',
  'chaingun-projectile': 'chaingun-projectile.m4a',
  'sniper-impact': 'sniper-impact.m4a',
  'shrike-blaster-projectile': 'shrike-blaster-projectile.m4a',
  'vehicle-explosion': 'vehicle-explosion.m4a',
  'flag-capture': 'flag-capture.m4a',
  'flag-snatch': 'flag-snatch.m4a',
  'flag-drop': 'flag-drop.m4a',
  'flag-taken': 'flag-taken.m4a',
  'flag-lost': 'flag-lost.m4a',
  'flag-return': 'flag-return.m4a',
  'outrider-engine': 'outrider-engine.m4a',
  'shrike-engine': 'shrike-engine.m4a',
  'shrike-blaster': 'shrike-blaster.m4a',
  'voice-target-destroyed': 'voice-target-destroyed.m4a',
  'voice-flag-take': 'voice-flag-take.m4a',
  'voice-thanks': 'voice-thanks.m4a',
  'voice-defend-flag': 'voice-defend-flag.m4a',
  'voice-repair-me': 'voice-repair-me.m4a',
  'voice-enemy-warning': 'voice-enemy-warning.m4a',
  'voice-yes': 'voice-yes.m4a',
  'voice-no': 'voice-no.m4a',
  'voice-nice': 'voice-nice.m4a',
};
const VOICE_SOUND: readonly SoundId[] = [
  'voice-target-destroyed',
  'voice-flag-take',
  'voice-thanks',
  'voice-defend-flag',
  'voice-repair-me',
  'voice-enemy-warning',
  'voice-yes',
  'voice-no',
  'voice-nice',
];
interface Profile {
  minDistance: number;
  maxDistance: number;
}
const CLOSE: Profile = { minDistance: 10, maxDistance: 50 };
const CLOSEST: Profile = { minDistance: 5, maxDistance: 30 };
const DEFAULT: Profile = { minDistance: 20, maxDistance: 100 };
const EXPLOSION: Profile = { minDistance: 50, maxDistance: 250 };
const WEAPON_EXPLOSION: Profile = { minDistance: 20, maxDistance: 150 };
const PROJECTILE: Profile = { minDistance: 5, maxDistance: 20 };
const WEAPON_PROFILE: Partial<Record<WeaponId, [SoundId, Profile]>> = {
  [WeaponId.Spinfusor]: ['spinfusor-fire', DEFAULT],
  [WeaponId.Chaingun]: ['chaingun-fire', DEFAULT],
  [WeaponId.Mortar]: ['mortar-fire', DEFAULT],
  [WeaponId.LaserRifle]: ['sniper-fire', CLOSE],
  [WeaponId.Blaster]: ['blaster-fire', DEFAULT],
};
const WEAPON_IMPACT: Partial<Record<WeaponId, [SoundId, Profile]>> = {
  [WeaponId.Spinfusor]: ['spinfusor-impact', WEAPON_EXPLOSION],
  [WeaponId.Chaingun]: ['chaingun-impact', CLOSEST],
  [WeaponId.Mortar]: ['mortar-explode', EXPLOSION],
  [WeaponId.LaserRifle]: ['sniper-impact', CLOSEST],
  [WeaponId.Blaster]: ['blaster-impact', CLOSEST],
};
/** Issue #56 Chaingun state cues. The base script hangs its own recording on each image state
 *  -- chaingun.cs's ChaingunSwitchSound on Activate, ChaingunSpinupSound on Spinup and
 *  ChaingunSpinDownSound on Spindown/EmptySpindown -- and all three are committed in
 *  audio-sources.ts. The sim keeps a WeaponState, not a transition log, so setChaingunState
 *  edge-detects these itself; Fire keeps playing the per-shot one-shot WEAPON_PROFILE maps,
 *  which is the recording's own type (AudioDefaultLooping3d) minus the continuous loop this
 *  milestone still does not drive. */
/** Issue #56 footstep variants. All three armour rows now resolve to that armour's own
 *  committed recordings -- `_soft` for terrain, `_metal` for interiors, the two T2 surface
 *  classes this game's FootstepSurface collapses to -- with the light row deliberately
 *  unchanged (light_LF_soft) so the approved feel of the default armour is untouched. This
 *  table is the whole variant policy: a surface class we do not distinguish would have to add
 *  its own row here, and a missing row would silence the cue -- never synthesize a
 *  substitute. */
export type FootstepSurface = 'terrain' | 'interior';
const FOOTSTEP_CUES: Record<ArmorId, Record<FootstepSurface, SoundId>> = {
  [ArmorId.Light]: { terrain: 'armor-footstep', interior: 'armor-footstep' },
  [ArmorId.Medium]: { terrain: 'medium-footstep', interior: 'medium-footstep-metal' },
  [ArmorId.Heavy]: { terrain: 'heavy-footstep', interior: 'heavy-footstep-metal' },
};
/** The footstep sample for an armor/surface pair: each armour's own two committed recordings
 *  (see FOOTSTEP_CUES). */
export function footstepCue(armor: ArmorId, surface: FootstepSurface): SoundId {
  return FOOTSTEP_CUES[armor][surface];
}
/** Base turrets fire with a barrel id offset out of WEAPON_DATA's range (projectiles.ts's
 *  TURRET_WEAPON_ID_OFFSET), so their detonations need this table instead of WEAPON_IMPACT.
 *  Each row is the recording the barrel's own script hangs on its projectile explosion, with
 *  the profile its AudioProfile description names: SentryTurretExpSound is AudioClosest3d
 *  (sentryTurret.cs:32-36), PlasmaBarrelExpSound is AudioExplosion3d
 *  (plasmaBarrelLarge.cs:44-48), and the AA barrel declares no recording of its own --
 *  aaBarrelLarge.cs:121 reuses the Blaster's `blasterExpSound` ->
 *  `fx/weapons/blaster_impact.wav` (blaster.cs:48-51). */
const TURRET_IMPACT: Partial<Record<number, [SoundId, Profile]>> = {
  [TurretBarrelId.PlasmaBarrelLarge]: ['turret-plasma-impact', EXPLOSION],
  [TurretBarrelId.AABarrelLarge]: ['blaster-impact', CLOSEST],
  [TurretBarrelId.SentryTurretBarrel]: ['turret-sentry-impact', CLOSEST],
};
/** Issue #52 residual: the one audio cue an authoritative impact record deserves, keyed on
 *  the record's own weapon and reason -- the exact semantics impactEffectFor renders
 *  visually, so what you hear always agrees with what you see:
 *
 *  - Timeout is NOT an impact: a Linear/Tracer/Energy shot expiring at end of lifetime is
 *    silent -- the #52 rule that stopped lifetime removals looking like strikes. Only an
 *    armed grenade's lifetime expiry really detonates (finalizeGrenadeLifetime), so only a
 *    Grenade-type Timeout gets the explosion.
 *  - A Grenade-type record is an explosive body. Mortar shells are grenade-type with their
 *    own WEAPON_IMPACT row (its EXPLOSION audible range with it); any other grenade is an
 *    alt-fire throw riding the firing weapon's id -- playing THAT weapon's impact sample
 *    would pass a disc/bullet detonation off as the grenade's -- so it gets the hand
 *    grenade's own recording, `fx/weapons/grenade_explode` (GrenadeExplosionSound,
 *    grenadeLauncher.cs:77-83, which HandGrenadeExplosion carries as its soundProfile,
 *    grenade.cs:180), at the generic weapon-explosion range.
 *  - VehicleLaser records carry the Shrike's offset weapon id (150, no WEAPON_DATA row, so
 *    no impact recording); the handheld Blaster bolt's impact sample stands in, the same
 *    mapping the old disappearance path used.
 *  - Turret shots carry their barrel ids at TURRET_WEAPON_ID_OFFSET and resolve through
 *    TURRET_IMPACT; a barrel with no committed recording stays silent rather than inventing
 *    one.
 *
 *  A bounce is a real contact, so it plays the weapon's own impact sample (no dedicated
 *  ricochet recording is committed) while the projectile keeps flying. */
export function projectileImpactCue(
  impact: ProjectileImpact,
): { sound: SoundId; profile: Profile } | null {
  if (impact.reason === ProjectileImpactReason.Timeout && impact.type !== ProjectileType.Grenade) {
    return null;
  }
  if (impact.type === ProjectileType.Grenade) {
    return impact.weaponId === WeaponId.Mortar
      ? { sound: 'mortar-explode', profile: EXPLOSION }
      : { sound: 'grenade-explode', profile: WEAPON_EXPLOSION };
  }
  const sound = impactSoundFor(impact);
  return sound ? { sound: sound[0], profile: sound[1] } : null;
}

/** The impact recording for an impact's stored weapon id, or undefined when no table claims
 *  it. `weaponId` rides the wire raw: turret barrels sit at `TURRET_WEAPON_ID_OFFSET`, vehicle
 *  weapons one range above that at `VEHICLE_WEAPON_ID_OFFSET`, and the Shrike's own bolt is
 *  handled by type before this because it has no handheld counterpart to borrow from.
 *
 *  The vehicle range is bounded by its own table rather than by `>= offset` alone: the offsets
 *  are append-only (vehicles.ts), so a raw id can be one this client has no row for, and an id
 *  above the last row has no recording. Borrowing the chaingun's sample for it is what a
 *  `>= offset` test does, and it makes every unknown id sound like a gun round. */
function impactSoundFor(impact: ProjectileImpact): readonly [SoundId, Profile] | undefined {
  if (impact.type === ProjectileType.VehicleLaser) return WEAPON_IMPACT[WeaponId.Blaster];
  if (impact.weaponId >= VEHICLE_WEAPON_ID_OFFSET) {
    // Vehicle-fired gun rounds (the Tank's AssaultChaingun, the Bomber's fusion bolt) reuse
    // the handheld Chaingun's own impact recording: the Tank's round IS the chaingun family
    // (vehicle_tank.cs:361's TracerProjectileData), and the Bomber's bolt
    // (vehicle_bomber.cs:412 `sound = BlasterProjectileSound`) is close enough to the Blaster
    // that either sample reads correctly. Vehicle ordnance (the mortar, the bombs) never
    // reaches here -- Grenade-type records were resolved above.
    const row =
      VEHICLE_WEAPON_DATA[(impact.weaponId - VEHICLE_WEAPON_ID_OFFSET) as VehicleWeaponId];
    return row ? WEAPON_IMPACT[WeaponId.Chaingun] : undefined;
  }
  if (impact.weaponId >= TURRET_WEAPON_ID_OFFSET) {
    return TURRET_IMPACT[impact.weaponId - TURRET_WEAPON_ID_OFFSET];
  }
  return WEAPON_IMPACT[impact.weaponId as WeaponId];
}

function levelAt(ear: Vec3 | undefined, position: Vec3 | undefined, profile: Profile): number {
  if (!ear || !position) return 1;
  const d = Math.hypot(position.x - ear.x, position.y - ear.y, position.z - ear.z);
  if (d >= profile.maxDistance) return 0;
  return d <= profile.minDistance
    ? 1
    : 1 - (d - profile.minDistance) / (profile.maxDistance - profile.minDistance);
}

export interface AudioEngine {
  weaponFire(weaponId: WeaponId, position: Vec3): void;
  /** Issue #56 Chaingun state cues. The sim exposes weaponSlot/weaponState, not the state
   *  transitions the T2 image has, so this edge-detects them: the mount one-shot when the
   *  slot becomes the Chaingun, spin-up on entering SpinUp, spin-down on leaving
   *  SpinUp/Firing. Cues are keyed per player because the engine, like setSkiing, owns the
   *  edge state across frames. */
  setChaingunState(id: number, slot: number, state: WeaponState): void;
  /** Issue #52 residual: the authoritative impact record's own cue, selected per weapon and
   *  reason by projectileImpactCue. Exactly-once is the caller's contract -- the same one
   *  spawnProjectileImpacts documents for the visual path. */
  projectileImpact(impact: ProjectileImpact): void;
  setProjectileSound(
    id: number,
    weaponId: number,
    type: number,
    position: Vec3,
    active: boolean,
  ): void;
  vehicleExplosion(position: Vec3): void;
  flagCapture(enemyCaptured?: boolean): void;
  flagTouch(enemyTookOwnFlag?: boolean): void;
  flagDrop(): void;
  flagReturn(): void;
  setJetting(playerId: number, active: boolean, energyFraction: number): void;
  setSkiing(playerId: number, active: boolean, speed: number): void;
  footstep(position: Vec3, variant?: { armor?: ArmorId; surface?: FootstepSurface }): void;
  /** Issue #51: the local Repair Pack's beam loop, keyed per player exactly like the jet
   *  loop. Start = the beam went live, stop = it released for any reason (release, occlusion,
   *  range, depletion, death, menu), so the audio cue tracks the beam's lifecycle 1:1. */
  setRepairBeam(id: number, active: boolean): void;
  /** Issue #51: the pack's own Activate recording (RepairPackImage's stateSound[1]), which
   *  fires on the toggle that mounts the repair gun -- a different moment from the beam going
   *  live, so a menu opening or a drained pool (both of which stop the beam) must not replay
   *  it. Rising-edge only, like setSkiing. */
  setRepairPack(id: number, active: boolean): void;
  setStationHum(id: number, position: Vec3, active: boolean): void;
  setGeneratorHum(id: number, position: Vec3, active: boolean): void;
  setVehicleEngine(id: number, kind: 'wildcat' | 'shrike', position: Vec3, active: boolean): void;
  /** Issue #56: feeds the Web Audio listener's position/orientation every frame so the
   *  panner graph can directionalize positioned cues. Camera frame state, not sim state. */
  updateListener(position: Vec3, forward: Vec3, up: Vec3): void;
  stationActivate(kind: 'inventory' | 'vehicle', position?: Vec3): void;
  stationDeactivate(position?: Vec3): void;
  stationDenied(position?: Vec3): void;
  vehicleWeaponFire(kind: 'shrike', position: Vec3): void;
  voice(lineId: number): void;
  resume(): void;
  dispose(): void;
}

function setLoop(loops: Map<string, Loop>, key: string, active: boolean, start: () => Loop): void {
  if (!active) {
    loops.get(key)?.stop();
    loops.delete(key);
  } else if (!loops.has(key)) loops.set(key, start());
}

export function createAudioEngine(listener: AudioLike): AudioEngine {
  const { context } = listener;
  const master = context.createGain() as GainNode;
  master.gain.value = AUDIO_MASTER_GAIN;
  master.connect(context.destination);
  const loops = new Map<string, Loop>();
  const skiing = new Set<number>();
  const armedPacks = new Set<number>();
  const chaingunStates = new Map<number, { slot: number; state: WeaponState }>();
  const oneShots = new Set<AudioBufferSourceNode>();
  const buffers = new Map<SoundId, AudioBuffer>();
  const loads = new Map<SoundId, Promise<void>>();
  const warned = new Set<SoundId>();
  let disposed = false;
  /** `context.currentTime` a launch owns the muzzle until (LAUNCH_DUCK_S). */
  let launchUntil = 0;
  if (typeof fetch === 'function' && context.decodeAudioData) {
    for (const [id, file] of Object.entries(SOUND_FILE) as Array<[SoundId, string]>) {
      const load = fetch(`${import.meta.env.BASE_URL}katabatic/audio/${file}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
          return r.arrayBuffer();
        })
        .then((bytes) => context.decodeAudioData(bytes))
        .then((buffer) => {
          if (!disposed) buffers.set(id, buffer);
        })
        .catch((error: unknown) => {
          if (!warned.has(id)) {
            warned.add(id);
            console.warn(`Unable to load T2 audio sample ${file}`, error);
          }
        });
      loads.set(id, load);
    }
  }
  /** Final mix level of a cue: distance falloff (levelAt) times #56's terrain-occlusion
   *  factor. Unpositioned cues (voices, flag cues, the local player's own jet/repair loops)
   *  are never occluded and keep their exact approved level. */
  const audibleLevel = (position: Vec3 | undefined, profile: Profile): number => {
    const level = levelAt(listener.position, position, profile);
    if (level === 0 || !position || !listener.occlusionAt) return level;
    return listener.occlusionAt(position) ? level * OCCLUSION_ATTENUATION : level;
  };
  /** Wires a cue's gain into the master chain. Issue #56: a positioned cue routes through an
   *  equalpower panner so it plays in its own direction. The panner's distance model is
   *  neutralized (rolloffFactor 0) because levelAt already applies the source distance
   *  profiles in the gain node -- the approved mix level is untouched; only direction is
   *  new. Returns the panner, when one was created, for the owner to disconnect. */
  const connectOutput = (
    node: GainNode,
    position: Vec3 | undefined,
    profile: Profile,
  ): PannerNode | undefined => {
    if (!position) {
      node.connect(master);
      return undefined;
    }
    const panner = context.createPanner() as PannerNode;
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'linear';
    panner.refDistance = profile.minDistance;
    panner.maxDistance = profile.maxDistance;
    panner.rolloffFactor = 0;
    panner.setPosition(position.x, position.y, position.z);
    node.connect(panner).connect(master);
    return panner;
  };
  /** Starts a one-shot and owns its teardown: tracked in `oneShots` so dispose stops it,
   *  disconnected once it ends (a sustained weapons exchange otherwise leaks a source/gain
   *  pair per shot), with `extra` releasing whatever else the cue's own graph added. */
  const startOneShot = (
    source: AudioBufferSourceNode,
    gain: GainNode,
    extra?: PannerNode,
  ): void => {
    oneShots.add(source);
    source.onended = () => {
      oneShots.delete(source);
      source.disconnect();
      gain.disconnect();
      extra?.disconnect();
    };
    source.start();
  };
  const play = (id: SoundId, profile: Profile, position?: Vec3): void => {
    if (disposed) return;
    const buffer = buffers.get(id);
    const level = audibleLevel(position, profile);
    if (!buffer || level === 0) return;
    const source = context.createBufferSource() as AudioBufferSourceNode;
    const gain = context.createGain() as GainNode;
    source.buffer = buffer;
    gain.gain.value = level;
    // Issue #57: this edge is what an audible one-shot IS, and it was the one edge this file
    // never made -- see the block at the top of this module. `loop` below connects the same
    // way, which is why the cues you could hear before this fix were exactly the loops.
    source.connect(gain);
    startOneShot(source, gain, connectOutput(gain, position, profile));
  };
  /** The local player's own gunshot: unpositioned (no panner) and never occluded, like the
   *  jet/repair loops and the Chaingun's state cues, with the launch envelope the recording's
   *  own body needs to stay under its transient -- see SELF_FIRE_ATTACK_S. Registers the
   *  launch window that holds the flight loops it just started under it. */
  const playSelfFire = (id: SoundId): void => {
    if (disposed) return;
    const buffer = buffers.get(id);
    if (!buffer) return;
    const source = context.createBufferSource() as AudioBufferSourceNode;
    const gain = context.createGain() as GainNode;
    source.buffer = buffer;
    // The node's own value is the full launch level, so a context that ignores the automation
    // below still plays the launch at level rather than muting it; the automation is the punch
    // on top. The test fake reads this field, so the level assertions stay meaningful.
    gain.gain.value = SELF_FIRE_GAIN;
    const at = context.currentTime;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(SELF_FIRE_GAIN, at + SELF_FIRE_ATTACK_S);
    gain.gain.setTargetAtTime(
      SELF_FIRE_GAIN * SELF_FIRE_SUSTAIN,
      at + SELF_FIRE_ATTACK_S,
      SELF_FIRE_DECAY_S,
    );
    source.connect(gain).connect(master);
    launchUntil = at + LAUNCH_DUCK_S;
    startOneShot(source, gain);
  };
  /** `level` is passed explicitly by setSpatialLoop, which may hold a loop under the launch
   *  duck at the moment it is created; every other caller leaves the profile's own level. */
  const loop = (
    id: SoundId,
    profile: Profile,
    position?: Vec3,
    level = audibleLevel(position, profile),
  ): Loop => {
    if (disposed) return { stop: () => undefined };
    let source: AudioBufferSourceNode | undefined;
    let stopped = false;
    const gain = context.createGain() as GainNode;
    gain.gain.value = level;
    const panner = connectOutput(gain, position, profile);
    const start = (): void => {
      const buffer = buffers.get(id);
      if (!disposed && !stopped && !source && buffer) {
        source = context.createBufferSource() as AudioBufferSourceNode;
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start();
      }
    };
    start();
    // Decode completes once; a failed fetch remains silent rather than spinning forever.
    if (!source) void loads.get(id)?.then(start);
    return {
      setLevel: (level) => gain.gain.setTargetAtTime(level, context.currentTime, 0.1),
      setPosition: (p) => panner?.setPosition(p.x, p.y, p.z),
      stop: () => {
        stopped = true;
        source?.stop();
        source?.disconnect();
        gain.disconnect();
        panner?.disconnect();
      },
    };
  };
  /** Issue #57: the flight loops a launch leaves behind duck under it for LAUNCH_DUCK_S, so
   *  the launch has a front to be heard against. Scoped by loop key rather than by shooter --
   *  the engine has no shooter identity here, and the loops in flight when the local player
   *  fires are, in practice, the shot just launched: anything further out already sits below
   *  full level on PROJECTILE's own falloff. */
  const launchDucked = (key: string, level: number): number =>
    key.startsWith(PROJECTILE_LOOP_PREFIX) && context.currentTime < launchUntil
      ? level * LAUNCH_DUCK_FACTOR
      : level;
  const setSpatialLoop = (
    key: string,
    id: SoundId,
    profile: Profile,
    position: Vec3,
    active: boolean,
  ): void => {
    if (disposed) return;
    const level = launchDucked(key, audibleLevel(position, profile));
    setLoop(loops, key, active && level > 0, () => loop(id, profile, position, level));
    const live = loops.get(key);
    live?.setLevel?.(level);
    live?.setPosition?.(position);
  };
  /** Whether a cue fired at `position` is the listener's own gun. `weaponFire` is the local
   *  player's own gun by contract, and this game's camera sits at the player's eye while the
   *  sim's muzzle sits MUZZLE_HEIGHT (1.6 m) above the player's feet, so a self shot is ~0.4 m
   *  from the listener -- SELF_FIRE_RADIUS_M carries the reasoning for the margin. */
  const ownShot = (position: Vec3): boolean => {
    const ear = listener.position;
    if (!ear) return false;
    return (
      Math.hypot(position.x - ear.x, position.y - ear.y, position.z - ear.z) <= SELF_FIRE_RADIUS_M
    );
  };
  return {
    weaponFire: (weapon, position) => {
      const sound = WEAPON_PROFILE[weapon];
      if (!sound) return;
      if (ownShot(position)) playSelfFire(sound[0]);
      else play(sound[0], sound[1], position);
    },
    // The base script's own state sounds (chaingun.cs stateSound[0], [3], [5]/[6]). Mount and
    // spin cues are the local player's own weapon, so they play at full level like the jet and
    // repair loops rather than through a panner.
    setChaingunState: (id, slot, state) => {
      const previous = chaingunStates.get(id);
      chaingunStates.set(id, { slot, state });
      if (slot !== WeaponId.Chaingun) return;
      if (previous?.slot !== WeaponId.Chaingun) {
        play('chaingun-activate', CLOSEST);
        return;
      }
      if (state === WeaponState.SpinUp && previous.state !== WeaponState.SpinUp) {
        play('chaingun-spinup', CLOSEST);
        return;
      }
      // EmptySpindown carries the same recording as Spindown, so any exit from the spin
      // thread counts, ammo gone or not.
      const spun = previous.state === WeaponState.SpinUp || previous.state === WeaponState.Firing;
      const stillSpinning = state === WeaponState.SpinUp || state === WeaponState.Firing;
      if (spun && !stillSpinning) play('chaingun-spindown', CLOSEST);
    },
    projectileImpact: (impact) => {
      const cue = projectileImpactCue(impact);
      if (cue) play(cue.sound, cue.profile, { x: impact.x, y: impact.y, z: impact.z });
    },
    setProjectileSound: (id, weaponId, type, position, active) => {
      const sound =
        type === ProjectileType.VehicleLaser
          ? 'shrike-blaster-projectile'
          : weaponId === WeaponId.Spinfusor
            ? 'spinfusor-projectile'
            : weaponId === WeaponId.Mortar
              ? 'mortar-projectile'
              : weaponId === WeaponId.Blaster
                ? 'blaster-projectile'
                : weaponId === WeaponId.Chaingun
                  ? 'chaingun-projectile'
                  : undefined;
      if (sound)
        setSpatialLoop(
          `${PROJECTILE_LOOP_PREFIX}${String(id)}`,
          sound,
          PROJECTILE,
          position,
          active,
        );
    },
    vehicleExplosion: (position) => play('vehicle-explosion', EXPLOSION, position),
    flagCapture: (enemyCaptured = false) =>
      play(enemyCaptured ? 'flag-lost' : 'flag-capture', DEFAULT),
    flagTouch: (enemyTookOwnFlag = false) =>
      play(enemyTookOwnFlag ? 'flag-taken' : 'flag-snatch', DEFAULT),
    flagDrop: () => play('flag-drop', DEFAULT),
    flagReturn: () => play('flag-return', DEFAULT),
    setJetting: (id, active) =>
      setLoop(loops, `jet:${String(id)}`, active, () => loop('armor-thrust', CLOSE)),
    // ski_soft is AudioClose3d (not looping) in player.cs; never create a false noise bed.
    setSkiing: (id, active) => {
      if (active && !skiing.has(id)) {
        skiing.add(id);
        play('armor-ski-soft', CLOSE);
      } else if (!active) skiing.delete(id);
    },
    footstep: (position, variant) =>
      play(
        footstepCue(variant?.armor ?? ArmorId.Light, variant?.surface ?? 'terrain'),
        CLOSE,
        position,
      ),
    // Issue #51: the Repair Pack beam's loop, keyed per player like the jet loop and CLOSE
    // like it -- the local player's own beam sits at the listener. The recording is committed
    // as repair-beam.m4a (repairpack.cs's RepairPackFireSound); loop()'s pending-start queue
    // means a start before it decodes still fires once it lands, and a failed fetch would
    // leave a silent pending loop rather than a synthesized substitute.
    setRepairBeam: (id, active) =>
      setLoop(loops, `repair:${String(id)}`, active, () => loop('repair-beam', CLOSE)),
    setRepairPack: (id, active) => {
      if (active && !armedPacks.has(id)) {
        armedPacks.add(id);
        play('repair-activate', CLOSEST);
      } else if (!active) armedPacks.delete(id);
    },
    setStationHum: (id, position, active) =>
      setSpatialLoop(`station:${String(id)}`, 'station-hum', CLOSE, position, active),
    setGeneratorHum: (id, position, active) =>
      setSpatialLoop(`generator:${String(id)}`, 'generator-hum', DEFAULT, position, active),
    setVehicleEngine: (id, kind, position, active) =>
      setSpatialLoop(
        `vehicle:${String(id)}`,
        kind === 'wildcat' ? 'outrider-engine' : 'shrike-engine',
        DEFAULT,
        position,
        active,
      ),
    stationActivate: (kind, position) =>
      play(kind === 'inventory' ? 'inventory-pad-on' : 'vehicle-screen-on', CLOSE, position),
    stationDeactivate: (position) => play('vehicle-screen-off', CLOSE, position),
    stationDenied: (position) => play('station-denied', CLOSE, position),
    vehicleWeaponFire: (_kind, position) => play('shrike-blaster', DEFAULT, position),
    voice: (lineId) => {
      const sound = VOICE_SOUND[lineId];
      if (sound) play(sound, DEFAULT);
    },
    updateListener: (position, forward, up) => {
      // Legacy-but-universal listener API; absent in some test fakes, and `?.` matches this
      // file's own defensive style (context.resume?.()).
      const l = context.listener;
      if (!l) return;
      l.setPosition?.(position.x, position.y, position.z);
      l.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    },
    resume: () => {
      if (context.state === 'suspended') void context.resume?.();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const loop of loops.values()) loop.stop();
      loops.clear();
      skiing.clear();
      armedPacks.clear();
      chaingunStates.clear();
      for (const source of oneShots) source.stop();
      oneShots.clear();
      master.disconnect();
      if (context.state !== 'closed') void context.close?.();
    },
  };
}
