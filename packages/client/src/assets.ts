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
  emptySquares: number[];
}
export interface ClientSceneData {
  terrain: {
    terrainFile: string;
    squareSize: number;
    position: [number, number, number];
    emptySquares: number[];
  };
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
  flagStands: Array<{ team: number; position: [number, number, number] }>;
  baseObjects: Array<{
    kind: number;
    team: number;
    position: [number, number, number];
    // ForceField placements only (kind 4) -- every other kind leaves both undefined.
    rotation?: { axis: [number, number, number]; degrees: number };
    scale?: [number, number, number];
  }>;
  turrets: Array<{ barrel: number; team: number; position: [number, number, number] }>;
  interiors: Array<{
    shape: string;
    position: [number, number, number];
    rotation: { axis: [number, number, number]; degrees: number };
  }>;
  shapesForBaseObjectKind: Record<number, string>;
  shapesForTurretBarrel: Record<number, string>;
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
export function shapeUrl(name: string): string {
  return `${ROOT}shapes/${name}.glb`;
}
export function collisionUrl(name: string): string {
  return `${ROOT}collision/${name}.collision.bin`;
}
export async function loadKatabatic(): Promise<KatabaticAssets> {
  const terrain = (await (await response('terrain.json')).json()) as TerrainManifest;
  const scene = (await (await response('scene.json')).json()) as ClientSceneData;
  const heightBytes = await (await response(terrain.heights)).arrayBuffer();
  const expectedHeights = terrain.gridSize * terrain.gridSize;
  // A truncated-but-200 fetch (a flaky proxy, a partial cache write) would otherwise pass
  // silently through to sampleTerrain, which defaults a missing sample to 0 and turns a
  // broken download into quietly wrong collision and rendering.
  if (heightBytes.byteLength !== expectedHeights * 2) {
    throw new Error(
      `Heightmap ${terrain.heights} is ${String(heightBytes.byteLength)} bytes, expected ${String(expectedHeights * 2)} for a ${String(terrain.gridSize)}x${String(terrain.gridSize)} grid`,
    );
  }
  const heightView = new DataView(heightBytes);
  const heights = new Uint16Array(expectedHeights);
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
