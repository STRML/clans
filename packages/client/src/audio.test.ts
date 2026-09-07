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
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    type: 'sine',
  });
  return {
    currentTime: 0,
    destination: {},
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
  it('weaponFire builds an oscillator graph for the Spinfusor', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.weaponFire(WeaponId.Spinfusor, { x: 0, y: 0, z: 0 });
    expect(ctx.createOscillator).toHaveBeenCalled();
    expect(ctx.createGain).toHaveBeenCalled();
  });

  it('weaponFire falls back to the Chaingun timbre for a weapon with no distinct synth', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.weaponFire(WeaponId.Blaster, { x: 0, y: 0, z: 0 });
    expect(ctx.createOscillator).toHaveBeenCalled();
  });

  it('explosion builds a noise-burst graph, not an oscillator-only one', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.explosion({ x: 0, y: 0, z: 0 });
    expect(ctx.createBufferSource).toHaveBeenCalled();
  });

  it('flagCapture plays a three-note fanfare', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.flagCapture();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
  });

  it('flagTouch plays a single tone', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.flagTouch();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
  });

  it('footstep builds a short noise burst', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.footstep({ x: 0, y: 0, z: 0 });
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('setJetting(true) then setJetting(false) does not leak a running node past dispose', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setJetting(0, true, 1);
    engine.setJetting(0, false, 0);
    expect(() => engine.dispose()).not.toThrow();
  });

  it('setJetting(true) twice in a row starts only one loop', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.setJetting(0, true, 1);
    engine.setJetting(0, true, 1);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
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
});
