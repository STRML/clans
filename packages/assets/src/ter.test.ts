import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeTer } from './ter.js';

const fixture = new URL('./__fixtures__/tiny-v2.ter', import.meta.url);

describe('decodeTer', () => {
  it('decodes version 2 fields in source order', async () => {
    const data = decodeTer(await readFile(fixture), 2);
    expect([...data.heights]).toEqual([1600, 1632, 1664, 1696]);
    expect([...data.materials]).toEqual([0, 1, 2, 3]);
    expect(data.materialNames).toEqual(['Snow', 'Ice']);
    expect(data.alphaMaps.map((map) => [...map])).toEqual([
      [255, 128, 64, 0],
      [0, 64, 128, 255],
    ]);
  });

  it('reports the unsupported version', () => {
    expect(() => decodeTer(Uint8Array.of(7), 2)).toThrow('Unsupported .ter version 7');
  });
});
