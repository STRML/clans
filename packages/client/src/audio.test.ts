import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createAudioEngine,
  footstepCue,
  OCCLUSION_ATTENUATION,
  projectileImpactCue,
} from './audio.js';
import type { FootstepSurface } from './audio.js';
import {
  ArmorId,
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  type ProjectileImpact,
  type Vec3,
} from '@clans/sim';

interface FakeGainParam {
  value: number;
  setValueAtTime: Mock;
  setTargetAtTime: Mock;
  linearRampToValueAtTime: Mock;
  exponentialRampToValueAtTime: Mock;
}
interface FakeAudioNode {
  connect: Mock;
  disconnect: Mock;
  start: Mock;
  stop: Mock;
  gain: FakeGainParam;
  frequency: { value: number; setValueAtTime: Mock; exponentialRampToValueAtTime: Mock };
  type: string;
}
interface FakePanner extends FakeAudioNode {
  setPosition: Mock;
}
function fakeAudioContext() {
  const created: { osc: number; gain: number; noise: number } = { osc: 0, gain: 0, noise: 0 };
  const gains: FakeAudioNode[] = [];
  const panners: FakePanner[] = [];
  const sources: FakeAudioNode[] = [];
  const node = (): FakeAudioNode => ({
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
      const n = node();
      gains.push(n);
      return n;
    }),
    createBufferSource: vi.fn(() => {
      created.noise += 1;
      const n = node();
      sources.push(n);
      return n;
    }),
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(4096) })),
    createBiquadFilter: vi.fn(() => node()),
    createPanner: vi.fn(() => {
      const n = { ...node(), setPosition: vi.fn() };
      panners.push(n);
      return n;
    }),
    _created: created,
    _gains: gains,
    _panners: panners,
    _sources: sources,
  };
}
/** Drains the engine's fetch->decode->cache promise chain deterministically: each awaited
 *  resolved promise yields once, and the chain is exactly three deep. No wall-clock timers. */
async function flushLoads(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** An engine whose every sample has "decoded", so positive playback assertions (one source
 *  per cue, panner graphs, mix levels) are observable; the synth-guard tests above stay on
 *  the bufferless path. `position` puts a listener somewhere for range falloff tests. */
async function engineWithSamples(occlusionAt?: (position: Vec3) => boolean, position?: Vec3) {
  const ctx = fakeAudioContext();
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
  Object.assign(ctx, {
    decodeAudioData: vi.fn(() => Promise.resolve({ duration: 1 } as unknown as AudioBuffer)),
  });
  // exactOptionalPropertyTypes: AudioLike's optional props accept absence, not undefined,
  // so the spread form is the honest construction.
  const engine = createAudioEngine({
    context: ctx as unknown as AudioContext,
    ...(occlusionAt ? { occlusionAt } : {}),
    ...(position ? { position } : {}),
  });
  await flushLoads();
  return { ctx, engine };
}

function impactRecord(overrides: Partial<ProjectileImpact> = {}): ProjectileImpact {
  return {
    x: 1,
    y: 2,
    z: 3,
    weaponId: WeaponId.Spinfusor,
    type: ProjectileType.Linear,
    reason: ProjectileImpactReason.Direct,
    seq: 1,
    ...overrides,
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

/** Issue #52 residual: cue selection must agree with the visual rule impactEffectFor
 *  renders, record for record. */
describe('projectileImpactCue (#52 residual)', () => {
  it('maps every direct or world hit to its own weapon impact recording', () => {
    const expectations: Array<[WeaponId, string]> = [
      [WeaponId.Spinfusor, 'spinfusor-impact'],
      [WeaponId.Chaingun, 'chaingun-impact'],
      [WeaponId.Mortar, 'mortar-explode'],
      [WeaponId.LaserRifle, 'sniper-impact'],
      [WeaponId.Blaster, 'blaster-impact'],
    ];
    for (const [weaponId, sound] of expectations) {
      expect(projectileImpactCue(impactRecord({ weaponId }))?.sound).toBe(sound);
      expect(
        projectileImpactCue(impactRecord({ weaponId, reason: ProjectileImpactReason.World }))
          ?.sound,
      ).toBe(sound);
    }
  });

  it('plays a bounce as the weapon contact it is', () => {
    expect(
      projectileImpactCue(
        impactRecord({
          weaponId: WeaponId.Blaster,
          type: ProjectileType.Energy,
          reason: ProjectileImpactReason.Bounce,
        }),
      )?.sound,
    ).toBe('blaster-impact');
  });

  it('keeps the Shrike bolt on the handheld Blaster impact sample (none dedicated committed)', () => {
    // 150 = projectiles.ts's VEHICLE_WEAPON_ID_OFFSET: no WEAPON_DATA row, no recording.
    expect(
      projectileImpactCue(impactRecord({ weaponId: 150, type: ProjectileType.VehicleLaser }))
        ?.sound,
    ).toBe('blaster-impact');
  });

  it('silences non-detonating lifetime expiries exactly like the visual rule', () => {
    for (const type of [ProjectileType.Linear, ProjectileType.Tracer, ProjectileType.Energy]) {
      expect(
        projectileImpactCue(impactRecord({ type, reason: ProjectileImpactReason.Timeout })),
      ).toBeNull();
    }
  });

  it('detonates only an armed grenade lifetime expiry (finalizeGrenadeLifetime)', () => {
    expect(
      projectileImpactCue(
        impactRecord({
          weaponId: WeaponId.Mortar,
          type: ProjectileType.Grenade,
          reason: ProjectileImpactReason.Timeout,
        }),
      )?.sound,
    ).toBe('mortar-explode');
  });

  it('sends non-mortar grenades to the generic weapon-explosion recording', () => {
    // The alt-fire grenade rides the firing weapon's id; there is no hand-grenade sample.
    expect(
      projectileImpactCue(
        impactRecord({
          weaponId: WeaponId.Spinfusor,
          type: ProjectileType.Grenade,
          reason: ProjectileImpactReason.World,
        }),
      )?.sound,
    ).toBe('mortar-explode');
  });

  it('leaves turret shots silent (no committed impact recording)', () => {
    expect(projectileImpactCue(impactRecord({ weaponId: 151 }))).toBeNull();
  });
});

describe('projectileImpact playback (#52 residual)', () => {
  it('plays exactly one cue per record and none for a suppressed timeout', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.projectileImpact(impactRecord({ seq: 1 }));
    expect(ctx._sources).toHaveLength(1);
    engine.projectileImpact(
      impactRecord({
        weaponId: WeaponId.Mortar,
        type: ProjectileType.Grenade,
        reason: ProjectileImpactReason.Timeout,
        seq: 2,
      }),
    );
    expect(ctx._sources).toHaveLength(2);
    engine.projectileImpact(impactRecord({ reason: ProjectileImpactReason.Timeout, seq: 3 }));
    expect(ctx._sources).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});

describe('directional panning (#56)', () => {
  it('routes a positioned one-shot through a panner at the cue position', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.weaponFire(WeaponId.Spinfusor, { x: 7, y: 8, z: 9 });
    expect(ctx._panners).toHaveLength(1);
    expect(ctx._panners[0]?.setPosition).toHaveBeenCalledWith(7, 8, 9);
    vi.unstubAllGlobals();
  });

  it('keeps unpositioned cues (voices, flag cues) out of the panner graph', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.flagDrop();
    expect(ctx._sources).toHaveLength(1);
    expect(ctx._panners).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('moves a spatial loop panner as its source moves without re-creating it', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.setStationHum(0, { x: 1, y: 0, z: 0 }, true);
    engine.setStationHum(0, { x: 2, y: 0, z: 0 }, true);
    expect(ctx._panners).toHaveLength(1);
    expect(ctx._panners[0]?.setPosition).toHaveBeenLastCalledWith(2, 0, 0);
    vi.unstubAllGlobals();
  });

  it('feeds the Web Audio listener position and orientation when present', () => {
    const ctx = fakeAudioContext();
    const listener = { setPosition: vi.fn(), setOrientation: vi.fn() };
    Object.assign(ctx, { listener });
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    engine.updateListener({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(listener.setPosition).toHaveBeenCalledWith(1, 2, 3);
    expect(listener.setOrientation).toHaveBeenCalledWith(0, 0, 1, 0, 1, 0);
  });

  it('updateListener is a safe no-op without a context listener', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({ context: ctx as unknown as AudioContext });
    expect(() =>
      engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }),
    ).not.toThrow();
  });
});

describe('terrain occlusion (#56)', () => {
  it('ducks a positioned cue that fails the occlusion test', async () => {
    const { ctx, engine } = await engineWithSamples(() => true);
    engine.weaponFire(WeaponId.Spinfusor, { x: 5, y: 0, z: 0 });
    // _gains[0] is the master; the one-shot's own gain carries the occluded distance level.
    expect(ctx._gains[1]?.gain.value).toBe(OCCLUSION_ATTENUATION);
    vi.unstubAllGlobals();
  });

  it('leaves a line-of-sight cue at its full distance level', async () => {
    const { ctx, engine } = await engineWithSamples(() => false);
    engine.weaponFire(WeaponId.Spinfusor, { x: 5, y: 0, z: 0 });
    expect(ctx._gains[1]?.gain.value).toBe(1);
    vi.unstubAllGlobals();
  });

  it('never occludes an unpositioned cue', async () => {
    const { ctx, engine } = await engineWithSamples(() => true);
    engine.flagDrop();
    expect(ctx._gains[1]?.gain.value).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('footstep variants (#56)', () => {
  it('resolves every armor/surface pair to the one committed footstep recording', () => {
    const surfaces: FootstepSurface[] = ['terrain', 'interior'];
    for (const armor of [ArmorId.Light, ArmorId.Medium, ArmorId.Heavy]) {
      for (const surface of surfaces) {
        expect(footstepCue(armor, surface)).toBe('armor-footstep');
      }
    }
  });

  it('plays the committed sample, never a synthesis, for whatever armor the app passes', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.footstep({ x: 0, y: 0, z: 0 }, { armor: ArmorId.Heavy, surface: 'interior' });
    expect(ctx._sources).toHaveLength(1);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('loop stop lifecycle (#56)', () => {
  it('never starts a spatial loop beyond its audible range', () => {
    const ctx = fakeAudioContext();
    const engine = createAudioEngine({
      context: ctx as unknown as AudioContext,
      position: { x: 0, y: 0, z: 0 },
    });
    engine.setStationHum(0, { x: 1000, y: 0, z: 0 }, true);
    // Master gain only: the out-of-range loop never even reaches its pending-start queue.
    expect(ctx._created.gain).toBe(1);
  });

  it('stops a running spatial loop once its source leaves audible range', async () => {
    const { ctx, engine } = await engineWithSamples(undefined, { x: 0, y: 0, z: 0 });
    engine.setStationHum(0, { x: 1, y: 0, z: 0 }, true);
    expect(ctx._sources).toHaveLength(1);
    engine.setStationHum(0, { x: 1000, y: 0, z: 0 }, true);
    expect(ctx._sources[0]?.stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('stops a running spatial loop on the active=false transition', async () => {
    // The same transition carries power loss, destruction and disconnect app-side; the
    // engine contract is that false stops the node exactly once.
    const { ctx, engine } = await engineWithSamples();
    engine.setGeneratorHum(0, { x: 1, y: 0, z: 0 }, true);
    expect(ctx._sources).toHaveLength(1);
    engine.setGeneratorHum(0, { x: 1, y: 0, z: 0 }, false);
    expect(ctx._sources[0]?.stop).toHaveBeenCalledTimes(1);
    engine.setGeneratorHum(0, { x: 1, y: 0, z: 0 }, false);
    expect(ctx._sources[0]?.stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
