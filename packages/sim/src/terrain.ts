export interface Heightfield {
  gridSize: number;
  squareSize: number;
  originX: number;
  originY: number;
  originZ: number;
  heightScale: number;
  heights: Uint16Array;
  /** Square indices (row * gridSize + col) the mission marks empty: holes with no ground. */
  emptySquares?: ReadonlySet<number>;
}
export interface TerrainSample {
  height: number;
  /** True inside an empty square. The height is still the plane, but nothing is there. */
  empty: boolean;
  normal: { x: number; y: number; z: number };
  col: number;
  row: number;
  split45: boolean;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));
export function terrainIndex(terrain: Heightfield, col: number, row: number): number {
  return row * terrain.gridSize + col;
}

/** The height-plane evaluation every terrain query shares: grid cell, corner heights,
 *  diagonal split, and the bilinear plane over the winning triangle. Single source on
 *  purpose -- sampleTerrain and the height-only sampleTerrainHeight below must stay
 *  float-identical forever, because the P2 ledger item (docs/ISSUES.md, "48-bot tick
 *  bursts") moved turrets.ts's hasLineOfSight march onto the height-only path, and that
 *  march's answers gate bot perception, turret acquisition, and with them the match
 *  fingerprints the telemetry probe hashes. Same expressions, same order, same float64
 *  results; hashWorld byte-identity across the four 24v24 seeds is the standing proof.
 *  Module-level scratch is safe here: synchronous, and nothing in this file re-enters
 *  while a sample is being evaluated. */
interface PlaneSample {
  height: number;
  du: number;
  dv: number;
  empty: boolean;
  col: number;
  row: number;
  split45: boolean;
}
const planeScratch: PlaneSample = {
  height: 0,
  du: 0,
  dv: 0,
  empty: false,
  col: 0,
  row: 0,
  split45: false,
};
function evalTerrainPlane(terrain: Heightfield, x: number, z: number): PlaneSample {
  const max = terrain.gridSize - 1;
  const gridX = clamp((x - terrain.originX) / terrain.squareSize, 0, max);
  const gridY = clamp((terrain.originZ - z) / terrain.squareSize, 0, max);
  const col = Math.min(Math.floor(gridX), max - 1);
  const row = Math.min(Math.floor(gridY), max - 1);
  const u = gridX - col;
  const v = gridY - row;
  const h = (dx: number, dy: number): number =>
    (terrain.heights[terrainIndex(terrain, col + dx, row + dy)] ?? 0) / terrain.heightScale +
    terrain.originY;
  const h00 = h(0, 0);
  const h10 = h(1, 0);
  const h01 = h(0, 1);
  const h11 = h(1, 1);
  const split45 = ((col ^ row) & 1) === 0;
  const empty = terrain.emptySquares?.has(row * terrain.gridSize + col) ?? false;
  let height: number;
  let du: number;
  let dv: number;
  if (split45 && u >= v) {
    height = h00 + u * (h10 - h00) + v * (h11 - h10);
    du = h10 - h00;
    dv = h11 - h10;
  } else if (split45) {
    height = h00 + u * (h11 - h01) + v * (h01 - h00);
    du = h11 - h01;
    dv = h01 - h00;
  } else if (u + v <= 1) {
    height = h00 + u * (h10 - h00) + v * (h01 - h00);
    du = h10 - h00;
    dv = h01 - h00;
  } else {
    height = h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    du = h11 - h01;
    dv = h11 - h10;
  }
  planeScratch.height = height;
  planeScratch.du = du;
  planeScratch.dv = dv;
  planeScratch.empty = empty;
  planeScratch.col = col;
  planeScratch.row = row;
  planeScratch.split45 = split45;
  return planeScratch;
}

export function sampleTerrain(terrain: Heightfield, x: number, z: number): TerrainSample {
  const plane = evalTerrainPlane(terrain, x, z);
  const nx = -plane.du / terrain.squareSize;
  const ny = 1;
  const nz = plane.dv / terrain.squareSize;
  const length = Math.hypot(nx, ny, nz);
  return {
    height: plane.height,
    empty: plane.empty,
    normal: { x: nx / length, y: ny / length, z: nz / length },
    col: plane.col,
    row: plane.row,
    split45: plane.split45,
  };
}

/** Height and empty-square flag only: what turrets.ts's hasLineOfSight march reads at
 *  each 0.5 m step (P2 ledger item). The full TerrainSample would have the march allocate
 *  a normal vector it never reads at every sample of every sightline -- ~300 objects per
 *  150 m scan, tens of thousands per tick at 24v24. The caller owns `out` (its own
 *  scratch), so the hot path allocates nothing, and the numbers are produced by the same
 *  evalTerrainPlane pass sampleTerrain uses, so they cannot drift from it. */
export interface TerrainHeightSample {
  height: number;
  empty: boolean;
}
export function sampleTerrainHeight(
  terrain: Heightfield,
  x: number,
  z: number,
  out: TerrainHeightSample,
): void {
  const plane = evalTerrainPlane(terrain, x, z);
  out.height = plane.height;
  out.empty = plane.empty;
}
