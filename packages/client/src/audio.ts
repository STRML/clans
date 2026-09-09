import { WeaponId, type Vec3 } from '@clans/sim';

// T2 AudioProfile volume is 1.0. This only leaves mix headroom.
export const AUDIO_MASTER_GAIN = 0.6;
export const FOOTSTEP_INTERVAL_S = 0.35;

interface AudioLike {
  position?: Vec3;
  context: Pick<
    AudioContext,
    | 'currentTime'
    | 'destination'
    | 'createGain'
    | 'createBufferSource'
    | 'decodeAudioData'
    | 'resume'
    | 'close'
    | 'state'
  >;
}
interface Loop {
  setLevel?(level: number): void;
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
  | 'flag-capture'
  | 'flag-snatch'
  | 'outrider-engine'
  | 'shrike-engine'
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
  'flag-capture': 'flag-capture.m4a',
  'flag-snatch': 'flag-snatch.m4a',
  'outrider-engine': 'outrider-engine.m4a',
  'shrike-engine': 'shrike-engine.m4a',
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
const DEFAULT: Profile = { minDistance: 20, maxDistance: 100 };
const EXPLOSION: Profile = { minDistance: 50, maxDistance: 250 };
const WEAPON_PROFILE: Partial<Record<WeaponId, [SoundId, Profile]>> = {
  [WeaponId.Spinfusor]: ['spinfusor-fire', DEFAULT],
  [WeaponId.Chaingun]: ['chaingun-fire', DEFAULT],
  [WeaponId.Mortar]: ['mortar-fire', DEFAULT],
  [WeaponId.LaserRifle]: ['sniper-fire', CLOSE],
  [WeaponId.Blaster]: ['blaster-fire', DEFAULT],
};

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
  explosion(position: Vec3): void;
  flagCapture(): void;
  flagTouch(): void;
  setJetting(playerId: number, active: boolean, energyFraction: number): void;
  setSkiing(playerId: number, active: boolean, speed: number): void;
  footstep(position: Vec3): void;
  setStationHum(id: number, position: Vec3, active: boolean): void;
  setGeneratorHum(id: number, position: Vec3, active: boolean): void;
  setVehicleEngine(id: number, kind: 'wildcat' | 'shrike', position: Vec3, active: boolean): void;
  stationActivate(kind: 'inventory' | 'vehicle', position?: Vec3): void;
  stationDeactivate(position?: Vec3): void;
  stationDenied(position?: Vec3): void;
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
  const play = (id: SoundId, profile: Profile, position?: Vec3): void => {
    if (disposed) return;
    const buffer = buffers.get(id);
    const level = levelAt(listener.position, position, profile);
    if (!buffer || level === 0) return;
    const source = context.createBufferSource() as AudioBufferSourceNode;
    const gain = context.createGain() as GainNode;
    source.buffer = buffer;
    gain.gain.value = level;
    source.connect(gain).connect(master);
    oneShots.add(source);
    source.onended = () => {
      oneShots.delete(source);
      source.disconnect();
      gain.disconnect();
    };
    source.start();
  };
  const loop = (id: SoundId, profile: Profile, position?: Vec3): Loop => {
    if (disposed) return { stop: () => undefined };
    let source: AudioBufferSourceNode | undefined;
    let stopped = false;
    const gain = context.createGain() as GainNode;
    gain.gain.value = levelAt(listener.position, position, profile);
    const start = (): void => {
      const buffer = buffers.get(id);
      if (!disposed && !stopped && !source && buffer) {
        source = context.createBufferSource() as AudioBufferSourceNode;
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain).connect(master);
        source.start();
      }
    };
    start();
    // Decode completes once; a failed fetch remains silent rather than spinning forever.
    if (!source) void loads.get(id)?.then(start);
    return {
      setLevel: (level) => gain.gain.setTargetAtTime(level, context.currentTime, 0.1),
      stop: () => {
        stopped = true;
        source?.stop();
        source?.disconnect();
        gain.disconnect();
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
    const level = levelAt(listener.position, position, profile);
    setLoop(loops, key, active && level > 0, () => loop(id, profile, position));
    loops.get(key)?.setLevel?.(level);
  };
  return {
    weaponFire: (weapon, position) => {
      const sound = WEAPON_PROFILE[weapon];
      if (sound) play(sound[0], sound[1], position);
    },
    explosion: (position) => play('mortar-explode', EXPLOSION, position),
    flagCapture: () => play('flag-capture', DEFAULT),
    flagTouch: () => play('flag-snatch', DEFAULT),
    setJetting: (id, active) =>
      setLoop(loops, `jet:${String(id)}`, active, () => loop('armor-thrust', CLOSE)),
    // ski_soft is AudioClose3d (not looping) in player.cs; never create a false noise bed.
    setSkiing: (id, active) => {
      if (active && !skiing.has(id)) {
        skiing.add(id);
        play('armor-ski-soft', CLOSE);
      } else if (!active) skiing.delete(id);
    },
    footstep: (position) => play('armor-footstep', CLOSE, position),
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
    voice: (lineId) => {
      const sound = VOICE_SOUND[lineId];
      if (sound) play(sound, DEFAULT);
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
