import { afterEach, describe, expect, it, vi } from 'vitest';
import { collisionUrl, loadKatabatic, shapeUrl, type TerrainManifest } from './assets.js';

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

describe('shapeUrl / collisionUrl (base-path aware, Codex review round 1 of the M7 PR)', () => {
  // Root-relative ("/katabatic/...") only works when the page itself is served from the
  // domain root -- apps/demo's own vite.config.ts sets `base: './'` because GitHub Pages
  // serves it under /clans/. import.meta.env.BASE_URL is Vite's own runtime reflection of
  // that setting; every asset URL this module builds must be prefixed with it, not a
  // hardcoded absolute root, or the demo build 404s on every asset fetch.
  it("shapeUrl is prefixed with import.meta.env.BASE_URL, not a hardcoded '/'", () => {
    expect(shapeUrl('shrike')).toBe(`${import.meta.env.BASE_URL}katabatic/shapes/shrike.glb`);
  });
  it("collisionUrl is prefixed with import.meta.env.BASE_URL, not a hardcoded '/'", () => {
    expect(collisionUrl('svpad')).toBe(
      `${import.meta.env.BASE_URL}katabatic/collision/svpad.collision.bin`,
    );
  });
});
