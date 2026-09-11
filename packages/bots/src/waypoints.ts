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

// Issue #32 stepping stones. The production landmark set has nothing in the midfield --
// every landmark sits at a base, a tower, or a pad -- so inter-base routes cross the map
// on mergeComponents bridges of 440-470 m (measured on Katabatic: tower-to-tower 442 m,
// team-2 deck relay to team-1 tower relay 469 m). A single straight bearing that long is
// unfollowable on foot: local avoidance slides a bot along whatever wall it meets with no
// sense of the route 400 m away, and the stuck ladder's skips are useless because the
// "next waypoint" is half a kilometre off. Walking each long edge and dropping standable
// stepping stones every EDGE_STONE_STEP_M turns one impossible leg into a chain of
// ordinary ones -- same geometry, same total cost, but each hop is short enough that
// wall-slide, ski and slope-assist make real progress node to node. This reuses the same
// clearance-validated graph machinery; it is not a second pathfinder.
const EDGE_SUBDIVIDE_MIN_M = 120; // Ours, meters: shorter legs are already followable.
const EDGE_STONE_STEP_M = 80; // Ours, meters: two bot-visibilities per hop.

/** Removes one undirected edge. */
function removeEdge(edges: Map<number, number[]>, a: number, b: number): void {
  edges.set(
    a,
    (edges.get(a) ?? []).filter((id) => id !== b),
  );
  edges.set(
    b,
    (edges.get(b) ?? []).filter((id) => id !== a),
  );
}

/** Snap one stone to the standable surface under the parent edge's line (plus headroom),
 *  mirroring relayCandidates' snap -- -Infinity when nothing standable is below. */
function stonePosition(world: World, a: Vec3, b: Vec3, t: number): Vec3 {
  const ceiling = a.y + (b.y - a.y) * t + 2;
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  const y = standableYAt(world, x, z, ceiling);
  return { x, y, z };
}

// Issue #32 terrain-profile lines. A straight bridge dropped on Katabatic cuts across
// whatever the terrain does between its endpoints, and the stones inherit that profile
// verbatim: measured on the team-2-flag to midfield-tower bridge -- (-569, 88, -334) to
// (-280, 169, 26), the route's first long hop home -- the straight line is 565 m of
// walking that climbs 186 m and includes a 77 m leg falling 100 m at gradient -1.29
// (52 degrees). That descent is the carrier's own death mode: steering.ts's fall-arrest
// note measures landing hits of 0.05-0.29 at 30-90 m/s exactly there, and every carrier
// death in the seed-1 trace was `attackerId -1`. The same terrain routed properly is 693 m
// with 120 m of climb and a worst descent of 0.66 (measured with the search below at this
// file's own constants: PROFILE_CHAIN_ASCENT_PENALTY 4, PROFILE_CHAIN_MAX_GRADE 0.7) --
// 36% less climbing and no cliff, paid for with 23% more length. So a long edge now
// carries whichever of the two lines is better on length-plus-climb (profileLineWorthCarrying
// below), and the straight chain it is compared against is byte-for-byte the pre-#32 one,
// so an edge whose terrain offers nothing better is unchanged. Applied to every long edge
// rather than to a carrier's route alone: the graph is built once, shared by both teams,
// and the two lines' cost difference (climb) is paid by whichever bot walks the edge --
// the carrier most of all, since the climb spends the energy its fall arrest needs.
const PROFILE_CHAIN_CELL_M = 8; // Ours, meters: one Katabatic terrain square (terrain.json
// squareSize 8) -- a finer lattice only re-samples the same bilinear field.
/** Issue #32: the profile line's hop length -- half the straight chain's
 *  EDGE_STONE_STEP_M, because the bot walks a STRAIGHT line between consecutive
 *  waypoints: an 80 m hop across a curving lattice path cuts the corner and puts the bot
 *  back onto the ground the profile was routed around. Measured end to end on the
 *  acceptance telemetry sweep (4 seeds x 12000 ticks, 13-18 carrier runs each): at this
 *  spacing 112 kills and 17970 of 48000 ticks with both flags carried, at the straight
 *  chain's own 80 m spacing 97 kills and 20530 ticks; the individual capture/reach numbers
 *  (0-1 of 4 seeds, best approach 0-86 m) move with sub-10 m stone placement across all
 *  these spacings, so they are knife-edge and are NOT what this constant is chosen on. */
const PROFILE_CHAIN_STONE_STEP_M = EDGE_STONE_STEP_M / 2; // Ours, meters.
const PROFILE_CHAIN_MARGIN_M = 120; // Ours, meters of room either side of the straight
// line for the search to leave it. Measured: the best crossing of the bridge above ran
// 48 m outside the endpoints' bounding box at its widest, so 120 m is generous headroom.
const PROFILE_CHAIN_MAX_GRADE = 0.7; // Ours: rise/run, ~35 degrees. Above this the bot is
// skiing or jetting, not walking, which is what turns a descent into a 30-90 m/s landing.
// The straight chain above used gradient 1.29 legs; capped at 0.7 they become ordinary.
const PROFILE_CHAIN_ASCENT_PENALTY = 4; // Ours: meters of route cost charged per meter
// climbed (descent is free -- the sim's ski assists it). Sized from the same measurement:
// at 4 the bridge above buys 66 m of climb back for 128 m of length, which is the trade
// the carrier's energy reserve and its fall arrest both want.
const PROFILE_CHAIN_LENGTH_BUDGET = 1.35; // Ours: a profile line longer than this multiple
// of the straight line's own length is not built at all -- the route's exposure time is a
// real cost too, and the measured lines land at 1.23. See CARRIER_ROUTE_LENGTH_BUDGET for
// the separate cap on how far a carrier's WHOLE route may stretch to use one.

/** Turret engagement envelopes are captured in the slice's report, not consumed here:
 *  measured on this build, a route that trades climb for envelope cover buys 37-66 m of
 *  ascent back with ~100 m inside a plasma turret's reach, and every weighted route this
 *  file's search can produce on Katabatic is byte-identical to the unweighted one (the
 *  corridor has no alternative). See the report's envelope-coverage table. */

interface ChainGrid {
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  height: Float64Array;
  walkable: Uint8Array;
}

interface ChainFrontier {
  cells: number[];
  costs: number[];
}

/** Binary min-heap push -- the chain search's frontier. The waypoint graph's own Dijkstra
 *  can afford a linear scan per pop (476 nodes today), but every long edge's chain search
 *  sweeps a few thousand terrain cells and `subdivideLongEdges` runs over every long edge
 *  at once, where an O(n^2) scan costs whole seconds of server start. */
function frontierPush(frontier: ChainFrontier, cell: number, cost: number): void {
  frontier.cells.push(cell);
  frontier.costs.push(cost);
  let child = frontier.cells.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    if ((frontier.costs[parent] as number) <= (frontier.costs[child] as number)) return;
    swapFrontier(frontier, parent, child);
    child = parent;
  }
}

function swapFrontier(frontier: ChainFrontier, a: number, b: number): void {
  const cell = frontier.cells[a] as number;
  const cost = frontier.costs[a] as number;
  frontier.cells[a] = frontier.cells[b] as number;
  frontier.costs[a] = frontier.costs[b] as number;
  frontier.cells[b] = cell;
  frontier.costs[b] = cost;
}

/** Pops the cheapest cell. Duplicate entries for a cell are left to the caller's settled
 *  check, the same way runDijkstra's visited set handles them. */
function frontierPop(frontier: ChainFrontier): number {
  const top = frontier.cells[0] as number;
  const lastCell = frontier.cells.pop() as number;
  const lastCost = frontier.costs.pop() as number;
  if (frontier.cells.length > 0) {
    frontier.cells[0] = lastCell;
    frontier.costs[0] = lastCost;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let best = parent;
      if (
        left < frontier.cells.length &&
        (frontier.costs[left] as number) < (frontier.costs[best] as number)
      ) {
        best = left;
      }
      if (
        right < frontier.cells.length &&
        (frontier.costs[right] as number) < (frontier.costs[best] as number)
      ) {
        best = right;
      }
      if (best === parent) return top;
      swapFrontier(frontier, parent, best);
      parent = best;
    }
  }
  return top;
}

/** The terrain around a long edge, as a lattice of standable-on-terrain cells. Terrain
 *  holes (Katabatic's base cut-outs) are unwalkable: the search is for the open-terrain
 *  profile of a midfield bridge, and a chain through a base interior is rejected by the
 *  interior-clearance check anyway. */
function chainGrid(world: World, a: Vec3, b: Vec3): ChainGrid {
  const spanX = Math.abs(b.x - a.x) + 2 * PROFILE_CHAIN_MARGIN_M;
  const spanZ = Math.abs(b.z - a.z) + 2 * PROFILE_CHAIN_MARGIN_M;
  const nx = Math.ceil(spanX / PROFILE_CHAIN_CELL_M) + 1;
  const nz = Math.ceil(spanZ / PROFILE_CHAIN_CELL_M) + 1;
  const x0 = Math.min(a.x, b.x) - PROFILE_CHAIN_MARGIN_M;
  const z0 = Math.min(a.z, b.z) - PROFILE_CHAIN_MARGIN_M;
  const grid: ChainGrid = {
    x0,
    z0,
    nx,
    nz,
    height: new Float64Array(nx * nz),
    walkable: new Uint8Array(nx * nz),
  };
  for (let ix = 0; ix < nx; ix += 1) {
    for (let iz = 0; iz < nz; iz += 1) {
      const sample = sampleTerrain(
        world.terrain,
        x0 + ix * PROFILE_CHAIN_CELL_M,
        z0 + iz * PROFILE_CHAIN_CELL_M,
      );
      if (sample.empty) continue;
      const cell = ix * nz + iz;
      grid.walkable[cell] = 1;
      grid.height[cell] = sample.height ?? 0;
    }
  }
  return grid;
}

function gridCellPosition(grid: ChainGrid, cell: number): Vec3 {
  const ix = Math.floor(cell / grid.nz);
  return {
    x: grid.x0 + ix * PROFILE_CHAIN_CELL_M,
    y: grid.height[cell] as number,
    z: grid.z0 + (cell % grid.nz) * PROFILE_CHAIN_CELL_M,
  };
}

/** The walkable cell nearest to `point`, searched over a fixed window wide enough to jump
 *  a base cut-out (120 m of cells at 8 m) -- the bridge endpoints frequently sit on one. */
function nearestGridCell(grid: ChainGrid, point: Vec3): number {
  const cx = Math.round((point.x - grid.x0) / PROFILE_CHAIN_CELL_M);
  const cz = Math.round((point.z - grid.z0) / PROFILE_CHAIN_CELL_M);
  const window = 15;
  let best = -1;
  let bestDistance = Infinity;
  for (let dx = -window; dx <= window; dx += 1) {
    for (let dz = -window; dz <= window; dz += 1) {
      const ix = cx + dx;
      const iz = cz + dz;
      if (ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz) continue;
      const cell = ix * grid.nz + iz;
      if (grid.walkable[cell] === 0) continue;
      const d = Math.hypot(dx, dz);
      if (d < bestDistance) {
        bestDistance = d;
        best = cell;
      }
    }
  }
  return best;
}

/** Length plus climb for one lattice step, or Infinity when the step is steeper than the
 *  grade cap in either direction -- the cap is what keeps a profile line off cliffs. */
function chainStepCost(grid: ChainGrid, from: number, to: number, flat: number): number {
  const dy = (grid.height[to] as number) - (grid.height[from] as number);
  if (Math.abs(dy) > flat * PROFILE_CHAIN_MAX_GRADE) return Infinity;
  return Math.hypot(flat, dy) + (dy > 0 ? dy * PROFILE_CHAIN_ASCENT_PENALTY : 0);
}

const CHAIN_NEIGHBOUR_STEPS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Relaxes the eight neighbours of one settled cell. Split out of the search loop to keep
 *  that loop's own nesting inside the lint's depth budget. */
function relaxChainCell(
  grid: ChainGrid,
  frontier: ChainFrontier,
  dist: Float64Array,
  prev: Int32Array,
  settled: Uint8Array,
  current: number,
): void {
  const ix = Math.floor(current / grid.nz);
  const iz = current % grid.nz;
  for (const [dx, dz] of CHAIN_NEIGHBOUR_STEPS) {
    const nx = ix + dx;
    const nz = iz + dz;
    if (nx < 0 || nz < 0 || nx >= grid.nx || nz >= grid.nz) continue;
    const next = nx * grid.nz + nz;
    if (grid.walkable[next] === 0 || settled[next] === 1) continue;
    const cost = chainStepCost(grid, current, next, Math.hypot(dx, dz) * PROFILE_CHAIN_CELL_M);
    const candidate = (dist[current] as number) + cost;
    if (candidate >= (dist[next] as number)) continue;
    dist[next] = candidate;
    prev[next] = current;
    frontierPush(frontier, next, candidate);
  }
}

/** Dijkstra over the lattice; the predecessor array back to `start`, or null when no
 *  route under the grade cap exists (a canyon the profile chain cannot cross at all). */
function gridPredecessors(grid: ChainGrid, start: number, goal: number): Int32Array | null {
  const count = grid.nx * grid.nz;
  const dist = new Float64Array(count).fill(Infinity);
  const prev = new Int32Array(count).fill(-1);
  const settled = new Uint8Array(count);
  const frontier: ChainFrontier = { cells: [], costs: [] };
  dist[start] = 0;
  frontierPush(frontier, start, 0);
  while (frontier.cells.length > 0) {
    const current = frontierPop(frontier);
    if (settled[current] === 1) continue;
    settled[current] = 1;
    if (current === goal) return prev;
    relaxChainCell(grid, frontier, dist, prev, settled, current);
  }
  return null;
}

/** Snap a searched cell to the standable surface under it (plus headroom), mirroring
 *  stonePosition -- -Infinity when nothing standable is below. */
function stoneAt(world: World, point: Vec3): Vec3 {
  const y = standableYAt(world, point.x, point.z, point.y + 2);
  return { x: point.x, y, z: point.z };
}

/** True when every point stands on something and every sub-segment of [a, ...stones, b]
 *  stays interior-clear -- the whole-chain acceptance rule the straight chain has always
 *  used, shared so the profile chain cannot commit a chain the straight one would have
 *  refused. */
function chainValid(world: World, points: Vec3[]): boolean {
  for (const point of points) {
    if (point.y === -Infinity) return false;
  }
  for (let i = 0; i + 1 < points.length; i += 1) {
    if (!segmentClearOfInteriors(world.interiors, points[i] as Vec3, points[i + 1] as Vec3)) {
      return false;
    }
  }
  return true;
}

/** The straight-line chain: evenly spaced stones on the a->b line, snapped to the
 *  standable surface. Null when any stone has nothing standable under the line or any
 *  sub-segment crosses interior geometry. */
function straightChain(world: World, a: Vec3, b: Vec3): Vec3[] | null {
  const interiorCount = Math.ceil(distance(a, b) / EDGE_STONE_STEP_M) - 1;
  const chain: Vec3[] = [];
  for (let i = 1; i <= interiorCount; i += 1) {
    chain.push(stonePosition(world, a, b, i / (interiorCount + 1)));
  }
  return chainValid(world, [a, ...chain, b]) ? chain : null;
}

/** The terrain-profile chain: a lattice route around whatever the straight line would
 *  climb over or drop into, thinned back to EDGE_STONE_STEP_M hops so the graph gains
 *  ordinary stones rather than a navmesh. The search runs between the straight chain's
 *  own first and last stones, not the edge's raw endpoints: those two stones are already
 *  proven clear of the base geometry at each end (the straight chain's own acceptance),
 *  whereas a search anchored on a raw endpoint can leave a base through a wall it had to
 *  walk around, and no thinning distance can repair the resulting cut-through. Null when
 *  the lattice search finds nothing or the chain fails the straight chain's own rule. */
function profileChain(world: World, straight: Vec3[], a: Vec3, b: Vec3): Vec3[] | null {
  const from = straight[0] as Vec3;
  const to = straight[straight.length - 1] as Vec3;
  const grid = chainGrid(world, from, to);
  const start = nearestGridCell(grid, from);
  const goal = nearestGridCell(grid, to);
  if (start === -1 || goal === -1) return null;
  const prev = gridPredecessors(grid, start, goal);
  if (prev === null) return null;
  const cells: number[] = [];
  let walk = goal;
  while (walk !== -1) {
    cells.unshift(walk);
    if (walk === start) break;
    walk = prev[walk] as number;
  }
  const stones: Vec3[] = [from];
  let travelled = 0;
  let previous = from;
  for (const cell of cells) {
    const point = gridCellPosition(grid, cell);
    travelled += distance(previous, point);
    previous = point;
    if (
      travelled < PROFILE_CHAIN_STONE_STEP_M ||
      distance(point, to) < PROFILE_CHAIN_STONE_STEP_M / 2
    ) {
      continue;
    }
    stones.push(stoneAt(world, point));
    travelled = 0;
  }
  // The chain always ends on the straight chain's own last stone: its final hop back to
  // the edge's endpoint is the one the straight chain already proved clear, while an
  // arbitrary lattice stone's hop to that same endpoint can cut the corner of whatever
  // structure the endpoint sits in (measured: the first cut of this search failed on
  // exactly that segment, 13 of 13 stones valid and the last hop through a wall).
  stones.push(to);
  return chainValid(world, [a, ...stones, b]) ? stones : null;
}

function chainLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    total += distance(points[i] as Vec3, points[i + 1] as Vec3);
  }
  return total;
}

/** Metres climbed along a chain -- the other half of the profile cost. Descent is
 *  deliberately free: the sim's ski assists it down, it is only the climb that spends the
 *  carrier's energy reserve (steering.ts's CLIMB_ENERGY_RESERVE_FRACTION note). */
function chainAscent(points: Vec3[]): number {
  let ascent = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const dy = (points[i + 1] as Vec3).y - (points[i] as Vec3).y;
    if (dy > 0) ascent += dy;
  }
  return ascent;
}

/** Issue #32: whether a profile line is worth carrying at all -- it must exist and stay
 *  inside the length budget, measured over the full point lists including the edge's own
 *  endpoints so the approach legs count exactly as much as the interior hops. The climb
 *  term is deliberately one-sided: descent is free, because the sim's ski assists it down,
 *  while every metre climbed spends the carrier's energy reserve (steering.ts's
 *  CLIMB_ENERGY_RESERVE_FRACTION note). */
function profileLineWorthCarrying(a: Vec3, b: Vec3, straight: Vec3[], profile: Vec3[]): boolean {
  const straightPoints = [a, ...straight, b];
  const profilePoints = [a, ...profile, b];
  const straightLength = chainLength(straightPoints);
  if (chainLength(profilePoints) > straightLength * PROFILE_CHAIN_LENGTH_BUDGET) return false;
  return (
    chainLength(profilePoints) + PROFILE_CHAIN_ASCENT_PENALTY * chainAscent(profilePoints) <
    straightLength + PROFILE_CHAIN_ASCENT_PENALTY * chainAscent(straightPoints)
  );
}

/** Links a chain's stones between the edge's two endpoint nodes. */
function appendChain(
  nodes: WaypointNode[],
  edges: Map<number, number[]>,
  aId: number,
  bId: number,
  chain: Vec3[],
): void {
  let previous = aId;
  for (const stone of chain) {
    nodes.push({ id: nodes.length, position: stone, label: 'relay' });
    addEdge(edges, previous, nodes.length - 1);
    previous = nodes.length - 1;
  }
  addEdge(edges, previous, bId);
}

/** Replaces long edge a-b with the better of the two lines it can carry (see
 *  profileLineWorthCarrying); leaves the edge untouched when neither chain is acceptable
 *  (a partially followable edge is worse than a connected one -- the chain must never be a
 *  regression). Interior-less worlds are rejected by the caller. */
function insertStoneChain(
  world: World,
  nodes: WaypointNode[],
  edges: Map<number, number[]>,
  aId: number,
  bId: number,
): void {
  const a = (nodes[aId] as WaypointNode).position;
  const b = (nodes[bId] as WaypointNode).position;
  const straight = straightChain(world, a, b);
  // Under two stones the edge is a single hop either way -- nothing for the lattice search
  // to shape, and it would cost a grid sweep to discover that.
  const candidate =
    straight !== null && straight.length >= 2 ? profileChain(world, straight, a, b) : null;
  const chain =
    straight !== null && candidate !== null && profileLineWorthCarrying(a, b, straight, candidate)
      ? candidate
      : straight;
  if (chain === null) return;
  // The chain commits only as a whole: drop the parent edge (equal total cost would let
  // Dijkstra keep routing over the unfollowable straight leg) and link stone to stone.
  removeEdge(edges, aId, bId);
  appendChain(nodes, edges, aId, bId, chain);
}

/** Splits every edge longer than EDGE_SUBDIVIDE_MIN_M into stepping stones. Runs after
 *  mergeComponents so the bridges it invents (the longest edges on any real map) are the
 *  first ones subdivided; connectivity is preserved by construction, so no re-merge is
 *  needed. Interior-less test worlds keep their exact historical graphs. */
function subdivideLongEdges(
  world: World,
  nodes: WaypointNode[],
  edges: Map<number, number[]>,
): void {
  if (world.interiors.length === 0) return;
  const long: Array<[number, number]> = [];
  for (const [aId, list] of edges) {
    for (const bId of list) {
      if (aId > bId) continue; // each undirected edge once
      const d = distance(
        (nodes[aId] as WaypointNode).position,
        (nodes[bId] as WaypointNode).position,
      );
      if (d > EDGE_SUBDIVIDE_MIN_M) long.push([aId, bId]);
    }
  }
  for (const [aId, bId] of long) insertStoneChain(world, nodes, edges, aId, bId);
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
  if (world) subdivideLongEdges(world, nodes, edges);
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
