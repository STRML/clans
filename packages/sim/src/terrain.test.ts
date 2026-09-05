import { describe, expect, it } from 'vitest';
import { sampleTerrain, type Heightfield } from './terrain.js';

function field(heights: number[], size = 3): Heightfield {
  return {
    gridSize: size,
    squareSize: 8,
    originX: 0,
    originY: 0,
    originZ: 16,
    heightScale: 1,
    heights: Uint16Array.from(heights),
  };
}

describe('sampleTerrain', () => {
  it('clamps grid edges and outside coordinates without throwing', () => {
    const terrain = field([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(sampleTerrain(terrain, -100, 100).height).toBe(10);
    expect(sampleTerrain(terrain, 100, -100).height).toBe(90);
    expect(sampleTerrain(terrain, 16, 0).height).toBe(90);
  });

  it('uses the split45 triangle planes for even parity', () => {
    // Square (col 0, row 0): h00=0, h10=8, h01=16, h11=40. h11 is off-plane so the two
    // diagonals give different answers.
    const terrain = field([0, 8, 0, 16, 40, 0, 0, 0, 0]);
    // u=0.75, v=0.25 lies in triangle (00,10,11): 0 + 0.75*8 + 0.25*(40-8) = 14.
    // The other diagonal's triangle (00,10,01) would give 10.
    expect(sampleTerrain(terrain, 6, 14).height).toBeCloseTo(14);
    // u=0.25, v=0.75 lies in triangle (00,01,11): 0.25*(40-16) + 0.75*16 = 18.
    expect(sampleTerrain(terrain, 2, 10).height).toBeCloseTo(18);
  });

  it('uses the opposite triangle planes for odd parity', () => {
    // Square (col 1, row 0): h00=0, h10=0, h01=8, h11=24.
    const terrain = field([0, 0, 0, 0, 8, 24, 0, 0, 0]);
    // u=0.75, v=0.25, u+v=1 lies in triangle (00,10,01): 0.25*8 = 2.
    // A split45 choice would give 0.25*24 = 6.
    expect(sampleTerrain(terrain, 14, 14).height).toBeCloseTo(2);
    // u=0.25, v=0.875, u+v>1 lies in triangle (11,01,10): 24 + 0.75*(8-24) + 0.125*(0-24) = 9.
    expect(sampleTerrain(terrain, 10, 9).height).toBeCloseTo(9);
  });

  it('reports an empty square and keeps the plane height for it', () => {
    const terrain = { ...field([0, 0, 0, 0, 0, 0, 0, 0, 0]), emptySquares: new Set([0]) };
    expect(sampleTerrain(terrain, 2, 14).empty).toBe(true);
    expect(sampleTerrain(terrain, 10, 14).empty).toBe(false);
  });
});
