import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadKatabatic, type TerrainManifest } from './assets.js';

const manifest: TerrainManifest = {
  gridSize: 2,
  squareSize: 1000,
  origin: { x: 0, y: 0, z: 0 },
  minHeight: 0,
  maxHeight: 0,
  heightScale: 1,
  heights: 'heights.bin',
  materials: 'materials.bin',
  layers: [],
  emptySquares: [],
};

function stubFetch(heightBytes: ArrayBuffer): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('terrain.json')) return new Response(JSON.stringify(manifest));
      if (url.endsWith('scene.json')) return new Response(JSON.stringify({}));
      if (url.endsWith('heights.bin')) return new Response(heightBytes);
      if (url.endsWith('materials.bin')) return new Response(new ArrayBuffer(0));
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
}

describe('loadKatabatic', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a heightmap whose byte length matches gridSize squared', async () => {
    stubFetch(new ArrayBuffer(manifest.gridSize * manifest.gridSize * 2));
    const assets = await loadKatabatic();
    expect(assets.heights.length).toBe(manifest.gridSize * manifest.gridSize);
  });

  it('rejects a truncated heightmap instead of silently zero-filling the missing samples', async () => {
    // Codex round 15: a successful-but-truncated fetch (a flaky proxy, a partial cache
    // write) produced a heights array shorter than gridSize squared, and sampleTerrain's
    // `?? 0` fallback turned that into quietly wrong collision and rendering instead of
    // a load failure.
    stubFetch(new ArrayBuffer(2)); // one height instead of the four a 2x2 grid needs
    await expect(loadKatabatic()).rejects.toThrow(/heightmap/i);
  });
});
