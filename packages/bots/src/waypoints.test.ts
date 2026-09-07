import { describe, expect, it } from 'vitest';
import {
  BaseObjectKind,
  createBaseObjects,
  createWorld,
  stepPower,
  type Heightfield,
} from '@clans/sim';
import { buildWaypointGraph, findPath, nearestNode } from './waypoints.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 2000,
  originX: -1000,
  originY: 0,
  originZ: -1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

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
