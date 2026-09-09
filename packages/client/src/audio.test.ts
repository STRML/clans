import { describe, expect, it, vi } from 'vitest';
import { createAudioEngine } from './audio.js';
import { WeaponId } from '@clans/sim';

function fakeAudioContext() {
  const created: { osc: number; gain: number; noise: number } = { osc: 0, gain: 0, noise: 0 };
  const node = () => ({
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    type: 'sine',
  });
  return {
    currentTime: 0,
    destination: {},
    state: 'running' as AudioContextState,
    resume: vi.fn(),
    close: vi.fn(),
    createOscillator: vi.fn(() => {
      created.osc += 1;
      return node();
    }),
    createGain: vi.fn(() => {
      created.gain += 1;
      return node();
    }),
    createBufferSource: vi.fn(() => {
      created.noise += 1;
      return node();
    }),
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(4096) })),
    createBiquadFilter: vi.fn(() => node()),
    createPanner: vi.fn(() => ({ ...node(), setPosition: vi.fn() })),
    _created: created,
  };
}

describe('createAudioEngine', () => {
  it('does not synthesize a generator hum while its original sample is loading', () => {
    const ctx = fakeAudioContext();
    const position = { x: 100, y: 0, z: 0 };
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext, position });
    engine.setStationHum(0, { x: 0, y: 0, z: 0 }, true);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('weaponFire does not substitute an oscillator when the original sample is unavailable', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.weaponFire(WeaponId.Spinfusor, { x: 0, y: 0, z: 0 });
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('weaponFire keeps the original Blaster mapping distinct from the Chaingun', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.weaponFire(WeaponId.Blaster, { x: 0, y: 0, z: 0 });
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('explosion does not create a fabricated noise burst while loading', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.explosion({ x: 0, y: 0, z: 0 });
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('flagCapture does not create a synthetic fanfare', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.flagCapture();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('flagTouch does not create a synthetic tone', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.flagTouch();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('footstep does not create a synthetic noise burst', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.footstep({ x: 0, y: 0, z: 0 });
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('setJetting(true) then setJetting(false) does not leak a running node past dispose', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setJetting(0, true, 1);
    engine.setJetting(0, false, 0);
    expect(() => engine.dispose()).not.toThrow();
  });

  it('setJetting(true) twice only creates one pending original-sample loop', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setJetting(0, true, 1);
    engine.setJetting(0, true, 1);
    expect(ctx.createGain).toHaveBeenCalledTimes(2); // master + one pending loop
  });

  // Issue #51: the repair beam's dedicated loop. These follow the exact setJetting loop
  // assertions above -- the engine never fabricates an oscillator while the (volume-less,
  // t2-mapper) sample is unavailable, and repeated start calls reuse one pending loop.
  it('setRepairBeam does not synthesize an oscillator while the sample is unavailable', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setRepairBeam(0, true);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('setRepairBeam(true) then setRepairBeam(false) does not leak a running node past dispose', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setRepairBeam(0, true);
    engine.setRepairBeam(0, false);
    expect(() => engine.dispose()).not.toThrow();
  });

  it('setRepairBeam(true) twice only creates one pending loop', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setRepairBeam(0, true);
    engine.setRepairBeam(0, true);
    expect(ctx.createGain).toHaveBeenCalledTimes(2); // master + one pending loop
  });

  it('the repair loop is distinct from the jet loop for the same player', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setJetting(0, true, 1);
    engine.setRepairBeam(0, true);
    // Master + two separate pending loops: one repair cue must never steal or share the
    // jet loop's node graph.
    expect(ctx.createGain).toHaveBeenCalledTimes(3);
  });

  it('does not start a loop when its sample decodes after dispose', async () => {
    const ctx = fakeAudioContext();
    const resolvers: Array<(buffer: AudioBuffer) => void> = [];
    Object.assign(ctx, {
      decodeAudioData: vi.fn(() => new Promise<AudioBuffer>((resolve) => resolvers.push(resolve))),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      ),
    );
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    await Promise.resolve();
    await Promise.resolve();
    engine.setJetting(0, true, 1);
    engine.dispose();
    resolvers.forEach((resolve) => resolve({} as AudioBuffer));
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('setSkiing(true) then setSkiing(false) does not leak a running node past dispose', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setSkiing(0, true, 10);
    engine.setSkiing(0, false, 0);
    expect(() => engine.dispose()).not.toThrow();
  });

  it('setStationHum(true) then setStationHum(false) does not leak a running node past dispose', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setStationHum(0, { x: 0, y: 0, z: 0 }, true);
    engine.setStationHum(0, { x: 0, y: 0, z: 0 }, false);
    expect(() => engine.dispose()).not.toThrow();
  });

  it('dispose stops every active loop and disconnects the master gain', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setJetting(0, true, 1);
    engine.setSkiing(1, true, 10);
    engine.setStationHum(0, { x: 0, y: 0, z: 0 }, true);
    expect(() => engine.dispose()).not.toThrow();
  });

  // Codex review round 1 of the M7 PR: the context itself was never resumed or closed at all.
  describe('resume/dispose close the underlying AudioContext', () => {
    it('resume() calls context.resume() when suspended (an autoplay-restricted browser)', () => {
      const ctx = fakeAudioContext();
      ctx.state = 'suspended';
      const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
      engine.resume();
      expect(ctx.resume).toHaveBeenCalledTimes(1);
    });

    it('resume() is a no-op when the context is already running', () => {
      const ctx = fakeAudioContext();
      const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
      engine.resume();
      expect(ctx.resume).not.toHaveBeenCalled();
    });

    it('dispose() closes the context, not just the loops and master gain', () => {
      const ctx = fakeAudioContext();
      const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
      engine.dispose();
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it('dispose() does not re-close an already-closed context', () => {
      const ctx = fakeAudioContext();
      ctx.state = 'closed';
      const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
      engine.dispose();
      expect(ctx.close).not.toHaveBeenCalled();
    });
  });
});
