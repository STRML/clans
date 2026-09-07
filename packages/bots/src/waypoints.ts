import { activeForceFieldBlockers, type Vec3, type World } from '@clans/sim';

export interface WaypointNode {
  id: number;
  position: Vec3;
  label: string;
}

export interface WaypointGraph {
  nodes: WaypointNode[];
  edges: Map<number, number[]>;
}

const K_NEAREST = 4; // Ours.
const WAYPOINT_EDGE_MAX_DISTANCE = 300; // Ours, meters.

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function addEdge(edges: Map<number, number[]>, a: number, b: number): void {
  const listA = edges.get(a) ?? [];
  if (!listA.includes(b)) listA.push(b);
  edges.set(a, listA);
  const listB = edges.get(b) ?? [];
  if (!listB.includes(a)) listB.push(a);
  edges.set(b, listB);
}

function bfsComponent(start: number, edges: Map<number, number[]>, seen: Uint8Array): number[] {
  const component: number[] = [];
  const queue = [start];
  seen[start] = 1;
  while (queue.length > 0) {
    const id = queue.pop() as number;
    component.push(id);
    for (const next of edges.get(id) ?? []) {
      if (seen[next]) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
  return component;
}

function connectedComponents(nodeCount: number, edges: Map<number, number[]>): number[][] {
  const seen = new Uint8Array(nodeCount);
  const components: number[][] = [];
  for (let start = 0; start < nodeCount; start += 1) {
    if (seen[start]) continue;
    components.push(bfsComponent(start, edges, seen));
  }
  return components;
}

interface ClosestPair {
  a: number;
  b: number;
  d: number;
}

function closestPairBetween(
  nodes: WaypointNode[],
  componentA: number[],
  componentB: number[],
): ClosestPair {
  let best: ClosestPair = { a: -1, b: -1, d: Infinity };
  for (const a of componentA) {
    for (const b of componentB) {
      const d = distance((nodes[a] as WaypointNode).position, (nodes[b] as WaypointNode).position);
      if (d < best.d) best = { a, b, d };
    }
  }
  return best;
}

function closestComponentPair(nodes: WaypointNode[], components: number[][]): ClosestPair {
  let best: ClosestPair = { a: -1, b: -1, d: Infinity };
  for (let ci = 0; ci < components.length; ci += 1) {
    for (let cj = ci + 1; cj < components.length; cj += 1) {
      const candidate = closestPairBetween(
        nodes,
        components[ci] as number[],
        components[cj] as number[],
      );
      if (candidate.d < best.d) best = candidate;
    }
  }
  return best;
}

/** Repeatedly connects the two closest nodes across the two closest components until
 *  only one component remains -- guarantees connectivity regardless of how the
 *  landmarks are actually distributed on a given map, rather than gambling on a single
 *  distance threshold covering every real gap (failure matrix row 15). */
function mergeComponents(nodes: WaypointNode[], edges: Map<number, number[]>): void {
  let components = connectedComponents(nodes.length, edges);
  while (components.length > 1) {
    const { a, b } = closestComponentPair(nodes, components);
    addEdge(edges, a, b);
    components = connectedComponents(nodes.length, edges);
  }
}

export function buildWaypointGraph(
  landmarks: Array<{ position: Vec3; label: string }>,
): WaypointGraph {
  const nodes: WaypointNode[] = landmarks.map((landmark, id) => ({ id, ...landmark }));
  const edges = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i += 1) {
    const ranked = nodes
      .map((n, j) => ({ j, d: distance((nodes[i] as WaypointNode).position, n.position) }))
      .filter((entry) => entry.j !== i)
      .sort((a, b) => a.d - b.d);
    for (const entry of ranked.slice(0, K_NEAREST)) addEdge(edges, i, entry.j);
    for (const entry of ranked) {
      if (entry.d <= WAYPOINT_EDGE_MAX_DISTANCE) addEdge(edges, i, entry.j);
    }
  }
  mergeComponents(nodes, edges);
  return { nodes, edges };
}

/** -1 for an empty graph (no landmarks at all) -- callers (findPath below) must check
 *  for this rather than trusting a fallback id that may not exist; a naive `best = 0`
 *  default here previously crashed findPath's own final lookup (`graph.nodes[0]`) on a
 *  landmark-less graph, since `graph.nodes` never gets a node with id 0 to begin with. */
export function nearestNode(graph: WaypointGraph, position: Vec3): number {
  if (graph.nodes.length === 0) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (const node of graph.nodes) {
    const d = distance(node.position, position);
    if (d < bestDist) {
      bestDist = d;
      best = node.id;
    }
  }
  return best;
}

/** An edge is blocked this tick if the straight segment between its two nodes crosses a
 *  currently-powered enemy force field. Terrain occlusion is deliberately NOT checked
 *  here -- a bot that has to go up and over a hill to use an edge still benefits from
 *  the sim's own ski/jet movement getting it there, the same as a human taking the same
 *  route; hasLineOfSight is reserved for combat perception (Task 4), not pathing. */
function edgeBlocked(world: World, forTeam: number, a: Vec3, b: Vec3): boolean {
  const blockers = activeForceFieldBlockers(world, forTeam);
  if (blockers.length === 0) return false;
  const dx = b.x - a.x,
    dy = b.y - a.y,
    dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return false;
  // Reuses hasLineOfSight purely as a segment-vs-terrain-height march; force fields are
  // thin vertical quads (baseObjects.ts's forceFieldQuad), so a cheap sampled check along
  // the segment against each blocker's own bounding box is enough for a coarse graph --
  // ours: not a real geometric raycast against the field's InteriorInstance triangles, which
  // would require importing raycastInteriors here and duplicating movement.ts's own sweep.
  // Adapted from the plan's draft, which referenced a `.position` field InteriorInstance
  // does not have (real shape: `bounds: {minX,minY,minZ,maxX,maxY,maxZ}`, `worldPositions`,
  // `grid` — no single center point), so this checks the segment sample against each
  // blocker's own world-space AABB directly instead. See Spec gaps.
  const steps = Math.max(1, Math.ceil(length / 10));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const point = { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t };
    for (const blocker of blockers) {
      const margin = 1; // Ours: small margin so a segment grazing the field's edge still counts.
      if (
        point.x >= blocker.bounds.minX - margin &&
        point.x <= blocker.bounds.maxX + margin &&
        point.z >= blocker.bounds.minZ - margin &&
        point.z <= blocker.bounds.maxZ + margin
      ) {
        return true;
      }
    }
  }
  return false;
}

interface QueueEntry {
  id: number;
  cost: number;
}

interface DijkstraState {
  dist: Map<number, number>;
  prev: Map<number, number>;
}

/** Relaxes one edge from `current` to `neighborId`, skipping it if a currently-powered
 *  enemy force field crosses it (re-checked fresh every call, never cached — failure
 *  matrix row 16) or if it doesn't improve on the neighbor's best known cost so far. */
function relaxNeighbor(
  graph: WaypointGraph,
  world: World,
  forTeam: number,
  state: DijkstraState,
  queue: QueueEntry[],
  current: QueueEntry,
  neighborId: number,
): void {
  const a = (graph.nodes[current.id] as WaypointNode).position;
  const b = (graph.nodes[neighborId] as WaypointNode).position;
  if (edgeBlocked(world, forTeam, a, b)) return;
  const cost = current.cost + distance(a, b);
  if (cost >= (state.dist.get(neighborId) ?? Infinity)) return;
  state.dist.set(neighborId, cost);
  state.prev.set(neighborId, current.id);
  queue.push({ id: neighborId, cost });
}

/** Dijkstra, not A* -- the spec's own bots section names A* for a full navmesh; this
 *  plan's graph tops out around 40 nodes for Katabatic (see Task 8's landmark count), so
 *  a heuristic buys nothing measurable and Dijkstra is simpler to get right. See Spec
 *  gaps. */
function runDijkstra(
  graph: WaypointGraph,
  world: World,
  forTeam: number,
  startId: number,
  goalId: number,
): DijkstraState {
  const state: DijkstraState = { dist: new Map([[startId, 0]]), prev: new Map() };
  const queue: QueueEntry[] = [{ id: startId, cost: 0 }];
  const visited = new Set<number>();
  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift() as QueueEntry;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.id === goalId) break;
    for (const neighborId of graph.edges.get(current.id) ?? []) {
      relaxNeighbor(graph, world, forTeam, state, queue, current, neighborId);
    }
  }
  return state;
}

function reconstructPath(
  prev: Map<number, number>,
  startId: number,
  goalId: number,
): number[] | null {
  const nodeIds: number[] = [goalId];
  let walk = goalId;
  while (walk !== startId) {
    const p = prev.get(walk);
    if (p === undefined) return null; // Disconnected after all (blocked edges pruned the only route).
    nodeIds.unshift(p);
    walk = p;
  }
  return nodeIds;
}

export function findPath(
  graph: WaypointGraph,
  world: World,
  forTeam: number,
  from: Vec3,
  to: Vec3,
): Vec3[] | null {
  // No landmarks at all -- e.g. a caller that built the graph with an empty landmark
  // list. Nothing to route through; the caller (steering.ts's ensurePath) already
  // falls back to a direct path straight at the goal when findPath returns null.
  if (graph.nodes.length === 0) return null;
  const startId = nearestNode(graph, from);
  const goalId = nearestNode(graph, to);
  const { dist, prev } = runDijkstra(graph, world, forTeam, startId, goalId);
  if (!dist.has(goalId)) return null;
  const nodeIds = reconstructPath(prev, startId, goalId);
  if (nodeIds === null) return null;
  return [from, ...nodeIds.map((id) => (graph.nodes[id] as WaypointNode).position), to];
}
