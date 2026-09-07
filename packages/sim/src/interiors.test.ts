import { describe, expect, it } from 'vitest';
import {
  buildInteriorCollider,
  raycastInteriors,
  resolveSphereAgainstInteriors,
  type InteriorPlacement,
  type InteriorQueryStats,
  type InteriorTriangles,
} from './interiors.js';

/** A 2x2x2 axis-aligned box centered on the origin in local space, faces wound outward. */
function unitBox(): InteriorTriangles {
  const p: [number, number, number][] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const quad = (a: number, b: number, c: number, d: number): number[] => [
    ...p[a]!,
    ...p[b]!,
    ...p[c]!,
    ...p[a]!,
    ...p[c]!,
    ...p[d]!,
  ];
  const positions = new Float32Array([
    ...quad(0, 3, 2, 1), // -Z
    ...quad(4, 5, 6, 7), // +Z
    ...quad(0, 4, 7, 3), // -X
    ...quad(1, 2, 6, 5), // +X
    ...quad(0, 1, 5, 4), // -Y
    ...quad(3, 7, 6, 2), // +Y
  ]);
  return { positions };
}

const identity: InteriorPlacement = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
};

describe('buildInteriorCollider + raycastInteriors', () => {
  it('hits the near face of an untransformed box from outside', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    const hit = raycastInteriors([instance], { x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
    expect(hit?.distance).toBeCloseTo(4, 1);
    expect(hit?.point.x).toBeCloseTo(-1, 1);
  });
  it('a ray that misses the box entirely returns null', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    const hit = raycastInteriors([instance], { x: -5, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).toBeNull();
  });
  it('respects a translated placement', () => {
    const moved: InteriorPlacement = { ...identity, position: { x: 100, y: 0, z: 0 } };
    const instance = buildInteriorCollider(unitBox(), moved);
    const hit = raycastInteriors([instance], { x: 95, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(99, 1);
  });
  it('respects a 90 degree rotated placement (a box is rotation-symmetric, so rotate a non-cube check via the Y axis on a differently-sized box is unnecessary; this proves the transform pipeline runs, not that rotation changes the hit for a cube)', () => {
    const rotated: InteriorPlacement = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 90 },
    };
    const instance = buildInteriorCollider(unitBox(), rotated);
    const hit = raycastInteriors([instance], { x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
  });
});

describe('resolveSphereAgainstInteriors', () => {
  it('returns null for a sphere well outside the box', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    expect(resolveSphereAgainstInteriors([instance], { x: 10, y: 0, z: 0 }, 0.5)).toBeNull();
  });
  it('pushes a penetrating sphere back out along the nearest face normal', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    // Center 0.7 inside the +X face (face at x=1), radius 0.5: penetration depth 0.5 - 0.3 = 0.2.
    const push = resolveSphereAgainstInteriors([instance], { x: 1.3, y: 0, z: 0 }, 0.5);
    expect(push).not.toBeNull();
    expect(push?.x ?? 0).toBeGreaterThan(0); // pushes further along +X, away from the box interior
    expect(Math.abs(push?.x ?? 0)).toBeCloseTo(0.2, 1);
  });
  it('an empty interior list always returns null', () => {
    expect(resolveSphereAgainstInteriors([], { x: 0, y: 0, z: 0 }, 1)).toBeNull();
  });
});

/** Twenty separate 1x1x1 boxes ("posts"), spaced 4 m apart along X, each its own pair of
 *  triangles in one shared triangle soup. Real Katabatic interiors are single connected
 *  meshes, but a sparse row of separated clusters is what actually proves cell-locality:
 *  a query near post 0 has no business touching the cells around post 19, and a brute-force
 *  scan (or a single whole-interior AABB reject, which is all the pre-grid draft had) cannot
 *  tell the difference — it always tests every triangle once inside the reject. */
function postRow(count: number): InteriorTriangles {
  const tris: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = i * 4;
    // One quad (2 triangles) per post, facing -X, so a ray along +X hits it squarely.
    tris.push(x, -0.5, -0.5, x, 0.5, -0.5, x, 0.5, 0.5, x, -0.5, -0.5, x, 0.5, 0.5, x, -0.5, 0.5);
  }
  return { positions: new Float32Array(tris) };
}

describe('uniform grid cell locality (spec: "per-interior triangle meshes with a BVH")', () => {
  it('a ray only visits the cells along its own short segment, not the whole row', () => {
    const instance = buildInteriorCollider(postRow(20), identity);
    const stats: InteriorQueryStats = { cellsVisited: 0, trianglesTested: 0 };
    // Post 0 is at x=0; this ray only travels from x=-2 to x=2, nowhere near posts 5-19.
    const hit = raycastInteriors([instance], { x: -2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 4, stats);
    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(0, 1);
    // The grid cell size is 2 m (this plan's "ours" table); a 4 m segment crosses at most a
    // handful of cells, never all 20 posts' worth.
    expect(stats.cellsVisited).toBeLessThan(6);
    expect(stats.trianglesTested).toBeLessThan(6);
  });
  it('a sphere query only visits the cells its own bounding box overlaps', () => {
    const instance = buildInteriorCollider(postRow(20), identity);
    const stats: InteriorQueryStats = { cellsVisited: 0, trianglesTested: 0 };
    // Post 0's quad sits flush at x=0; distance from this center to it is 0.4, so the sphere
    // needs radius > 0.4 to actually penetrate it (the plan's original 0.3 never touches the
    // quad at all — geometry bug in the plan's own fixture, fixed here to a radius that does).
    const push = resolveSphereAgainstInteriors([instance], { x: 0.4, y: 0, z: 0 }, 0.5, stats);
    expect(push).not.toBeNull();
    expect(stats.cellsVisited).toBeLessThan(6);
    expect(stats.trianglesTested).toBeLessThan(6);
  });
  it('correctness is unaffected by the acceleration structure: a ray that only reaches post 0 never reports post 1', () => {
    const instance = buildInteriorCollider(postRow(20), identity);
    const hit = raycastInteriors([instance], { x: -2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 2.4);
    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(0, 1); // post 0, not post 1 at x=4
  });
});

describe('benchmark: query time stays under budget on a Katabatic-scale interior', () => {
  /** 5,000 triangles is a conservative over-estimate for one real Katabatic interior — Task
   *  9's measured real total across all 19 needed .glb files is 1,278,076 bytes, and a shape
   *  that size rarely reaches even a tenth this triangle count. A flat grid of small quads
   *  filling a 30 x 4 x 20 m volume (a generous interior footprint) stands in for the real
   *  geometry without needing network access in this unit test. */
  function denseInterior(triangleCount: number): InteriorTriangles {
    const quads = Math.ceil(triangleCount / 2);
    const cols = Math.ceil(Math.sqrt(quads));
    const positions = new Float32Array(quads * 18);
    for (let i = 0; i < quads; i += 1) {
      const gx = (i % cols) * (30 / cols) - 15;
      const gz = Math.floor(i / cols) * (20 / cols) - 10;
      const o = i * 18;
      positions.set(
        [
          gx,
          0,
          gz,
          gx + 0.2,
          4,
          gz,
          gx + 0.2,
          4,
          gz + 0.2,
          gx,
          0,
          gz,
          gx + 0.2,
          4,
          gz + 0.2,
          gx,
          0,
          gz + 0.2,
        ],
        o,
      );
    }
    return { positions };
  }

  it('raycastInteriors averages under 50 microseconds per call against a 5,000-triangle interior', () => {
    const instance = buildInteriorCollider(denseInterior(5000), identity);
    const iterations = 10000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      raycastInteriors([instance], { x: -20, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 40);
    }
    const microsPerCall = ((performance.now() - start) * 1000) / iterations;
    expect(microsPerCall).toBeLessThan(50);
  });

  it('resolveSphereAgainstInteriors averages under 50 microseconds per call against the same interior', () => {
    const instance = buildInteriorCollider(denseInterior(5000), identity);
    const iterations = 10000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      resolveSphereAgainstInteriors([instance], { x: 0.1, y: 2, z: 0.1 }, 0.6);
    }
    const microsPerCall = ((performance.now() - start) * 1000) / iterations;
    expect(microsPerCall).toBeLessThan(50);
  });
});
