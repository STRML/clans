import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractTriangles, writeTriangleBinary } from './interiors.js';

const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__/triangle.glb');

describe('extractTriangles', () => {
  it('extracts one triangle (9 floats) with the node translation baked in', async () => {
    const { positions } = await extractTriangles(fixture);
    expect(positions).toHaveLength(9);
    // The fixture's node translates by (10, 0, 0); local (0,0,0) becomes world (10,0,0).
    expect(positions[0]).toBeCloseTo(10);
    expect(positions[1]).toBeCloseTo(0);
    expect(positions[2]).toBeCloseTo(0);
    // Local (1,0,0) becomes world (11,0,0).
    expect(positions[3]).toBeCloseTo(11);
  });
});

describe('writeTriangleBinary', () => {
  it('round-trips through a Float32Array view with no copy loss', async () => {
    const triangles = await extractTriangles(fixture);
    const bytes = writeTriangleBinary(triangles);
    expect(bytes.byteLength).toBe(9 * 4);
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, 9);
    expect(Array.from(view)).toEqual(Array.from(triangles.positions));
  });
});
