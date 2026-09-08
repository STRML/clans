import { WeaponId, type Vec3 } from '@clans/sim';

// Every synthesis parameter below is an original sound-design pick (no T2 script gives one --
// T2 shipped sampled audio, not a synthesis spec). See the M7 plan's "ours" numbers table.
export const AUDIO_MASTER_GAIN = 0.6; // Ours -- headroom so overlapping effects don't clip.
export const FOOTSTEP_INTERVAL_S = 0.35; // Ours -- reads as a jog, not a machine-gun of clicks.

interface AudioLike {
  /** Mutable listener position, usually the active camera position. */
  position?: Vec3;
  context: Pick<
    AudioContext,
    | 'currentTime'
    | 'destination'
    | 'createOscillator'
    | 'createGain'
    | 'createBufferSource'
    | 'createBuffer'
    | 'createBiquadFilter'
    | 'createPanner'
    | 'resume'
    | 'close'
    | 'state'
  >;
}

function noiseBuffer(context: AudioLike['context'], seconds: number): AudioBuffer {
  const sampleRate = 44100;
  const buffer = context.createBuffer(
    1,
    Math.floor(sampleRate * seconds),
    sampleRate,
  ) as AudioBuffer;
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function envelope(
  context: AudioLike['context'],
  gainNode: GainNode,
  peak: number,
  attackS: number,
  releaseS: number,
): void {
  const now = context.currentTime;
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(peak, now + attackS);
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + attackS + releaseS);
}

/** Sawtooth 220 -> 90 Hz over 120 ms -- a low thud with an edge. */
function spinfusorFire(context: AudioLike['context'], master: GainNode): void {
  const osc = context.createOscillator() as OscillatorNode;
  const gain = context.createGain() as GainNode;
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, context.currentTime);
  osc.frequency.exponentialRampToValueAtTime(90, context.currentTime + 0.12);
  envelope(context, gain, 0.5, 0.005, 0.12);
  osc.connect(gain).connect(master);
  osc.start();
  osc.stop(context.currentTime + 0.15);
}

/** Square 900 Hz, 12 ms decay -- a short dry click per shot. */
function chaingunFire(context: AudioLike['context'], master: GainNode): void {
  const osc = context.createOscillator() as OscillatorNode;
  const gain = context.createGain() as GainNode;
  osc.type = 'square';
  osc.frequency.setValueAtTime(900, context.currentTime);
  envelope(context, gain, 0.25, 0.001, 0.012);
  osc.connect(gain).connect(master);
  osc.start();
  osc.stop(context.currentTime + 0.02);
}

/** Sine 60 Hz thump over 200 ms -- a low, distant-feeling launch. */
function mortarFire(context: AudioLike['context'], master: GainNode): void {
  const osc = context.createOscillator() as OscillatorNode;
  const gain = context.createGain() as GainNode;
  osc.type = 'sine';
  osc.frequency.setValueAtTime(60, context.currentTime);
  envelope(context, gain, 0.6, 0.01, 0.2);
  osc.connect(gain).connect(master);
  osc.start();
  osc.stop(context.currentTime + 0.25);
}

/** Sine sweep 800 -> 2000 Hz over 80 ms -- an instant "zap" for the hitscan Laser Rifle. */
function laserFire(context: AudioLike['context'], master: GainNode): void {
  const osc = context.createOscillator() as OscillatorNode;
  const gain = context.createGain() as GainNode;
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, context.currentTime);
  osc.frequency.exponentialRampToValueAtTime(2000, context.currentTime + 0.08);
  envelope(context, gain, 0.35, 0.002, 0.08);
  osc.connect(gain).connect(master);
  osc.start();
  osc.stop(context.currentTime + 0.1);
}

const WEAPON_SYNTH: Partial<
  Record<WeaponId, (ctx: AudioLike['context'], master: GainNode) => void>
> = {
  [WeaponId.Spinfusor]: spinfusorFire,
  [WeaponId.Chaingun]: chaingunFire,
  [WeaponId.Mortar]: mortarFire,
  [WeaponId.LaserRifle]: laserFire,
  [WeaponId.Blaster]: chaingunFire, // closest existing timbre; no distinct spec guidance
};

function synthExplosion(context: AudioLike['context'], master: GainNode): void {
  const src = context.createBufferSource() as AudioBufferSourceNode;
  src.buffer = noiseBuffer(context, 0.4);
  const filter = context.createBiquadFilter() as BiquadFilterNode;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(800, context.currentTime);
  filter.frequency.exponentialRampToValueAtTime(80, context.currentTime + 0.4);
  const gain = context.createGain() as GainNode;
  envelope(context, gain, 0.7, 0.005, 0.4);
  src.connect(filter).connect(gain).connect(master);
  src.start();
}

/** Three ascending square-wave notes -- a short capture fanfare. */
function synthFlagCapture(context: AudioLike['context'], master: GainNode): void {
  const notes = [523, 659, 784];
  notes.forEach((freq, i) => {
    const osc = context.createOscillator() as OscillatorNode;
    const gain = context.createGain() as GainNode;
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, context.currentTime + i * 0.1);
    envelope(context, gain, 0.3, 0.005, 0.1);
    osc.connect(gain).connect(master);
    osc.start(context.currentTime + i * 0.1);
    osc.stop(context.currentTime + i * 0.1 + 0.12);
  });
}

/** One short sine blip -- a lighter cue than the capture fanfare. */
function synthFlagTouch(context: AudioLike['context'], master: GainNode): void {
  const osc = context.createOscillator() as OscillatorNode;
  const gain = context.createGain() as GainNode;
  osc.type = 'sine';
  osc.frequency.setValueAtTime(440, context.currentTime);
  envelope(context, gain, 0.3, 0.005, 0.08);
  osc.connect(gain).connect(master);
  osc.start();
  osc.stop(context.currentTime + 0.1);
}

/** A short percussive tick -- footsteps are many short bursts, not one sustained note. */
function synthFootstep(context: AudioLike['context'], master: GainNode): void {
  const src = context.createBufferSource() as AudioBufferSourceNode;
  src.buffer = noiseBuffer(context, 0.03);
  const filter = context.createBiquadFilter() as BiquadFilterNode;
  filter.type = 'lowpass';
  filter.frequency.value = 400;
  const gain = context.createGain() as GainNode;
  envelope(context, gain, 0.2, 0.001, 0.03);
  src.connect(filter).connect(gain).connect(master);
  src.start();
}

interface Loop {
  setLevel?(level: number): void;
  stop(): void;
}

/** Looping filtered-noise jet exhaust; pitch rises slightly with remaining energy. */
function startJetLoop(
  context: AudioLike['context'],
  master: GainNode,
  energyFraction: number,
): Loop {
  const src = context.createBufferSource() as AudioBufferSourceNode;
  src.buffer = noiseBuffer(context, 1);
  src.loop = true;
  const filter = context.createBiquadFilter() as BiquadFilterNode;
  filter.type = 'bandpass';
  filter.frequency.value = 300 + energyFraction * 200;
  const gain = context.createGain() as GainNode;
  gain.gain.value = 0.3;
  src.connect(filter).connect(gain).connect(master);
  src.start();
  return { stop: () => src.stop() };
}

/** Looping filtered-noise ski hiss; pitch and level rise with speed. */
function startSkiLoop(context: AudioLike['context'], master: GainNode, speed: number): Loop {
  const src = context.createBufferSource() as AudioBufferSourceNode;
  src.buffer = noiseBuffer(context, 1);
  src.loop = true;
  const filter = context.createBiquadFilter() as BiquadFilterNode;
  filter.type = 'bandpass';
  filter.frequency.value = 200 + Math.min(speed, 20) * 50;
  const gain = context.createGain() as GainNode;
  gain.gain.value = Math.min(speed / 20, 1) * 0.25;
  src.connect(filter).connect(gain).connect(master);
  src.start();
  return { stop: () => src.stop() };
}

/** Two detuned low sine oscillators (55/110 Hz) -- a quiet, sustained power hum. */
function startStationHumLoop(context: AudioLike['context'], master: GainNode): Loop {
  const oscA = context.createOscillator() as OscillatorNode;
  const oscB = context.createOscillator() as OscillatorNode;
  oscA.type = 'sine';
  oscB.type = 'sine';
  oscA.frequency.value = 55;
  oscB.frequency.value = 110;
  const gain = context.createGain() as GainNode;
  gain.gain.value = 0;
  oscA.connect(gain).connect(master);
  oscB.connect(gain);
  oscA.start();
  oscB.start();
  return {
    setLevel: (level) => gain.gain.setTargetAtTime(level * 0.025, context.currentTime, 0.1),
    stop: () => {
      oscA.stop();
      oscB.stop();
      oscA.disconnect();
      oscB.disconnect();
      gain.disconnect();
    },
  };
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
  /** Best-effort resume of a context a browser's autoplay policy started (or later put back
   *  into) the `suspended` state -- must be called from inside a real user-gesture handler
   *  (a click, a keydown), the same restriction every browser places on `AudioContext.resume`
   *  itself. A no-op, not a throw, when the context is already running or resume isn't
   *  available (Codex review round 1 of the M7 PR). */
  resume(): void;
  dispose(): void;
}

/** Starts or stops a keyed loop, no-opping a redundant start or a stop of a key that never
 *  started -- the shared shape setJetting/setSkiing/setStationHum below all follow. */
function setLoop(loops: Map<string, Loop>, key: string, active: boolean, start: () => Loop): void {
  if (!active) {
    loops.get(key)?.stop();
    loops.delete(key);
    return;
  }
  if (loops.has(key)) return;
  loops.set(key, start());
}

export function createAudioEngine(listener: AudioLike): AudioEngine {
  const { context } = listener;
  const master = context.createGain() as GainNode;
  master.gain.value = AUDIO_MASTER_GAIN;
  master.connect(context.destination);
  const loops = new Map<string, Loop>();

  return {
    weaponFire(weaponId, _position): void {
      (WEAPON_SYNTH[weaponId] ?? chaingunFire)(context, master);
    },
    explosion(_position): void {
      synthExplosion(context, master);
    },
    flagCapture(): void {
      synthFlagCapture(context, master);
    },
    flagTouch(): void {
      synthFlagTouch(context, master);
    },
    setJetting(playerId, active, energyFraction): void {
      setLoop(loops, `jet:${String(playerId)}`, active, () =>
        startJetLoop(context, master, energyFraction),
      );
    },
    setSkiing(playerId, active, speed): void {
      setLoop(loops, `ski:${String(playerId)}`, active, () => startSkiLoop(context, master, speed));
    },
    footstep(_position): void {
      synthFootstep(context, master);
    },
    setStationHum(id, position, active): void {
      const ear = listener.position ?? { x: 0, y: 0, z: 0 };
      const distance = Math.hypot(position.x - ear.x, position.y - ear.y, position.z - ear.z);
      // Ours: quiet room ambience, inaudible beyond 24 m; no map-wide oscillator bed.
      const level = Math.max(0, 1 - distance / 24) ** 2;
      const key = `hum:${String(id)}`;
      setLoop(loops, key, active && level > 0, () => startStationHumLoop(context, master));
      loops.get(key)?.setLevel?.(level);
    },
    resume(): void {
      if (context.state === 'suspended') void context.resume?.();
    },
    dispose(): void {
      for (const loop of loops.values()) loop.stop();
      loops.clear();
      master.disconnect();
      // Codex review round 1 of the M7 PR: dispose stopped every loop and disconnected the
      // master gain, but never closed the underlying AudioContext -- app.ts had no teardown
      // path calling this at all before this same round, so every App instance (a hot reload,
      // a test harness creating several) leaked a real OS-level audio device context.
      if (context.state !== 'closed') void context.close?.();
    },
  };
}
