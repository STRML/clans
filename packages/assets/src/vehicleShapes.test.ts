import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertVehicleShape } from './vehicleShapes.js';

const GLB_URL = 'https://example.invalid/real.glb';
const STL_URL = 'https://example.invalid/fallback.stl';

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

    const result = await convertVehicleShape(GLB_URL, STL_URL);
    expect(result.source).toBe('glb');
    expect(result.bytes).toEqual(glbBytes);
  });

  it('falls back to the STL when the glb fetch fails', async () => {
    const stlBytes = new Uint8Array([4, 5, 6]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) === GLB_URL) return failResponse(404);
        if (String(url) === STL_URL) return okResponse(stlBytes);
        throw new Error(`unexpected url: ${String(url)}`);
      }),
    );

    const result = await convertVehicleShape(GLB_URL, STL_URL);
    expect(result.source).toBe('stl');
    expect(result.bytes).toEqual(stlBytes);
  });

  it('falls back to procedural when both the glb and the STL fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );

    const result = await convertVehicleShape(GLB_URL, STL_URL);
    expect(result.source).toBe('procedural');
    expect(result.bytes).toBeNull();
  });
});
