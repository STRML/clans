import { describe, expect, it } from 'vitest';
import {
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  type ProjectileImpact,
} from '@clans/sim';
import {
  SPAWN_INDICATOR_LIFETIME_MS,
  SPAWN_INDICATOR_RADIUS_M,
  relativeBearing,
  spawnIndicatorFor,
  syncSpawnIndicators,
  type LocalPose,
  type SpawnIndicator,
} from './weapon-trails.js';

const impact = (over: Partial<ProjectileImpact>): ProjectileImpact => ({
  x: 10,
  y: 0,
  z: 0,
  weaponId: WeaponId.Spinfusor,
  type: ProjectileType.Linear,
  reason: ProjectileImpactReason.Direct,
  seq: 1,
  ...over,
});

const pose = (over: Partial<LocalPose>): LocalPose => ({ x: 0, y: 0, z: 0, yaw: 0, ...over });

describe('relativeBearing', () => {
  // Forward is (sin yaw, 0, cos yaw) and right is (-cos yaw, 0, sin yaw) (movement.ts), which is
  // the frame every cue has to be measured in: the same convention app.ts's aimCamera turns into
  // Three's rotation.y = yaw + PI.
  it('bears dead ahead as 0, to the right as +PI/2 and to the left as -PI/2', () => {
    expect(relativeBearing(pose({}), 0, 20)).toBeCloseTo(0);
    expect(relativeBearing(pose({}), -20, 0)).toBeCloseTo(Math.PI / 2);
    expect(relativeBearing(pose({}), 20, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('bears a point behind the player as +/-PI rather than wrapping to 0', () => {
    expect(Math.abs(relativeBearing(pose({}), 0, -20))).toBeCloseTo(Math.PI);
  });

  it('turns with the yaw: a point along the new forward bears 0', () => {
    expect(relativeBearing(pose({ yaw: Math.PI / 2 }), 20, 0)).toBeCloseTo(0);
    // input.ts accumulates yaw without wrapping, so an unwrapped angle has to work too.
    expect(relativeBearing(pose({ yaw: Math.PI / 2 + 4 * Math.PI }), 20, 0)).toBeCloseTo(0);
  });

  it('measures from the player feet, not from the world origin', () => {
    expect(relativeBearing(pose({ x: 100, z: 100 }), 100, 120)).toBeCloseTo(0);
  });
});

describe('spawnIndicatorFor', () => {
  it('points at a disc that lands within the radius, with its bearing and distance', () => {
    const cue = spawnIndicatorFor(impact({ x: 0, y: 3, z: 4 }), pose({}), 500);
    expect(cue?.bearing).toBeCloseTo(0);
    expect(cue?.distance).toBeCloseTo(5);
    expect(cue?.expiresAtMs).toBe(500 + SPAWN_INDICATOR_LIFETIME_MS);
    expect(cue?.strength).toBe(1);
  });

  it('takes the radius as a 3D distance: a disc landing overhead is not a near miss', () => {
    // 15 m up and 20 m out is 25 m of flight, not 20: a disc that detonated over the player's
    // head is exactly the shot this cue exists for (the Mortar's own radius is 20 m).
    expect(spawnIndicatorFor(impact({ x: 20, y: 15, z: 0 }), pose({}), 0)).not.toBeNull();
    expect(spawnIndicatorFor(impact({ x: 20, y: 15.1, z: 0 }), pose({}), 0)).toBeNull();
  });

  it('cues a landing just inside the radius and none beyond it', () => {
    expect(
      spawnIndicatorFor(impact({ x: SPAWN_INDICATOR_RADIUS_M - 1 }), pose({}), 0),
    ).not.toBeNull();
    expect(spawnIndicatorFor(impact({ x: SPAWN_INDICATOR_RADIUS_M + 1 }), pose({}), 0)).toBeNull();
  });

  it('ignores every weapon that is not the Spinfusor disc', () => {
    expect(
      spawnIndicatorFor(
        impact({ weaponId: WeaponId.Chaingun, type: ProjectileType.Tracer }),
        pose({}),
        0,
      ),
    ).toBeNull();
    expect(
      spawnIndicatorFor(
        impact({ weaponId: WeaponId.Mortar, type: ProjectileType.Grenade }),
        pose({}),
        0,
      ),
    ).toBeNull();
    // A turret barrel's weaponId is the player weapon's +100 (projectiles.ts): somebody else's
    // gun, and not the disc this cue is about.
    expect(
      spawnIndicatorFor(impact({ weaponId: WeaponId.Spinfusor + 100 }), pose({}), 0),
    ).toBeNull();
  });

  it('cues only the two reasons that detonate, never a bounce or a silent timeout', () => {
    // The same split impactEffectFor draws effects on (#52): a Bounce keeps flying and a
    // Linear timeout is a removal, so neither has an explosion to point at.
    expect(
      spawnIndicatorFor(impact({ reason: ProjectileImpactReason.World }), pose({}), 0),
    ).not.toBeNull();
    expect(
      spawnIndicatorFor(impact({ reason: ProjectileImpactReason.Bounce }), pose({}), 0),
    ).toBeNull();
    expect(
      spawnIndicatorFor(impact({ reason: ProjectileImpactReason.Timeout }), pose({}), 0),
    ).toBeNull();
  });
});

describe('syncSpawnIndicators', () => {
  it('adds one cue per accepted record and leaves the rest alone', () => {
    const cues: SpawnIndicator[] = [];
    syncSpawnIndicators(
      cues,
      [impact({ x: 5 }), impact({ x: 400 }), impact({ reason: ProjectileImpactReason.Timeout })],
      pose({}),
      0,
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]?.x).toBe(5);
  });

  it('fades a cue over its lifetime and drops it once it expires', () => {
    const cues: SpawnIndicator[] = [];
    syncSpawnIndicators(cues, [impact({ x: 5 })], pose({}), 0);
    syncSpawnIndicators(cues, [], pose({}), SPAWN_INDICATOR_LIFETIME_MS / 2);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.strength).toBeCloseTo(0.5);
    syncSpawnIndicators(cues, [], pose({}), SPAWN_INDICATOR_LIFETIME_MS);
    expect(cues).toHaveLength(0);
  });

  it('keeps a fading cue where it was put while the player turns to look at it', () => {
    // The bearing is measured once, on the landing frame: re-deriving it from a live yaw would
    // swing the marker around the screen while the player turns toward the shot it marks.
    const cues: SpawnIndicator[] = [];
    syncSpawnIndicators(cues, [impact({ x: -20 })], pose({}), 0);
    const bearing = cues[0]?.bearing;
    expect(bearing).toBeCloseTo(Math.PI / 2);
    syncSpawnIndicators(cues, [], pose({ yaw: Math.PI }), 100);
    expect(cues[0]?.bearing).toBe(bearing);
  });

  it('drops a cue even when the player is never handed another impact', () => {
    const cues: SpawnIndicator[] = [];
    syncSpawnIndicators(cues, [impact({ x: 5 }), impact({ x: 6 })], pose({}), 0);
    expect(cues).toHaveLength(2);
    syncSpawnIndicators(cues, [], pose({}), SPAWN_INDICATOR_LIFETIME_MS + 1);
    expect(cues).toHaveLength(0);
  });
});
