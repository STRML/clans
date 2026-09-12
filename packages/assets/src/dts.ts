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
 * - `math/mMath_C.cc`      `m_quatF_set_matF_C`, reached through `QuatF::setMatrix`: the
 *                          matrix a stored rotation produces is the *inverse* rotation, which
 *                          is why `parseDts` conjugates every node rotation it reads.
 *
 * `parseDts` reads a shape; `dtsToGlb` turns one into a `.glb` the asset build can publish,
 * in the Torque-to-glTF basis every shipped asset already uses (see `TORQUE_MODEL_BASIS`).
 */

import {
  BufferUtils,
  Document,
  type Accessor,
  type Animation,
  type AnimationChannel,
  type Material,
  type Mesh,
  type Node,
  type Primitive,
  type Root,
} from '@gltf-transform/core';

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

/** `Sequence::flags` (`ts/tsShape.h`): bit 0 uniform scale, bit 1 aligned scale, bit 2
 *  arbitrary scale, bit 3 blend, bit 4 cyclic, bit 5 make path, bit 6 has translucency.
 *  Before version 22 the first three and the next three were stored as separate bytes after
 *  `duration` rather than bits of this word. */
export const SEQUENCE_FLAG_CYCLIC = 1 << 4;

/** One entry of `TSShape::sequences`: the sequence's own name, its playback length, and the
 *  membership sets naming which nodes and objects it animates. The engine samples keyframe
 *  `k` of a member at `base + rank * numKeyframes + k`, where `rank` is the member's position
 *  within its (sorted) set — the layout `TSShape::animate` reads and `dtsToGlb` emits. */
export interface DtsSequence {
  readonly name: string;
  readonly flags: number;
  /** `Sequence::numKeyframes` — the number of samples each animated member stores. */
  readonly numKeyframes: number;
  /** `Sequence::duration`, in seconds: the engine plays the sequence over this long. */
  readonly duration: number;
  /** Base index, in quaternions, into `DtsShape.nodeRotationKeys`. */
  readonly baseRotation: number;
  /** Base index, in vectors, into `DtsShape.nodeTranslationKeys`. */
  readonly baseTranslation: number;
  readonly baseScale: number;
  /** Base index, in `{visibility, frame, materialFrame}` records, into `objectStates`. */
  readonly baseObjectState: number;
  readonly baseDecalState: number;
  /** `Sequence::toolBegin` — the point in `duration` an IFL material's playback starts. */
  readonly toolBegin: number;
  /** Sorted indices of the nodes this sequence animates. */
  readonly rotationMatters: readonly number[];
  readonly translationMatters: readonly number[];
  readonly scaleMatters: readonly number[];
  /** Sorted indices of the objects this sequence animates, and of its IFL material slots. */
  readonly visibilityMatters: readonly number[];
  readonly frameMatters: readonly number[];
  readonly materialFrameMatters: readonly number[];
  readonly decalMatters: readonly number[];
  readonly iflMatters: readonly number[];
  readonly cyclic: boolean;
}

/** `TSShape::ObjectState`: the visibility, mesh frame and material frame an object holds at
 *  one keyframe. `TSShape::animate` writes them through the object's mesh. */
export interface DtsObjectState {
  readonly visibility: number;
  readonly frame: number;
  readonly materialFrame: number;
}

/** One entry of `TSShape::iflMaterials`: the material slot whose texture is an image file
 *  list, and the frames that list holds. */
export interface DtsIflMaterial {
  readonly name: string;
  readonly materialSlot: number;
  readonly firstFrame: number;
  readonly firstFrameOffTimeIndex: number;
  readonly numFrames: number;
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
  /** `TSShape::sequences`, in file order: the shape's animation. */
  readonly sequences: readonly DtsSequence[];
  /** `TSShape::sequences.size()` — the count the file header's sequence section leads with. */
  readonly sequenceCount: number;
  /** `TSShape::mNodeRotations` after the per-node defaults, as stored: four `S16`s per key,
   *  each `/0x7FFF` (`Quat16`). A sequence's members index into it through `baseRotation`. */
  readonly nodeRotationKeys: Int16Array;
  /** `TSShape::mNodeTranslations` after the defaults: one `Point3F` per key. */
  readonly nodeTranslationKeys: Float32Array;
  /** `TSShape::objectStates`: the visibility/frame/material-frame keys the sequences read. */
  readonly objectStates: readonly DtsObjectState[];
  readonly iflMaterials: readonly DtsIflMaterial[];
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

  private take(
    view: DataView,
    offset: number,
    size: number,
    section: string,
    field: string,
  ): number {
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
    const wrapped = [expected | 0, (expected << 16) >> 16, (expected << 24) >> 24];
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

/** `TSShape::assembleShape`'s opening `get32` run, in its exact order. The rotation and
 *  translation key counts sit in the middle of the run and are version-dependent, so
 *  `readNodeKeyCounts` reads that group; the run ends with the two `smallestVisible*`
 *  fields, which are read after the count block rather than with it. */
function readShapeCounts(stream: ShapeStream, version: number): ShapeCounts {
  const numNodes = stream.i32('numNodes');
  const numObjects = stream.i32('numObjects');
  const numDecals = stream.i32('numDecals');
  const numSubShapes = stream.i32('numSubShapes');
  const numIflMaterials = stream.i32('numIflMaterials');
  const nodeKeyCounts = readNodeKeyCounts(stream, version, numNodes);
  const numObjectStates = stream.i32('numObjectStates');
  const numDecalStates = stream.i32('numDecalStates');
  const numTriggers = stream.i32('numTriggers');
  const numDetails = stream.i32('numDetails');
  const numMeshes = stream.i32('numMeshes');
  if (version < 23) stream.i32('numSkins'); // v23 folds skins into the mesh list
  const numNames = stream.i32('numNames');
  const smallestVisibleSize = stream.f32('mSmallestVisibleSize');
  const smallestVisibleDetailLevel = stream.i32('mSmallestVisibleDL');
  const counts: ShapeCounts = {
    numNodes,
    numObjects,
    numDecals,
    numSubShapes,
    numIflMaterials,
    ...nodeKeyCounts,
    numObjectStates,
    numDecalStates,
    numTriggers,
    numDetails,
    numMeshes,
    numNames,
    smallestVisibleSize,
    smallestVisibleDetailLevel,
  };
  assertCountsArePlausible(counts);
  return counts;
}

/** The node key counts `TSShape::assembleShape` reads between `numIflMaterials` and
 *  `numObjectStates`. Version 22 split one rotation+translation count into two and added the
 *  three node-scale counts, so an older shape's single `rotTrans` word has to be split here:
 *  its per-purpose counts are that word's difference from the node count, and it has no
 *  scale arrays at all. */
function readNodeKeyCounts(
  stream: ShapeStream,
  version: number,
  numNodes: number,
): Pick<
  ShapeCounts,
  | 'numNodeRots'
  | 'numNodeTrans'
  | 'numNodeUniformScales'
  | 'numNodeAlignedScales'
  | 'numNodeArbitraryScales'
> {
  const rotTrans = version < 22 ? stream.i32('numNodeRots') : 0;
  const numNodeRots = version < 22 ? rotTrans - numNodes : stream.i32('numNodeRots');
  const numNodeTrans = version < 22 ? rotTrans - numNodes : stream.i32('numNodeTrans');
  const numNodeUniformScales = version < 22 ? 0 : stream.i32('numNodeUniformScales');
  const numNodeAlignedScales = version < 22 ? 0 : stream.i32('numNodeAlignedScales');
  const numNodeArbitraryScales = version < 22 ? 0 : stream.i32('numNodeArbitraryScales');
  return {
    numNodeRots,
    numNodeTrans,
    numNodeUniformScales,
    numNodeAlignedScales,
    numNodeArbitraryScales,
  };
}

/** Every count in the header multiplies a later read, so a nonsense value is a corrupt file,
 *  not an empty shape — the engine only asserts on them much later, if at all. The count
 *  name is reported, in the order `ShapeCounts` declares them, because that is the only clue
 *  a caller gets about which field of a hand-edited file went wrong. */
function assertCountsArePlausible(counts: ShapeCounts): void {
  const integerCounts: Record<string, number> = { ...counts, smallestVisibleSize: 0 };
  for (const [name, value] of Object.entries(integerCounts)) {
    if (!Number.isInteger(value) || value < 0 || value > 1 << 22) {
      throw new Error(`Invalid DTS shape: ${name} is ${value}, which cannot be a count.`);
    }
  }
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

interface RawIflMaterial {
  readonly nameIndex: number;
  readonly materialSlot: number;
  readonly firstFrame: number;
  readonly firstFrameOffTimeIndex: number;
  readonly numFrames: number;
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
  readonly nodeRotationKeys: Int16Array;
  readonly nodeTranslationKeys: Float32Array<ArrayBuffer>;
  readonly objectStates: readonly DtsObjectState[];
  readonly iflMaterials: readonly RawIflMaterial[];
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
  const initialVerts = sharedArray(
    stream,
    payload.parentMesh,
    parent,
    'verts',
    numUnique * 3,
    'initialVerts',
  );
  const initialNorms = sharedArray(
    stream,
    payload.parentMesh,
    parent,
    'norms',
    numUnique * 3,
    'initialNorms',
  );
  if (payload.parentMesh < 0 && stream.version > 21)
    stream.skip8(numUnique, 'initial encoded normals');
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

/** `TSSortedMesh::assemble`: a standard payload, then the cluster tables. Unlike a skin
 *  mesh it has no vertex arrays of its own beyond the shared ones, so the payload's arrays
 *  are already what it renders with and no `arraysByMesh` lookup is needed. */
function readSortedPayload(stream: ShapeStream, payload: MeshPayload): MeshArrays {
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
      arrays = readSortedPayload(stream, payload);
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
    kind === 'skin'
      ? arrays.verts.length / 3
      : payload.vertsPerFrame > 0
        ? payload.vertsPerFrame
        : arrays.verts.length / 3;
  const vertexCount = Math.min(
    frameLength,
    arrays.verts.length / 3,
    arrays.tverts.length / 2,
    arrays.norms.length / 3,
  );
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
 *  it ends with — the same order `TSShape::disassembleShape` writes. Each field group below
 *  is read by its own helper, named for the group it reads, because this reader's only
 *  correctness invariant is the order the groups consume the stream in: the engine's
 *  `checkGuard` calls, one per cursor, are what detect a group read out of order. */
function readShapeBuffer(stream: ShapeStream, version: number, counts: ShapeCounts): RawShape {
  stream.checkGuard();
  const radius = stream.f32('radius');
  const tubeRadius = stream.f32('tubeRadius');
  const center = stream.vec3('center');
  const bounds = stream.box('bounds');

  stream.checkGuard();
  const nodes = readNodeTable(stream, counts);
  stream.checkGuard();
  const objects = readObjectTable(stream, counts);
  stream.checkGuard();
  stream.skip32(counts.numDecals * 5, 'decals');
  stream.checkGuard();
  const iflMaterials = readIflMaterialTable(stream, counts);
  stream.checkGuard();
  const subShapes = readSubShapeTable(stream, counts);
  const { nodeRotationKeys, nodeTranslationKeys } = readNodeKeyArrays(
    stream,
    version,
    counts,
    nodes,
  );
  const objectStates = readObjectStates(stream, counts);
  stream.skip32(counts.numDecalStates, 'decalStates');
  stream.checkGuard();
  stream.skip32(counts.numTriggers * 2, 'triggers');
  stream.checkGuard();
  const details = readDetailTable(stream, counts);
  const meshes = readMeshList(stream, counts);
  stream.checkGuard();
  const names = readNameTable(stream, counts);
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
    nodeRotationKeys,
    nodeTranslationKeys,
    objectStates,
    iflMaterials,
  };
}

/** `TSShape::nodes`: a name, a parent, and the three link fields (`firstObject`,
 *  `firstChild`, `nextSibling`) the reader steps over — the parent link above and
 *  `Object::nodeIndex` already say what they mean. A node's default transform is not in this
 *  record: the engine keeps it in the `defaultRotations`/`defaultTranslations` arrays, which
 *  `readNodeKeyArrays` reads below. */
function readNodeTable(stream: ShapeStream, counts: ShapeCounts): RawNode[] {
  const nodes: RawNode[] = [];
  for (let index = 0; index < counts.numNodes; index += 1) {
    const nameIndex = stream.i32('node name');
    const parentIndex = stream.i32('node parent');
    stream.skip32(3, 'node links'); // firstObject, firstChild, nextSibling
    nodes.push({ nameIndex, parentIndex, translation: [0, 0, 0], rotation: [0, 0, 0, 1] });
  }
  return nodes;
}

/** `TSShape::objects`: a name, the run of meshes it owns (`startMeshIndex`/`numMeshes`, one
 *  mesh per detail level) and the node it renders under — plus the two links
 *  (`nextSibling`, `firstDecal`) the reader steps over because the mesh list below already
 *  carries the ownership they describe. */
function readObjectTable(stream: ShapeStream, counts: ShapeCounts): RawObject[] {
  const objects: RawObject[] = [];
  for (let index = 0; index < counts.numObjects; index += 1) {
    const nameIndex = stream.i32('object name');
    const numMeshes = stream.i32('object meshes');
    const startMeshIndex = stream.i32('object first mesh');
    const nodeIndex = stream.i32('object node');
    stream.skip32(2, 'object links'); // nextSibling, firstDecal
    objects.push({ nameIndex, numMeshes, startMeshIndex, nodeIndex });
  }
  return objects;
}

/** `TSShape::iflMaterials`: each IFL material's name-table index, the material slot whose
 *  texture it animates, and the frame range a sequence's `iflMatters` set points into. */
function readIflMaterialTable(stream: ShapeStream, counts: ShapeCounts): RawIflMaterial[] {
  const iflMaterials: RawIflMaterial[] = [];
  for (let index = 0; index < counts.numIflMaterials; index += 1) {
    iflMaterials.push({
      nameIndex: stream.i32('ifl material name'),
      materialSlot: stream.i32('ifl material slot'),
      firstFrame: stream.i32('ifl first frame'),
      firstFrameOffTimeIndex: stream.i32('ifl off-time frame'),
      numFrames: stream.i32('ifl frames'),
    });
  }
  return iflMaterials;
}

/** The `TSShape::subShape*` arrays, in the two groups `TSShape::disassembleShape` writes
 *  them in: the node and object first indices, then their counts, with the two decal arrays
 *  interleaved into those groups and stepped over. Each group is closed by its own guard, so
 *  the two halves cannot be read as one. */
function readSubShapeTable(stream: ShapeStream, counts: ShapeCounts): DtsSubShape[] {
  const firstNodes = stream.ints(counts.numSubShapes, 'subShapeFirstNode');
  const firstObjects = stream.ints(counts.numSubShapes, 'subShapeFirstObject');
  stream.skip32(counts.numSubShapes, 'subShapeFirstDecal');
  stream.checkGuard();
  const numNodesPerSubShape = stream.ints(counts.numSubShapes, 'subShapeNumNodes');
  const numObjectsPerSubShape = stream.ints(counts.numSubShapes, 'subShapeNumObjects');
  stream.skip32(counts.numSubShapes, 'subShapeNumDecals');
  stream.checkGuard();
  return Array.from({ length: counts.numSubShapes }, (_, index) => ({
    firstNode: firstNodes[index] ?? 0,
    numNodes: numNodesPerSubShape[index] ?? 0,
    firstObject: firstObjects[index] ?? 0,
    numObjects: numObjectsPerSubShape[index] ?? 0,
  }));
}

/** Applies one node's default rotation and translation out of the two arrays the shape
 *  stores them in. Split out of the loop that walks the node table so both functions stay
 *  inside the lint's complexity budget; the conjugation note lives here because this is
 *  where the conjugation happens. */
function applyNodeDefaults(
  node: RawNode,
  index: number,
  rotations: Int16Array,
  translations: Float32Array<ArrayBuffer>,
): void {
  // `QuatF::setMatrix` builds the *inverse* of the rotation the four components name:
  // `m_quatF_set_matF_C` (`math/mMath_C.cc:135`) writes `m[row*4+col]` with every
  // off-diagonal term negated relative to a standard rotation matrix, i.e. the transpose,
  // and `TSTransform::setMatrix` (`ts/tsTransform.h:80`) then puts the translation in
  // column 3. The engine therefore orients a node by the conjugate of what the file
  // stores, and `tsShape.cc:498` composes those matrices parent-relative unchanged. glTF
  // has no such quirk -- a node's rotation is the rotation -- so the conjugate is taken here
  // and `DtsNode.rotation` means what its own comment already claims: the node's local
  // transform, which `dtsToGlb` can write straight into a glTF node. Skipping this leaves
  // every node whose rotation is not its own inverse misplaced: `turret_aa_large`'s
  // `Body_`/`Mid_` (stored +90 degrees about X) land 8-10 units away, and only 35% of that
  // shape's vertices match the shipped `.glb` instead of all of them.
  node.rotation = [
    -(rotations[index * 4] ?? 0) / QUAT16_MAX_VAL,
    -(rotations[index * 4 + 1] ?? 0) / QUAT16_MAX_VAL,
    -(rotations[index * 4 + 2] ?? 0) / QUAT16_MAX_VAL,
    (rotations[index * 4 + 3] ?? 0) / QUAT16_MAX_VAL,
  ];
  node.translation = [
    translations[index * 3] ?? 0,
    translations[index * 3 + 1] ?? 0,
    translations[index * 3 + 2] ?? 0,
  ];
}

/** The default node transforms and the animation keys that follow them in the same two
 *  arrays: `defaultRotations`/`nodeRotations` (four `S16`s per key, read out of the 16-bit
 *  section) and `defaultTranslations`/`nodeTranslations` (three floats per key). The defaults
 *  are applied to the nodes `readNodeTable` built, and the key arrays are returned for
 *  `dtsToGlb` to address through a sequence's `baseRotation`/`baseTranslation`. The v22
 *  node-scale arrays between them are stepped over: a shape's scale keys are never emitted.
 */
function readNodeKeyArrays(
  stream: ShapeStream,
  version: number,
  counts: ShapeCounts,
  nodes: readonly RawNode[],
): { nodeRotationKeys: Int16Array; nodeTranslationKeys: Float32Array<ArrayBuffer> } {
  const rotations = stream.words(counts.numNodes * 4, 'defaultRotations');
  const translations = stream.floats(counts.numNodes * 3, 'defaultTranslations');
  for (let index = 0; index < counts.numNodes; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    applyNodeDefaults(node, index, rotations, translations);
  }
  const nodeTranslationKeys = stream.floats(counts.numNodeTrans * 3, 'nodeTranslations');
  const nodeRotationKeys = stream.words(counts.numNodeRots * 4, 'nodeRotations');
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
  return { nodeRotationKeys, nodeTranslationKeys };
}

/** `TSShape::ObjectState` records, one per keyframe an object's animation can land on: its
 *  visibility as a float, its mesh frame and its material frame. A sequence's
 *  visibility/frame/material-frame membership sets index into these records through
 *  `Sequence::baseObjectState`. */
function readObjectStates(stream: ShapeStream, counts: ShapeCounts): DtsObjectState[] {
  const objectStates: DtsObjectState[] = [];
  for (let index = 0; index < counts.numObjectStates; index += 1) {
    objectStates.push({
      visibility: stream.f32('object visibility'),
      frame: stream.i32('object frame'),
      materialFrame: stream.i32('object material frame'),
    });
  }
  stream.checkGuard();
  return objectStates;
}

/** `TSShape::details`: each detail level's name, the sub-shape it selects and the mesh
 *  within each of that sub-shape's objects, plus the projected size it is chosen at and the
 *  error/poly counts the engine's tools read. `dtsToGlb` picks one of these by index. */
function readDetailTable(stream: ShapeStream, counts: ShapeCounts): RawDetail[] {
  const details: RawDetail[] = [];
  for (let index = 0; index < counts.numDetails; index += 1) {
    const nameIndex = stream.i32('detail name');
    const subShapeNum = stream.i32('detail subshape');
    const objectDetailNum = stream.i32('detail object detail');
    const size = stream.f32('detail size');
    const averageError = stream.f32('detail average error');
    const maxError = stream.f32('detail max error');
    const polyCount = stream.i32('detail poly count');
    details.push({
      nameIndex,
      subShapeNum,
      objectDetailNum,
      size,
      averageError,
      maxError,
      polyCount,
    });
  }
  stream.checkGuard();
  return details;
}

/** The shape's name table: `numNames` null-terminated byte strings from the 8-bit section,
 *  which every index read above (`RawNode.nameIndex`, `RawObject.nameIndex`,
 *  `RawDetail.nameIndex`, ...) resolves against. It is the last group in the buffer. */
function readNameTable(stream: ShapeStream, counts: ShapeCounts): string[] {
  const names: string[] = [];
  for (let index = 0; index < counts.numNames; index += 1) names.push(stream.string());
  stream.checkGuard();
  return names;
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
    const unknown =
      materialFlags &
      ~Object.keys(MATERIAL_FLAG_NAMES).reduce((mask, bit) => mask | Number(bit), 0);
    return {
      name,
      flags: materialFlags,
      flagNames: unknown === 0 ? flagNames : [...flagNames, `Unknown(0x${unknown.toString(16)})`],
    };
  });
}

/** `TSShape::Sequence::read` (`ts/tsShapeOldRead.cc`) for the versions this reader accepts,
 *  walked over the raw bytes after the shape buffer: the sequence section sits between the
 *  shape buffer and the material list, and reading it is what reaches the material list.
 *
 *  A sequence is mostly bookkeeping — name, flags, key count, duration and ground-frame
 *  range — followed by the `base` indices that say where in the shape's keyframe arrays its
 *  members start, and by eight `TSIntegerSet` membership sets. `rotationMatters` names the
 *  *nodes* it rotates, `translationMatters`/`scaleMatters` the nodes it moves and scales, and
 *  the visibility/frame/material-frame/decal/IFL sets name *objects*, decals and IFL material
 *  slots. `dtsToGlb` turns exactly those into the emitted clips and node metadata. */
function readSequences(
  bytes: Uint8Array,
  offset: number,
  version: number,
  names: readonly string[],
): { sequences: DtsSequence[]; materialOffset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (offset + 4 > bytes.byteLength) throw new Error('Truncated DTS: no sequence count.');
  const sequenceCount = view.getInt32(offset, true);
  if (sequenceCount < 0 || sequenceCount > 0x4000) {
    throw new Error(`Invalid DTS shape: ${sequenceCount} sequences.`);
  }
  let cursor = offset + 4;
  const sequences: DtsSequence[] = [];
  for (let index = 0; index < sequenceCount; index += 1) {
    const read = readOneSequence(view, cursor, version, bytes.byteLength, index, names);
    sequences.push(read.sequence);
    cursor = read.cursor;
  }
  return { sequences, materialOffset: cursor };
}

/** A sequence's cursor over the raw bytes after the shape buffer. It is the same shape as
 *  `ShapeStream` — one value at a time, each read of the two compound records validated, and
 *  a read past the end of the file reported through `truncated` — but a sequence is one flat
 *  record with one cursor rather than three independent sections, so it gets its own reader
 *  instead of a fourth `ShapeStream` cursor. */
class SequenceReader {
  /** Where the next read starts; a sequence's own `cursor` in `readOneSequence`'s terms. */
  cursor: number;

  constructor(
    private readonly view: DataView,
    offset: number,
    private readonly index: number,
    private readonly length: number,
  ) {
    this.cursor = offset;
  }

  i32(field: string): number {
    this.require(4, field);
    const value = this.view.getInt32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  /** `dwords(count, field)` in the engine's read order: `count` dwords consumed and only the
   *  first returned. Only the trigger range is read more than one at a time, and it is
   *  stepped over. */
  skip32(count: number, field: string): void {
    this.require(count * 4, field);
    this.cursor += count * 4;
  }

  f32(field: string): number {
    this.require(4, field);
    const value = this.view.getFloat32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  /** The three legacy `Blend`/`Cyclic`/`MakePath` bytes a pre-v22 sequence stores after
   *  `duration` rather than as bits of its flags word; each one sets its bit of `flags`. They
   *  are one byte each — the engine's own `Stream::read(bool*)` reads a `U8`. */
  legacyFlagBytes(flags: number): number {
    let result = flags;
    for (let flag = 0; flag < 3; flag += 1) {
      this.require(1, 'legacy flags');
      const byte = this.view.getUint8(this.cursor);
      this.cursor += 1;
      if (byte !== 0) result |= 1 << (3 + flag);
    }
    return result;
  }

  /** `TSIntegerSet::read`: a `S32` that is always written 0, a word count, then the words.
   *  The set is returned as the member indices its bits name, which is how every caller of
   *  this reader uses it. */
  integerSet(field: string): number[] {
    this.require(8, field);
    const words = this.view.getInt32(this.cursor + 4, true);
    this.cursor += 8;
    if (words < 0 || words > 0x4000) {
      throw new Error(
        `Invalid DTS shape: sequence ${this.index}'s ${field} claims ${words} words.`,
      );
    }
    const members: number[] = [];
    for (let word = 0; word < words; word += 1) {
      this.require(4, field);
      const bits = this.view.getUint32(this.cursor, true);
      this.cursor += 4;
      for (let bit = 0; bit < 32; bit += 1) {
        if ((bits & (1 << bit)) !== 0) members.push(word * 32 + bit);
      }
    }
    return members;
  }

  private require(bytes: number, field: string): void {
    if (this.cursor + bytes > this.length) throw truncated(this.index, field, this.length);
  }
}

/** One `Sequence::read`: the bookkeeping, the `base` indices and the eight membership sets,
 *  in the order `ts/tsShapeOldRead.cc` reads them, each version-dependent group split out
 *  because which fields exist — and therefore where the next one starts — is exactly what
 *  the version word decides. */
function readOneSequence(
  view: DataView,
  offset: number,
  version: number,
  length: number,
  index: number,
  names: readonly string[],
): { sequence: DtsSequence; cursor: number } {
  const reader = new SequenceReader(view, offset, index, length);
  const nameIndex = reader.i32('name');
  let flags = version > 21 ? reader.i32('flags') : 0;
  const numKeyframes = reader.i32('keyframes');
  const duration = reader.f32('duration');
  if (version < 22) flags = reader.legacyFlagBytes(flags);
  reader.i32('priority');
  reader.i32('firstGroundFrame');
  reader.i32('numGroundFrames');
  const { baseRotation, baseTranslation, baseScale, baseObjectState, baseDecalState } =
    readSequenceBases(reader, version);
  if (version > 8) reader.skip32(2, 'trigger range');
  const toolBegin = version > 7 ? reader.f32('toolBegin') : 0;
  const rotationMatters = reader.integerSet('rotationMatters');
  const {
    translationMatters,
    scaleMatters,
    visibilityMatters,
    frameMatters,
    materialFrameMatters,
    decalMatters,
    iflMatters,
  } = readSequenceMembershipSets(reader, version, rotationMatters);
  return {
    cursor: reader.cursor,
    sequence: {
      name: names[nameIndex] ?? `sequence${index}`,
      flags,
      numKeyframes,
      duration,
      baseRotation,
      baseTranslation,
      baseScale,
      baseObjectState,
      baseDecalState,
      toolBegin,
      rotationMatters,
      translationMatters,
      scaleMatters,
      visibilityMatters,
      frameMatters,
      materialFrameMatters,
      decalMatters,
      iflMatters,
      cyclic: (flags & SEQUENCE_FLAG_CYCLIC) !== 0,
    },
  };
}

/** The `base` indices: where in the shape's keyframe arrays this sequence's members start.
 *  v22 widened the record to five words — the scale and decal bases joined it — while a v17
 *  or v18 sequence stores the rotation and translation base as one word and has no scale
 *  base at all, so its translation base is copied from the rotation base. */
function readSequenceBases(
  reader: SequenceReader,
  version: number,
): Pick<
  DtsSequence,
  'baseRotation' | 'baseTranslation' | 'baseScale' | 'baseObjectState' | 'baseDecalState'
> {
  let baseRotation = 0;
  let baseTranslation = 0;
  let baseScale = 0;
  let baseObjectState = 0;
  let baseDecalState = 0;
  if (version > 21) {
    baseRotation = reader.i32('baseRotation');
    baseTranslation = reader.i32('baseTranslation');
    baseScale = reader.i32('baseScale');
    baseObjectState = reader.i32('baseObjectState');
    baseDecalState = reader.i32('baseDecalState');
  } else if (version >= 17) {
    baseRotation = reader.i32('baseRotation');
    baseTranslation = baseRotation;
    baseObjectState = reader.i32('baseObjectState');
    baseDecalState = reader.i32('baseDecalState');
  }
  return { baseRotation, baseTranslation, baseScale, baseObjectState, baseDecalState };
}

/** The membership sets after `rotationMatters`, in file order. Before v22 the translation
 *  and scale sets are not stored at all: the engine copies `rotationMatters` into
 *  `translationMatters` rather than reading it, and a v21 file has no scale set either
 *  (`ts/tsShapeOldRead.cc` `Sequence::read`). The sets *after* these two are still written
 *  and must still be stepped over, so this copies one and skips one. */
function readSequenceMembershipSets(
  reader: SequenceReader,
  version: number,
  rotationMatters: readonly number[],
): Pick<
  DtsSequence,
  | 'translationMatters'
  | 'scaleMatters'
  | 'visibilityMatters'
  | 'frameMatters'
  | 'materialFrameMatters'
  | 'decalMatters'
  | 'iflMatters'
> {
  const translationMatters =
    version >= 22 ? reader.integerSet('translationMatters') : [...rotationMatters];
  const scaleMatters = version >= 22 ? reader.integerSet('scaleMatters') : [];
  const decalMatters = version > 10 ? reader.integerSet('decalMatters') : [];
  const iflMatters = version > 5 ? reader.integerSet('iflMatters') : [];
  const visibilityMatters = reader.integerSet('visMatters');
  const frameMatters = reader.integerSet('frameMatters');
  const materialFrameMatters = reader.integerSet('matFrameMatters');
  return {
    translationMatters,
    scaleMatters,
    visibilityMatters,
    frameMatters,
    materialFrameMatters,
    decalMatters,
    iflMatters,
  };
}

/** Every sequence read past the end of the file reports the same way: the field name and
 *  the sequence it belongs to, as `skipOneSequence` did before sequences were read. */
function truncated(index: number, field: string, length: number): Error {
  return new Error(
    `Truncated DTS: sequence ${index}'s ${field} runs past the end of the file (${length} bytes).`,
  );
}

/** `TSDrawPrimitive`'s element types that produce triangles: `tsMesh.h`'s `TriangleList`,
 *  `TriangleFan` and a strip — the third falls through to the alternating-winding walk. */
const TRIANGLE_LIST = 0;
const TRIANGLE_FAN = 2;

/** `TSDrawPrimitive` plus `TSMesh::leaveAsMultipleStrips`/`unwindStrip`: each primitive is
 *  a `start`/`numElements` pair into the index list and a material word whose top two bits
 *  say triangles, strip or fan. Degenerate triangles are dropped exactly where
 *  `unwindStrip` drops them. Each element type is walked by its own helper below, because
 *  the three walks share only the index decode. */
function primitiveTriangles(mesh: RawMesh, primitiveIndex: number): number[] {
  const start = mesh.primData[primitiveIndex * 2] ?? 0;
  const numElements = mesh.primData[primitiveIndex * 2 + 1] ?? 0;
  const type = ((mesh.primMats[primitiveIndex] ?? 0) >>> PRIMITIVE_TYPE_SHIFT) & 0b11;
  const at = (offset: number): number => mesh.indices[start + offset] ?? 0;
  if (type === TRIANGLE_LIST) return listTriangles(numElements, at);
  // A fan and a strip both need three vertices before they describe a triangle at all.
  if (numElements < 3) return [];
  if (type === TRIANGLE_FAN) return fanTriangles(numElements, at);
  return stripTriangles(numElements, at);
}

/** A plain triangle list: every three indices in turn, with the trailing partial triple
 *  dropped exactly where the engine's list case leaves it. */
function listTriangles(numElements: number, at: (offset: number) => number): number[] {
  const triangles: number[] = [];
  for (let index = 0; index + 2 < numElements; index += 3) {
    triangles.push(at(index), at(index + 1), at(index + 2));
  }
  return triangles;
}

/** A fan: a fixed first vertex, then consecutive pairs. */
function fanTriangles(numElements: number, at: (offset: number) => number): number[] {
  const triangles: number[] = [];
  for (let index = 1; index + 1 < numElements; index += 1) {
    triangles.push(at(0), at(index), at(index + 1));
  }
  return triangles;
}

/** A strip: winding alternates with the index, and the engine skips any triangle with a
 *  repeated index rather than emitting a degenerate one. */
function stripTriangles(numElements: number, at: (offset: number) => number): number[] {
  const triangles: number[] = [];
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
    const materialIndex =
      (materialWord & PRIMITIVE_NO_MATERIAL) !== 0 ? -1 : materialWord & PRIMITIVE_MATERIAL_MASK;
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
  sequences: readonly DtsSequence[],
): DtsShape {
  const nameOf = (nameIndex: number, fallback: string): string => raw.names[nameIndex] ?? fallback;
  const meshes = raw.meshes.map((mesh, index) => {
    const owner = raw.objects.find(
      (object) =>
        index >= object.startMeshIndex && index < object.startMeshIndex + object.numMeshes,
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
      triangleCount: primitives.reduce(
        (total, primitive) => total + primitive.indices.length / 3,
        0,
      ),
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
    sequences,
    nodeRotationKeys: raw.nodeRotationKeys,
    nodeTranslationKeys: raw.nodeTranslationKeys,
    objectStates: raw.objectStates,
    iflMaterials: raw.iflMaterials.map((material, index) => ({
      name: nameOf(material.nameIndex, `ifl${index}`),
      materialSlot: material.materialSlot,
      firstFrame: material.firstFrame,
      firstFrameOffTimeIndex: material.firstFrameOffTimeIndex,
      numFrames: material.numFrames,
    })),
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
  const { sequences, materialOffset } = readSequences(bytes, bodyOffset, version, raw.names);
  const sequenceCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(
    bodyOffset,
    true,
  );
  return assembleShape(
    raw,
    version,
    exporterVersion,
    readMaterialList(bytes, materialOffset, version),
    sequenceCount,
    sequences,
  );
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

/** The basis every `.glb` this repository publishes is written in, as a rotation of Torque's
 *  model space (`TSShape`: X forward, Y left, Z up) into glTF's Y-up space. The value is not
 *  derived from a convention document; it was fitted to the shipped assets. Each shape's
 *  node world translations were read out of both the file the build used to download and the
 *  one this emitter writes, and `(-x, z, y)` reproduces them exactly — 35 shared attachment
 *  nodes on `vehicle_air_scout` and on `vehicle_grav_scout` agree to 5e-7, and
 *  `weapon_disc`'s whole vertex cloud agrees to 9e-6. As a quaternion that map is a half
 *  turn about the (0, 1, 1) diagonal, `[0, √½, √½, 0]`, equivalently `Rz(180°)` then
 *  `Rx(-90°)`: the `Rz` is real, not noise — Torque's +X forward becomes glTF's -X, while its
 *  Z up and its Y left become glTF's +Y and +Z.
 *
 *  Leaving it out is not a subtle difference. Every consumer is written against this basis:
 *  the client orients vehicles and turrets by their glTF axes, and `build.ts` reads the
 *  pad's `Mount0` out of `vehicle_pad.glb` to place the station the simulation spawns there.
 *  Emitting Torque model space directly made all 21 shapes lie on their side — the Shrike's
 *  nose-to-heading alignment in `e2e/shrike-spawn.spec.ts` collapsed to 0.0054, a 90 degree
 *  error, where the basis reads > 0.98 — and moved the pad attachment 8-10 m, which walks the
 *  spawned station out of reach.
 *
 *  The rotation is one node wrapping the shape's roots, not a transform folded into each
 *  mesh's vertices: every accessor stays exactly the authored DTS numbers and only world
 *  space changes. That keeps the conversion in a single place, so no consumer can apply it
 *  twice, and keeps the emitted meshes comparable to their source by inspection. */
const TORQUE_MODEL_BASIS: Quat = [0, Math.SQRT1_2, Math.SQRT1_2, 0];

/** Emits one detail level of `shape` as a glTF binary.
 *
 *  The scene keeps one node per DTS node with its authored name and its own parent-relative
 *  transform — the form the engine composes in `TSShape::computeBounds` and the form the
 *  client's `Eye`/`Mount0` lookups need — with one mesh per mesh that detail level draws,
 *  carried by its own child node named the way the shipped files name it (see `emitObjectNode`
 *  below: the DTS node's name and its object's name are separate names and both are kept).
 *
 *  Node transforms are written as authored, so each node's *local* TRS is the DTS number;
 *  the one transform between Torque model space and glTF space lives on `TORQUE_MODEL_BASIS`
 *  above, which every root hangs off.
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
  const basis = document.createNode('TorqueModelSpace').setRotation([...TORQUE_MODEL_BASIS]);
  scene.addChild(basis);
  const nodes = createNodeLayer(document, shape, basis);
  emitDetailLevel(document, shape, detail, nodes, basis);
  return serializeGlb(document, options.generator ?? 'clans-dts');
}

/** The DTS node layer: one glTF node per `shape.nodes` entry, in the shape's own order, each
 *  carrying its authored name and its own parent-relative transform. A node hangs off its
 *  parent's node, or off `basis` when it is a root — and also when the shape names a parent
 *  index it does not have, so a malformed link cannot drop a node out of the scene graph. */
function createNodeLayer(document: Document, shape: DtsShape, basis: Node): Node[] {
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
    else basis.addChild(child);
  });
  return nodes;
}

/** Adds every object of the detail level's sub-shape to the node layer, in `TSShape`'s own
 *  object order — the run `TSShape::computeBounds` walks. The material map is per emission,
 *  so a material slot is created once and shared by every object whose mesh uses it. */
function emitDetailLevel(
  document: Document,
  shape: DtsShape,
  detail: DtsDetailLevel,
  nodes: readonly Node[],
  basis: Node,
): void {
  const materials = new Map<number, Material>();
  for (const { nodeIndex, object } of detailObjects(shape, detail)) {
    emitObjectNode(document, shape, detail, object, nodeIndex, nodes, basis, materials);
  }
}

/** One object's node, and the mesh it draws at this detail level if it draws one.
 *
 *  A DTS shape names its two layers separately, and the shipped files keep both: the node
 *  the engine transforms is one name-table entry (`Disc110`, `Main_Body_100`), and the
 *  *object* drawn under it is another (`Disc`, `Main_Body_`) — `Object::nameIndex` is its
 *  own string, which is why the mesh (whose name `parseDts` takes from its object) and its
 *  node usually differ. Torque never merges them: `Object::nodeIndex` is a separate link,
 *  and `TSShape::computeBounds` composes the node's transform before drawing the mesh in
 *  its space. The shipped `.glb`s preserve exactly that pair — a Blender-converted
 *  `weapon_disc.glb` holds `Disc110` as the parent of a `Disc` node carrying `DTSMesh5`,
 *  and every other shape the same way — so a node's own name is the handle the client
 *  animates and looks up (`Disc110` spins, `Mountpoint`, `Eye`, `DumTurn`), while the mesh
 *  child's bare name is the handle a caller toggles or poses (`Disc` goes invisible on
 *  fire, `M_Hood_100` recoils, `MuzzleFlashFront_` flashes). Folding the two into one node
 *  drops a name every one of those lookups resolves against.
 *
 *  The child is a plain node with no transform of its own, so the chain still composes to
 *  the node's authored TRS and the vertices do not move: this is a naming and hierarchy
 *  change, not a second transform. Each object gets its own child, so two objects under one
 *  node (legal in the format) stay separate meshes rather than one replacing the other. */
function emitObjectNode(
  document: Document,
  shape: DtsShape,
  detail: DtsDetailLevel,
  object: DtsObject,
  nodeIndex: number,
  nodes: readonly Node[],
  basis: Node,
  materials: Map<number, Material>,
): void {
  const holder = document.createNode(object.name);
  // An object whose node is -1 has nothing to hang off and hangs off the basis instead of
  // vanishing from the scene graph.
  (nodes[nodeIndex] ?? basis).addChild(holder);
  // The engine's own test for "this object has geometry at this level" is
  // `objectDetailNum < object.numMeshes`; past it, or on a `NullMeshType` slot, or on a mesh
  // with no material batch, the object is still an object the shape names — every collision
  // and line-of-sight object in the base shapes (`Col`, `Pad`, `Hull`, `LOScol`) is one,
  // drawn only at the collision detail levels — and it reaches the file as a bare node,
  // which is exactly the node the shipped files carry for it.
  const mesh = meshAtDetail(shape, detail, object);
  if (mesh && mesh.primitives.length > 0)
    holder.setMesh(emitMesh(document, shape, mesh, materials));
}

/** The mesh the object draws at this detail level: its own `objectDetailNum`-th mesh, or
 *  nothing when the object has fewer meshes than that — the engine's own
 *  `objectDetailNum < object.numMeshes` test. */
function meshAtDetail(
  shape: DtsShape,
  detail: DtsDetailLevel,
  object: DtsObject,
): DtsMesh | undefined {
  if (detail.objectDetailNum >= object.numMeshes) return undefined;
  return shape.meshes[object.startMeshIndex + detail.objectDetailNum];
}

/** An object's node in the emitted document, with the mesh it drew at the detail level being
 *  written (`undefined` when the object had no geometry at that level). Both the visibility
 *  metadata and the IFL binding are keyed off the object, so `dtsToGlb` collects this while
 *  it builds the node layer. Exported with `applyObjectExtras`, its only consumer. */
export interface ObjectNode {
  readonly node: Node;
  readonly mesh: DtsMesh | undefined;
}

/** The metadata a DTS sequence drives that glTF has no channel for, written where the
 *  shipped files write it: on the object's own node.
 *
 *  Visibility is the first: the engine animates an object's `ObjectState::visibility`
 *  (`TSShape::animate` writes it through the object's mesh), and the shipped files carry the
 *  base state as `vis` — the client's shape loader applies it as the node's initial
 *  `visible`, which is also the value three's `AnimationMixer` restores when the last action
 *  touching `.visible` stops. Each sequence that animates the object adds
 *  `vis_keyframes_<sequence>` with its per-keyframe values plus `vis_duration_<sequence>`
 *  and `vis_cyclic_<sequence>`, which the client's `withVisibility` turns into a boolean
 *  track on that sequence's clip; the keys are lowercased because the client looks clips up
 *  by lowercased name.
 *
 *  An IFL material's playback is the second: the sequence that starts it
 *  (`ifl_sequence`/`ifl_duration`/`ifl_cyclic`/`ifl_tool_begin`) is a property of the
 *  material slot, so it lands on every object whose drawn mesh uses that slot — the same
 *  place the shipped `weapon_disc.glb` puts `ifl_sequence: "discSpin"` on its two `dcase00`
 *  casing objects. Which sequence wins when several animate that slot is the first one in
 *  file order, which is what the shipped file carries. */
export function applyObjectExtras(shape: DtsShape, objectNodes: Map<number, ObjectNode>): void {
  for (const [objectIndex, { node, mesh }] of objectNodes) {
    node.setExtras(objectExtras(shape, objectIndex, mesh));
  }
}

/** The extras one object node carries, in the order the shipped files carry them: the
 *  visibility keys first, then the IFL binding of the slots the object's drawn mesh uses —
 *  and nothing beyond the base `vis` when the object draws nothing at this detail level. */
function objectExtras(
  shape: DtsShape,
  objectIndex: number,
  mesh: DtsMesh | undefined,
): Record<string, unknown> {
  const extras = visibilityExtras(shape, objectIndex);
  if (mesh) Object.assign(extras, iflExtras(shape, mesh));
  return extras;
}

/** The base `vis` value of an object — the visibility of the `ObjectState` record a sequence
 *  animates it through, or 0 when the shape has no record for it — plus one
 *  `vis_keyframes_`/`vis_duration_`/`vis_cyclic_` triple per sequence whose
 *  `visibilityMatters` set names the object. */
function visibilityExtras(shape: DtsShape, objectIndex: number): Record<string, unknown> {
  const baseState = shape.objectStates[objectIndex];
  const extras: Record<string, unknown> = { vis: baseState && baseState.visibility > 0 ? 1 : 0 };
  for (const sequence of shape.sequences) {
    const rank = sequence.visibilityMatters.indexOf(objectIndex);
    if (rank < 0) continue;
    Object.assign(extras, sequenceVisibilityExtras(shape, sequence, rank));
  }
  return extras;
}

/** One sequence's visibility metadata for the `rank`-th object it animates: the per-keyframe
 *  track the client turns into a boolean list, its length, and whether it cycles. The keys
 *  are lowercased because the client looks clips up by lowercased name. */
function sequenceVisibilityExtras(
  shape: DtsShape,
  sequence: DtsSequence,
  rank: number,
): Record<string, unknown> {
  const name = sequence.name.toLowerCase();
  return {
    [`vis_keyframes_${name}`]: sequenceKeys(sequence).map((key) =>
      objectStateAt(shape, sequence, rank, key).visibility > 0 ? 1 : 0,
    ),
    [`vis_duration_${name}`]: sequence.duration,
    [`vis_cyclic_${name}`]: sequence.cyclic ? 1 : 0,
  };
}

/** The IFL binding of the material slots the mesh's batches use: for each IFL material in
 *  file order whose slot is one of them, the first sequence that starts it. A shape carries
 *  one IFL material per slot, so this is one binding; when several IFL materials cover a
 *  used slot the later ones overwrite the earlier, which is what the loop that wrote these
 *  keys straight onto the extras object did. */
function iflExtras(shape: DtsShape, mesh: DtsMesh): Record<string, unknown> {
  const slots = new Set(mesh.primitives.map((primitive) => primitive.materialIndex));
  let extras: Record<string, unknown> = {};
  for (const [materialIndex, material] of shape.iflMaterials.entries()) {
    if (!slots.has(material.materialSlot)) continue;
    const sequence = shape.sequences.find((candidate) =>
      candidate.iflMatters.includes(materialIndex),
    );
    if (!sequence) continue;
    extras = {
      ifl_sequence: sequence.name,
      ifl_duration: sequence.duration,
      ifl_cyclic: sequence.cyclic ? 1 : 0,
      ifl_tool_begin: sequence.toolBegin,
    };
  }
  return extras;
}

/** One glTF animation per DTS sequence, named the sequence's own name, with one channel per
 *  animated node — the same clip names, targets and playback length the shipped files carry,
 *  because a clip name is how every consumer reaches the animation.
 *
 *  NOT CALLED YET, and deliberately so. Everything below is verified against the shipped
 *  files (`weapon_disc`, `weapon_chaingun`, `weapon_mortar`, `weapon_sniper`, `weapon_energy`,
 *  `turret_aa_large`, `turret_base_large`, `turret_fusion_large`, `turret_sentry`,
 *  `station_generator_large`, `station_inv_human`, `sensor_pulse_large`, `vehicle_pad`,
 *  `vehicle_pad_station`, `vehicle_shrike`, `vehicle_wildcat`):
 *
 *  - Verified: the sequence layout, the keyframe addressing (`base + rank * numKeyframes + k`
 *    for member `rank`, with the cyclic extra key wrapping to sample 0), the timebase
 *    (`numKeyframes` samples over `duration`, cyclic clips carrying one extra key at
 *    `duration`), the Quat16 decode (the same conjugate `parseDts` applies to node defaults),
 *    and the node targeting (a sequence animates *nodes*, an object only carries visibility
 *    and IFL metadata). Clip names, durations and target sets are equal to the shipped files
 *    on every clip, and the real transform clips match them in world space to 1e-7..2.6e-4
 *    over five samples per clip — the weapons' `discSpin`/`Reload`/`Fire`/`Spin`/`Recoil`, the
 *    turrets' `Deploy`/`Activate`/`Elevate`/`Turn`, the stations' and pad's `Activate`.
 *
 *  - Not verified, and why this is not called: (1) the placeholder clips — a sequence whose
 *    only members are objects (visibility/IFL) has no transform channel, and the shipped files
 *    hold a two-key constant on the shape's own first node while this emits the full key list,
 *    with a held value that differs from the shipped one by up to 2.8 world units; (2) this
 *    emits clips for sequences the shipped files have no clip for, and (3) enabling it broke
 *    the whole browser suite, not just the weapon spec: 11 of 11 specs failed, including
 *    `ui-audio` and `world-geometry`, which load no weapon model. The two suspects for (3) are
 *    those non-transform clips and `applyObjectExtras` below, whose `vis` value is derived from
 *    `objectStates[objectIndex]` and would hide a mesh whose object-state record is not simply
 *    the object's default. Start there, not at the clip math: the transform clips are right.
 *  @see DTS_CONVERTED_SHAPES in `build.ts` for why the converted shapes are limited to the
 *  four vehicles that have no committed GLB. */
export function emitSequenceAnimations(
  document: Document,
  shape: DtsShape,
  nodes: readonly Node[],
): void {
  for (const sequence of shape.sequences) {
    const times = sequenceTimes(sequence);
    const channels = sequenceChannels(shape, sequence, nodes, times.length);
    if (channels.length === 0) continue;
    const animation = document.createAnimation(sequence.name);
    for (const channel of channels)
      addAnimationChannel(document, animation, sequence, channel, times);
  }
}

/** One transform channel of a sequence: the node it targets, the TRS path it drives, and the
 *  key list itself, one sample per entry of the sequence's own timebase. */
interface SequenceChannel {
  readonly node: Node;
  readonly path: 'rotation' | 'translation';
  readonly values: Float32Array<ArrayBuffer>;
}

/** Every transform channel a sequence drives — its rotation set first, then its translation
 *  set, in the shape's own member order — plus the placeholder clip a sequence whose only
 *  members are objects needs. */
function sequenceChannels(
  shape: DtsShape,
  sequence: DtsSequence,
  nodes: readonly Node[],
  keyCount: number,
): SequenceChannel[] {
  const channels = [
    ...rotationChannels(shape, sequence, nodes, keyCount),
    ...translationChannels(shape, sequence, nodes, keyCount),
  ];
  // `TSShape` keeps a sequence name even when its only members are objects: visibility,
  // frames and IFL slots are not transform channels, so such a sequence would otherwise
  // emit no clip at all — and a clip name is how a consumer reaches the sequence. The
  // shipped files keep those clips, each holding one constant translation key on the
  // shape's own first node. A sequence with no members at all (the Spinfusor's `NoAmmo`)
  // animates nothing anywhere and gets no clip, exactly as in the shipped file.
  const anchor = nodes[0];
  if (channels.length === 0 && animatesObjects(sequence) && anchor) {
    const held = new Float32Array(6);
    held.set([...anchor.getTranslation(), ...anchor.getTranslation()]);
    channels.push({ node: anchor, path: 'translation', values: held });
  }
  return channels;
}

/** Whether a sequence's members include any object-level state — visibility, mesh frames,
 *  material frames, decals or IFL slots — rather than nodes only. */
function animatesObjects(sequence: DtsSequence): boolean {
  return (
    sequence.visibilityMatters.length > 0 ||
    sequence.frameMatters.length > 0 ||
    sequence.materialFrameMatters.length > 0 ||
    sequence.decalMatters.length > 0 ||
    sequence.iflMatters.length > 0
  );
}

/** One VEC4 key list per node the sequence's `rotationMatters` set names, sampled at
 *  `baseRotation + rank * numKeyframes + k` for the member's rank in the (sorted) set — the
 *  layout `TSShape::animate` reads.
 *
 *  The same conjugate the default node rotations take: `QuatF::setMatrix` builds the
 *  transpose of what the file stores, so the engine applies the conjugate and glTF needs
 *  that rotation, not the stored one. */
function rotationChannels(
  shape: DtsShape,
  sequence: DtsSequence,
  nodes: readonly Node[],
  keyCount: number,
): SequenceChannel[] {
  const channels: SequenceChannel[] = [];
  const keyframes = sequence.numKeyframes;
  for (const [rank, nodeIndex] of sequence.rotationMatters.entries()) {
    const node = nodes[nodeIndex];
    if (!node) continue;
    const values = new Float32Array(keyCount * 4);
    for (const [key, sample] of sequenceKeys(sequence).entries()) {
      const at = (sequence.baseRotation + rank * keyframes + sample) * 4;
      values[key * 4] = -(shape.nodeRotationKeys[at] ?? 0) / QUAT16_MAX_VAL;
      values[key * 4 + 1] = -(shape.nodeRotationKeys[at + 1] ?? 0) / QUAT16_MAX_VAL;
      values[key * 4 + 2] = -(shape.nodeRotationKeys[at + 2] ?? 0) / QUAT16_MAX_VAL;
      values[key * 4 + 3] = (shape.nodeRotationKeys[at + 3] ?? 0) / QUAT16_MAX_VAL;
    }
    normalizeQuaternions(values);
    channels.push({ node, path: 'rotation', values });
  }
  return channels;
}

/** One VEC3 key list per node the sequence's `translationMatters` set names, addressed the
 *  same way `rotationChannels` addresses the rotation keys but into the translation array. */
function translationChannels(
  shape: DtsShape,
  sequence: DtsSequence,
  nodes: readonly Node[],
  keyCount: number,
): SequenceChannel[] {
  const channels: SequenceChannel[] = [];
  const keyframes = sequence.numKeyframes;
  for (const [rank, nodeIndex] of sequence.translationMatters.entries()) {
    const node = nodes[nodeIndex];
    if (!node) continue;
    const values = new Float32Array(keyCount * 3);
    for (const [key, sample] of sequenceKeys(sequence).entries()) {
      const at = (sequence.baseTranslation + rank * keyframes + sample) * 3;
      values[key * 3] = shape.nodeTranslationKeys[at] ?? 0;
      values[key * 3 + 1] = shape.nodeTranslationKeys[at + 1] ?? 0;
      values[key * 3 + 2] = shape.nodeTranslationKeys[at + 2] ?? 0;
    }
    channels.push({ node, path: 'translation', values });
  }
  return channels;
}

/** One channel of an animation: a sampler over the sequence's shared timebase, aimed at the
 *  channel's node and TRS path. The sampler is named for the sequence and the path, and so is
 *  the channel, because the clip's own name is only half of how a consumer reaches it. */
function addAnimationChannel(
  document: Document,
  animation: Animation,
  sequence: DtsSequence,
  channel: SequenceChannel,
  times: Float32Array<ArrayBuffer>,
): void {
  const name = `${sequence.name}_${channel.path}`;
  const sampler = document
    .createAnimationSampler(name)
    .setInput(accessorFor(document, `${name}_time`, times, 'SCALAR'))
    .setOutput(
      accessorFor(document, name, channel.values, channel.path === 'rotation' ? 'VEC4' : 'VEC3'),
    )
    .setInterpolation('LINEAR');
  animation
    .addSampler(sampler)
    .addChannel(
      document
        .createAnimationChannel(name)
        .setTargetNode(channel.node)
        .setTargetPath(channel.path)
        .setSampler(sampler),
    );
}

/** Keyframe `k` of a sequence: the sample a track reads, wrapping the extra cyclic key back
 *  to the first one (`TSShape` plays a cycle from 0 to `duration` and starts again). */
function sequenceKeys(sequence: DtsSequence): number[] {
  if (!sequence.cyclic || sequence.numKeyframes <= 1) {
    return Array.from({ length: Math.max(sequence.numKeyframes, 1) }, (_, key) => key);
  }
  return Array.from({ length: sequence.numKeyframes + 1 }, (_, key) =>
    key === sequence.numKeyframes ? 0 : key,
  );
}

/** When each key plays, in seconds: `numKeyframes` samples spread over `duration`, plus the
 *  cyclic wrap key, whose time is `duration` itself. */
function sequenceTimes(sequence: DtsSequence): Float32Array<ArrayBuffer> {
  const keys = sequenceKeys(sequence);
  const last = sequence.cyclic ? sequence.numKeyframes : Math.max(sequence.numKeyframes - 1, 1);
  return Float32Array.from(keys, (_, key) => (sequence.duration * key) / last);
}

/** The object state keyframe `k` of a sequence's `rank`-th animated object. */
function objectStateAt(
  shape: DtsShape,
  sequence: DtsSequence,
  rank: number,
  key: number,
): DtsObjectState {
  const at = sequence.baseObjectState + rank * sequence.numKeyframes + key;
  return shape.objectStates[at] ?? { visibility: 1, frame: 0, materialFrame: 0 };
}

/** glTF rotations must be unit quaternions; `Quat16` stores `S16 / 0x7FFF`, which is within
 *  a rounding step of unit but not exactly it. */
function normalizeQuaternions(values: Float32Array<ArrayBuffer>): void {
  for (let at = 0; at + 3 < values.length; at += 4) {
    const length = Math.hypot(
      values[at] ?? 0,
      values[at + 1] ?? 0,
      values[at + 2] ?? 0,
      values[at + 3] ?? 0,
    );
    if (length === 0) {
      values[at + 3] = 1;
      continue;
    }
    for (let component = 0; component < 4; component += 1)
      values[at + component] = (values[at + component] ?? 0) / length;
  }
}

/** Every object of the detail level's sub-shape, in `TSShape`'s own order, with the node it
 *  renders under — the run `TSShape::computeBounds` walks. Which of them actually draws is
 *  decided in `dtsToGlb`, because an object that does not draw is still a node. */
function detailObjects(
  shape: DtsShape,
  detail: DtsDetailLevel,
): { nodeIndex: number; objectIndex: number; object: DtsObject }[] {
  const subShape = shape.subShapes[detail.subShapeNum];
  if (!subShape) {
    throw new Error(
      `dtsToGlb: detail level ${detail.name} names sub-shape ${detail.subShapeNum}, which the ` +
        `shape's ${shape.subShapes.length} sub-shapes do not include.`,
    );
  }
  const objects: { nodeIndex: number; objectIndex: number; object: DtsObject }[] = [];
  const end = subShape.firstObject + subShape.numObjects;
  for (let index = subShape.firstObject; index < end; index += 1) {
    const object = shape.objects[index];
    if (!object) continue;
    objects.push({ nodeIndex: object.nodeIndex, objectIndex: index, object });
  }
  return objects;
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
      .setAttribute(
        'POSITION',
        accessorFor(document, `${mesh.name}_position`, primitive.positions, 'VEC3'),
      )
      .setAttribute(
        'NORMAL',
        accessorFor(document, `${mesh.name}_normal`, primitive.normals, 'VEC3'),
      )
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
  type: 'VEC4' | 'VEC3' | 'VEC2' | 'SCALAR',
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
    .setExtras({
      resource_path: source.name,
      flags: source.flags,
      flag_names: [...source.flagNames],
    });
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
  animations?: {
    name: string;
    samplers: { input: number; output: number; interpolation: string }[];
    channels: { sampler: number; target: { node: number; path: string | null } }[];
  }[];
}

/** glTF 2.0 §3.6.2.5 requires `min`/`max` on a `POSITION` accessor and recommends them on an
 *  animation's input, which is where a loader reads a clip's length from before it samples
 *  anything. */
function scalarBoundsOf(values: Float32Array): { min: number[]; max: number[] } {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return {
    min: [Number.isFinite(min) ? min : 0],
    max: [Number.isFinite(max) ? max : 0],
  };
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
  const indexes = collectGltfIndexes(root);
  const packed = packAccessors(root, indexes);
  const binary = packed.chunks.length > 0 ? BufferUtils.concat(packed.chunks) : new Uint8Array(0);
  const json: GltfJson = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: scenesJson(root, indexes.nodeIndexes),
    nodes: nodesJson(root, indexes.meshIndexes, indexes.nodeIndexes),
    meshes: meshesJson(root, packed.accessorIndexes, indexes.materialIndexes),
    materials: materialsJson(root),
    accessors: packed.accessors,
    bufferViews: packed.bufferViews,
    ...animationsJson(root, packed.accessorIndexes, indexes.nodeIndexes),
    buffers: binary.byteLength > 0 ? [{ byteLength: binary.byteLength }] : [],
  };
  return writeGlbContainer(json, binary);
}

/** The index maps and accessor classifications serialization needs, gathered in one pass:
 *  meshes own the accessors that take an `ELEMENT_ARRAY_BUFFER` target and the ones that
 *  need `POSITION` bounds, and an animation's sampler inputs need bounds of their own. */
interface GltfIndexes {
  meshIndexes: Map<Mesh, number>;
  materialIndexes: Map<Material, number>;
  nodeIndexes: Map<Node, number>;
  indexAccessors: Set<Accessor>;
  positionAccessors: Set<Accessor>;
  animationInputs: Set<Accessor>;
}

function collectGltfIndexes(root: Root): GltfIndexes {
  const indexes: GltfIndexes = {
    meshIndexes: new Map(),
    materialIndexes: new Map(),
    nodeIndexes: new Map(),
    indexAccessors: new Set(),
    positionAccessors: new Set(),
    animationInputs: new Set(),
  };
  for (const animation of root.listAnimations()) {
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput();
      if (input) indexes.animationInputs.add(input);
    }
  }
  for (const mesh of root.listMeshes()) {
    indexes.meshIndexes.set(mesh, indexes.meshIndexes.size);
    for (const primitive of mesh.listPrimitives()) classifyPrimitive(primitive, indexes);
  }
  for (const material of root.listMaterials()) {
    indexes.materialIndexes.set(material, indexes.materialIndexes.size);
  }
  for (const node of root.listNodes()) indexes.nodeIndexes.set(node, indexes.nodeIndexes.size);
  return indexes;
}

/** One primitive's two accessor roles: its indices (`ELEMENT_ARRAY_BUFFER`) and the
 *  `POSITION` attribute glTF wants bounds for. */
function classifyPrimitive(primitive: Primitive, indexes: GltfIndexes): void {
  const indices = primitive.getIndices();
  if (indices) indexes.indexAccessors.add(indices);
  const position = primitive.getAttribute('POSITION');
  if (position) indexes.positionAccessors.add(position);
}

/** Packs every accessor into its own four-byte-aligned buffer view, which is what glTF 2.0
 *  §3.6.2.4 requires of both the `FLOAT` attributes and the `UNSIGNED_SHORT` indices. */
function packAccessors(
  root: Root,
  indexes: GltfIndexes,
): {
  accessors: GltfAccessorJson[];
  bufferViews: GltfBufferViewJson[];
  chunks: Uint8Array[];
  accessorIndexes: Map<Accessor, number>;
} {
  const bufferViews: GltfBufferViewJson[] = [];
  const chunks: Uint8Array[] = [];
  const accessors: GltfAccessorJson[] = [];
  const accessorIndexes = new Map<Accessor, number>();
  let length = 0;
  for (const accessor of root.listAccessors()) {
    const array = accessor.getArray();
    if (!array) continue;
    length += pushAlignment(chunks, length);
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({
      buffer: 0,
      byteOffset: length,
      byteLength: bytes.byteLength,
      target: indexes.indexAccessors.has(accessor) ? GLTF_ELEMENT_ARRAY_BUFFER : GLTF_ARRAY_BUFFER,
    });
    chunks.push(new Uint8Array(bytes));
    length += bytes.byteLength;
    accessorIndexes.set(accessor, accessors.length);
    accessors.push(accessorJson(accessor, bufferViews.length - 1, array, indexes));
  }
  return { accessors, bufferViews, chunks, accessorIndexes };
}

/** Pads the binary to the next four-byte boundary, returning how many bytes that took. */
function pushAlignment(chunks: Uint8Array[], length: number): number {
  const padding = (4 - (length % 4)) % 4;
  if (padding === 0) return 0;
  chunks.push(new Uint8Array(padding));
  return padding;
}

/** One accessor's JSON. The two bound sets are glTF's own requirements rather than ours:
 *  `min`/`max` on a `POSITION` accessor (§3.6.2.5) and on an animation's input accessor,
 *  where they come from the scalar times rather than the positions. */
function accessorJson(
  accessor: Accessor,
  bufferView: number,
  array: ArrayBufferView,
  indexes: GltfIndexes,
): GltfAccessorJson {
  const vertexBounds =
    indexes.positionAccessors.has(accessor) && array instanceof Float32Array ? boundsOf(array) : {};
  const timeBounds =
    indexes.animationInputs.has(accessor) && array instanceof Float32Array
      ? scalarBoundsOf(array)
      : {};
  return {
    bufferView,
    componentType: accessor.getComponentType(),
    count: accessor.getCount(),
    type: accessor.getType(),
    ...vertexBounds,
    ...timeBounds,
  };
}

function scenesJson(root: Root, nodeIndexes: Map<Node, number>): GltfJson['scenes'] {
  return root.listScenes().map((scene) => ({
    name: scene.getName(),
    nodes: scene.listChildren().map((child) => nodeIndexes.get(child) ?? -1),
  }));
}

function nodesJson(
  root: Root,
  meshIndexes: Map<Mesh, number>,
  nodeIndexes: Map<Node, number>,
): GltfJson['nodes'] {
  return root.listNodes().map((node) => {
    const mesh = node.getMesh();
    const children = node.listChildren().map((child) => nodeIndexes.get(child) ?? -1);
    const extras = node.getExtras();
    return {
      name: node.getName(),
      translation: [...node.getTranslation()],
      rotation: [...node.getRotation()],
      scale: [...node.getScale()],
      ...(Object.keys(extras).length > 0 ? { extras } : {}),
      ...(mesh ? { mesh: meshIndexes.get(mesh) ?? -1 } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  });
}

function meshesJson(
  root: Root,
  accessorIndexes: Map<Accessor, number>,
  materialIndexes: Map<Material, number>,
): GltfJson['meshes'] {
  return root.listMeshes().map((mesh) => ({
    name: mesh.getName(),
    primitives: mesh
      .listPrimitives()
      .map((primitive) => primitiveJson(primitive, accessorIndexes, materialIndexes)),
  }));
}

function primitiveJson(
  primitive: Primitive,
  accessorIndexes: Map<Accessor, number>,
  materialIndexes: Map<Material, number>,
): Record<string, unknown> {
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
}

function materialsJson(root: Root): GltfJson['materials'] {
  return root.listMaterials().map((material) => ({
    name: material.getName(),
    extras: material.getExtras(),
    pbrMetallicRoughness: {
      baseColorFactor: [...material.getBaseColorFactor()],
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
    },
    ...(material.getDoubleSided() ? { doubleSided: true } : {}),
  }));
}

/** Animations are absent entirely when there are none, which is the case while sequence
 *  emission is dormant; the key is then left out of the JSON rather than written empty. */
function animationsJson(
  root: Root,
  accessorIndexes: Map<Accessor, number>,
  nodeIndexes: Map<Node, number>,
): Pick<GltfJson, 'animations'> {
  const animations = root.listAnimations();
  if (animations.length === 0) return {};
  return {
    animations: animations.map((animation) => ({
      name: animation.getName(),
      samplers: animation.listSamplers().map((sampler) => ({
        input: accessorIndexes.get(sampler.getInput()!) ?? 0,
        output: accessorIndexes.get(sampler.getOutput()!) ?? 0,
        interpolation: sampler.getInterpolation(),
      })),
      channels: animation.listChannels().map((channel) => ({
        sampler: channelSamplerIndex(animation, channel),
        target: {
          node: nodeIndexes.get(channel.getTargetNode()!) ?? -1,
          path: channel.getTargetPath(),
        },
      })),
    })),
  };
}

function channelSamplerIndex(animation: Animation, channel: AnimationChannel): number {
  const sampler = channel.getSampler();
  if (!sampler) return 0;
  return animation.listSamplers().indexOf(sampler);
}

/** glTF 2.0 §4.4: magic, version and total length, then each chunk's length and type. The
 *  JSON chunk is space-padded and the binary chunk zero-padded, per the same section. */
function writeGlbContainer(json: GltfJson, binary: Uint8Array): Uint8Array {
  const jsonChunk = BufferUtils.pad(BufferUtils.encodeText(JSON.stringify(json)), 0x20);
  const binChunk = binary.byteLength > 0 ? BufferUtils.pad(binary, 0) : new Uint8Array(0);
  const binHeaderLength = binChunk.byteLength > 0 ? 8 : 0;
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
