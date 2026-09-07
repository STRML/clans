import { NodeIO, type Node } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
// @ts-expect-error -- draco3dgltf ships no types; its shape is exactly the emscripten
// decoder-module factory @gltf-transform/extensions' KHRDracoMeshCompression expects.
import draco3d from 'draco3dgltf';
import { mat4, vec3 } from 'gl-matrix';

/** T2's exported `.glb`s use Draco mesh compression (confirmed against the real fetched
 *  files, not the plan's uncompressed unit-test fixture — plain `NodeIO` throws "Missing
 *  required extension" without this). One decoder module is created once and reused for
 *  every `.glb` this build step reads. */
async function createIO(): Promise<NodeIO> {
  const decoderModule: unknown = await draco3d.createDecoderModule();
  return new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({ 'draco3d.decoder': decoderModule });
}

export interface ExtractedTriangles {
  /** Object-space triangle soup, 9 floats per triangle — every mesh node's own local
   *  transform is already baked in, matching exactly what `@clans/sim`'s
   *  `InteriorTriangles`/`buildInteriorCollider` expects as input (that function then
   *  applies the *mission's* placement transform on top of this). */
  positions: Float32Array;
}

async function collectWorldMatrices(node: Node, parent: mat4, out: Map<Node, mat4>): Promise<void> {
  const world = mat4.create();
  mat4.multiply(world, parent, node.getMatrix() as unknown as mat4);
  out.set(node, world);
  for (const child of node.listChildren()) await collectWorldMatrices(child, world, out);
}

function trianglesFromNode(node: Node, world: mat4, out: number[]): void {
  const mesh = node.getMesh();
  if (!mesh) return;
  for (const primitive of mesh.listPrimitives()) {
    const positionAttr = primitive.getAttribute('POSITION');
    if (!positionAttr) continue;
    const positions = positionAttr.getArray() as Float32Array;
    const indexAccessor = primitive.getIndices();
    const vertexCount = positions.length / 3;
    const indices = indexAccessor
      ? (indexAccessor.getArray() as Uint16Array | Uint32Array)
      : Uint32Array.from({ length: vertexCount }, (_, i) => i);
    for (let i = 0; i < indices.length; i += 1) {
      const vi = indices[i] ?? 0;
      const local = vec3.fromValues(
        positions[vi * 3] ?? 0,
        positions[vi * 3 + 1] ?? 0,
        positions[vi * 3 + 2] ?? 0,
      );
      const worldPoint = vec3.transformMat4(vec3.create(), local, world);
      out.push(worldPoint[0], worldPoint[1], worldPoint[2]);
    }
  }
}

/** Reads one `.glb` and flattens every mesh in its default scene into a single object-space
 *  triangle soup, baking each node's own local transform along the way. T2's static base
 *  and interior shapes are simple (no skeleton, at most a couple of transformed child
 *  nodes), so this general recursive bake is correctness insurance, not overkill for a
 *  known-flat hierarchy — a future shape with more structure costs nothing extra here. */
export async function extractTriangles(glbPath: string): Promise<ExtractedTriangles> {
  const io = await createIO();
  const document = await io.read(glbPath);
  const scene = document.getRoot().listScenes()[0];
  if (!scene) throw new Error(`${glbPath} has no default scene`);
  const worldMatrices = new Map<Node, mat4>();
  for (const node of scene.listChildren())
    await collectWorldMatrices(node, mat4.create(), worldMatrices);
  const triangles: number[] = [];
  for (const [node, world] of worldMatrices) trianglesFromNode(node, world, triangles);
  return { positions: Float32Array.from(triangles) };
}

export function writeTriangleBinary(triangles: ExtractedTriangles): Uint8Array {
  return new Uint8Array(
    triangles.positions.buffer,
    triangles.positions.byteOffset,
    triangles.positions.byteLength,
  );
}

/** Ours — see this plan's "ours" numbers table. The measured real total for every `.glb`
 *  this task fetches is 1,278,076 bytes; this budget covers that plus the extracted
 *  collision binaries (roughly the same order of magnitude) with real headroom. */
export const ASSET_SIZE_BUDGET_BYTES = 8 * 1024 * 1024;
