import textureSources from './texture-sources.json' with { type: 'json' };

interface GltfMaterial {
  extras?: { resource_path?: string };
  pbrMetallicRoughness?: { baseColorTexture?: { index: number }; baseColorFactor?: number[] };
}
interface GltfJson {
  materials?: GltfMaterial[];
  images?: Array<{ uri?: string }>;
  textures?: Array<{ source: number; sampler?: number }>;
  samplers?: Array<{ wrapS: number; wrapT: number }>;
}

export function textureKey(resource: string): string {
  return resource.replaceAll('\\', '/').toLowerCase();
}

function materialResource(material: GltfMaterial): string | undefined {
  return material.extras?.resource_path;
}

function applyDiffuse(material: GltfMaterial, index: number): void {
  const pbr = (material.pbrMetallicRoughness ??= {});
  const alpha = pbr.baseColorFactor?.[3] ?? 1;
  pbr.baseColorTexture = { index };
  pbr.baseColorFactor = [1, 1, 1, alpha];
}

/** Patch only the JSON chunk: preserve original Draco bytes, UVs, and lightmaps. */
export function attachShapeTextures(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const gltf = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
  ) as GltfJson;
  const images = (gltf.images ??= []);
  const textures = (gltf.textures ??= []);
  const samplers = (gltf.samplers ??= []);
  const sampler = samplers.push({ wrapS: 10497, wrapT: 10497 }) - 1;
  const mapped = new Map<string, number>();
  for (const material of gltf.materials ?? []) {
    const resource = materialResource(material);
    if (!resource) continue;
    const key = textureKey(resource);
    if (!(key in textureSources)) throw new Error(`Missing texture source: ${resource}`);
    let index = mapped.get(key);
    if (index === undefined) {
      const source = images.push({ uri: `../textures/${key}.png` }) - 1;
      index = textures.push({ source, sampler }) - 1;
      mapped.set(key, index);
    }
    applyDiffuse(material, index);
  }
  return replaceJsonChunk(bytes, gltf, jsonLength);
}

function replaceJsonChunk(bytes: Uint8Array, gltf: GltfJson, jsonLength: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const remainder = bytes.subarray(20 + jsonLength);
  const result = new Uint8Array(20 + paddedLength + remainder.length);
  result.set(bytes.subarray(0, 20));
  const resultView = new DataView(result.buffer);
  resultView.setUint32(8, result.length, true);
  resultView.setUint32(12, paddedLength, true);
  result.fill(32, 20, 20 + paddedLength);
  result.set(json, 20);
  result.set(remainder, 20 + paddedLength);
  return result;
}
