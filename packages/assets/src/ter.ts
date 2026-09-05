export interface TerrainData {
  version: 2;
  gridSize: number;
  heights: Uint16Array;
  materials: Uint8Array;
  materialNames: string[];
  alphaMaps: Uint8Array[];
}

function requireBytes(bytes: Uint8Array, offset: number, count: number): void {
  if (offset + count > bytes.byteLength) {
    throw new RangeError(`Truncated .ter at byte ${offset}; need ${count} bytes`);
  }
}

export function decodeTer(bytes: Uint8Array, gridSize = 256): TerrainData {
  requireBytes(bytes, 0, 1);
  const version = bytes[0];
  if (version !== 2) throw new Error(`Unsupported .ter version ${String(version)}`);

  const points = gridSize * gridSize;
  let offset = 1;
  requireBytes(bytes, offset, points * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, points * 2);
  const heights = new Uint16Array(points);
  for (let i = 0; i < points; i += 1) heights[i] = view.getUint16(i * 2, true);
  offset += points * 2;

  requireBytes(bytes, offset, points);
  const materials = bytes.slice(offset, offset + points);
  offset += points;

  const materialNames: string[] = [];
  while (true) {
    requireBytes(bytes, offset, 1);
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (length === 0) break;
    requireBytes(bytes, offset, length);
    materialNames.push(String.fromCharCode(...bytes.slice(offset, offset + length)));
    offset += length;
  }

  // Three bytes of unknown purpose sit between the name list and the alpha maps
  // (verified on Katabatic.ter: the maps occupy exactly the last names.length * points
  // bytes, and reading them from the terminator instead gives blend sums of 0 not 255).
  // Anchor on the file end so the decoder does not depend on what those bytes mean.
  const alphaStart = bytes.byteLength - materialNames.length * points;
  if (alphaStart < offset) {
    throw new RangeError(
      `Truncated .ter: alpha maps need ${String(materialNames.length * points)} bytes`,
    );
  }
  offset = alphaStart;
  const alphaMaps = materialNames.map(() => {
    const map = bytes.slice(offset, offset + points);
    offset += points;
    return map;
  });

  return { version: 2, gridSize, heights, materials, materialNames, alphaMaps };
}
