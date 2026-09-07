import type { Vec3 } from './types.js';

export interface InteriorTriangles {
  /** Local-space triangle soup: 9 floats per triangle (3 verts x xyz), no index buffer. */
  positions: Float32Array;
}
export interface InteriorPlacement {
  position: Vec3;
  rotation: { axis: Vec3; degrees: number };
}
interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}
/** A uniform grid over one interior instance's world-space triangles, built once at load
 *  (`buildInteriorCollider`, right below) and never rebuilt — Katabatic's interiors never
 *  move. `cellStart` is a CSR prefix-sum array (length `dimX*dimY*dimZ + 1`); cell `c`'s
 *  triangle indices live at `triangleIndices[cellStart[c] .. cellStart[c+1])`. This is what
 *  the spec's "per-interior triangle meshes with a BVH for buildings" asks for — a uniform
 *  grid, not a hierarchical tree, is the simpler of the two well-known static-scene
 *  acceleration structures and is enough for Katabatic's small, roughly-convex rooms. See
 *  this plan's Global Constraints. */
interface UniformGrid {
  cellSize: number;
  minX: number;
  minY: number;
  minZ: number;
  dimX: number;
  dimY: number;
  dimZ: number;
  cellStart: Int32Array;
  triangleIndices: Int32Array;
}

/** Ours — see this plan's "ours" numbers table. Small enough that a typical Katabatic
 *  corridor (a few metres wide) spans only 1-2 cells per axis. */
const GRID_CELL_SIZE = 2;

export interface InteriorInstance {
  /** World-space triangle soup, already transformed once at build time — Katabatic's
   *  interiors never move, so this pays the rotation/translation cost exactly once instead
   *  of every tick. */
  worldPositions: Float32Array;
  bounds: Aabb;
  grid: UniformGrid;
}

/** An optional out-parameter both query functions below mutate in place when supplied —
 *  never allocated when omitted, so a caller that does not care (every M1-M3-style test,
 *  and any hot path that skips it) pays nothing extra. Feeds the spec's Debug mode "interior
 *  BVH" stat and this task's own cell-locality tests. */
export interface InteriorQueryStats {
  cellsVisited: number;
  trianglesTested: number;
}

function axisAngleToMatrix(axis: Vec3, degrees: number): number[] {
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const x = axis.x / len,
    y = axis.y / len,
    z = axis.z / len;
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad),
    s = Math.sin(rad),
    t = 1 - c;
  // Row-major 3x3 rotation matrix, standard axis-angle (Rodrigues) form.
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

function applyPlacement(m: number[], p: InteriorPlacement, x: number, y: number, z: number): Vec3 {
  return {
    x: (m[0] ?? 1) * x + (m[1] ?? 0) * y + (m[2] ?? 0) * z + p.position.x,
    y: (m[3] ?? 0) * x + (m[4] ?? 1) * y + (m[5] ?? 0) * z + p.position.y,
    z: (m[6] ?? 0) * x + (m[7] ?? 0) * y + (m[8] ?? 1) * z + p.position.z,
  };
}

function boundsOf(positions: Float32Array): Aabb {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0,
      y = positions[i + 1] ?? 0,
      z = positions[i + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function triangleAabb(positions: Float32Array, i: number): Aabb {
  const ax = positions[i] ?? 0,
    ay = positions[i + 1] ?? 0,
    az = positions[i + 2] ?? 0;
  const bx = positions[i + 3] ?? 0,
    by = positions[i + 4] ?? 0,
    bz = positions[i + 5] ?? 0;
  const cx = positions[i + 6] ?? 0,
    cy = positions[i + 7] ?? 0,
    cz = positions[i + 8] ?? 0;
  return {
    minX: Math.min(ax, bx, cx),
    minY: Math.min(ay, by, cy),
    minZ: Math.min(az, bz, cz),
    maxX: Math.max(ax, bx, cx),
    maxY: Math.max(ay, by, cy),
    maxZ: Math.max(az, bz, cz),
  };
}

type GridShape = Pick<
  UniformGrid,
  'minX' | 'minY' | 'minZ' | 'cellSize' | 'dimX' | 'dimY' | 'dimZ'
>;

function clampCell(v: number, dim: number): number {
  return Math.min(Math.max(v, 0), dim - 1);
}

function cellCoordFor(grid: GridShape, p: Vec3): [number, number, number] {
  return [
    clampCell(Math.floor((p.x - grid.minX) / grid.cellSize), grid.dimX),
    clampCell(Math.floor((p.y - grid.minY) / grid.cellSize), grid.dimY),
    clampCell(Math.floor((p.z - grid.minZ) / grid.cellSize), grid.dimZ),
  ];
}

function cellIndex(
  grid: Pick<GridShape, 'dimX' | 'dimY'>,
  x: number,
  y: number,
  z: number,
): number {
  return (z * grid.dimY + y) * grid.dimX + x;
}

function visitRow(
  grid: GridShape,
  x0: number,
  x1: number,
  y: number,
  z: number,
  visit: (i: number) => void,
): void {
  for (let x = x0; x <= x1; x += 1) visit(cellIndex(grid, x, y, z));
}

/** Every cell an AABB overlaps, inclusive. Kept to depth 3 (function -> for -> for -> call)
 *  by delegating the innermost loop to `visitRow`. */
function forEachOverlappedCell(grid: GridShape, box: Aabb, visit: (i: number) => void): void {
  const [x0, y0, z0] = cellCoordFor(grid, { x: box.minX, y: box.minY, z: box.minZ });
  const [x1, y1, z1] = cellCoordFor(grid, { x: box.maxX, y: box.maxY, z: box.maxZ });
  for (let z = z0; z <= z1; z += 1) {
    for (let y = y0; y <= y1; y += 1) visitRow(grid, x0, x1, y, z, visit);
  }
}

function buildUniformGrid(positions: Float32Array, bounds: Aabb): UniformGrid {
  const cellSize = GRID_CELL_SIZE;
  const dimX = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
  const dimY = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSize));
  const dimZ = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cellSize));
  const grid: GridShape = {
    cellSize,
    minX: bounds.minX,
    minY: bounds.minY,
    minZ: bounds.minZ,
    dimX,
    dimY,
    dimZ,
  };
  const cellCount = dimX * dimY * dimZ;
  const triangleCount = positions.length / 9;
  const counts = new Int32Array(cellCount);
  for (let t = 0; t < triangleCount; t += 1) {
    forEachOverlappedCell(grid, triangleAabb(positions, t * 9), (i) => {
      counts[i] = (counts[i] ?? 0) + 1;
    });
  }
  const cellStart = new Int32Array(cellCount + 1);
  for (let c = 0; c < cellCount; c += 1) cellStart[c + 1] = (cellStart[c] ?? 0) + (counts[c] ?? 0);
  const cursor = cellStart.slice(0, cellCount);
  const triangleIndices = new Int32Array(cellStart[cellCount] ?? 0);
  for (let t = 0; t < triangleCount; t += 1) {
    forEachOverlappedCell(grid, triangleAabb(positions, t * 9), (i) => {
      triangleIndices[cursor[i] ?? 0] = t;
      cursor[i] = (cursor[i] ?? 0) + 1;
    });
  }
  return { ...grid, cellStart, triangleIndices };
}

export function buildInteriorCollider(
  triangles: InteriorTriangles,
  placement: InteriorPlacement,
): InteriorInstance {
  const m = axisAngleToMatrix(placement.rotation.axis, placement.rotation.degrees);
  const src = triangles.positions;
  const worldPositions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const world = applyPlacement(m, placement, src[i] ?? 0, src[i + 1] ?? 0, src[i + 2] ?? 0);
    worldPositions[i] = world.x;
    worldPositions[i + 1] = world.y;
    worldPositions[i + 2] = world.z;
  }
  const bounds = boundsOf(worldPositions);
  return { worldPositions, bounds, grid: buildUniformGrid(worldPositions, bounds) };
}

/** Slab-method ray/AABB test, returning the entry/exit distances instead of a bare boolean
 *  so callers can start a grid walk at the point the ray actually enters the bounds, not at
 *  `origin` (which may be well outside them). */
function rayAabbInterval(
  bounds: Aabb,
  origin: Vec3,
  inv: Vec3,
  maxDistance: number,
): { tMin: number; tMax: number } | null {
  let tMin = 0,
    tMax = maxDistance;
  const axes: Array<[number, number, number, number]> = [
    [origin.x, inv.x, bounds.minX, bounds.maxX],
    [origin.y, inv.y, bounds.minY, bounds.maxY],
    [origin.z, inv.z, bounds.minZ, bounds.maxZ],
  ];
  for (const [o, invD, lo, hi] of axes) {
    let t1 = (lo - o) * invD;
    let t2 = (hi - o) * invD;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return { tMin, tMax };
}

/** Möller–Trumbore ray/triangle intersection, single-sided (Katabatic's interiors are closed
 *  solids, so we only care about the entry face). Returns the hit distance, or null. */
function rayTriangle(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  maxDistance: number,
): number | null {
  const EPS = 1e-7;
  const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const h = {
    x: direction.y * e2.z - direction.z * e2.y,
    y: direction.z * e2.x - direction.x * e2.z,
    z: direction.x * e2.y - direction.y * e2.x,
  };
  const det = e1.x * h.x + e1.y * h.y + e1.z * h.z;
  if (Math.abs(det) < EPS) return null;
  const invDet = 1 / det;
  const s = { x: origin.x - a.x, y: origin.y - a.y, z: origin.z - a.z };
  const u = (s.x * h.x + s.y * h.y + s.z * h.z) * invDet;
  if (u < 0 || u > 1) return null;
  const q = { x: s.y * e1.z - s.z * e1.y, y: s.z * e1.x - s.x * e1.z, z: s.x * e1.y - s.y * e1.x };
  const v = (direction.x * q.x + direction.y * q.y + direction.z * q.z) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2.x * q.x + e2.y * q.y + e2.z * q.z) * invDet;
  return t > EPS && t <= maxDistance ? t : null;
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const nx = e1.y * e2.z - e1.z * e2.y;
  const ny = e1.z * e2.x - e1.x * e2.z;
  const nz = e1.x * e2.y - e1.y * e2.x;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function readTri(positions: Float32Array, i: number): [Vec3, Vec3, Vec3] {
  return [
    { x: positions[i] ?? 0, y: positions[i + 1] ?? 0, z: positions[i + 2] ?? 0 },
    { x: positions[i + 3] ?? 0, y: positions[i + 4] ?? 0, z: positions[i + 5] ?? 0 },
    { x: positions[i + 6] ?? 0, y: positions[i + 7] ?? 0, z: positions[i + 8] ?? 0 },
  ];
}

interface CellCoord {
  x: number;
  y: number;
  z: number;
}
interface DdaAxis {
  cell: number;
  dim: number;
  step: number;
  tMax: number;
  tDelta: number;
}

function ddaAxis(
  origin: number,
  dir: number,
  gridMin: number,
  cellSize: number,
  dim: number,
): DdaAxis {
  const cell = clampCell(Math.floor((origin - gridMin) / cellSize), dim);
  if (dir === 0) return { cell, dim, step: 0, tMax: Infinity, tDelta: Infinity };
  const step = dir > 0 ? 1 : -1;
  const boundary = gridMin + (cell + (step > 0 ? 1 : 0)) * cellSize;
  return { cell, dim, step, tMax: (boundary - origin) / dir, tDelta: cellSize / Math.abs(dir) };
}

function inGridRange(ax: DdaAxis, ay: DdaAxis, az: DdaAxis): boolean {
  return (
    ax.cell >= 0 &&
    ax.cell < ax.dim &&
    ay.cell >= 0 &&
    ay.cell < ay.dim &&
    az.cell >= 0 &&
    az.cell < az.dim
  );
}

function smallestTMaxAxis(ax: DdaAxis, ay: DdaAxis, az: DdaAxis): 'x' | 'y' | 'z' {
  if (ax.tMax <= ay.tMax && ax.tMax <= az.tMax) return 'x';
  return ay.tMax <= az.tMax ? 'y' : 'z';
}

function stepAxis(axis: DdaAxis): DdaAxis {
  return { ...axis, cell: axis.cell + axis.step, tMax: axis.tMax + axis.tDelta };
}

/** Amanatides & Woo voxel traversal: visits exactly the cells the segment from `entry` in
 *  `direction`, for up to `remaining` distance, actually crosses — in order, never the
 *  segment's whole bounding box. This is the acceleration this task's Global Constraints
 *  bullet and the spec's own "BVH for buildings" line ask for. */
function cellsAlongRay(
  grid: UniformGrid,
  entry: Vec3,
  direction: Vec3,
  remaining: number,
): CellCoord[] {
  let ax = ddaAxis(entry.x, direction.x, grid.minX, grid.cellSize, grid.dimX);
  let ay = ddaAxis(entry.y, direction.y, grid.minY, grid.cellSize, grid.dimY);
  let az = ddaAxis(entry.z, direction.z, grid.minZ, grid.cellSize, grid.dimZ);
  const cells: CellCoord[] = [];
  let traveled = 0;
  while (traveled <= remaining && inGridRange(ax, ay, az)) {
    cells.push({ x: ax.cell, y: ay.cell, z: az.cell });
    const axis = smallestTMaxAxis(ax, ay, az);
    traveled = axis === 'x' ? ax.tMax : axis === 'y' ? ay.tMax : az.tMax;
    if (axis === 'x') ax = stepAxis(ax);
    else if (axis === 'y') ay = stepAxis(ay);
    else az = stepAxis(az);
  }
  return cells;
}

/** Every triangle index referenced by any of `cells`, each reported once even if several
 *  cells share it (a triangle spanning a cell boundary is bucketed into every cell it
 *  overlaps at build time — see `buildUniformGrid`). */
function candidateTriangles(
  grid: UniformGrid,
  cells: readonly CellCoord[],
  stats?: InteriorQueryStats,
): Set<number> {
  const candidates = new Set<number>();
  for (const cell of cells) {
    if (stats) stats.cellsVisited += 1;
    const index = cellIndex(grid, cell.x, cell.y, cell.z);
    const start = grid.cellStart[index] ?? 0;
    const end = grid.cellStart[index + 1] ?? 0;
    for (let i = start; i < end; i += 1) candidates.add(grid.triangleIndices[i] ?? 0);
  }
  return candidates;
}

function raycastOneInterior(
  instance: InteriorInstance,
  origin: Vec3,
  direction: Vec3,
  inv: Vec3,
  maxDistance: number,
  stats?: InteriorQueryStats,
): { distance: number; point: Vec3; normal: Vec3 } | null {
  const interval = rayAabbInterval(instance.bounds, origin, inv, maxDistance);
  if (!interval) return null;
  const entryT = Math.max(interval.tMin, 0);
  const entry: Vec3 = {
    x: origin.x + direction.x * entryT,
    y: origin.y + direction.y * entryT,
    z: origin.z + direction.z * entryT,
  };
  const cells = cellsAlongRay(instance.grid, entry, direction, maxDistance - entryT);
  let nearest: { distance: number; point: Vec3; normal: Vec3 } | null = null;
  for (const t of candidateTriangles(instance.grid, cells, stats)) {
    if (stats) stats.trianglesTested += 1;
    const [a, b, c] = readTri(instance.worldPositions, t * 9);
    const distance = rayTriangle(origin, direction, a, b, c, maxDistance);
    if (distance === null || (nearest && distance >= nearest.distance)) continue;
    const point: Vec3 = {
      x: origin.x + direction.x * distance,
      y: origin.y + direction.y * distance,
      z: origin.z + direction.z * distance,
    };
    nearest = { distance, point, normal: triangleNormal(a, b, c) };
  }
  return nearest;
}

export function raycastInteriors(
  interiors: readonly InteriorInstance[],
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  stats?: InteriorQueryStats,
): { distance: number; point: Vec3; normal: Vec3 } | null {
  const inv: Vec3 = {
    x: direction.x !== 0 ? 1 / direction.x : Infinity,
    y: direction.y !== 0 ? 1 / direction.y : Infinity,
    z: direction.z !== 0 ? 1 / direction.z : Infinity,
  };
  let nearest: { distance: number; point: Vec3; normal: Vec3 } | null = null;
  for (const instance of interiors) {
    const hit = raycastOneInterior(instance, origin, direction, inv, maxDistance, stats);
    if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
  }
  return nearest;
}

function sphereIntersectsAabb(bounds: Aabb, center: Vec3, radius: number): boolean {
  const cx = Math.max(bounds.minX, Math.min(center.x, bounds.maxX));
  const cy = Math.max(bounds.minY, Math.min(center.y, bounds.maxY));
  const cz = Math.max(bounds.minZ, Math.min(center.z, bounds.maxZ));
  return Math.hypot(center.x - cx, center.y - cy, center.z - cz) <= radius;
}

/** The six edge/vertex dot products the clamp-to-edges construction below is built from —
 *  split out so each region-test function stays under the complexity budget. */
interface BaryTerms {
  d1: number;
  d2: number;
  d3: number;
  d4: number;
  d5: number;
  d6: number;
}
interface BaryWeights {
  va: number;
  vb: number;
  vc: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function baryTerms(ab: Vec3, ac: Vec3, ap: Vec3, bp: Vec3, cp: Vec3): BaryTerms {
  return {
    d1: dot(ab, ap),
    d2: dot(ac, ap),
    d3: dot(ab, bp),
    d4: dot(ac, bp),
    d5: dot(ab, cp),
    d6: dot(ac, cp),
  };
}

function baryWeights(t: BaryTerms): BaryWeights {
  return {
    vc: t.d1 * t.d4 - t.d3 * t.d2,
    vb: t.d5 * t.d2 - t.d1 * t.d6,
    va: t.d3 * t.d6 - t.d5 * t.d4,
  };
}

/** The three vertex regions: `p` projects outside the triangle past one of its corners. */
function vertexRegion(a: Vec3, b: Vec3, c: Vec3, t: BaryTerms): Vec3 | null {
  if (t.d1 <= 0 && t.d2 <= 0) return a;
  if (t.d3 >= 0 && t.d4 <= t.d3) return b;
  if (t.d6 >= 0 && t.d5 <= t.d6) return c;
  return null;
}

function edgeAb(a: Vec3, ab: Vec3, t: BaryTerms, w: BaryWeights): Vec3 | null {
  if (w.vc > 0 || t.d1 < 0 || t.d3 > 0) return null;
  const v = t.d1 / (t.d1 - t.d3);
  return { x: a.x + ab.x * v, y: a.y + ab.y * v, z: a.z + ab.z * v };
}

function edgeAc(a: Vec3, ac: Vec3, t: BaryTerms, w: BaryWeights): Vec3 | null {
  if (w.vb > 0 || t.d2 < 0 || t.d6 > 0) return null;
  const weight = t.d2 / (t.d2 - t.d6);
  return { x: a.x + ac.x * weight, y: a.y + ac.y * weight, z: a.z + ac.z * weight };
}

function edgeBc(b: Vec3, c: Vec3, t: BaryTerms, w: BaryWeights): Vec3 | null {
  if (w.va > 0 || t.d4 - t.d3 < 0 || t.d5 - t.d6 < 0) return null;
  const weight = (t.d4 - t.d3) / (t.d4 - t.d3 + (t.d5 - t.d6));
  return {
    x: b.x + (c.x - b.x) * weight,
    y: b.y + (c.y - b.y) * weight,
    z: b.z + (c.z - b.z) * weight,
  };
}

function faceInterior(a: Vec3, ab: Vec3, ac: Vec3, w: BaryWeights): Vec3 {
  const denom = 1 / (w.va + w.vb + w.vc);
  const v = w.vb * denom,
    weight = w.vc * denom;
  return {
    x: a.x + ab.x * v + ac.x * weight,
    y: a.y + ab.y * v + ac.y * weight,
    z: a.z + ab.z * v + ac.z * weight,
  };
}

/** Closest point on triangle (a,b,c) to `p` — the standard clamp-to-edges construction
 *  (Ericson, Real-Time Collision Detection), split into vertex/edge/face-region helpers so
 *  each function stays under this repo's complexity budget. */
function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const bp = { x: p.x - b.x, y: p.y - b.y, z: p.z - b.z };
  const cp = { x: p.x - c.x, y: p.y - c.y, z: p.z - c.z };
  const t = baryTerms(ab, ac, ap, bp, cp);
  const vertex = vertexRegion(a, b, c, t);
  if (vertex) return vertex;
  const w = baryWeights(t);
  const edge = edgeAb(a, ab, t, w) ?? edgeAc(a, ac, t, w) ?? edgeBc(b, c, t, w);
  return edge ?? faceInterior(a, ab, ac, w);
}

function sphereCells(grid: UniformGrid, center: Vec3, radius: number): CellCoord[] {
  const box: Aabb = {
    minX: center.x - radius,
    minY: center.y - radius,
    minZ: center.z - radius,
    maxX: center.x + radius,
    maxY: center.y + radius,
    maxZ: center.z + radius,
  };
  const cells: CellCoord[] = [];
  forEachOverlappedCell(grid, box, (i) => {
    const z = Math.floor(i / (grid.dimX * grid.dimY));
    const y = Math.floor((i - z * grid.dimX * grid.dimY) / grid.dimX);
    const x = i - z * grid.dimX * grid.dimY - y * grid.dimX;
    cells.push({ x, y, z });
  });
  return cells;
}

function resolveSphereAgainstOneInterior(
  instance: InteriorInstance,
  center: Vec3,
  radius: number,
  stats?: InteriorQueryStats,
): { depth: number; push: Vec3 } | null {
  if (!sphereIntersectsAabb(instance.bounds, center, radius)) return null;
  const cells = sphereCells(instance.grid, center, radius);
  let deepest: { depth: number; push: Vec3 } | null = null;
  for (const t of candidateTriangles(instance.grid, cells, stats)) {
    if (stats) stats.trianglesTested += 1;
    const [a, b, c] = readTri(instance.worldPositions, t * 9);
    const closest = closestPointOnTriangle(center, a, b, c);
    const dx = center.x - closest.x,
      dy = center.y - closest.y,
      dz = center.z - closest.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance >= radius) continue;
    const depth = radius - distance;
    if (deepest && depth <= deepest.depth) continue;
    const len = distance || 1;
    deepest = {
      depth,
      push: { x: (dx / len) * depth, y: (dy / len) * depth, z: (dz / len) * depth },
    };
  }
  return deepest;
}

/** The single deepest penetration this tick, across every triangle of every interior whose
 *  AABB the sphere could plausibly touch — and, within an instance, only the triangles in
 *  the grid cells the sphere's own bounding box overlaps. Ours: not the sum of every
 *  overlapping triangle's push-out (that can push a sphere wedged in a corner further than
 *  either face alone would), matching how `applyGround` in `movement.ts` already resolves
 *  one contact per tick. */
export function resolveSphereAgainstInteriors(
  interiors: readonly InteriorInstance[],
  center: Vec3,
  radius: number,
  stats?: InteriorQueryStats,
): Vec3 | null {
  let deepest: { depth: number; push: Vec3 } | null = null;
  for (const instance of interiors) {
    const found = resolveSphereAgainstOneInterior(instance, center, radius, stats);
    if (found && (!deepest || found.depth > deepest.depth)) deepest = found;
  }
  return deepest?.push ?? null;
}
