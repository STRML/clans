import {
  ArmorId,
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  type ProjectileImpact,
  type Vec3,
} from '@clans/sim';

// T2 AudioProfile volume is 1.0. This only leaves mix headroom.
export const AUDIO_MASTER_GAIN = 0.6;
export const FOOTSTEP_INTERVAL_S = 0.35;
/** Issue #56: how far a positioned cue drops when terrain blocks its straight path to the
 *  listener. Ours -- the t2-mapper volume ships no occlusion profile; turrets and repair
 *  already treat terrain LOS as the occluder of record (hasLineOfSight), so audio uses the
 *  same answer instead of a second geometry model. */
export const OCCLUSION_ATTENUATION = 0.3;

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
  | 'station-hum'
  | 'generator-hum'
  | 'inventory-pad-on'
  | 'vehicle-screen-on'
  | 'vehicle-screen-off'
  | 'station-denied'
  | 'spinfusor-fire'
  | 'chaingun-fire'
  | 'mortar-fire'
  | 'sniper-fire'
  | 'blaster-fire'
  | 'mortar-explode'
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
  // Issue #51: the Repair Pack beam's own loop. The t2-mapper audio.vl2 volume this repo
  // samples everything else from carries no repair-beam sample, so until
  // katabatic/audio/repair-beam.m4a is added to packages/assets the entry loads like every
  // other sample (warn-once fetch failure) and stays silent -- never a synthesized
  // substitute, per this module's own test suite.
  | 'repair-beam'
  | 'voice-target-destroyed'
  | 'voice-flag-take'
  | 'voice-thanks'
  | 'voice-defend-flag'
  | 'voice-repair-me'
  | 'voice-enemy-warning'
  | 'voice-yes'
  | 'voice-no'
  | 'voice-nice';

/** Original audio.vl2 samples copied by packages/assets. */
const SOUND_FILE: Record<SoundId, string> = {
  'armor-thrust': 'armor-thrust.m4a',
  'armor-ski-soft': 'armor-ski-soft.m4a',
  'armor-footstep': 'armor-footstep.m4a',
  'station-hum': 'station-hum.m4a',
  'generator-hum': 'generator-hum.m4a',
  'inventory-pad-on': 'inventory-pad-on.m4a',
  'vehicle-screen-on': 'vehicle-screen-on.m4a',
  'vehicle-screen-off': 'vehicle-screen-off.m4a',
  'station-denied': 'station-denied.m4a',
  'spinfusor-fire': 'spinfusor-fire.m4a',
  'chaingun-fire': 'chaingun-fire.m4a',
  'mortar-fire': 'mortar-fire.m4a',
  'sniper-fire': 'sniper-fire.m4a',
  'blaster-fire': 'blaster-fire.m4a',
  'mortar-explode': 'mortar-explode.m4a',
  'spinfusor-impact': 'spinfusor-impact.m4a',
  'spinfusor-projectile': 'spinfusor-projectile.m4a',
  'mortar-projectile': 'mortar-projectile.m4a',
  'blaster-impact': 'blaster-impact.m4a',
  'blaster-projectile': 'blaster-projectile.m4a',
  'repair-beam': 'repair-beam.m4a',
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
/** Issue #56, stated plainly: the t2-mapper volume commits no chaingun spin-up/spin-down
 *  recording and no continuous fire-loop sample (only the per-shot chaingun_fire one-shot),
 *  so the sim's WeaponState.SpinUp phase and "spin/fire/stop loop timing" have no original
 *  sample to play and stay silent rather than getting an invented oscillator loop. Fire
 *  stays the per-shot one-shots WEAPON_PROFILE maps. */
/** Issue #56 footstep variants. The t2-mapper audio.vl2 volume commits exactly one footstep
 *  recording -- light armor's light_LF_soft (audio-sources.ts) -- and none for interior
 *  surfaces or the medium/heavy armors, so every armor/surface row resolves to that same
 *  committed sample and the approved footstep feel is unchanged for every behavior. This
 *  table is the whole variant policy: when a real recording lands in the manifest, its row
 *  changes here and nowhere else. A missing row would silence the cue -- never synthesize
 *  a substitute. */
export type FootstepSurface = 'terrain' | 'interior';
const FOOTSTEP_CUES: Record<ArmorId, Record<FootstepSurface, SoundId>> = {
  [ArmorId.Light]: { terrain: 'armor-footstep', interior: 'armor-footstep' },
  [ArmorId.Medium]: { terrain: 'armor-footstep', interior: 'armor-footstep' },
  [ArmorId.Heavy]: { terrain: 'armor-footstep', interior: 'armor-footstep' },
};
/** The footstep sample for an armor/surface pair; every pair shares the one committed
 *  recording today (see FOOTSTEP_CUES). */
export function footstepCue(armor: ArmorId, surface: FootstepSurface): SoundId {
  return FOOTSTEP_CUES[armor][surface];
}
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
 *    would pass a disc/bullet detonation off as the grenade's -- so both get the volume's
 *    one generic weapon-explosion recording: no dedicated hand-grenade sample is committed.
 *  - VehicleLaser records carry the Shrike's offset weapon id (150, no WEAPON_DATA row, so
 *    no impact recording); the handheld Blaster bolt's impact sample stands in, the same
 *    mapping the old disappearance path used.
 *  - Turret shots carry their own offset weapon ids and have no committed impact
 *    recordings; they stay silent rather than inventing one.
 *
 *  A bounce is a real contact, so it plays the weapon's own impact sample (no dedicated
 *  ricochet recording is committed) while the projectile keeps flying. */
export function projectileImpactCue(
  impact: ProjectileImpact,
): { sound: SoundId; profile: Profile } | null {
  if (impact.reason === ProjectileImpactReason.Timeout) {
    return impact.type === ProjectileType.Grenade
      ? { sound: 'mortar-explode', profile: EXPLOSION }
      : null;
  }
  if (impact.type === ProjectileType.Grenade) {
    return {
      sound: 'mortar-explode',
      profile: impact.weaponId === WeaponId.Mortar ? EXPLOSION : WEAPON_EXPLOSION,
    };
  }
  // weaponId rides the wire raw; offset ids (Shrike 150+, turret 151+) simply find no row.
  const sound =
    impact.type === ProjectileType.VehicleLaser
      ? WEAPON_IMPACT[WeaponId.Blaster]
      : WEAPON_IMPACT[impact.weaponId as WeaponId];
  return sound ? { sound: sound[0], profile: sound[1] } : null;
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
  const oneShots = new Set<AudioBufferSourceNode>();
  const buffers = new Map<SoundId, AudioBuffer>();
  const loads = new Map<SoundId, Promise<void>>();
  const warned = new Set<SoundId>();
  let disposed = false;
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
  const play = (id: SoundId, profile: Profile, position?: Vec3): void => {
    if (disposed) return;
    const buffer = buffers.get(id);
    const level = audibleLevel(position, profile);
    if (!buffer || level === 0) return;
    const source = context.createBufferSource() as AudioBufferSourceNode;
    const gain = context.createGain() as GainNode;
    source.buffer = buffer;
    gain.gain.value = level;
    const panner = connectOutput(gain, position, profile);
    oneShots.add(source);
    source.onended = () => {
      oneShots.delete(source);
      source.disconnect();
      gain.disconnect();
      panner?.disconnect();
    };
    source.start();
  };
  const loop = (id: SoundId, profile: Profile, position?: Vec3): Loop => {
    if (disposed) return { stop: () => undefined };
    let source: AudioBufferSourceNode | undefined;
    let stopped = false;
    const gain = context.createGain() as GainNode;
    gain.gain.value = audibleLevel(position, profile);
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
  const setSpatialLoop = (
    key: string,
    id: SoundId,
    profile: Profile,
    position: Vec3,
    active: boolean,
  ): void => {
    if (disposed) return;
    const level = audibleLevel(position, profile);
    setLoop(loops, key, active && level > 0, () => loop(id, profile, position));
    const live = loops.get(key);
    live?.setLevel?.(level);
    live?.setPosition?.(position);
  };
  return {
    weaponFire: (weapon, position) => {
      const sound = WEAPON_PROFILE[weapon];
      if (sound) play(sound[0], sound[1], position);
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
      if (sound) setSpatialLoop(`projectile:${String(id)}`, sound, PROJECTILE, position, active);
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
    // like it -- the local player's own beam sits at the listener. loop()'s pending-start
    // queue means a start before the sample decodes still fires once it lands, while a
    // missing sample stays a silent pending loop rather than a synthesized substitute.
    setRepairBeam: (id, active) =>
      setLoop(loops, `repair:${String(id)}`, active, () => loop('repair-beam', CLOSE)),
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
      for (const source of oneShots) source.stop();
      oneShots.clear();
      master.disconnect();
      if (context.state !== 'closed') void context.close?.();
    },
  };
}
