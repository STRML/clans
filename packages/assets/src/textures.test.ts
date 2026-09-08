import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { attachShapeTextures, textureKey, prepareVehicleAsset } from './textures.js';

describe('external shape textures', () => {
  it('normalizes Torque texture paths', () => {
    expect(textureKey('skins\\Vehicle_grav_scout')).toBe('skins/vehicle_grav_scout');
  });
  it('preserves Draco binary and lightmaps while adding diffuse maps', async () => {
    // Use committed real assets so CI does not depend on the fetch cache.
    const original = await readFile(
      new URL('../../../assets/out/katabatic/shapes/sbunk2.glb', import.meta.url),
    );
    const transformed = attachShapeTextures(original);
    const beforeLength = original.readUInt32LE(12);
    const afterLength = new DataView(transformed.buffer).getUint32(12, true);
    expect(transformed.slice(20 + afterLength)).toEqual(
      new Uint8Array(original.subarray(20 + beforeLength)),
    );
    const data = JSON.parse(new TextDecoder().decode(transformed.subarray(20, 20 + afterLength)));
    for (const material of data.materials) {
      expect(material.pbrMetallicRoughness.baseColorTexture).toBeDefined();
      expect(material.emissiveTexture.texCoord).toBe(1);
      const texture = data.textures[material.pbrMetallicRoughness.baseColorTexture.index];
      expect(data.images[texture.source].uri).toMatch(/^\.\.\/textures\/ice\/.*\.png$/);
    }
  });
});

it('uses the procedural vehicle when the unconverted STL fallback is returned', () => {
  expect(
    prepareVehicleAsset({ source: 'stl', bytes: new TextEncoder().encode('solid vehicle') }),
  ).toEqual({ source: 'procedural', bytes: null });
});
