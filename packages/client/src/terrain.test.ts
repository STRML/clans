import { describe, expect, it } from 'vitest';
import { buildTerrainGeometry } from './terrain.js';
import type { KatabaticAssets } from './assets.js';

const data = {
  terrain: {
    gridSize: 3,
    squareSize: 8,
    origin: { x: 0, y: 0, z: 16 },
    minHeight: 0,
    maxHeight: 0,
    heightScale: 32,
    heights: 'heights.bin',
    materials: 'materials.bin',
    layers: [],
    emptySquares: [],
  },
  scene: {
    terrain: { terrainFile: 'x', squareSize: 8, position: [0, 0, 16], emptySquares: [] },
    sun: { direction: [1, -1, 0], color: [0.7, 0.7, 0.7, 1], ambient: [0.3, 0.3, 0.3, 1] },
    sky: {
      visibleDistance: 500,
      fogDistance: 400,
      fogColor: [0.65, 0.65, 0.7, 1],
      materialList: '',
    },
    missionArea: { minX: 0, minZ: 0, width: 16, depth: 16 },
    spawns: [],
    flagStands: [],
  },
  heights: new Uint16Array(9),
  materials: new Uint8Array(9),
  alphaMaps: [],
} as KatabaticAssets;

describe('buildTerrainGeometry', () => {
  it('uses split45 on even squares and the opposite split on odd squares', () => {
    const index = [...(buildTerrainGeometry(data).getIndex()?.array ?? [])];
    expect(index.slice(0, 6)).toEqual([0, 4, 3, 0, 1, 4]);
    expect(index.slice(6, 12)).toEqual([1, 2, 4, 2, 5, 4]);
  });

  it('leaves a hole for each empty square', () => {
    const withHole = {
      ...data,
      terrain: { ...data.terrain, emptySquares: [0] },
    } as KatabaticAssets;
    const full = buildTerrainGeometry(data).getIndex()?.count ?? 0;
    const holed = buildTerrainGeometry(withHole).getIndex()?.count ?? 0;
    expect(full - holed).toBe(6);
  });
});
