import { describe, expect, it } from 'vitest';
import {
  applyBaseObjectDamage,
  BaseObjectKind,
  createBaseObjects,
  stepPower,
} from './baseObjects.js';
import { createWorld, type Heightfield, type World } from './index.js';
import {
  buildInteriorCollider,
  type InteriorPlacement,
  type InteriorTriangles,
} from './interiors.js';
import { segmentBlockedByInteriors } from './occlusion.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

/** A single quad wall in the plane x = `x`, spanning y 0..4 and z -4..4 — the same shape
 *  projectiles.test.ts's interior fixture uses, parametrized so tests can stack several
 *  walls without them overlapping. */
function wallAtX(x: number): InteriorTriangles {
  const positions = new Float32Array([x, 0, -4, x, 4, -4, x, 4, 4, x, 0, -4, x, 4, 4, x, 0, 4]);
  return { positions };
}
const identity: InteriorPlacement = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
};

/** The projectiles.test.ts force-field matrix's shape: an owner-team generator powering a
 *  field across the segment, plus the opposing team's generator off to the side so the
 *  other team has power of its own. `ownerTeam` owns the field; team `3 - ownerTeam` is
 *  the viewer the blocked cases look through it for. */
function withFieldOwnedBy(ownerTeam: number): World {
  const world = createWorld(flat, 1);
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: ownerTeam, position: { x: 5, y: 0, z: 20 } },
    {
      kind: BaseObjectKind.ForceField,
      team: ownerTeam,
      position: { x: 5, y: 2, z: 0 },
      rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
      scale: { x: 1, y: 4, z: 6 },
    },
    { kind: BaseObjectKind.Generator, team: 3 - ownerTeam, position: { x: 20, y: 2, z: 0 } },
  ]);
  stepPower(world);
  return world;
}

describe('segmentBlockedByInteriors (issue #21/#49 shared interior/force-field sight test)', () => {
  it('never blocks when the world has no interiors and no fields', () => {
    const world = createWorld(flat, 1);
    expect(segmentBlockedByInteriors(world, { x: -2, y: 1, z: 0 }, { x: 8, y: 1, z: 0 }, 1)).toBe(
      false,
    );
  });

  it('blocks a segment that crosses a static interior wall', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallAtX(5), identity)];
    expect(segmentBlockedByInteriors(world, { x: -2, y: 1, z: 0 }, { x: 8, y: 1, z: 0 }, 1)).toBe(
      true,
    );
  });

  it('does not block a segment that misses the wall entirely (parallel, outside its span)', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallAtX(5), identity)];
    // The wall spans z -4..4; a segment at z=6 passes beside it, not through it.
    expect(segmentBlockedByInteriors(world, { x: -2, y: 1, z: 6 }, { x: 8, y: 1, z: 6 }, 1)).toBe(
      false,
    );
  });

  it('does not block when only an endpoint region is near the wall: the segment must actually cross it', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallAtX(5), identity)];
    // Ends short of the wall.
    expect(segmentBlockedByInteriors(world, { x: 0, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }, 1)).toBe(
      false,
    );
    // Starts already past it — occlusion is between the endpoints, not world-wide.
    expect(segmentBlockedByInteriors(world, { x: 6, y: 1, z: 0 }, { x: 8, y: 1, z: 0 }, 1)).toBe(
      false,
    );
  });

  it('never blocks a zero-length segment, even one sitting exactly on the wall', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallAtX(5), identity)];
    expect(segmentBlockedByInteriors(world, { x: 5, y: 1, z: 0 }, { x: 5, y: 1, z: 0 }, 1)).toBe(
      false,
    );
  });

  it('blocks for a viewer the powered force field opposes, but not for the field owner', () => {
    // Team 1 owns the field: the team-2 viewer is blinded by it, the owner is not — the
    // same team-passable rule projectiles already resolve world hits with.
    const world = withFieldOwnedBy(1);
    expect(segmentBlockedByInteriors(world, { x: -2, y: 2, z: 0 }, { x: 8, y: 2, z: 0 }, 2)).toBe(
      true,
    );
    expect(segmentBlockedByInteriors(world, { x: -2, y: 2, z: 0 }, { x: 8, y: 2, z: 0 }, 1)).toBe(
      false,
    );
  });

  it('an unpowered field blocks nobody', () => {
    const world = createWorld(flat, 1);
    // No generator for team 2: stepPower leaves the field unpowered.
    createBaseObjects(world, [
      {
        kind: BaseObjectKind.ForceField,
        team: 2,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
    ]);
    stepPower(world);
    expect(segmentBlockedByInteriors(world, { x: -2, y: 2, z: 0 }, { x: 8, y: 2, z: 0 }, 1)).toBe(
      false,
    );
  });

  it('a field whose powering generator dies blocks nobody', () => {
    // Force fields are invincible to direct damage (forceField.cs: no health of their
    // own -- they die with their generator), so the real way a field stops blocking is
    // its team losing power: kill the owner-team generator (withFieldOwnedBy's first
    // base object), re-run stepPower, and the field drops out of the blocker set.
    const world = withFieldOwnedBy(1);
    applyBaseObjectDamage(world, 0, 1000);
    stepPower(world);
    expect(segmentBlockedByInteriors(world, { x: -2, y: 2, z: 0 }, { x: 8, y: 2, z: 0 }, 2)).toBe(
      false,
    );
  });
});
