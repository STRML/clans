import {
  activeForceFieldBlockers,
  raycastInteriors,
  sampleTerrain,
  type InteriorInstance,
  type Vec3,
  type World,
} from '@clans/sim';

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
/** Issue #32: how far each endpoint of a candidate edge is shrunk inward before the
 *  remaining segment is interior-raycast. Katabatic's station/generator landmarks sit
 *  embedded in their own housing geometry (and in the base wall they mount on), so an
 *  un-inset ray "hits a wall" a fraction of a meter from its own start for nearly every
 *  base-object pair and the validated graph would strip itself down to almost nothing
 *  (measured on the production landmark set: 142 of 155 edges blocked un-inset). 2.5 m
 *  matches baseObjects.ts's STATION_USE_RADIUS -- the reach a player is expected to have
 *  from the landmark's own tile -- so a pair of stations in the same room still validates
 *  while a segment crossing a real wall two rooms away does not. Segments shorter than two
 *  insets are clear by definition: both endpoints share whatever pocket they sit in. */
export const WAYPOINT_CLEARANCE_INSET = 2.5; // Ours, meters.

// Issue #32 relay sampling. The production landmarks cluster indoors (every station,
// generator, and pad sits inside a base structure; on Katabatic the flag stands sit on
// the base's open top deck). A graph over ONLY those points has no node a route can
// legally leave the graph from near the flag deck -- every final leg from an indoor node
// pierces the deck edge -- so the validated graph routes bots to the base wall and
// leaves them there. Sampling a fixed, deterministic ring of clearance-verified relay
// nodes around each landmark adds the missing standable points (deck surface, deck-edge
// lips, the ridge dropping onto the deck, doorway aprons) without anything resembling a
// navmesh: candidates are rejected unless the straight segment from their landmark is
// interior-clear, so only genuinely connected, genuinely standable points survive.
const RELAY_RING_RADII_M = [8, 16, 24, 32]; // Ours, meters.
const RELAY_RAY_COUNT = 8; // Ours: compass directions, first pointing +Z.
/** A relay higher than this above its landmark is not "the same place" -- it is a roof
 *  or a ridge top the landmark's local space has no clear relationship to; the
 *  segment-clear test rejects most of those anyway, this keeps candidates honest when
 *  the segment happens to thread an opening. Sized so Katabatic's deck-edge relays
 *  (deck 96 m, flanking ridge terrain ~104 m) still qualify. */
const RELAY_MAX_RISE_M = 8; // Ours, meters.

/** The highest standable surface at (x,z) at or under `ceilingY`: interior geometry
 *  first (raycast down from the ceiling), then terrain. -Infinity when neither exists
 *  (terrain holes report empty). */
function standableYAt(world: World, x: number, z: number, ceilingY: number): number {
  const down = raycastInteriors(world.interiors, { x, y: ceilingY, z }, { x: 0, y: -1, z: 0 }, 400);
  const interiorY = down === null ? -Infinity : ceilingY - down.distance;
  const terrain = sampleTerrain(world.terrain, x, z);
  const terrainY = terrain.empty ? -Infinity : (terrain.height ?? -Infinity);
  return Math.max(interiorY, terrainY);
}

/** Deterministic relay candidates for one landmark: compass rings at fixed radii, each
 *  snapped to the standable surface below the landmark's height (plus headroom), kept
 *  only if it doesn't rise implausibly far above the landmark. Clearance against the
 *  landmark itself is checked by the caller (it needs the interiors list). */
function relayCandidates(world: World, landmark: Vec3): Vec3[] {
  const candidates: Vec3[] = [];
  for (const radius of RELAY_RING_RADII_M) {
    for (let k = 0; k < RELAY_RAY_COUNT; k += 1) {
      const angle = (k * Math.PI) / 4; // RELAY_RAY_COUNT rays around the compass.
      const x = landmark.x + Math.sin(angle) * radius;
      const z = landmark.z + Math.cos(angle) * radius;
      const y = standableYAt(world, x, z, landmark.y + 2);
      if (y === -Infinity || y > landmark.y + RELAY_MAX_RISE_M) continue;
      candidates.push({ x, y, z });
    }
  }
  return candidates;
}

/** Appends clearance-verified relay nodes for every landmark to `nodes`, skipping
 *  duplicates (two landmarks a meter apart must not each spawn the same relay). Only
 *  runs when a real world supplied interiors -- an interior-less flat test world gains
 *  nothing from relays (every segment is already clear) and must keep its exact
 *  historical node set for the existing graph tests. */
function appendRelayNodes(
  world: World,
  landmarks: Array<{ position: Vec3; label: string }>,
  nodes: WaypointNode[],
): void {
  if (world.interiors.length === 0) return;
  const seen = new Set<string>();
  for (const node of nodes) {
    seen.add(
      `${Math.round(node.position.x)},${Math.round(node.position.y)},${Math.round(node.position.z)}`,
    );
  }
  for (const landmark of landmarks) {
    for (const candidate of relayCandidates(world, landmark.position)) {
      const key = `${Math.round(candidate.x)},${Math.round(candidate.y)},${Math.round(candidate.z)}`;
      if (seen.has(key)) continue;
      if (!segmentClearOfInteriors(world.interiors, landmark.position, candidate)) continue;
      seen.add(key);
      nodes.push({ id: nodes.length, position: candidate, label: 'relay' });
    }
  }
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
/** Issue #32: true when the straight segment a->b does not cross any interior triangle.
 *  Both endpoints are inset inward first (WAYPOINT_CLEARANCE_INSET) so landmarks that sit
 *  inside their own housing geometry don't self-block. This is the collision awareness the
 *  original M6 scope note deliberately left out -- importing raycastInteriors here was
 *  avoided "to keep the pathing layer's sim surface minimal", and that avoidance is
 *  exactly why the production landmark graph (every base object, most of them indoors)
 *  routes bots through walls; #32 reverses it. Terrain occlusion stays deliberately
 *  unchecked for the same reason as before: a bot that has to ski up and over a hill
 *  still benefits from the sim's own ski/jet movement, the same as a human taking the
 *  same route, while a wall is impassable for both. */
export function segmentClearOfInteriors(
  interiors: readonly InteriorInstance[],
  a: Vec3,
  b: Vec3,
): boolean {
  if (interiors.length === 0) return true;
  const dx = b.x - a.x,
    dy = b.y - a.y,
    dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (length <= WAYPOINT_CLEARANCE_INSET * 2) return true;
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  const start = {
    x: a.x + direction.x * WAYPOINT_CLEARANCE_INSET,
    y: a.y + direction.y * WAYPOINT_CLEARANCE_INSET,
    z: a.z + direction.z * WAYPOINT_CLEARANCE_INSET,
  };
  return (
    raycastInteriors(interiors, start, direction, length - WAYPOINT_CLEARANCE_INSET * 2) === null
  );
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

/** Repeatedly connects components until only one remains -- guarantees connectivity
 *  regardless of how the landmarks are actually distributed on a given map, rather than
 *  gambling on a single distance threshold covering every real gap (failure matrix row
 *  15). Issue #32: when interiors are supplied, each merge prefers the closest pair of
 *  nodes whose connecting segment is CLEAR of interior geometry, so the bridge edges the
 *  merge invents route around buildings instead of straight through them; the plain
 *  closest pair remains the fallback when every candidate is walled off (a landmark
 *  sealed in a sealed room), because findPath/steering already know how to walk a bot to
 *  a wall and slide along it, while a permanently disconnected component would fall all
 *  the way back to a direct line at the goal. */
function mergeComponents(
  nodes: WaypointNode[],
  edges: Map<number, number[]>,
  interiors: readonly InteriorInstance[],
): void {
  let components = connectedComponents(nodes.length, edges);
  while (components.length > 1) {
    const { a, b } = closestClearComponentPair(nodes, components, interiors);
    addEdge(edges, a, b);
    components = connectedComponents(nodes.length, edges);
  }
}

/** Pair distance as a ClosestPair, so the cross-component enumeration below stays at
 *  the lint's depth cap. */
function pairDistance(nodes: WaypointNode[], a: number, b: number): ClosestPair {
  return {
    a,
    b,
    d: distance((nodes[a] as WaypointNode).position, (nodes[b] as WaypointNode).position),
  };
}

/** The (unsorted) distances between every node pair across two components. */
function pushPairsBetween(
  nodes: WaypointNode[],
  componentA: number[],
  componentB: number[],
  pairs: ClosestPair[],
): void {
  for (const a of componentA) {
    for (const b of componentB) {
      pairs.push(pairDistance(nodes, a, b));
    }
  }
}

/** Every cross-component node pair, closest first. Build-time only -- the production
 *  graph tops out around 40 nodes, so enumerating and sorting at most a few hundred
 *  pairs per merge is noise next to the raycasts the clear scan saves. */
function pairsAcrossComponents(nodes: WaypointNode[], components: number[][]): ClosestPair[] {
  const pairs: ClosestPair[] = [];
  for (let ci = 0; ci < components.length; ci += 1) {
    for (let cj = ci + 1; cj < components.length; cj += 1) {
      pushPairsBetween(nodes, components[ci] as number[], components[cj] as number[], pairs);
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  return pairs;
}

function closestClearComponentPair(
  nodes: WaypointNode[],
  components: number[][],
  interiors: readonly InteriorInstance[],
): ClosestPair {
  if (interiors.length === 0) return closestComponentPair(nodes, components);
  const pairs = pairsAcrossComponents(nodes, components);
  for (const pair of pairs) {
    if (
      segmentClearOfInteriors(
        interiors,
        (nodes[pair.a] as WaypointNode).position,
        (nodes[pair.b] as WaypointNode).position,
      )
    ) {
      return pair;
    }
  }
  return pairs[0] as ClosestPair;
}

/** `world` is optional so existing interior-less callers (unit tests, spawn-only graphs
 *  on flat test terrain) keep their exact historical graphs; with a real world, edges are
 *  interior-validated and clearance-verified relay nodes are appended after the landmark
 *  nodes (landmark ids stay == array indices). */
export function buildWaypointGraph(
  landmarks: Array<{ position: Vec3; label: string }>,
  world?: World | null,
): WaypointGraph {
  const interiors = world?.interiors ?? [];
  const nodes: WaypointNode[] = landmarks.map((landmark, id) => ({ id, ...landmark }));
  if (world) appendRelayNodes(world, landmarks, nodes);
  const edges = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i += 1) {
    const here = (nodes[i] as WaypointNode).position;
    const ranked = nodes
      .map((n, j) => ({ j, d: distance((nodes[i] as WaypointNode).position, n.position) }))
      .filter((entry) => entry.j !== i)
      .sort((a, b) => a.d - b.d);
    // Issue #32: candidate edges whose straight segment crosses real interior geometry
    // are dropped before either acceptance rule sees them -- k-nearest no longer pins a
    // bot to a wall-crossing edge just because it is short, and the 300 m threshold no
    // longer blesses a long one. A node whose every candidate is blocked simply gets no
    // edges here and is rejoined by mergeComponents's clear-preferring bridge instead.
    let added = 0;
    for (const entry of ranked) {
      if (!segmentClearOfInteriors(interiors, here, (nodes[entry.j] as WaypointNode).position)) {
        continue;
      }
      if (added < K_NEAREST || entry.d <= WAYPOINT_EDGE_MAX_DISTANCE) {
        addEdge(edges, i, entry.j);
        added += 1;
      }
    }
  }
  mergeComponents(nodes, edges, interiors);
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
  goalId: number | null,
): DijkstraState {
  const state: DijkstraState = { dist: new Map([[startId, 0]]), prev: new Map() };
  const queue: QueueEntry[] = [{ id: startId, cost: 0 }];
  const visited = new Set<number>();
  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift() as QueueEntry;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (goalId !== null && current.id === goalId) break;
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
/** Issue #32: the node a path should enter/leave the graph through -- the nearest node
 *  whose straight segment from/to `position` is clear of interior geometry, falling back
 *  to the plain nearest node when none is (a goal sealed in a room, or a position pressed
 *  against the very wall the nearest node hides behind). Without the clearance test the
 *  final leg findPath appends after the last graph node is exactly the "straight line
 *  through the same wall" failure #32 root-caused: the route to the node is fine and the
 *  appended leg points into brick. */
function clearEndpointNode(
  graph: WaypointGraph,
  interiors: readonly InteriorInstance[],
  position: Vec3,
): number {
  const nearest = nearestNode(graph, position);
  if (interiors.length === 0 || nearest === -1) return nearest;
  const ranked = graph.nodes
    .map((n) => ({ id: n.id, d: distance(n.position, position) }))
    .sort((a, b) => a.d - b.d);
  for (const entry of ranked) {
    if (
      segmentClearOfInteriors(interiors, position, (graph.nodes[entry.id] as WaypointNode).position)
    ) {
      return entry.id;
    }
  }
  return nearest;
}

/** Issue #32: among the nodes Dijkstra proved reachable, the cheapest place to leave the
 *  graph for the literal goal -- path cost to the node plus the straight final leg, over
 *  nodes whose final leg is interior-clear. Falls back to the plain nearest node (the
 *  pre-#32 choice) when no reachable node has a clear shot, so callers see the same
 *  "no route" contract as before via the dist check in findPath. */
function pickGoalNode(
  graph: WaypointGraph,
  interiors: readonly InteriorInstance[],
  dist: Map<number, number>,
  to: Vec3,
): number {
  let best = -1;
  let bestCost = Infinity;
  for (const [id, pathCost] of dist) {
    const position = (graph.nodes[id] as WaypointNode).position;
    if (!segmentClearOfInteriors(interiors, position, to)) continue;
    const cost = pathCost + distance(position, to);
    if (cost < bestCost) {
      bestCost = cost;
      best = id;
    }
  }
  if (best !== -1) return best;
  return nearestNode(graph, to);
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
  const interiors = world.interiors;
  const startId = clearEndpointNode(graph, interiors, from);
  // Full relaxation, no early exit: pickGoalNode below wants costs for EVERY reachable
  // node -- an early exit at some provisional goal node could finalize the best clear
  // candidate's cost after the pop and hide a strictly cheaper route. The graph tops out
  // around 40 nodes (see the Dijkstra note above), so the extra pops are noise.
  const { dist, prev } = runDijkstra(graph, world, forTeam, startId, null);
  const goalId = pickGoalNode(graph, interiors, dist, to);
  if (goalId === -1 || !dist.has(goalId)) return null;
  const nodeIds = reconstructPath(prev, startId, goalId);
  if (nodeIds === null) return null;
  return [from, ...nodeIds.map((id) => (graph.nodes[id] as WaypointNode).position), to];
}
