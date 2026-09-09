import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertVehicleShape } from './vehicleShapes.js';
import { prepareVehicleAsset } from './textures.js';

const GLB_URL = 'https://example.invalid/real.glb';

function okResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function failResponse(status: number): Response {
  return { ok: false, status } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('convertVehicleShape', () => {
  it('prefers the real glb when it fetches successfully', async () => {
    const glbBytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toBe(GLB_URL);
        return okResponse(glbBytes);
      }),
    );

    const result = await convertVehicleShape(GLB_URL);
    expect(result.source).toBe('glb');
    expect(result.bytes).toEqual(glbBytes);
  });

  // Issue #29 acceptance: forcing the glb tier to fail must NOT produce bytes that get
  // published under a .glb name GLTFLoader cannot parse. The old second tier returned
  // raw STL bytes under source: 'stl' — unrenderable by every consumer — so the tier is
  // skipped outright: no STL fetch happens at all, and the composed build pipeline
  // (build.ts's exact convertVehicleShape -> prepareVehicleAsset -> write-if-bytes
  // sequence) emits no file and labels the vehicle honestly as procedural.
  it('falls back to procedural without fetching an STL when the glb fetch fails', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        requested.push(String(url));
        return failResponse(404);
      }),
    );

    const result = await convertVehicleShape(GLB_URL);
    expect(result).toEqual({ source: 'procedural', bytes: null });
    expect(requested).toEqual([GLB_URL]);

    // The seam build.ts actually publishes through: no bytes -> no .glb written, and
    // scene.json's vehicles[kind].source reads 'procedural', which the client treats as
    // "keep the placeholder mesh, never attempt a GLTFLoader load".
    const prepared = prepareVehicleAsset(result);
    expect(prepared).toEqual({ source: 'procedural', bytes: null });
  });

  it('falls back to procedural when the glb fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );

    const result = await convertVehicleShape(GLB_URL);
    expect(result.source).toBe('procedural');
    expect(result.bytes).toBeNull();
  });
});
