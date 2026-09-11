import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createAudioEngine,
  footstepCue,
  OCCLUSION_ATTENUATION,
  projectileImpactCue,
  SOUND_FILE,
} from './audio.js';
import type { FootstepSurface } from './audio.js';
import {
  ArmorId,
  ProjectileImpactReason,
  ProjectileType,
  TurretBarrelId,
  WeaponId,
  WeaponState,
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
  /** Set by the engine when it plays a decoded sample; engineWithSamples tags it with the URL
   *  it was fetched from, so a test can assert which recording a cue chose. */
  buffer?: { name?: string };
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
    vi.fn((input: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(input).buffer),
      }),
    ),
  );
  Object.assign(ctx, {
    // The fake decoder carries the fetched URL through, so `_sources[i].buffer.name` names the
    // recording a cue actually played -- the file name is the whole contract with the asset
    // manifest, and asserting it is what the acceptance means by "assert the mapping".
    decodeAudioData: vi.fn((bytes: ArrayBuffer) =>
      Promise.resolve({
        duration: 1,
        name: new TextDecoder().decode(new Uint8Array(bytes)),
      } as unknown as AudioBuffer),
    ),
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

/** The recording a cue played, as the URL the engine fetched it from: engineWithSamples tags
 *  each decoded buffer with that URL, so this asserts the cue -> file mapping rather than just
 *  counting nodes. */
function sourceNames(ctx: { _sources: FakeAudioNode[] }): Array<string | undefined> {
  return ctx._sources.map((source) => source.buffer?.name);
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
  // assertions above -- the engine never fabricates an oscillator while the original sample is
  // still undecoded, and repeated start calls reuse one pending loop.
  it('does not synthesize an oscillator before the beam sample decodes', () => {
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

  it('sends non-mortar grenades to the hand grenade\'s own detonation recording', () => {
    // The alt-fire grenade rides the firing weapon's id; GrenadeExplosionSound is
    // fx/weapons/grenade_explode (grenadeLauncher.cs:77-83), which HandGrenadeExplosion
    // carries as its soundProfile (grenade.cs:180).
    expect(
      projectileImpactCue(
        impactRecord({
          weaponId: WeaponId.Spinfusor,
          type: ProjectileType.Grenade,
          reason: ProjectileImpactReason.World,
        }),
      )?.sound,
    ).toBe('grenade-explode');
    expect(
      projectileImpactCue(
        impactRecord({
          weaponId: WeaponId.Chaingun,
          type: ProjectileType.Grenade,
          reason: ProjectileImpactReason.Direct,
        }),
      )?.sound,
    ).toBe('grenade-explode');
  });

  it('maps each turret barrel to the recording its own script commits', () => {
    // Barrels ride the wire at projectiles.ts's TURRET_WEAPON_ID_OFFSET (100).
    const expectations: Array<[TurretBarrelId, string]> = [
      [TurretBarrelId.PlasmaBarrelLarge, 'turret-plasma-impact'],
      [TurretBarrelId.AABarrelLarge, 'blaster-impact'],
      [TurretBarrelId.SentryTurretBarrel, 'turret-sentry-impact'],
    ];
    for (const [barrel, sound] of expectations) {
      const weaponId = barrel + 100;
      expect(projectileImpactCue(impactRecord({ weaponId }))?.sound).toBe(sound);
      expect(
        projectileImpactCue(impactRecord({ weaponId, reason: ProjectileImpactReason.World }))
          ?.sound,
      ).toBe(sound);
    }
  });

  it('leaves an id with no committed impact recording silent', () => {
    // 151 is one past the Shrike's own offset: no WEAPON_DATA row and no turret barrel.
    expect(projectileImpactCue(impactRecord({ weaponId: 151 }))).toBeNull();
    // A turret bolt that merely outlives its lifetime is a removal, not a detonation.
    expect(
      projectileImpactCue(
        impactRecord({
          weaponId: TurretBarrelId.SentryTurretBarrel + 100,
          reason: ProjectileImpactReason.Timeout,
        }),
      ),
    ).toBeNull();
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
  it('resolves each armor/surface pair to that armor\'s own committed recording', () => {
    // player.cs gives every armor its own L/R footstep set; terrain takes the `soft` take and
    // interior the `metal` one (the two T2 surface classes our FootstepSurface collapses).
    const expectations: Array<[ArmorId, FootstepSurface, string]> = [
      [ArmorId.Light, 'terrain', 'armor-footstep'],
      [ArmorId.Light, 'interior', 'armor-footstep'],
      [ArmorId.Medium, 'terrain', 'medium-footstep'],
      [ArmorId.Medium, 'interior', 'medium-footstep-metal'],
      [ArmorId.Heavy, 'terrain', 'heavy-footstep'],
      [ArmorId.Heavy, 'interior', 'heavy-footstep-metal'],
    ];
    for (const [armor, surface, sound] of expectations) {
      expect(footstepCue(armor, surface)).toBe(sound);
    }
  });

  it('plays each armor/surface recording it names, never a synthesis', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.footstep({ x: 0, y: 0, z: 0 }, { armor: ArmorId.Light, surface: 'terrain' });
    engine.footstep({ x: 0, y: 0, z: 0 }, { armor: ArmorId.Medium, surface: 'terrain' });
    engine.footstep({ x: 0, y: 0, z: 0 }, { armor: ArmorId.Medium, surface: 'interior' });
    engine.footstep({ x: 0, y: 0, z: 0 }, { armor: ArmorId.Heavy, surface: 'interior' });
    expect(sourceNames(ctx)).toEqual([
      '/katabatic/audio/armor-footstep.m4a',
      '/katabatic/audio/medium-footstep.m4a',
      '/katabatic/audio/medium-footstep-metal.m4a',
      '/katabatic/audio/heavy-footstep-metal.m4a',
    ]);
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

/** Issue #51: the beam loop now has a committed recording, and the pack toggle has its own
 *  one-shot. Both are pinned by the recording they play, not just by node counts, because the
 *  whole defect was that the loop resolved to a file the assets step never published. */
describe('repair pack audio (#51)', () => {
  it("plays the beam loop from the pack script's own Repair recording", async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.setRepairBeam(0, true);
    expect(sourceNames(ctx)).toEqual(['/katabatic/audio/repair-beam.m4a']);
    engine.setRepairBeam(0, false);
    expect(ctx._sources[0]?.stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('plays the pack Activate one-shot once per toggle, not once per frame', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.setRepairPack(0, true);
    expect(sourceNames(ctx)).toEqual(['/katabatic/audio/repair-activate.m4a']);
    engine.setRepairPack(0, true);
    expect(ctx._sources).toHaveLength(1);
    engine.setRepairPack(0, false);
    engine.setRepairPack(0, true);
    expect(sourceNames(ctx)).toEqual([
      '/katabatic/audio/repair-activate.m4a',
      '/katabatic/audio/repair-activate.m4a',
    ]);
    vi.unstubAllGlobals();
  });

  it('keeps the beam loop and the activate one-shot on different recordings', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.setRepairPack(0, true);
    engine.setRepairBeam(0, true);
    expect(sourceNames(ctx)).toEqual([
      '/katabatic/audio/repair-activate.m4a',
      '/katabatic/audio/repair-beam.m4a',
    ]);
    vi.unstubAllGlobals();
  });
});

/** Issue #56: chaingun.cs hangs one recording on each image state (Activate, Spinup, Spindown
 *  and EmptySpindown). The sim exposes weaponState rather than those transitions, so the
 *  engine edge-detects; these pin the transitions the sim actually produces. */
describe('chaingun state cues (#56)', () => {
  it("plays Activate, Spinup and Spindown in the script's own order", async () => {
    const { ctx, engine } = await engineWithSamples();
    const cue = (state: WeaponState): void => engine.setChaingunState(0, WeaponId.Chaingun, state);
    cue(WeaponState.Ready); // the slot just became the Chaingun: mount
    cue(WeaponState.SpinUp); // trigger down
    cue(WeaponState.SpinUp); // still spinning
    cue(WeaponState.Firing); // firing: the per-shot one-shots own this state
    cue(WeaponState.Ready); // trigger up
    expect(sourceNames(ctx)).toEqual([
      '/katabatic/audio/chaingun-activate.m4a',
      '/katabatic/audio/chaingun-spinup.m4a',
      '/katabatic/audio/chaingun-spindown.m4a',
    ]);
    vi.unstubAllGlobals();
  });

  it('plays SpinDown on EmptySpindown too (the same stateSound[6] recording)', async () => {
    const { ctx, engine } = await engineWithSamples();
    const cue = (state: WeaponState): void => engine.setChaingunState(0, WeaponId.Chaingun, state);
    cue(WeaponState.Ready);
    cue(WeaponState.SpinUp);
    cue(WeaponState.Firing);
    cue(WeaponState.NoAmmo);
    expect(sourceNames(ctx)).toEqual([
      '/katabatic/audio/chaingun-activate.m4a',
      '/katabatic/audio/chaingun-spinup.m4a',
      '/katabatic/audio/chaingun-spindown.m4a',
    ]);
    vi.unstubAllGlobals();
  });

  it('never plays a chaingun state cue while another weapon is selected', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.setChaingunState(0, WeaponId.Blaster, WeaponState.Ready);
    engine.setChaingunState(0, WeaponId.Spinfusor, WeaponState.Firing);
    engine.setChaingunState(0, WeaponId.Blaster, WeaponState.Ready);
    expect(ctx._sources).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('plays the mount recording once per switch back to the Chaingun', async () => {
    const { ctx, engine } = await engineWithSamples();
    engine.setChaingunState(0, WeaponId.Chaingun, WeaponState.Ready);
    engine.setChaingunState(0, WeaponId.Blaster, WeaponState.Ready);
    engine.setChaingunState(0, WeaponId.Chaingun, WeaponState.Ready);
    expect(sourceNames(ctx)).toEqual([
      '/katabatic/audio/chaingun-activate.m4a',
      '/katabatic/audio/chaingun-activate.m4a',
    ]);
    vi.unstubAllGlobals();
  });
});

/** Issues #51 and #56 both shipped cues whose only defect was a file name the asset manifest
 *  never listed: the engine fetches `<BASE_URL>katabatic/audio/<file>` and warns once when it
 *  404s, so the cue is simply mute. Pinning each new cue to the exact file it must find is the
 *  client half of that contract; `packages/assets/src/audio-sources.ts` is the other half, and
 *  the asset step's output directory is the end-to-end proof. */
describe('cue -> committed recording mapping (#51, #56)', () => {
  it('names the manifest file for every recording this issue pair adds', () => {
    const expectations: Array<[keyof typeof SOUND_FILE, string]> = [
      ['repair-beam', 'repair-beam.m4a'],
      ['repair-activate', 'repair-activate.m4a'],
      ['chaingun-activate', 'chaingun-activate.m4a'],
      ['chaingun-spinup', 'chaingun-spinup.m4a'],
      ['chaingun-spindown', 'chaingun-spindown.m4a'],
      ['grenade-explode', 'grenade-explode.m4a'],
      ['turret-sentry-impact', 'turret-sentry-impact.m4a'],
      ['turret-plasma-impact', 'turret-plasma-impact.m4a'],
      ['medium-footstep', 'medium-footstep.m4a'],
      ['medium-footstep-metal', 'medium-footstep-metal.m4a'],
      ['heavy-footstep', 'heavy-footstep.m4a'],
      ['heavy-footstep-metal', 'heavy-footstep-metal.m4a'],
    ];
    for (const [sound, file] of expectations) expect(SOUND_FILE[sound]).toBe(file);
    // A copy-pasted row would make one cue play another's recording while every assertion
    // above still passed, so the table must also stay one-file-per-cue.
    expect(new Set(Object.values(SOUND_FILE)).size).toBe(Object.keys(SOUND_FILE).length);
  });
});
