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

export function sampleTerrain(terrain: Heightfield, x: number, z: number): TerrainSample {
  const max = terrain.gridSize - 1;
  const gridX = clamp((x - terrain.originX) / terrain.squareSize, 0, max);
  const gridY = clamp((terrain.originZ - z) / terrain.squareSize, 0, max);
  const col = Math.min(Math.floor(gridX), max - 1);
  const row = Math.min(Math.floor(gridY), max - 1);
  const u = gridX - col,
    v = gridY - row;
  const h = (dx: number, dy: number): number =>
    (terrain.heights[terrainIndex(terrain, col + dx, row + dy)] ?? 0) / terrain.heightScale +
    terrain.originY;
  const h00 = h(0, 0),
    h10 = h(1, 0),
    h01 = h(0, 1),
    h11 = h(1, 1);
  const split45 = ((col ^ row) & 1) === 0;
  const empty = terrain.emptySquares?.has(row * terrain.gridSize + col) ?? false;
  let height: number, du: number, dv: number;
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
  const nx = -du / terrain.squareSize,
    ny = 1,
    nz = dv / terrain.squareSize;
  const length = Math.hypot(nx, ny, nz);
  return {
    height,
    empty,
    normal: { x: nx / length, y: ny / length, z: nz / length },
    col,
    row,
    split45,
  };
}
