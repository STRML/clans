/**
 * Tribes 2 `.dts` shape reader and glTF-binary emitter.
 *
 * The `.dts` container has no public specification; its only authoritative definition is
 * the Torque/V12 engine's own reader, so every field group below is a port of that code.
 * The engine sources are read from github.com/tribes2/engine over HTTP — they are NOT
 * vendored into this repo — and each section names the file and function it came from:
 *
 * - `ts/tsShape.cc`        `TSShape::read` (file header, sequence and material sections),
 *                          `TSShape::assembleShape` (the shape-data memory buffer, in
 *                          `TSShape::disassembleShape`'s write order), and
 *                          `TSShape::computeBounds` (node transforms compose
 *                          parent-relative; mesh vertices are in their node's local space).
 * - `ts/tsShapeAlloc.cc`   `TSShapeAlloc`'s read mode: the shape buffer is three independent
 *                          cursors (32-, 16-, 8-bit) over three sections, and `checkGuard`
 *                          consumes one value per cursor. A mis-ordered read trips the
 *                          engine's own self-check, which this reader reproduces.
 * - `ts/tsMesh.cc`         `TSMesh::assemble` / `TSSkinMesh::assemble` (mesh field order),
 *                          `TSMesh::leaveAsMultipleStrips` / `unwindStrip` (primitive
 *                          encoding: an `S16 start`/`S16 numElements` pair in the 16-bit
 *                          section plus an `S32 matIndex` in the 32-bit section).
 * - `ts/tsMesh.h`          `TSDrawPrimitive` (material/type bit layout) plus the mesh type
 *                          and mesh flag enums.
 * - `ts/tsDecal.cc`, `ts/tsSortedMesh.cc`  the other two mesh payloads in the mesh list.
 * - `ts/tsMaterialList.cc`, `dgl/materialList.cc`  the material list: a `U8` version, a
 *                          `U32` count, one length-prefixed name per material, then six
 *                          per-material arrays.
 * - `ts/tsShapeOldRead.cc` `Sequence::read`, and `ts/tsIntegerSet.cc` `TSIntegerSet::read`
 *                          for the membership sets inside it (skipped here).
 * - `ts/tsTransform.cc`    `Quat16::getQuatF`: a rotation is four `S16`s scaled by 1/0x7FFF.
 *
 * `parseDts` reads a shape; `dtsToGlb` turns one into a `.glb` the asset build can publish.
 * Neither applies an axis conversion — the engine does not either, and no engine function
 * exists to source one from (see `dtsToGlb`).
 */

import { BufferUtils, Document, type Accessor, type Material, type Mesh, type Node } from '@gltf-transform/core';

/** `TSShape::smVersion` is 23 (`ts/tsShape.cc:17`); every base `shapes.vl2` vehicle is 22
 *  or 23, and nothing newer exists to read. */
const SUPPORTED_DTS_VERSION = 23;

/** `Quat16::MAX_VAL` — `ts/tsTransform.h`. */
const QUAT16_MAX_VAL = 0x7fff;

export type Vec3 = readonly [number, number, number];
/** `[x, y, z, w]`, the component order the engine's `QuatF` uses. */
export type Quat = readonly [number, number, number, number];

export interface DtsBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** One entry of `TSShape::nodes`: its name and its own parent-relative default transform.
 *  The engine composes these with the parent's (`tsShape.cc:498-502`), so they are exactly
 *  a glTF node's local TRS. */
export interface DtsNode {
  readonly name: string;
  /** Index into `nodes`, or -1 for a root. */
  readonly parentIndex: number;
  readonly translation: Vec3;
  readonly rotation: Quat;
  /** Always `[1, 1, 1]`: only `defaultRotations` and `defaultTranslations` are written per
   *  node (`TSShape::disassembleShape`), and `TSTransform::setMatrix` builds `rot * pos`. */
  readonly scale: Vec3;
  /** Indices into `meshes` of the meshes whose owning object hangs off this node. */
  readonly meshIndexes: readonly number[];
}

/** One material batch of a mesh: a triangle list sharing one material slot. */
export interface DtsPrimitive {
  /** Index into `DtsShape.materials`, or -1 for `TSDrawPrimitive::NoMaterial`. */
  readonly materialIndex: number;
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals: Float32Array<ArrayBuffer>;
  readonly uvs: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

export type DtsMeshKind = 'standard' | 'skin' | 'decal' | 'sorted' | 'null';

export interface DtsMesh {
  /** The owning object's name from the shape's name table (`main_body`, `Mount0`, ...). */
  readonly name: string;
  readonly kind: DtsMeshKind;
  /** Index into `nodes` of the node this mesh renders under, or -1 when no object owns it. */
  readonly nodeIndex: number;
  /** `TSMesh::mBounds`/`mCenter`/`mRadius`: the mesh's own local-space bounds. */
  readonly bounds: DtsBox;
  readonly center: Vec3;
  readonly radius: number;
  /** Vertices actually referenced by this mesh's frame-0 geometry. */
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly primitives: readonly DtsPrimitive[];
  /** `TSMesh::numFrames` and `numMatFrames` — only frame 0 is emitted. */
  readonly frameCount: number;
  readonly materialFrameCount: number;
}

export interface DtsMaterial {
  /** The material name as authored, which in T2 is the skin resource path with no
   *  extension (`skins\Vehicle_grav_scout`). The asset build's `attachShapeTextures`
   *  normalizes exactly this string into its texture keys. */
  readonly name: string;
  /** The `TSMaterialList` flag word, carried into the GLB's material `extras` so the
   *  build's `Translucent`/`SelfIlluminating` handling keeps working. */
  readonly flags: number;
  readonly flagNames: readonly string[];
}

export interface DtsDetailLevel {
  readonly name: string;
  /** `Detail::size` — the projected size this level is selected at. */
  readonly size: number;
  readonly subShapeNum: number;
  readonly objectDetailNum: number;
  readonly averageError: number;
  readonly maxError: number;
  readonly polyCount: number;
}

/** One entry of `TSShape::objects`: a renderable item and the meshes (one per detail level,
 *  in `objectDetailNum` order, starting at `startMeshIndex`) that can draw it. */
export interface DtsObject {
  readonly name: string;
  /** `Object::numMeshes` — one per detail level of this object's sub-shape. */
  readonly numMeshes: number;
  /** `Object::startMeshIndex` — index of this object's `objectDetailNum` 0 mesh. */
  readonly startMeshIndex: number;
  /** `Object::nodeIndex` — the node the object renders under, or -1. */
  readonly nodeIndex: number;
}

/** One entry of `TSShape::subShapeFirstNode`/`subShapeNumNodes`/`subShapeFirstObject`/
 *  `subShapeNumObjects`: a contiguous run of the node and object arrays. Detail levels
 *  select a sub-shape (`Detail::subShapeNum`) and a mesh within each of its objects
 *  (`Detail::objectDetailNum`); that pair is how the engine maps a detail level to
 *  geometry, in `TSShape::computeBounds` and `TSShape::buildConvexHull`. */
export interface DtsSubShape {
  readonly firstNode: number;
  readonly numNodes: number;
  readonly firstObject: number;
  readonly numObjects: number;
}

export interface DtsShape {
  /** Low byte of the version word (`TSShape::read`: `smReadVersion &= 0xFF`). */
  readonly version: number;
  /** High 16 bits of the version word: the exporter's build number. */
  readonly exporterVersion: number;
  readonly radius: number;
  readonly tubeRadius: number;
  readonly center: Vec3;
  readonly bounds: DtsBox;
  readonly nodes: readonly DtsNode[];
  readonly meshes: readonly DtsMesh[];
  readonly objects: readonly DtsObject[];
  readonly subShapes: readonly DtsSubShape[];
  readonly materials: readonly DtsMaterial[];
  readonly detailLevels: readonly DtsDetailLevel[];
  /** `TSShape::sequences.size()` — parsed past, not emitted. */
  readonly sequenceCount: number;
  /** `TSShape::mSmallestVisibleSize`/`mSmallestVisibleDL`. */
  readonly smallestVisibleSize: number;
  readonly smallestVisibleDetailLevel: number;
}

/** `TSMaterialList`: `S_Wrap`, `T_Wrap`, `Translucent`, `Additive`, `Subtractive`,
 *  `SelfIlluminating`, `NeverEnvMap`, `NoMipMap`, `MipMap_ZeroBorder` are the enum in
 *  Torque3D's `ts/tsMaterialList.h`; bit 27 is `IflMaterial`, which `TSMaterialList::read`
 *  itself tests for, with its `IflFrame` companion at bit 28. The whole table agrees with
 *  the flag words T2's own exported shapes carry — `vehicle_grav_scout`'s materials decode
 *  67/99/7/134217839, named exactly these names, in the cached GLB's material extras. */
const MATERIAL_FLAG_NAMES: Record<number, string> = {
  1: 'SWrap',
  2: 'TWrap',
  4: 'Translucent',
  8: 'Additive',
  16: 'Subtractive',
  32: 'SelfIlluminating',
  64: 'NeverEnvMap',
  128: 'NoMipMap',
  256: 'MipMap_ZeroBorder',
  [1 << 27]: 'IflMaterial',
  [1 << 28]: 'IflFrame',
};

/** `TSMesh::StandardMeshType` and friends — `ts/tsMesh.h`. */
const MESH_TYPE_MASK = 0b11111;
const STANDARD_MESH_TYPE = 0;
const SKIN_MESH_TYPE = 1;
const DECAL_MESH_TYPE = 2;
const SORTED_MESH_TYPE = 3;

/** `TSMesh::NullMeshType` — `ts/tsMesh.h`. An object's mesh slot for a detail level it has
 *  no geometry for is written as this type word and nothing else (`TSShape::disassembleShape`
 *  writes no payload, and `TSMesh::assembleMesh` reads none). */
const NULL_MESH_TYPE = 4;

/** `TSDrawPrimitive` — `ts/tsMesh.h`: the element type is the top two bits of the material
 *  word, the material index the next 28; `NoMaterial` is bit 28 and `Indexed` bit 29. */
const PRIMITIVE_TYPE_SHIFT = 30;
const PRIMITIVE_MATERIAL_MASK = 0x0fffffff;
const PRIMITIVE_NO_MATERIAL = 1 << 28;

/** `TSShapeAlloc`'s guard counter. Both the writer and the reader start every section's
 *  guard sequence at zero, so guard #n must read exactly `n`. */
class ShapeStream {
  private offset32 = 0;
  private offset16 = 0;
  private offset8 = 0;
  private guards = 0;
  private readonly section32: DataView;
  private readonly section16: DataView;
  private readonly section8: DataView;
  /** The shape's version word, which several payloads branch on. */
  readonly version: number;

  constructor(section32: DataView, section16: DataView, section8: DataView, version: number) {
    this.section32 = section32;
    this.section16 = section16;
    this.section8 = section8;
    this.version = version;
  }

  private take(view: DataView, offset: number, size: number, section: string, field: string): number {
    if (offset + size > view.byteLength) {
      throw new Error(
        `Truncated DTS: ${field} needs ${size} more bytes at ${offset} of the ${section} ` +
          `section, which holds ${view.byteLength}.`,
      );
    }
    return offset + size;
  }

  i32(field = 'a dword'): number {
    this.offset32 = this.take(this.section32, this.offset32, 4, '32-bit', field);
    return this.section32.getInt32(this.offset32 - 4, true);
  }

  f32(field = 'a float'): number {
    this.offset32 = this.take(this.section32, this.offset32, 4, '32-bit', field);
    return this.section32.getFloat32(this.offset32 - 4, true);
  }

  i16(field = 'a word'): number {
    this.offset16 = this.take(this.section16, this.offset16, 2, '16-bit', field);
    return this.section16.getInt16(this.offset16 - 2, true);
  }

  i8(field = 'a byte'): number {
    this.offset8 = this.take(this.section8, this.offset8, 1, '8-bit', field);
    return this.section8.getInt8(this.offset8 - 1);
  }

  /** A copy, never a view: the backing storage holds all three sections and the whole file. */
  floats(count: number, field = 'a float array'): Float32Array<ArrayBuffer> {
    this.offset32 = this.take(this.section32, this.offset32, count * 4, '32-bit', field);
    const values = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      values[index] = this.section32.getFloat32(this.offset32 + index * 4 - count * 4, true);
    }
    return values;
  }

  ints(count: number, field = 'a dword array'): Int32Array {
    this.offset32 = this.take(this.section32, this.offset32, count * 4, '32-bit', field);
    const values = new Int32Array(count);
    for (let index = 0; index < count; index += 1) {
      values[index] = this.section32.getInt32(this.offset32 + index * 4 - count * 4, true);
    }
    return values;
  }

  words(count: number, field = 'a word array'): Int16Array {
    this.offset16 = this.take(this.section16, this.offset16, count * 2, '16-bit', field);
    const values = new Int16Array(count);
    for (let index = 0; index < count; index += 1) {
      values[index] = this.section16.getInt16(this.offset16 + index * 2 - count * 2, true);
    }
    return values;
  }

  skip32(count: number, field = 'a dword array'): void {
    this.offset32 = this.take(this.section32, this.offset32, count * 4, '32-bit', field);
  }

  skip16(count: number, field = 'a word array'): void {
    this.offset16 = this.take(this.section16, this.offset16, count * 2, '16-bit', field);
  }

  skip8(count: number, field = 'a byte array'): void {
    this.offset8 = this.take(this.section8, this.offset8, count, '8-bit', field);
  }

  vec3(field = 'a vector'): Vec3 {
    const values = this.floats(3, field);
    return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
  }

  /** A `Box3F`: six floats, min then max (`TSShape::disassembleShape`'s `copyToBuffer32`). */
  box(field = 'bounds'): DtsBox {
    const min = this.vec3(`${field} min`);
    const max = this.vec3(`${field} max`);
    return { min, max };
  }

  /** One null-terminated byte string out of the 8-bit section — the shape's name table. */
  string(): string {
    const start = this.offset8;
    let end = start;
    while (end < this.section8.byteLength && this.section8.getUint8(end) !== 0) end += 1;
    if (end >= this.section8.byteLength) {
      throw new Error('Truncated DTS: the shape name table ends in an unterminated string.');
    }
    this.offset8 = end + 1;
    return new TextDecoder('latin1').decode(
      new Uint8Array(this.section8.buffer, this.section8.byteOffset + start, end - start),
    );
  }

  /** `TSShapeAlloc::checkGuard` — one value per cursor, in lockstep with the writer's
   *  `setGuard`. This is the ordering check: a skipped or re-ordered field shifts every
   *  later read, and this throws before any of it reaches a mesh. Each counter is checked at
   *  its own width, exactly as the engine's `S8`/`S16`/`S32` guards wrap. */
  checkGuard(): void {
    const expected = this.guards;
    const found = [this.i32('guard dword'), this.i16('guard word'), this.i8('guard byte')];
    this.guards += 1;
    const wrapped = [
      expected | 0,
      (expected << 16) >> 16,
      (expected << 24) >> 24,
    ];
    if (found[0] !== wrapped[0] || found[1] !== wrapped[1] || found[2] !== wrapped[2]) {
      throw new Error(
        `Corrupt or unsupported DTS: guard #${expected} read [${found.join(', ')}] instead of ` +
          `[${wrapped.join(', ')}] — the stream is out of step with the engine write order.`,
      );
    }
  }
}

interface ShapeCounts {
  numNodes: number;
  numObjects: number;
  numDecals: number;
  numSubShapes: number;
  numIflMaterials: number;
  numNodeRots: number;
  numNodeTrans: number;
  numNodeUniformScales: number;
  numNodeAlignedScales: number;
  numNodeArbitraryScales: number;
  numObjectStates: number;
  numDecalStates: number;
  numTriggers: number;
  numDetails: number;
  numMeshes: number;
  numNames: number;
  smallestVisibleSize: number;
  smallestVisibleDetailLevel: number;
}

/** `TSShape::assembleShape`'s opening `get32` run, in its exact order. */
function readShapeCounts(stream: ShapeStream, version: number): ShapeCounts {
  const numNodes = stream.i32('numNodes');
  const numObjects = stream.i32('numObjects');
  const numDecals = stream.i32('numDecals');
  const numSubShapes = stream.i32('numSubShapes');
  const numIflMaterials = stream.i32('numIflMaterials');
  // v22 split one rotation+translation count into two; before that the single count covered
  // both, so the per-purpose counts are its difference from the node count.
  const rotTrans = version < 22 ? stream.i32('numNodeRots') : 0;
  const numNodeRots = version < 22 ? rotTrans - numNodes : stream.i32('numNodeRots');
  const numNodeTrans = version < 22 ? rotTrans - numNodes : stream.i32('numNodeTrans');
  const numNodeUniformScales = version < 22 ? 0 : stream.i32('numNodeUniformScales');
  const numNodeAlignedScales = version < 22 ? 0 : stream.i32('numNodeAlignedScales');
  const numNodeArbitraryScales = version < 22 ? 0 : stream.i32('numNodeArbitraryScales');
  const numObjectStates = stream.i32('numObjectStates');
  const numDecalStates = stream.i32('numDecalStates');
  const numTriggers = stream.i32('numTriggers');
  const numDetails = stream.i32('numDetails');
  const numMeshes = stream.i32('numMeshes');
  if (version < 23) stream.i32('numSkins'); // v23 folds skins into the mesh list
  const numNames = stream.i32('numNames');
  const smallestVisibleSize = stream.f32('mSmallestVisibleSize');
  const smallestVisibleDetailLevel = stream.i32('mSmallestVisibleDL');
  const counts = {
    numNodes,
    numObjects,
    numDecals,
    numSubShapes,
    numIflMaterials,
    numNodeRots,
    numNodeTrans,
    numNodeUniformScales,
    numNodeAlignedScales,
    numNodeArbitraryScales,
    numObjectStates,
    numDecalStates,
    numTriggers,
    numDetails,
    numMeshes,
    numNames,
    smallestVisibleSize,
    smallestVisibleDetailLevel,
  };
  // Every one of these multiplies a later read, so a nonsense value is a corrupt file, not
  // an empty shape — the engine only asserts on them much later, if at all.
  const integerCounts: Record<string, number> = { ...counts, smallestVisibleSize: 0 };
  for (const [name, value] of Object.entries(integerCounts)) {
    if (!Number.isInteger(value) || value < 0 || value > 1 << 22) {
      throw new Error(`Invalid DTS shape: ${name} is ${value}, which cannot be a count.`);
    }
  }
  return counts;
}

/** `TSIntegerSet::read` — a `S32` that is always written 0, a word count, then the words. */
function skipIntegerSet(stream: ShapeStream): void {
  stream.i32('set size');
  const words = stream.i32('set words');
  if (words < 0 || words > 0x4000) {
    throw new Error(`Invalid DTS shape: an animation membership set claims ${words} words.`);
  }
  stream.skip32(words, 'membership set');
}

interface RawNode {
  readonly nameIndex: number;
  readonly parentIndex: number;
  translation: Vec3;
  rotation: Quat;
}

interface RawObject {
  readonly nameIndex: number;
  readonly numMeshes: number;
  readonly startMeshIndex: number;
  readonly nodeIndex: number;
}

interface RawDetail {
  readonly nameIndex: number;
  readonly subShapeNum: number;
  readonly objectDetailNum: number;
  readonly size: number;
  readonly averageError: number;
  readonly maxError: number;
  readonly polyCount: number;
}

interface RawMesh {
  readonly kind: DtsMeshKind;
  readonly parentMesh: number;
  readonly bounds: DtsBox;
  readonly center: Vec3;
  readonly radius: number;
  readonly frameCount: number;
  readonly materialFrameCount: number;
  readonly vertsPerFrame: number;
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals: Float32Array<ArrayBuffer>;
  readonly uvs: Float32Array<ArrayBuffer>;
  readonly primData: Int16Array;
  readonly primMats: Int32Array;
  readonly indices: Int16Array;
}

interface RawShape extends ShapeCounts {
  readonly radius: number;
  readonly tubeRadius: number;
  readonly center: Vec3;
  readonly bounds: DtsBox;
  readonly nodes: RawNode[];
  readonly objects: RawObject[];
  readonly details: RawDetail[];
  readonly meshes: RawMesh[];
  readonly names: string[];
  readonly subShapes: readonly DtsSubShape[];
}

/** The vertex, texcoord and normal arrays of one mesh. A mesh whose `parentMesh` is >= 0
 *  shares them with that earlier mesh and the stream holds none of its own
 *  (`TSMesh::getSharedData32`). */
interface MeshArrays {
  readonly verts: Float32Array<ArrayBuffer>;
  readonly tverts: Float32Array<ArrayBuffer>;
  readonly norms: Float32Array<ArrayBuffer>;
}

function sharedArray(
  stream: ShapeStream,
  parentMesh: number,
  parent: MeshArrays | undefined,
  kind: keyof MeshArrays,
  count: number,
  field: string,
): Float32Array<ArrayBuffer> {
  if (parentMesh < 0) return stream.floats(count, field);
  const shared = parent?.[kind];
  if (!shared || shared.length < count) {
    throw new Error(
      `Invalid DTS shape: mesh shares its ${kind} with parent mesh ${parentMesh}, which ` +
        'does not carry them.',
    );
  }
  return shared;
}

interface MeshPayload {
  readonly arrays: MeshArrays;
  readonly parentMesh: number;
  readonly bounds: DtsBox;
  readonly center: Vec3;
  readonly radius: number;
  readonly frameCount: number;
  readonly materialFrameCount: number;
  readonly vertsPerFrame: number;
  readonly primData: Int16Array;
  readonly primMats: Int32Array;
  readonly indices: Int16Array;
}

/** `TSMesh::assemble`, in the engine's read order. Its `allocShape` calls only size the
 *  engine's *output* buffer and its `align32` calls only pad that buffer, so neither
 *  consumes stream data here — the two cursors stay independent. */
function readMeshPayload(
  stream: ShapeStream,
  arraysByMesh: readonly (MeshArrays | undefined)[],
): MeshPayload {
  stream.checkGuard();
  const frameCount = stream.i32('numFrames');
  const materialFrameCount = stream.i32('numMatFrames');
  const parentMesh = stream.i32('parentMesh');
  const parent = parentMesh >= 0 ? arraysByMesh[parentMesh] : undefined;
  const bounds = stream.box('mesh bounds');
  const center = stream.vec3('mCenter');
  const radius = stream.f32('mRadius');
  const numVerts = stream.i32('numVerts');
  const verts = sharedArray(stream, parentMesh, parent, 'verts', numVerts * 3, 'verts');
  const numTVerts = stream.i32('numTVerts');
  const tverts = sharedArray(stream, parentMesh, parent, 'tverts', numTVerts * 2, 'tverts');
  const norms = sharedArray(stream, parentMesh, parent, 'norms', numVerts * 3, 'norms');
  // Stored encoded normals arrived with version 22 (`TSMesh::assemble`'s `smReadVersion>21`
  // branch); older shapes have neither them nor a replacement.
  if (parentMesh < 0 && stream.version > 21) stream.skip8(numVerts, 'encoded normals');
  const szPrim = stream.i32('numPrimitives');
  const primData = stream.words(szPrim * 2, 'primitive starts and lengths');
  const primMats = stream.ints(szPrim, 'primitive materials');
  const szInd = stream.i32('numIndices');
  const indices = stream.words(szInd, 'indices');
  const szMerge = stream.i32('numMergeIndices');
  stream.skip16(szMerge, 'mergeIndices');
  const vertsPerFrame = stream.i32('vertsPerFrame');
  stream.i32('mesh flags');
  stream.checkGuard(); // `TSMesh::assemble`'s closing check, before the skin/decal extras
  return {
    arrays: { verts, tverts, norms },
    parentMesh,
    bounds,
    center,
    radius,
    frameCount,
    materialFrameCount,
    vertsPerFrame,
    primData,
    primMats,
    indices,
  };
}

/** `TSSkinMesh::assemble`: a standard payload plus a second vert/normal pair — the *unique*
 *  bind-pose vertices, in model space, which `TSSkinMesh::updateSkin` multiplies by
 *  `nodeWorld * initialTransform` — and the per-bone index/weight lists. */
function readSkinPayload(
  stream: ShapeStream,
  payload: MeshPayload,
  arraysByMesh: readonly (MeshArrays | undefined)[],
): MeshArrays {
  const parent = payload.parentMesh >= 0 ? arraysByMesh[payload.parentMesh] : undefined;
  const numUnique = stream.i32('numInitialVerts');
  const initialVerts = sharedArray(stream, payload.parentMesh, parent, 'verts', numUnique * 3, 'initialVerts');
  const initialNorms = sharedArray(stream, payload.parentMesh, parent, 'norms', numUnique * 3, 'initialNorms');
  if (payload.parentMesh < 0 && stream.version > 21) stream.skip8(numUnique, 'initial encoded normals');
  const transforms = stream.i32('numInitialTransforms');
  stream.skip32(transforms * 16, 'initialTransforms'); // inverse bind-pose matrices
  const influenced = stream.i32('numInfluences');
  stream.skip32(influenced * 3, 'vertexIndex/boneIndex/weight');
  const joints = stream.i32('numNodeIndices');
  stream.skip32(joints, 'nodeIndex');
  stream.checkGuard();
  return { verts: initialVerts, tverts: payload.arrays.tverts, norms: initialNorms };
}

/** `TSDecalMesh::assemble`: primitives and indices only — a decal's vertices belong to the
 *  object it is drawn over, so a decal contributes no geometry of its own. Below version 20
 *  a decal still carried a mesh's worth of legacy fields, which the reader steps over. */
function readDecalPayload(stream: ShapeStream): void {
  if (stream.version < 20) {
    stream.checkGuard();
    stream.skip32(15, 'legacy decal mesh');
  }
  const szPrim = stream.i32('numDecalPrimitives');
  stream.skip16(szPrim * 2, 'decal primitive data');
  stream.skip32(szPrim, 'decal primitive materials');
  const szInd = stream.i32('numDecalIndices');
  stream.skip16(szInd, 'decal indices');
  if (stream.version < 20) {
    stream.skip32(3, 'legacy decal tail');
    stream.checkGuard();
  }
  const szStarts = stream.i32('numStartPrimitives');
  stream.skip32(szStarts, 'startPrimitive');
  stream.skip32(szStarts * 4, 'texgenS');
  stream.skip32(szStarts * 4, 'texgenT');
  stream.i32('decal materialIndex');
  stream.checkGuard();
}

/** `TSSortedMesh::assemble`: a standard payload, then the cluster tables. */
function readSortedPayload(
  stream: ShapeStream,
  payload: MeshPayload,
  arraysByMesh: readonly (MeshArrays | undefined)[],
): MeshArrays {
  const clusters = stream.i32('numClusters');
  stream.skip32(clusters * 8, 'clusters');
  const starts = stream.i32('numStartClusters');
  stream.skip32(starts, 'startCluster');
  const firstVerts = stream.i32('numFirstVerts');
  stream.skip32(firstVerts, 'firstVerts');
  const counts = stream.i32('numVerts');
  stream.skip32(counts, 'numVerts');
  const firstTVerts = stream.i32('numFirstTVerts');
  stream.skip32(firstTVerts, 'firstTVerts');
  stream.i32('alwaysWriteDepth');
  stream.checkGuard();
  return payload.arrays;
}

/** The mesh list: one `S32` type word per mesh, then that mesh's payload — the "read in the
 *  meshes" loop of `TSShape::assembleShape`. */
function readMeshList(stream: ShapeStream, counts: ShapeCounts): RawMesh[] {
  const meshes: RawMesh[] = [];
  const arraysByMesh: (MeshArrays | undefined)[] = [];
  for (let index = 0; index < counts.numMeshes; index += 1) {
    const meshType = stream.i32('mesh type') & MESH_TYPE_MASK;
    if (meshType === NULL_MESH_TYPE) {
      arraysByMesh.push(undefined);
      meshes.push(emptyMesh('null'));
      continue;
    }
    if (meshType === DECAL_MESH_TYPE) {
      readDecalPayload(stream);
      arraysByMesh.push(undefined);
      meshes.push(emptyMesh('decal'));
      continue;
    }
    const payload = readMeshPayload(stream, arraysByMesh);
    let arrays: MeshArrays;
    if (meshType === SKIN_MESH_TYPE) {
      arrays = readSkinPayload(stream, payload, arraysByMesh);
      meshes.push(rawMesh('skin', payload, arrays));
    } else if (meshType === SORTED_MESH_TYPE) {
      arrays = readSortedPayload(stream, payload, arraysByMesh);
      meshes.push(rawMesh('sorted', payload, arrays));
    } else if (meshType === STANDARD_MESH_TYPE) {
      arrays = payload.arrays;
      meshes.push(rawMesh('standard', payload, arrays));
    } else {
      throw new Error(
        `Unsupported DTS mesh type ${meshType} at mesh ${index}: this reader implements the ` +
          'four payloads T2 ships (standard, skin, decal, sorted).',
      );
    }
    arraysByMesh.push(arrays);
  }
  return meshes;
}

function emptyMesh(kind: 'null' | 'decal'): RawMesh {
  const zero: Vec3 = [0, 0, 0];
  return {
    kind,
    parentMesh: -1,
    bounds: { min: zero, max: zero },
    center: zero,
    radius: 0,
    frameCount: 0,
    materialFrameCount: 0,
    vertsPerFrame: 0,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    primData: new Int16Array(0),
    primMats: new Int32Array(0),
    indices: new Int16Array(0),
  };
}

function rawMesh(kind: DtsMeshKind, payload: MeshPayload, arrays: MeshArrays): RawMesh {
  // A standard mesh stores every morph frame back to back; only frame 0 is geometry we can
  // emit. A skin mesh's arrays are already the unique bind-pose verts `updateSkin` uses, so
  // its own count wins.
  const frameLength =
    kind === 'skin' ? arrays.verts.length / 3 : payload.vertsPerFrame > 0 ? payload.vertsPerFrame : arrays.verts.length / 3;
  const vertexCount = Math.min(frameLength, arrays.verts.length / 3, arrays.tverts.length / 2, arrays.norms.length / 3);
  return {
    kind,
    parentMesh: payload.parentMesh,
    bounds: payload.bounds,
    center: payload.center,
    radius: payload.radius,
    frameCount: payload.frameCount,
    materialFrameCount: payload.materialFrameCount,
    vertsPerFrame: payload.vertsPerFrame,
    positions: arrays.verts.subarray(0, vertexCount * 3),
    normals: arrays.norms.subarray(0, vertexCount * 3),
    uvs: arrays.tverts.subarray(0, vertexCount * 2),
    primData: payload.primData,
    primMats: payload.primMats,
    indices: payload.indices,
  };
}

/** `TSShape::assembleShape` from the count block through the name table, plus the mesh list
 *  it ends with — the same order `TSShape::disassembleShape` writes. */
function readShapeBuffer(stream: ShapeStream, version: number, counts: ShapeCounts): RawShape {
  stream.checkGuard();
  const radius = stream.f32('radius');
  const tubeRadius = stream.f32('tubeRadius');
  const center = stream.vec3('center');
  const bounds = stream.box('bounds');

  stream.checkGuard();
  const nodes: RawNode[] = [];
  for (let index = 0; index < counts.numNodes; index += 1) {
    const nameIndex = stream.i32('node name');
    const parentIndex = stream.i32('node parent');
    stream.skip32(3, 'node links'); // firstObject, firstChild, nextSibling
    nodes.push({ nameIndex, parentIndex, translation: [0, 0, 0], rotation: [0, 0, 0, 1] });
  }

  stream.checkGuard();
  const objects: RawObject[] = [];
  for (let index = 0; index < counts.numObjects; index += 1) {
    const nameIndex = stream.i32('object name');
    const numMeshes = stream.i32('object meshes');
    const startMeshIndex = stream.i32('object first mesh');
    const nodeIndex = stream.i32('object node');
    stream.skip32(2, 'object links'); // nextSibling, firstDecal
    objects.push({ nameIndex, numMeshes, startMeshIndex, nodeIndex });
  }

  stream.checkGuard();
  stream.skip32(counts.numDecals * 5, 'decals');
  stream.checkGuard();
  stream.skip32(counts.numIflMaterials * 5, 'iflMaterials');
  stream.checkGuard();
  const firstNodes = stream.ints(counts.numSubShapes, 'subShapeFirstNode');
  const firstObjects = stream.ints(counts.numSubShapes, 'subShapeFirstObject');
  stream.skip32(counts.numSubShapes, 'subShapeFirstDecal');
  stream.checkGuard();
  const numNodesPerSubShape = stream.ints(counts.numSubShapes, 'subShapeNumNodes');
  const numObjectsPerSubShape = stream.ints(counts.numSubShapes, 'subShapeNumObjects');
  stream.skip32(counts.numSubShapes, 'subShapeNumDecals');
  stream.checkGuard();
  const subShapes = Array.from({ length: counts.numSubShapes }, (_, index) => ({
    firstNode: firstNodes[index] ?? 0,
    numNodes: numNodesPerSubShape[index] ?? 0,
    firstObject: firstObjects[index] ?? 0,
    numObjects: numObjectsPerSubShape[index] ?? 0,
  }));

  // Default node transforms, then the animated keys that follow them in the same arrays.
  const rotations = stream.words(counts.numNodes * 4, 'defaultRotations');
  const translations = stream.floats(counts.numNodes * 3, 'defaultTranslations');
  for (let index = 0; index < counts.numNodes; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    node.rotation = [
      (rotations[index * 4] ?? 0) / QUAT16_MAX_VAL,
      (rotations[index * 4 + 1] ?? 0) / QUAT16_MAX_VAL,
      (rotations[index * 4 + 2] ?? 0) / QUAT16_MAX_VAL,
      (rotations[index * 4 + 3] ?? 0) / QUAT16_MAX_VAL,
    ];
    node.translation = [
      translations[index * 3] ?? 0,
      translations[index * 3 + 1] ?? 0,
      translations[index * 3 + 2] ?? 0,
    ];
  }
  stream.skip32(counts.numNodeTrans * 3, 'nodeTranslations');
  stream.skip16(counts.numNodeRots * 4, 'nodeRotations');
  stream.checkGuard();
  // Node scale keys arrived with version 22: an older shape has neither the arrays nor the
  // guard that follows them (`TSShape::assembleShape` reads both inside `smReadVersion>21`).
  if (version > 21) {
    stream.skip32(counts.numNodeUniformScales, 'nodeUniformScales');
    stream.skip32(counts.numNodeAlignedScales * 3, 'nodeAlignedScales');
    stream.skip32(counts.numNodeArbitraryScales * 3, 'nodeArbitraryScaleFactors');
    stream.skip16(counts.numNodeArbitraryScales * 4, 'nodeArbitraryScaleRots');
    stream.checkGuard();
  }

  stream.skip32(counts.numObjectStates * 3, 'objectStates');
  stream.checkGuard();
  stream.skip32(counts.numDecalStates, 'decalStates');
  stream.checkGuard();
  stream.skip32(counts.numTriggers * 2, 'triggers');
  stream.checkGuard();
  const details: RawDetail[] = [];
  for (let index = 0; index < counts.numDetails; index += 1) {
    const nameIndex = stream.i32('detail name');
    const subShapeNum = stream.i32('detail subshape');
    const objectDetailNum = stream.i32('detail object detail');
    const size = stream.f32('detail size');
    const averageError = stream.f32('detail average error');
    const maxError = stream.f32('detail max error');
    const polyCount = stream.i32('detail poly count');
    details.push({ nameIndex, subShapeNum, objectDetailNum, size, averageError, maxError, polyCount });
  }
  stream.checkGuard();

  const meshes = readMeshList(stream, counts);
  stream.checkGuard();

  const names: string[] = [];
  for (let index = 0; index < counts.numNames; index += 1) names.push(stream.string());
  stream.checkGuard();
  return {
    ...counts,
    radius,
    tubeRadius,
    center,
    bounds,
    nodes,
    objects,
    details,
    meshes,
    names,
    subShapes,
  };
}

/** `TSShape::read`'s header: the packed version word and the dword offsets that split the
 *  shape buffer into its 32-, 16- and 8-bit sections. */
function splitSections(bytes: Uint8Array): {
  version: number;
  exporterVersion: number;
  stream: ShapeStream;
  bodyOffset: number;
} {
  if (bytes.byteLength < 16) {
    throw new Error(`Truncated DTS: ${bytes.byteLength} bytes cannot hold the 16-byte header.`);
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionWord = header.getUint32(0, true);
  const version = versionWord & 0xff;
  const exporterVersion = versionWord >>> 16;
  if (version < 19 || version > SUPPORTED_DTS_VERSION) {
    throw new Error(
      `Unsupported DTS version ${version} (exporter ${exporterVersion}): this reader ` +
        `implements versions 19..${SUPPORTED_DTS_VERSION}, the memory-buffer container T2 ` +
        'ships. Older shapes use the pre-v19 layout (`TSShape::readOldShape`), which this ' +
        'reader does not implement.',
    );
  }
  const sizeMemBuffer = header.getUint32(4, true);
  const startU16 = header.getUint32(8, true);
  const startU8 = header.getUint32(12, true);
  if (startU16 > sizeMemBuffer || startU8 > sizeMemBuffer || startU8 < startU16) {
    throw new Error(
      `Invalid DTS shape: section offsets ${startU16}/${startU8} do not fit the header's ` +
        `${sizeMemBuffer}-dword shape buffer.`,
    );
  }
  const bufferStart = 16;
  if (bufferStart + sizeMemBuffer * 4 > bytes.byteLength) {
    throw new Error(
      `Truncated DTS: the header declares a ${sizeMemBuffer}-dword shape buffer but only ` +
        `${bytes.byteLength - bufferStart} bytes follow it.`,
    );
  }
  const section = (from: number, to: number): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset + bufferStart + from * 4, (to - from) * 4);
  return {
    version,
    exporterVersion,
    stream: new ShapeStream(
      section(0, startU16),
      section(startU16, startU8),
      section(startU8, sizeMemBuffer),
      version,
    ),
    bodyOffset: bufferStart + sizeMemBuffer * 4,
  };
}

/** `TSMaterialList::read` + `MaterialList::read` (`ts/tsMaterialList.cc`,
 *  `dgl/materialList.cc`): a `U8` version, a `U32` count, one length-prefixed name per
 *  material, then flags, reflectance/bump/detail map indices, detail scales and reflection
 *  amounts — one `U32` or `F32` per material, each array in turn. */
function readMaterialList(bytes: Uint8Array, offset: number, version: number): DtsMaterial[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryVersion = view.getUint8(offset);
  if (binaryVersion !== 1) {
    throw new Error(
      `Unsupported DTS material list: version byte ${binaryVersion}; only the binary form ` +
        '(version 1) appears in T2 shapes.',
    );
  }
  const count = view.getUint32(offset + 1, true);
  if (count > 0x4000) throw new Error(`Invalid DTS material list: ${count} materials.`);
  let cursor = offset + 5;
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = view.getUint8(cursor);
    cursor += 1;
    if (cursor + length > bytes.byteLength) {
      throw new Error(`Truncated DTS: material ${index}'s name runs past the end of the file.`);
    }
    names.push(
      new TextDecoder('latin1').decode(
        new Uint8Array(bytes.buffer, bytes.byteOffset + cursor, length),
      ),
    );
    cursor += length;
  }
  const flags: number[] = [];
  for (let index = 0; index < count; index += 1) {
    flags.push(view.getUint32(cursor, true));
    cursor += 4;
  }
  const mapArrays = version < 5 ? 0 : 3; // reflectance, bump, detail maps
  cursor += count * 4 * mapArrays;
  if (version > 11) cursor += count * 4; // detail scales
  if (version > 20) cursor += count * 4; // reflection amounts
  if (cursor > bytes.byteLength) {
    throw new Error('Truncated DTS: the material list runs past the end of the file.');
  }
  return names.map((name, index) => {
    const materialFlags = flags[index] ?? 0;
    const flagNames = Object.entries(MATERIAL_FLAG_NAMES)
      .filter(([bit]) => (materialFlags & Number(bit)) !== 0)
      .map(([, flagName]) => flagName);
    // Anything outside the table stays visible rather than being silently dropped.
    const unknown = materialFlags & ~Object.keys(MATERIAL_FLAG_NAMES).reduce((mask, bit) => mask | Number(bit), 0);
    return {
      name,
      flags: materialFlags,
      flagNames: unknown === 0 ? flagNames : [...flagNames, `Unknown(0x${unknown.toString(16)})`],
    };
  });
}

/** `TSShape::Sequence::read` (`ts/tsShapeOldRead.cc`) for the versions this reader accepts,
 *  walked over the raw bytes after the shape buffer — sequences carry their own cursors and
 *  must be stepped over to reach the material list. */
function skipSequences(bytes: Uint8Array, offset: number, version: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (offset + 4 > bytes.byteLength) throw new Error('Truncated DTS: no sequence count.');
  const sequenceCount = view.getInt32(offset, true);
  if (sequenceCount < 0 || sequenceCount > 0x4000) {
    throw new Error(`Invalid DTS shape: ${sequenceCount} sequences.`);
  }
  let cursor = offset + 4;
  for (let index = 0; index < sequenceCount; index += 1) {
    cursor = skipOneSequence(view, cursor, version, bytes.byteLength, index);
  }
  return cursor;
}

function skipOneSequence(
  view: DataView,
  offset: number,
  version: number,
  length: number,
  index: number,
): number {
  let cursor = offset;
  const dwords = (count: number, field: string): void => {
    if (cursor + count * 4 > length) {
      throw new Error(`Truncated DTS: sequence ${index}'s ${field} runs past the end of the file.`);
    }
    cursor += count * 4;
  };
  const integerSet = (field: string): void => {
    if (cursor + 8 > length) {
      throw new Error(`Truncated DTS: sequence ${index}'s ${field} runs past the end of the file.`);
    }
    const words = view.getInt32(cursor + 4, true);
    cursor += 8;
    if (words < 0 || words > 0x4000) {
      throw new Error(`Invalid DTS shape: sequence ${index}'s ${field} claims ${words} words.`);
    }
    dwords(words, field);
  };
  dwords(1, 'name'); // nameIndex
  if (version > 21) dwords(1, 'flags');
  dwords(1, 'keyframes'); // numKeyframes, or the start/end pair before v17
  if (version < 17) dwords(1, 'keyframe range');
  dwords(1, 'duration');
  dwords(3, 'priority and ground frames'); // priority, firstGroundFrame, numGroundFrames
  if (version > 21) dwords(5, 'base states');
  else if (version >= 17) dwords(3, 'base states');
  if (version > 8) dwords(2, 'trigger range');
  if (version > 7) dwords(1, 'toolBegin');
  integerSet('rotationMatters');
  if (version < 22) return cursor;
  integerSet('translationMatters');
  integerSet('scaleMatters');
  if (version > 10) integerSet('decalMatters');
  if (version > 5) integerSet('iflMatters');
  integerSet('visMatters');
  integerSet('frameMatters');
  integerSet('matFrameMatters');
  return cursor;
}

/** `TSDrawPrimitive` plus `TSMesh::leaveAsMultipleStrips`/`unwindStrip`: each primitive is
 *  a `start`/`numElements` pair into the index list and a material word whose top two bits
 *  say triangles, strip or fan. Degenerate triangles are dropped exactly where
 *  `unwindStrip` drops them. */
function primitiveTriangles(mesh: RawMesh, primitiveIndex: number): number[] {
  const start = mesh.primData[primitiveIndex * 2] ?? 0;
  const numElements = mesh.primData[primitiveIndex * 2 + 1] ?? 0;
  const type = ((mesh.primMats[primitiveIndex] ?? 0) >>> PRIMITIVE_TYPE_SHIFT) & 0b11;
  const at = (offset: number): number => mesh.indices[start + offset] ?? 0;
  const triangles: number[] = [];
  if (type === 0) {
    for (let index = 0; index + 2 < numElements; index += 3) {
      triangles.push(at(index), at(index + 1), at(index + 2));
    }
    return triangles;
  }
  if (numElements < 3) return triangles;
  if (type === 2) {
    for (let index = 1; index + 1 < numElements; index += 1) {
      triangles.push(at(0), at(index), at(index + 1));
    }
    return triangles;
  }
  // Strip: winding alternates; the engine skips any triangle with a repeated index rather
  // than emitting a degenerate one.
  for (let index = 2; index < numElements; index += 1) {
    const a = at(index % 2 === 0 ? index - 2 : index - 1);
    const b = at(index % 2 === 0 ? index - 1 : index - 2);
    const c = at(index);
    if (a === b || b === c || c === a) continue;
    triangles.push(a, b, c);
  }
  return triangles;
}

/** Groups a mesh's primitives into material batches the way `TSMesh::convertToTris` starts
 *  a new draw when the material word changes, and emits each batch as a triangle list (the
 *  only topology glTF needs). */
function buildPrimitives(mesh: RawMesh): DtsPrimitive[] {
  const batches: { materialIndex: number; indices: number[] }[] = [];
  for (let index = 0; index < mesh.primMats.length; index += 1) {
    const materialWord = mesh.primMats[index] ?? 0;
    const materialIndex = (materialWord & PRIMITIVE_NO_MATERIAL) !== 0 ? -1 : materialWord & PRIMITIVE_MATERIAL_MASK;
    const last = batches[batches.length - 1];
    if (!last || last.materialIndex !== materialIndex) batches.push({ materialIndex, indices: [] });
    batches[batches.length - 1]?.indices.push(...primitiveTriangles(mesh, index));
  }
  return batches
    .filter((batch) => batch.indices.length > 0)
    .map((batch) => ({
      materialIndex: batch.materialIndex,
      positions: mesh.positions,
      normals: mesh.normals,
      uvs: mesh.uvs,
      indices: Uint16Array.from(batch.indices),
    }));
}

/** Resolves the raw tables into the public shape: names, mesh→node ownership, and each
 *  mesh's triangle batches. */
function assembleShape(
  raw: RawShape,
  version: number,
  exporterVersion: number,
  materials: readonly DtsMaterial[],
  sequenceCount: number,
): DtsShape {
  const nameOf = (nameIndex: number, fallback: string): string => raw.names[nameIndex] ?? fallback;
  const meshes = raw.meshes.map((mesh, index) => {
    const owner = raw.objects.find(
      (object) => index >= object.startMeshIndex && index < object.startMeshIndex + object.numMeshes,
    );
    const primitives = buildPrimitives(mesh);
    return {
      name: owner ? nameOf(owner.nameIndex, `object${owner.nameIndex}`) : `mesh${index}`,
      kind: mesh.kind,
      nodeIndex: owner?.nodeIndex ?? -1,
      bounds: mesh.bounds,
      center: mesh.center,
      radius: mesh.radius,
      vertexCount: mesh.positions.length / 3,
      triangleCount: primitives.reduce((total, primitive) => total + primitive.indices.length / 3, 0),
      primitives,
      frameCount: mesh.frameCount,
      materialFrameCount: mesh.materialFrameCount,
    };
  });
  const meshIndexesByNode = new Map<number, number[]>();
  for (const [index, mesh] of meshes.entries()) {
    if (mesh.nodeIndex < 0) continue;
    const list = meshIndexesByNode.get(mesh.nodeIndex) ?? [];
    list.push(index);
    meshIndexesByNode.set(mesh.nodeIndex, list);
  }
  return {
    version,
    exporterVersion,
    radius: raw.radius,
    tubeRadius: raw.tubeRadius,
    center: raw.center,
    bounds: raw.bounds,
    nodes: raw.nodes.map((node, index) => ({
      name: nameOf(node.nameIndex, `node${index}`),
      parentIndex: node.parentIndex,
      translation: node.translation,
      rotation: node.rotation,
      scale: [1, 1, 1] as Vec3,
      meshIndexes: meshIndexesByNode.get(index) ?? [],
    })),
    meshes,
    objects: raw.objects.map((object, index) => ({
      name: nameOf(object.nameIndex, `object${index}`),
      numMeshes: object.numMeshes,
      startMeshIndex: object.startMeshIndex,
      nodeIndex: object.nodeIndex,
    })),
    subShapes: raw.subShapes,
    materials,
    detailLevels: raw.details.map((detail, index) => ({
      name: nameOf(detail.nameIndex, `detail${index}`),
      size: detail.size,
      subShapeNum: detail.subShapeNum,
      objectDetailNum: detail.objectDetailNum,
      averageError: detail.averageError,
      maxError: detail.maxError,
      polyCount: detail.polyCount,
    })),
    sequenceCount,
    smallestVisibleSize: raw.smallestVisibleSize,
    smallestVisibleDetailLevel: raw.smallestVisibleDetailLevel,
  };
}

/** Reads a Tribes 2 `.dts` shape. Throws on a version this reader does not implement, on a
 *  truncated file, and on a stream that falls out of step with the engine's own write
 *  order (each `checkGuard` above). */
export function parseDts(bytes: Uint8Array): DtsShape {
  const { version, exporterVersion, stream, bodyOffset } = splitSections(bytes);
  const counts = readShapeCounts(stream, version);
  const raw = readShapeBuffer(stream, version, counts);
  const materialOffset = skipSequences(bytes, bodyOffset, version);
  const sequenceCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(
    bodyOffset,
    true,
  );
  return assembleShape(raw, version, exporterVersion, readMaterialList(bytes, materialOffset, version), sequenceCount);
}

export interface DtsToGlbOptions {
  /** Which entry of `DtsShape.detailLevels` to emit; defaults to 0, the highest detail.
   *  The engine draws one mesh per object *per detail level* (`TSShape::computeBounds`),
   *  so the file's mesh list holds every LOD — emitting them all would stack the levels on
   *  top of each other. */
  readonly detailLevel?: number;
  /** Name for the emitted glTF scene. */
  readonly name?: string;
  /** glTF `asset.generator`. */
  readonly generator?: string;
}

/** Emits one detail level of `shape` as a glTF binary.
 *
 *  The scene keeps one node per DTS node with its authored name and its own parent-relative
 *  transform — the form the engine composes in `TSShape::computeBounds` and the form the
 *  client's `Eye`/`Mount0` lookups need — and one mesh per mesh that detail level draws.
 *
 *  No axis conversion is applied. The engine never rotates a shape into another basis: node
 *  transforms are used as authored and no reader or instance function applies a basis
 *  change, so there is nothing to source one from. Geometry therefore stays in DTS model
 *  space (Z up). The pre-converted `.glb` files the build used to download did carry a
 *  Z-up→Y-up conversion, but it came from Blender's exporter rather than from T2 —
 *  `dts.test.ts` measures both sides.
 *
 *  `@gltf-transform/core` builds the document — its accessors, primitives, materials, node
 *  graph and chunk padding are the emitted content — and `serializeGlb` writes that
 *  document's JSON chunk. The library's own `NodeIO.writeBinary` is async in v4 while this
 *  module's consumers are synchronous build steps, so the twelve lines of container header
 *  glTF 2.0 §4.4 specifies are written here instead of awaited. */
export function dtsToGlb(shape: DtsShape, options: DtsToGlbOptions = {}): Uint8Array {
  const detailIndex = options.detailLevel ?? 0;
  const detail = shape.detailLevels[detailIndex];
  if (!detail) {
    throw new Error(
      `dtsToGlb: detail level ${detailIndex} does not exist; the shape has ` +
        `${shape.detailLevels.length} (${shape.detailLevels.map((level) => level.name).join(', ')}).`,
    );
  }
  const document = new Document();
  const scene = document.createScene(options.name ?? 'Scene');
  document.getRoot().setDefaultScene(scene);
  const nodes = shape.nodes.map((node) =>
    document
      .createNode(node.name)
      .setTranslation([...node.translation])
      .setRotation([...node.rotation])
      .setScale([...node.scale]),
  );
  shape.nodes.forEach((node, index) => {
    const child = nodes[index];
    if (!child) return;
    const parent = node.parentIndex >= 0 ? nodes[node.parentIndex] : undefined;
    if (parent) parent.addChild(child);
    else scene.addChild(child);
  });
  const materials = new Map<number, Material>();
  for (const { nodeIndex, mesh } of detailMeshes(shape, detail)) {
    const owner = nodes[nodeIndex];
    // One object per node per detail level is the T2 layout; a second mesh on the same node
    // (legal in the format) gets its own child node rather than replacing the first.
    const holder = owner && !owner.getMesh() ? owner : document.createNode(`${mesh.name}_${nodeIndex}`);
    (owner ?? scene).addChild(holder);
    holder.setMesh(emitMesh(document, shape, mesh, materials));
  }
  return serializeGlb(document, options.generator ?? 'clans-dts');
}

/** Which meshes a detail level draws, exactly as `TSShape::computeBounds` walks them: every
 *  object of the level's sub-shape, taking that object's mesh at `objectDetailNum` — or
 *  nothing, when the object has fewer meshes than that (the engine's `od<numMeshes` test). */
function detailMeshes(shape: DtsShape, detail: DtsDetailLevel): { nodeIndex: number; mesh: DtsMesh }[] {
  const subShape = shape.subShapes[detail.subShapeNum];
  if (!subShape) {
    throw new Error(
      `dtsToGlb: detail level ${detail.name} names sub-shape ${detail.subShapeNum}, which the ` +
        `shape's ${shape.subShapes.length} sub-shapes do not include.`,
    );
  }
  const drawn: { nodeIndex: number; mesh: DtsMesh }[] = [];
  const end = subShape.firstObject + subShape.numObjects;
  for (let index = subShape.firstObject; index < end; index += 1) {
    const object = shape.objects[index];
    if (!object || detail.objectDetailNum >= object.numMeshes) continue;
    const mesh = shape.meshes[object.startMeshIndex + detail.objectDetailNum];
    if (mesh && mesh.primitives.length > 0) drawn.push({ nodeIndex: object.nodeIndex, mesh });
  }
  return drawn;
}

/** Turns one DTS mesh into one glTF mesh: a primitive per material batch, holding the
 *  frame-0 positions, normals and texture coordinates `parseDts` read. */
function emitMesh(
  document: Document,
  shape: DtsShape,
  mesh: DtsMesh,
  materials: Map<number, Material>,
): Mesh {
  const gltfMesh = document.createMesh(mesh.name);
  for (const primitive of mesh.primitives) {
    const gltfPrimitive = document
      .createPrimitive()
      .setAttribute('POSITION', accessorFor(document, `${mesh.name}_position`, primitive.positions, 'VEC3'))
      .setAttribute('NORMAL', accessorFor(document, `${mesh.name}_normal`, primitive.normals, 'VEC3'))
      .setAttribute('TEXCOORD_0', accessorFor(document, `${mesh.name}_uv`, primitive.uvs, 'VEC2'))
      .setIndices(accessorFor(document, `${mesh.name}_index`, primitive.indices, 'SCALAR'));
    const material = materialFor(document, shape, primitive.materialIndex, materials);
    if (material) gltfPrimitive.setMaterial(material);
    gltfMesh.addPrimitive(gltfPrimitive);
  }
  return gltfMesh;
}

/** `@gltf-transform/core` derives the accessor's component type from its array, so a
 *  `Float32Array` is `FLOAT` and a `Uint16Array` is `UNSIGNED_SHORT` — the two the DTS
 *  reader produces. */
function accessorFor(
  document: Document,
  name: string,
  values: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>,
  type: 'VEC3' | 'VEC2' | 'SCALAR',
): Accessor {
  return document.createAccessor(name).setArray(values).setType(type);
}

/** Maps a DTS material slot onto an emitted material, creating it on first use. Only
 *  referenced materials are emitted: the build's `attachShapeTextures` throws for a material
 *  whose resource it cannot resolve, and a shape's decal slots (bulletholes and damage
 *  overlays) are not in that manifest. Base color stays unassigned — the build attaches the
 *  authored skin — with the same neutral stand-in values the existing converted shapes use. */
function materialFor(
  document: Document,
  shape: DtsShape,
  materialIndex: number,
  materials: Map<number, Material>,
): Material | null {
  const source = shape.materials[materialIndex];
  if (!source) return null;
  const existing = materials.get(materialIndex);
  if (existing) return existing;
  const material = document
    .createMaterial(source.name)
    .setBaseColorFactor([0.8, 0.8, 0.8, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.5)
    .setExtras({ resource_path: source.name, flags: source.flags, flag_names: [...source.flagNames] });
  // Torque draws translucent materials without culling.
  if (source.flagNames.includes('Translucent')) material.setDoubleSided(true);
  materials.set(materialIndex, material);
  return material;
}

interface GltfAccessorJson {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GltfBufferViewJson {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

interface GltfJson {
  asset: { version: string; generator: string };
  scene: number;
  scenes: { name: string; nodes: number[] }[];
  nodes: Record<string, unknown>[];
  meshes: Record<string, unknown>[];
  materials: Record<string, unknown>[];
  accessors: GltfAccessorJson[];
  bufferViews: GltfBufferViewJson[];
  buffers: { byteLength: number }[];
}

/** glTF 2.0 §3.6.2.2: vertex attributes are `ARRAY_BUFFER`, indices
 *  `ELEMENT_ARRAY_BUFFER`; §3.7.2.1: `mode` 4 is a triangle list. */
const GLTF_MODE_TRIANGLES = 4;
const GLTF_ARRAY_BUFFER = 34962;
const GLTF_ELEMENT_ARRAY_BUFFER = 34963;

/** Serializes the document `dtsToGlb` built: every node, mesh, material and accessor it
 *  holds, plus one buffer, packed as a glTF binary. Each accessor gets its own buffer view
 *  padded to four bytes, which satisfies §3.6.2.4's alignment rule for both the `FLOAT`
 *  attributes and the `UNSIGNED_SHORT` indices. */
function serializeGlb(document: Document, generator: string): Uint8Array {
  const root = document.getRoot();
  const bufferViews: GltfBufferViewJson[] = [];
  const chunks: Uint8Array[] = [];
  let length = 0;
  const accessorIndexes = new Map<Accessor, number>();
  const accessors: GltfAccessorJson[] = [];
  const indexAccessors = new Set<Accessor>();
  const positionAccessors = new Set<Accessor>();
  const meshIndexes = new Map<Mesh, number>();
  const materialIndexes = new Map<Material, number>();
  const nodeIndexes = new Map<Node, number>();
  for (const mesh of root.listMeshes()) {
    meshIndexes.set(mesh, meshIndexes.size);
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      if (indices) indexAccessors.add(indices);
      const position = primitive.getAttribute('POSITION');
      if (position) positionAccessors.add(position);
    }
  }
  for (const material of root.listMaterials()) materialIndexes.set(material, materialIndexes.size);
  for (const node of root.listNodes()) nodeIndexes.set(node, nodeIndexes.size);
  for (const accessor of root.listAccessors()) {
    const array = accessor.getArray();
    if (!array) continue;
    const padding = (4 - (length % 4)) % 4;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
      length += padding;
    }
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({
      buffer: 0,
      byteOffset: length,
      byteLength: bytes.byteLength,
      target: indexAccessors.has(accessor) ? GLTF_ELEMENT_ARRAY_BUFFER : GLTF_ARRAY_BUFFER,
    });
    chunks.push(new Uint8Array(bytes));
    length += bytes.byteLength;
    const type = accessor.getType();
    accessorIndexes.set(accessor, accessors.length);
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: accessor.getComponentType(),
      count: accessor.getCount(),
      type,
      ...(positionAccessors.has(accessor) && array instanceof Float32Array
        ? boundsOf(array)
        : {}),
    });
  }
  const binary = chunks.length > 0 ? BufferUtils.concat(chunks) : new Uint8Array(0);
  const json: GltfJson = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: root.listScenes().map((scene) => ({
      name: scene.getName(),
      nodes: scene.listChildren().map((child) => nodeIndexes.get(child) ?? -1),
    })),
    nodes: root.listNodes().map((node) => {
      const mesh = node.getMesh();
      const children = node.listChildren().map((child) => nodeIndexes.get(child) ?? -1);
      return {
        name: node.getName(),
        translation: [...node.getTranslation()],
        rotation: [...node.getRotation()],
        scale: [...node.getScale()],
        ...(mesh ? { mesh: meshIndexes.get(mesh) ?? -1 } : {}),
        ...(children.length > 0 ? { children } : {}),
      };
    }),
    meshes: root.listMeshes().map((mesh) => ({
      name: mesh.getName(),
      primitives: mesh.listPrimitives().map((primitive) => {
        const attributes: Record<string, number> = {};
        for (const semantic of primitive.listSemantics()) {
          const accessor = primitive.getAttribute(semantic);
          if (accessor) attributes[semantic] = accessorIndexes.get(accessor) ?? -1;
        }
        const indices = primitive.getIndices();
        const material = primitive.getMaterial();
        return {
          attributes,
          ...(indices ? { indices: accessorIndexes.get(indices) ?? -1 } : {}),
          ...(material ? { material: materialIndexes.get(material) ?? -1 } : {}),
          mode: primitive.getMode() || GLTF_MODE_TRIANGLES,
        };
      }),
    })),
    materials: root.listMaterials().map((material) => ({
      name: material.getName(),
      extras: material.getExtras(),
      pbrMetallicRoughness: {
        baseColorFactor: [...material.getBaseColorFactor()],
        metallicFactor: material.getMetallicFactor(),
        roughnessFactor: material.getRoughnessFactor(),
      },
      ...(material.getDoubleSided() ? { doubleSided: true } : {}),
    })),
    accessors,
    bufferViews,
    buffers: binary.byteLength > 0 ? [{ byteLength: binary.byteLength }] : [],
  };
  const jsonChunk = BufferUtils.pad(BufferUtils.encodeText(JSON.stringify(json)), 0x20);
  const binChunk = binary.byteLength > 0 ? BufferUtils.pad(binary, 0) : new Uint8Array(0);
  const binHeaderLength = binChunk.byteLength > 0 ? 8 : 0;
  // glTF 2.0 §4.4: magic, version, total length, then each chunk's length and type.
  const total = 12 + 8 + jsonChunk.byteLength + binHeaderLength + binChunk.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  if (binChunk.byteLength > 0) {
    const at = 20 + jsonChunk.byteLength;
    view.setUint32(at, binChunk.byteLength, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(binChunk, at + 8);
  }
  return out;
}

/** glTF requires `min`/`max` on every `POSITION` accessor (§3.6.2.5). */
function boundsOf(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? value, value);
      max[axis] = Math.max(max[axis] ?? value, value);
    }
  }
  return {
    min: min.map((value) => (Number.isFinite(value) ? value : 0)),
    max: max.map((value) => (Number.isFinite(value) ? value : 0)),
  };
}
