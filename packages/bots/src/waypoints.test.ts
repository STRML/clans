import { describe, expect, it } from 'vitest';
import {
  BaseObjectKind,
  buildInteriorCollider,
  createBaseObjects,
  createWorld,
  sampleTerrain,
  stepPower,
  type Heightfield,
  type Vec3,
} from '@clans/sim';
import {
  buildWaypointGraph,
  findPath,
  nearestNode,
  type WaypointGraph,
  type WaypointNode,
} from './waypoints.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 2000,
  originX: -1000,
  originY: 0,
  originZ: -1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

// Issue #32 terrain-profile line fixtures. Both worlds are 640 m across with the two flag
// landmarks 550 m apart on opposite sides of a wall at x=320: `ridgeHeights(true)` makes a
// 100 m wall that only ramps up over 60 m on each side (gradient 1.67, steeper than the
// profile search's own 0.7 cap, so the wall cannot be crossed there) except inside a 60 m
// band around z=450, where the same wall is 15 m tall and its ramps are 0.25 -- the saddle
// the search is supposed to find. `ridgeHeights(false)` is the same grid with no relief, so
// the search must leave the straight line exactly where it was. The lone interior is parked
// 5 km away: the stone subdivision only runs for a world that HAS interiors, and nothing in
// these two worlds should ever raycast against it.
const RIDGE_SIZE = 64;
const RIDGE_SQUARE = 10;
const RIDGE_ORIGIN_Z = 640;
const RIDGE_SADDLE_MIN_Z = 420;
const RIDGE_SADDLE_MAX_Z = 480;
const RIDGE_FROM: Vec3 = { x: 40, y: 0, z: 300 };
const RIDGE_TO: Vec3 = { x: 590, y: 0, z: 300 };

function ridgeTerrain(heights: Uint16Array): Heightfield {
  return {
    gridSize: RIDGE_SIZE,
    squareSize: RIDGE_SQUARE,
    originX: 0,
    originY: 0,
    originZ: RIDGE_ORIGIN_Z,
    heightScale: 1,
    heights,
  };
}

/** 0 outside the wall's footprint, 1 across its top, linear in between. */
function ridgeWallShape(x: number): number {
  if (x <= 220) return 0;
  if (x >= 420) return 0;
  if (x < 280) return (x - 220) / 60;
  if (x > 360) return (420 - x) / 60;
  return 1;
}

function ridgeHeights(withRelief: boolean): Uint16Array {
  const heights = new Uint16Array(RIDGE_SIZE * RIDGE_SIZE);
  if (!withRelief) return heights;
  for (let row = 0; row < RIDGE_SIZE; row += 1) {
    const z = RIDGE_ORIGIN_Z - row * RIDGE_SQUARE;
    const amplitude = z >= RIDGE_SADDLE_MIN_Z && z <= RIDGE_SADDLE_MAX_Z ? 15 : 100;
    for (let col = 0; col < RIDGE_SIZE; col += 1) {
      heights[row * RIDGE_SIZE + col] = Math.round(amplitude * ridgeWallShape(col * RIDGE_SQUARE));
    }
  }
  return heights;
}

/** A world with one parked interior, so buildWaypointGraph's stone subdivision runs. */
function ridgeWorld(terrain: Heightfield) {
  const world = createWorld(terrain, 1);
  world.interiors = [
    buildInteriorCollider(
      { positions: new Float32Array([0, 0, -4, 0, 4, -4, 0, 4, 4, 0, 0, -4, 0, 4, 4, 0, 0, 4]) },
      {
        position: { x: 5000, y: 0, z: 5000 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
      },
    ),
  ];
  return world;
}

/** Ascent (metres climbed) along a polyline -- the profile term both chains and routes are
 *  judged by, computed here independently of the module so the assertion is about what a
 *  consumer of the route sees, not about the module's own bookkeeping. */
function ascent(points: Vec3[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const dy = (points[i + 1] as Vec3).y - (points[i] as Vec3).y;
    if (dy > 0) total += dy;
  }
  return total;
}

function length(points: Vec3[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] as Vec3;
    const b = points[i + 1] as Vec3;
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

/** The stones the subdivision committed to between the two landmark nodes: every relay
 *  further than 60 m from BOTH landmarks -- a landmark's own relay ring never reaches past
 *  32 m, so anything further out is chain geometry. */
function chainStones(graph: WaypointGraph, from: Vec3, to: Vec3): WaypointNode[] {
  return graph.nodes.filter((n) => {
    if (n.label !== 'relay') return false;
    const dFrom = Math.hypot(n.position.x - from.x, n.position.z - from.z);
    const dTo = Math.hypot(n.position.x - to.x, n.position.z - to.z);
    return dFrom > 60 && dTo > 60;
  });
}

/** The chain in walking order, from its stone nearest `from` to the far end. Each stone
 *  has exactly two chain neighbours (the ends have one plus their own relay ring link), so
 *  stepping to the one unvisited chain neighbour walks the committed line exactly. */
function orderChain(graph: WaypointGraph, stones: WaypointNode[], from: Vec3): Vec3[] {
  const byId = new Map(stones.map((n) => [n.id, n]));
  let current = stones.reduce((best, n) =>
    Math.hypot(n.position.x - from.x, n.position.z - from.z) <
    Math.hypot(best.position.x - from.x, best.position.z - from.z)
      ? n
      : best,
  );
  const ordered: Vec3[] = [current.position];
  const seen = new Set<number>([current.id]);
  for (;;) {
    const next = (graph.edges.get(current.id) ?? []).find((id) => byId.has(id) && !seen.has(id));
    if (next === undefined) break;
    current = byId.get(next) as WaypointNode;
    seen.add(next);
    ordered.push(current.position);
  }
  return ordered;
}

/** The terrain's own height profile along the straight line, sampled every 2 m: what the
 *  pre-#32 straight chain would make a bot climb. */
function straightLineProfile(terrain: Heightfield, from: Vec3, to: Vec3): Vec3[] {
  const points: Vec3[] = [];
  const steps = 100;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const sample = sampleTerrain(terrain, x, z);
    points.push({ x, y: sample.height ?? 0, z });
  }
  return points;
}

describe('buildWaypointGraph terrain-profile lines (issue #32)', () => {
  it('a long edge over a wall is routed through the saddle instead of over the crest', () => {
    const terrain = ridgeTerrain(ridgeHeights(true));
    const world = ridgeWorld(terrain);
    const from = {
      ...RIDGE_FROM,
      y: sampleTerrain(terrain, RIDGE_FROM.x, RIDGE_FROM.z).height ?? 0,
    };
    const to = { ...RIDGE_TO, y: sampleTerrain(terrain, RIDGE_TO.x, RIDGE_TO.z).height ?? 0 };
    const graph = buildWaypointGraph(
      [
        { position: from, label: 'flag0' },
        { position: to, label: 'flag1' },
      ],
      world,
    );
    const ordered = orderChain(graph, chainStones(graph, from, to), from);
    expect(ordered.length).toBeGreaterThan(2);
    const chain = [from, ...ordered, to];

    // The straight line climbs the 100 m wall -- 1.67 gradient ramps, past the point any
    // bot walks -- and the committed chain must buy most of that back.
    const straightAscent = ascent(straightLineProfile(terrain, from, to));
    expect(straightAscent).toBeGreaterThan(90);
    expect(ascent(chain)).toBeLessThan(straightAscent * 0.6);

    // It buys it by the saddle, not by some other artifact: the wall's ramps are
    // uncrossable outside the 15 m band, so the chain has to reach it.
    expect(Math.max(...chain.map((p) => p.z))).toBeGreaterThanOrEqual(RIDGE_SADDLE_MIN_Z);

    // The documented budget: never more than 35% longer than the straight line between the
    // two landmarks (PROFILE_CHAIN_LENGTH_BUDGET), so a profile cannot be bought with an
    // unbounded detour.
    const straightDistance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    expect(length(chain)).toBeLessThanOrEqual(straightDistance * 1.35);

    // And the graph stays routable across the committed chain.
    expect(findPath(graph, world, 1, from, to)).not.toBeNull();
  });

  it('leaves a long edge on the straight line when the terrain offers nothing better', () => {
    const terrain = ridgeTerrain(ridgeHeights(false));
    const world = ridgeWorld(terrain);
    const graph = buildWaypointGraph(
      [
        { position: RIDGE_FROM, label: 'flag0' },
        { position: RIDGE_TO, label: 'flag1' },
      ],
      world,
    );
    const stones = chainStones(graph, RIDGE_FROM, RIDGE_TO);
    expect(stones.length).toBeGreaterThan(2);
    // Every stone still sits on the A->B line: the profile search's cost comparison is what
    // rejects a detour that buys nothing, so a flat edge keeps its pre-#32 geometry.
    for (const stone of stones) {
      const t = (stone.position.x - RIDGE_FROM.x) / (RIDGE_TO.x - RIDGE_FROM.x);
      const lineZ = RIDGE_FROM.z + (RIDGE_TO.z - RIDGE_FROM.z) * t;
      expect(Math.hypot(stone.position.z - lineZ, stone.position.y)).toBeLessThan(1);
    }
    expect(findPath(graph, world, 1, RIDGE_FROM, RIDGE_TO)).not.toBeNull();
  });

  it('adds no relay or stone nodes to an interior-less graph', () => {
    // The stone subdivision and the profile search are both world-only: a caller that
    // builds a graph without a world (every existing unit test, and the spawn-only graphs)
    // must keep its exact historical node set.
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 400, y: 0, z: 0 }, label: 'b' },
    ]);
    expect(graph.nodes).toHaveLength(2);
  });
});

describe('buildWaypointGraph', () => {
  it('connects two landmark clusters that are far apart', () => {
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 10, y: 0, z: 0 }, label: 'b' },
      { position: { x: 900, y: 0, z: 0 }, label: 'c' },
      { position: { x: 910, y: 0, z: 0 }, label: 'd' },
    ]);
    // BFS from node 0 must reach every node -- single connected component.
    const seen = new Set([0]);
    const queue = [0];
    while (queue.length > 0) {
      const id = queue.pop() as number;
      for (const next of graph.edges.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(graph.nodes.length);
  });

  it('three disconnected clusters still merge into one component', () => {
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 900, y: 0, z: 0 }, label: 'b' },
      { position: { x: -900, y: 0, z: 900 }, label: 'c' },
    ]);
    const seen = new Set([0]);
    const queue = [0];
    while (queue.length > 0) {
      const id = queue.pop() as number;
      for (const next of graph.edges.get(id) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
    expect(seen.size).toBe(3);
  });
});

describe('findPath', () => {
  it('finds a direct path with no obstruction', () => {
    const world = createWorld(flat, 1);
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 100, y: 0, z: 0 }, label: 'b' },
    ]);
    const path = findPath(graph, world, 1, { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 });
    expect(path).not.toBeNull();
    expect(path?.length).toBeGreaterThan(0);
  });

  it('excludes an edge through a powered enemy force field', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      {
        kind: BaseObjectKind.ForceField,
        team: 2,
        position: { x: 50, y: 0, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 90 },
        scale: { x: 1, y: 20, z: 100 },
      },
    ]);
    stepPower(world); // ForceField.needsPower with no generator -> stays powered=1 by default seed
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 100, y: 0, z: 0 }, label: 'b' },
      { position: { x: 0, y: 0, z: 200 }, label: 'c' },
      { position: { x: 100, y: 0, z: 200 }, label: 'd' },
    ]);
    const direct = findPath(graph, world, 1, { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 });
    // A path still exists (the long way around via c/d), but it must not be the direct
    // a->b edge -- asserted indirectly by requiring more than 2 waypoints.
    expect(direct).not.toBeNull();
    expect((direct as unknown[]).length).toBeGreaterThan(2);
  });

  it('returns null only when no path exists at all', () => {
    const world = createWorld(flat, 1);
    const graph = buildWaypointGraph([{ position: { x: 0, y: 0, z: 0 }, label: 'a' }]);
    const path = findPath(graph, world, 1, { x: 0, y: 0, z: 0 }, { x: 5000, y: 0, z: 5000 });
    expect(path).not.toBeNull(); // a single-node graph still routes to/through its one node
  });
});

describe('nearestNode', () => {
  it('picks the closest node by straight-line distance', () => {
    const graph = buildWaypointGraph([
      { position: { x: 0, y: 0, z: 0 }, label: 'a' },
      { position: { x: 100, y: 0, z: 0 }, label: 'b' },
    ]);
    expect(nearestNode(graph, { x: 10, y: 0, z: 0 })).toBe(0);
    expect(nearestNode(graph, { x: 90, y: 0, z: 0 })).toBe(1);
  });

  it('returns -1 for an empty graph rather than a fallback id that does not exist', () => {
    const graph = buildWaypointGraph([]);
    expect(nearestNode(graph, { x: 0, y: 0, z: 0 })).toBe(-1);
  });
});

describe('findPath on a landmark-less graph', () => {
  it('returns null instead of crashing on an empty graph', () => {
    const world = createWorld(flat, 1);
    const graph = buildWaypointGraph([]);
    expect(findPath(graph, world, 1, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })).toBeNull();
  });
});
