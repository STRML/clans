export interface TerrainManifest {
  gridSize: number;
  squareSize: number;
  origin: { x: number; y: number; z: number };
  minHeight: number;
  maxHeight: number;
  heightScale: number;
  heights: string;
  materials: string;
  layers: Array<{ name: string; texture: string; alpha: string }>;
}
export interface ClientSceneData {
  terrain: { terrainFile: string; squareSize: number; position: [number, number, number] };
  sun: {
    direction: [number, number, number];
    color: [number, number, number, number];
    ambient: [number, number, number, number];
  };
  sky: {
    visibleDistance: number;
    fogDistance: number;
    fogColor: [number, number, number, number];
    materialList: string;
  };
  missionArea: { minX: number; minZ: number; width: number; depth: number };
  spawns: Array<{
    name: string | null;
    team: number;
    position: [number, number, number];
    radius: number;
  }>;
}
export interface KatabaticAssets {
  terrain: TerrainManifest;
  scene: ClientSceneData;
  heights: Uint16Array;
  materials: Uint8Array;
  alphaMaps: Uint8Array[];
}

const ROOT = '/katabatic/';
async function response(path: string): Promise<Response> {
  const result = await fetch(`${ROOT}${path}`);
  if (!result.ok) throw new Error(`Asset load failed ${result.status}: ${path}`);
  return result;
}
export async function loadKatabatic(): Promise<KatabaticAssets> {
  const terrain = (await (await response('terrain.json')).json()) as TerrainManifest;
  const scene = (await (await response('scene.json')).json()) as ClientSceneData;
  const heightBytes = await (await response(terrain.heights)).arrayBuffer();
  const heightView = new DataView(heightBytes);
  const heights = new Uint16Array(heightBytes.byteLength / 2);
  for (let index = 0; index < heights.length; index += 1)
    heights[index] = heightView.getUint16(index * 2, true);
  const materials = new Uint8Array(await (await response(terrain.materials)).arrayBuffer());
  const alphaMaps = await Promise.all(
    terrain.layers.map(
      async (layer) => new Uint8Array(await (await response(layer.alpha)).arrayBuffer()),
    ),
  );
  return { terrain, scene, heights, materials, alphaMaps };
}
