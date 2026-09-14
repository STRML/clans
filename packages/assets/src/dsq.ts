/**
 * Tribes 2 `.dsq` sequence-container reader.
 *
 * The player animation clips are *separate files*, one per clip, next to the body's `.dts`
 * in the mirror. A `.dsq` is not a shape — `parseDts` rejects one, correctly, because it is
 * not a `TSShape` buffer with its three guarded sections — it is one shape's worth of
 * animation state, written by `TSShape::exportSequences` (`ts/tsShapeOldRead.cc:941`) and
 * read back by `TSShape::importSequences` (`:1046`), which appends it to an already-loaded
 * shape through `TSShapeConstructor::onAdd` (`ts/tsShapeConstruct.cc:40-117`).
 *
 * The layout below is the write order of `exportSequences`, which is also the read order of
 * `importSequences` — the two functions are one contract, so each field names the call that
 * writes it (`s->write(...)` in `:941-1043`) and the call that reads it (`s->read(...)` in
 * `:1046-1330`):
 *
 *   S32   version            `smVersion`; `importSequences` refuses a version newer than the
 *                            running build's (`:1048-1055`), and `Sequence::read`'s own
 *                            version branches below are decided by this word.
 *   S32   nodeCount          the *sequence file's* node list — not the shape's:
 *   { S32 length; bytes }    written by `writeName` (`:1489`), read by `readName` (`:1500`)
 *                            with `addName=1`, as a bare length-prefixed string with no
 *                            terminator and no name table, because a standalone file has no
 *                            table to index. `importSequences` maps each of these names onto
 *                            the shape's own nodes by name (`:1060-1129`), which is how a
 *                            `.dsq` can animate a subset of the shape in its own order — the
 *                            biped clips list 20-27 of `light_male.dts`'s 32 nodes.
 *   S32   legacyObjects      always 0 (`s->write(0)`, ": "legacy write -- write zero objects",
 *                            `:962`); `importSequences` reads it and drops it (`:1136-1138`).
 *   S32   objectCount        the source shape's object count, used below to adjust object
 *                            indices: `adjObjectStates = objectStates.size() -
 *                            oldShapeNumObjects` (`:1119-1135`).
 *   S32   rotationCount      then that many `Quat16` — four `S16` — per key, the same
 *                            "skip default node states" run `exportSequences` writes at `:1003`
 *                            and `importSequences` appends at `:1146-1162`. Note the writer's
 *                            `write(nodeRotations[i].x)` is the `S16` overload of `Stream`
 *                            (`core/stream.h:120-130`): a `.dsq` stores rotations as `Quat16`
 *                            exactly like `TSShape::nodeRotations`, not as floats.
 *   S32   translationCount   then that many `Point3F` (`F32` x/y/z) — `:1009` / `:1163`.
 *   S32   uniformScaleCount  then that many `F32`; `:1014` / `:1165`.
 *   S32   alignedScaleCount  then that many `Point3F`; `:1020` / `:1171`.
 *   S32   arbitraryScaleCount then that many `Quat16`, then — with no count of its own —
 *                            `arbitraryScaleCount` `Point3F` factors: the writer emits the two
 *                            parallel arrays back to back (`:1026-1037`), and the reader sizes
 *                            the factors from the rotation array it just read (`:1178-1183`).
 *   S32   groundCount        then that many `Point3F` ground translations, then, again with no
 *                            count, that many `Quat16` ground rotations (`:1038-1049`).
 *   S32   objectStateCount   legacy, always 0: sequences animate nodes and objects through
 *                            this container only in the exporter's own writes, and
 *                            `importSequences` reads the count and discards the records
 *                            ("shouldn't be any...assume it", `:1244-1246`).
 *   S32   sequenceCount      then that many sequences, each a length-prefixed name (the same
 *                            `writeName`/`readName` pair, written at `:1055-1060` with the
 *                            name index the record itself omits: `seq.write(s, false)`) and a
 *                            `Sequence::read` record — the identical record a shape's own
 *                            sequence section holds, which is why `readSequenceRecord` in
 *                            `dts.ts` is shared by both containers.
 *   S32   triggerCount       then that many `{ S32 state; F32 pos }` pairs (`:1064-1071` /
 *                            `:1320-1328`).
 *
 * Versions below 22 are refused. Their node-state section interleaves the rotations and
 * translations per key instead of writing them as two separate runs (`:1221-1237`), and their
 * sequences carry three separate Blend/Cyclic/MakePath bytes instead of flag bits — a second
 * layout this reader would have to implement twice over. Nothing in the mirror needs it: every
 * player `.dsq` the game ships carries version 22, the same `smVersion` the exported
 * `light_male.dts` was written with. */

import {
  SUPPORTED_DTS_VERSION,
  readSequenceRecord,
  type DtsNode,
  type DtsSequence,
  type DtsShape,
} from './dts.js';

/** `Quat16` is four `S16` per key (`ts/tsTransform.h`), the layout `DtsShape.nodeRotationKeys`
 *  carries: this many array entries per key. */
const QUAT16_COMPONENTS = 4;
/** One `Point3F` per translation key: three `F32`. */
const POINT3_COMPONENTS = 3;
/** The same ceiling `dts.ts` puts on a shape's sequence list, for the same reason: the count
 *  multiplies a later read, so a nonsense value is a corrupt file rather than an empty list. */
const MAX_SEQUENCES = 0x4000;

/** One `.dsq` file: the source shape's node list, its appended node states, and the sequences
 *  that index into them. The shape's own geometry, meshes and materials are not here — they
 *  live in the `.dts` this file is appended to. */
export interface DsqFile {
  /** The writer's `smVersion` (`exportSequences`'s first write, `:944`). */
  readonly version: number;
  /** The sequence file's node names, in its own order: `importSequences` maps each of these
   *  onto a shape node by name (`:1090-1129`), and only then can a member index mean
   *  anything. */
  readonly nodeNames: readonly string[];
  /** The source shape's object count — `importSequences`' `oldShapeNumObjects` (`:1119`),
   *  which shifts a sequence's `baseObjectState` onto the target shape's object-state list
   *  (`:1135`). */
  readonly objectCount: number;
  /** `Quat16` rotation keys, four `S16` per key, in `DtsShape.nodeRotationKeys`' own layout:
   *  the sequences' `baseRotation` indices are positions in this array. */
  readonly nodeRotationKeys: Int16Array;
  /** `Point3F` translation keys, three `F32` per key, addressed by `baseTranslation`. */
  readonly nodeTranslationKeys: Float32Array;
  /** The file's sequences, in written order, with their base indices still relative to this
   *  file's own key arrays — `appendSequences` below is what moves them onto a shape. */
  readonly sequences: readonly DtsSequence[];
}

/** A `.dsq` cursor: one flat record, one value at a time, every read past the end of the file
 *  reported with the field that ran out — the same shape as `dts.ts`'s `ShapeStream` and
 *  `SequenceReader`, for the same reason (the reader's only correctness invariant is the order
 *  the fields consume the stream in). */
class DsqStream {
  cursor = 0;

  constructor(
    private readonly view: DataView,
    readonly length: number,
  ) {}

  /** The `S32` every count and index in this container is written as. */
  i32(field: string): number {
    this.require(4, field);
    const value = this.view.getInt32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  f32(field: string): number {
    this.require(4, field);
    const value = this.view.getFloat32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  i16(field: string): number {
    this.require(2, field);
    const value = this.view.getInt16(this.cursor, true);
    this.cursor += 2;
    return value;
  }

  /** `TSShape::readName` (`:1500`): an `S32` length, then that many bytes and no terminator.
   *  Read as latin1, the single-byte encoding the engine's `char` strings are, so a name with
   *  a high byte round-trips instead of becoming a replacement character. */
  name(field: string): string {
    const length = this.i32(`${field} length`);
    if (length < 0 || this.cursor + length > this.length) {
      throw new Error(
        `Truncated DSQ: ${field}'s name claims ${String(length)} bytes at ${String(this.cursor)} ` +
          `of ${String(this.length)}.`,
      );
    }
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.cursor, length);
    this.cursor += length;
    return new TextDecoder('latin1').decode(bytes);
  }

  /** Steps over an array this reader reads only to reach the field after it. */
  skip(bytes: number, field: string): void {
    this.require(bytes, field);
    this.cursor += bytes;
  }

  /** The view the sequence records are read through: `Sequence::read` is a `dts.ts` reader,
   *  and one implementation of it is the point of sharing it. */
  get data(): DataView {
    return this.view;
  }

  private require(bytes: number, field: string): void {
    if (this.cursor + bytes > this.length) {
      throw new Error(
        `Truncated DSQ: ${field} runs ${String(this.cursor + bytes - this.length)} bytes past ` +
          `the end of the ${String(this.length)}-byte file.`,
      );
    }
  }
}

/** Reads a `.dsq` into the same shape `parseDts` produces for a `.dts`'s own sequence
 *  section, so `appendSequences` can hand the result to the same animation emitter. Throws on
 *  a version this reader does not implement, on a truncated file, and on a file with bytes
 *  left over — which is what a layout mistake looks like from here, since every section is
 *  sized by a count the file itself carries. */
export function parseDsq(bytes: Uint8Array): DsqFile {
  const stream = new DsqStream(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    bytes.byteLength,
  );
  const version = stream.i32('version');
  if (version < 22 || version > SUPPORTED_DTS_VERSION) {
    throw new Error(
      `Unsupported DSQ version ${String(version)}: this reader implements 22..` +
        `${String(SUPPORTED_DTS_VERSION)}, the versions whose node states are two separate ` +
        'runs and whose sequences store their flags as bits (tsShapeOldRead.cc:1146, :1346).',
    );
  }
  const nodeNames = readDsqNodeNames(stream);
  stream.skip(4, 'legacy object count');
  const objectCount = stream.i32('objectCount');
  const nodeRotationKeys = readQuat16Keys(stream, 'nodeRotations');
  const nodeTranslationKeys = readPoint3Keys(stream, 'nodeTranslations');
  skipDsqScaleState(stream);
  skipDsqGroundState(stream);
  stream.skip(4, 'objectStateCount');
  const sequences = readDsqSequences(stream, version);
  skipDsqTriggers(stream);
  if (stream.cursor !== bytes.byteLength) {
    throw new Error(
      `Invalid DSQ: ${String(bytes.byteLength - stream.cursor)} bytes left over after the ` +
        'trigger list; the container layout this reader implements ends there.',
    );
  }
  return { version, nodeNames, objectCount, nodeRotationKeys, nodeTranslationKeys, sequences };
}

/** The sequence file's node names. Nothing bounds this list but the file, so every name is
 *  read as a length-prefixed string and the list is capped the way `dts.ts` caps its own
 *  count blocks. */
function readDsqNodeNames(stream: DsqStream): string[] {
  const count = stream.i32('nodeCount');
  if (count < 0 || count > MAX_SEQUENCES) {
    throw new Error(`Invalid DSQ: ${String(count)} nodes.`);
  }
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) names.push(stream.name(`node${String(index)}`));
  return names;
}

/** `n` `Quat16` keys: four `S16` per key, the layout `parseDts` reads a shape's own
 *  `nodeRotations` in, so the two arrays concatenate without conversion. */
function readQuat16Keys(stream: DsqStream, field: string): Int16Array {
  const count = stream.i32(`${field}Count`);
  assertKeyCount(count, field);
  const keys = new Int16Array(count * QUAT16_COMPONENTS);
  for (let index = 0; index < keys.length; index += 1) keys[index] = stream.i16(field);
  return keys;
}

/** `n` `Point3F` keys: three `F32` each. */
function readPoint3Keys(stream: DsqStream, field: string): Float32Array {
  const count = stream.i32(`${field}Count`);
  assertKeyCount(count, field);
  const keys = new Float32Array(count * POINT3_COMPONENTS);
  for (let index = 0; index < keys.length; index += 1) keys[index] = stream.f32(field);
  return keys;
}

function assertKeyCount(count: number, field: string): void {
  if (count < 0 || count > 0x100000) {
    throw new Error(`Invalid DSQ: ${field} claims ${String(count)} keys.`);
  }
}

/** The three scale arrays, read past rather than carried: `DtsShape` keeps no scale key array
 *  for them to land in, and `emitSequenceAnimations` emits rotation and translation channels
 *  only. Every player `.dsq` in the mirror has all three counts at zero, so nothing is lost by
 *  the skip today; a clip that did animate scale would emit without its scale channels. */
function skipDsqScaleState(stream: DsqStream): void {
  const uniform = stream.i32('uniformScaleCount');
  stream.skip(uniform * 4, 'uniformScales');
  const aligned = stream.i32('alignedScaleCount');
  stream.skip(aligned * 12, 'alignedScales');
  const arbitrary = stream.i32('arbitraryScaleCount');
  stream.skip(arbitrary * 8 + arbitrary * 12, 'arbitraryScales');
}

/** The ground-transform arrays: translations with a count of their own, then the rotations
 *  that follow them countless (`:1038-1049`). A sequence's `firstGroundFrame` indexes them,
 *  and neither this reader nor the emitted clips use them — a decoded player clip plays its
 *  keyframes, and the ground transform is the root motion the engine applies on top. */
function skipDsqGroundState(stream: DsqStream): void {
  const count = stream.i32('groundTranslationsCount');
  stream.skip(count * 12 + count * 8, 'groundTransforms');
}

/** The sequences: a length-prefixed name each, then the record `dts.ts` reads for a shape's
 *  own sequence section — `Sequence::read(s, true)` there, `(s, false)` here, which is the
 *  only difference between the two containers' records. */
function readDsqSequences(stream: DsqStream, version: number): DtsSequence[] {
  const count = stream.i32('sequenceCount');
  if (count < 0 || count > MAX_SEQUENCES)
    throw new Error(`Invalid DSQ: ${String(count)} sequences.`);
  const sequences: DtsSequence[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = stream.name(`sequence${String(index)}`);
    const read = readSequenceRecord(
      stream.data,
      stream.cursor,
      version,
      stream.length,
      index,
      name,
    );
    stream.skip(read.cursor - stream.cursor, `sequence${String(index)} record`);
    sequences.push(read.sequence);
  }
  return sequences;
}

/** `Sequence::Trigger`: the state word and the position in `duration` it fires at. Read so the
 *  file's last section is accounted for, and otherwise unused: a trigger drives a shape
 *  instance's state variables, which is engine runtime state rather than something a glTF
 *  animation carries. */
function skipDsqTriggers(stream: DsqStream): void {
  const count = stream.i32('triggerCount');
  if (count < 0 || count > MAX_SEQUENCES)
    throw new Error(`Invalid DSQ: ${String(count)} triggers.`);
  stream.skip(count * 8, 'triggers');
}

/** Appends one `.dsq`'s sequences to a shape, the way `TSShape::importSequences` does at load
 *  time (`ts/tsShapeOldRead.cc:1046`): the node states join the shape's keyframe arrays, each
 *  sequence's base indices move to where its keys now live, and its node memberships are
 *  remapped from the sequence file's node order onto the shape's.
 *
 *  `clipName` is the name the file's clip takes in the shape, and it is the caller's for the
 *  same reason it is the engine's: `TSShapeConstructor::onAdd` renames the sequence it has just
 *  appended (`ts/tsShapeConstruct.cc:104-116`), which is how a datablock's
 *  `sequence1 = "light_male_forward.dsq run"` turns the file's stored `Forward` into `run`.
 *  Where the datablock takes that name from its own second token, the player build takes it
 *  from the file's suffix, because the contract's clip names are the `.dsq` suffixes. Only the
 *  last appended sequence is renamed, as in `onAdd`: a `.dsq` holding more than one sequence
 *  keeps the file's own names for the others. */
export function appendSequences(shape: DtsShape, dsq: DsqFile, clipName: string): DtsShape {
  const nodeMap = mapSequenceNodes(shape.nodes, dsq.nodeNames);
  // `adjNodeRots`/`adjNodeTrans` (`:1130-1132`): the imported keys land after the shape's own.
  const baseRotation = shape.nodeRotationKeys.length / QUAT16_COMPONENTS;
  const baseTranslation = shape.nodeTranslationKeys.length / POINT3_COMPONENTS;
  // `adjObjectStates` (`:1135`): the file's object indices are relative to a shape with
  // `objectCount` objects, this shape may hold a different number of object-state records.
  const objectStateShift = shape.objectStates.length - dsq.objectCount;
  const nodeRotationKeys = new Int16Array(
    shape.nodeRotationKeys.length + dsq.nodeRotationKeys.length,
  );
  nodeRotationKeys.set(shape.nodeRotationKeys);
  nodeRotationKeys.set(dsq.nodeRotationKeys, shape.nodeRotationKeys.length);
  const nodeTranslationKeys = new Float32Array(
    shape.nodeTranslationKeys.length + dsq.nodeTranslationKeys.length,
  );
  nodeTranslationKeys.set(shape.nodeTranslationKeys);
  nodeTranslationKeys.set(dsq.nodeTranslationKeys, shape.nodeTranslationKeys.length);
  return {
    ...shape,
    sequenceCount: shape.sequenceCount + dsq.sequences.length,
    sequences: [
      ...shape.sequences,
      ...dsq.sequences.map((sequence, index) =>
        remapSequence(
          index === dsq.sequences.length - 1 ? { ...sequence, name: clipName } : sequence,
          nodeMap,
          baseRotation,
          baseTranslation,
          objectStateShift,
        ),
      ),
    ],
    nodeRotationKeys,
    nodeTranslationKeys,
  };
}

/** `importSequences`' node map (`:1060-1129`): each of the sequence file's node names resolved
 *  to a node of the shape, by name, so a clip written against one body's node list can drive
 *  another body's. The engine looks names up in a case-insensitive `StringTable` and maps the
 *  `n`-th occurrence of a repeated name to the `n`-th node with that name (`:1076-1110`); both
 *  are reproduced here. A name the shape does not have fails the import with the engine's own
 *  message (`:1111-1120`) rather than dropping the node's animation silently. */
function mapSequenceNodes(nodes: readonly DtsNode[], names: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const index = nthNodeNamed(nodes, key, occurrence);
    if (index < 0) {
      throw new Error(`Sequence import failed: sequence node "${name}" not found in base shape.`);
    }
    return index;
  });
}

/** The mapped index of the `occurrence`-th node whose name matches `key`, or -1 when the
 *  shape has fewer than that many — the shape-index half of the engine's duplicate-name rule
 *  (`:1076-1110`). Spelled out rather than inlined into `mapSequenceNodes` because "the n-th
 *  node with this name", not "the first", is the whole point. */
function nthNodeNamed(nodes: readonly DtsNode[], key: string, occurrence: number): number {
  let seen = 0;
  for (const [index, node] of nodes.entries()) {
    if (node.name.toLowerCase() !== key) continue;
    if (seen === occurrence) return index;
    seen += 1;
  }
  return -1;
}

/** One imported sequence with its indices moved onto the shape. `baseScale` is deliberately
 *  left as stored: `DtsShape` carries no scale key arrays for it to index into, and the scale
 *  arrays themselves are read past unread (see `skipDsqScaleState`). */
function remapSequence(
  sequence: DtsSequence,
  nodeMap: readonly number[],
  baseRotation: number,
  baseTranslation: number,
  objectStateShift: number,
): DtsSequence {
  return {
    ...sequence,
    baseRotation: sequence.baseRotation + baseRotation,
    baseTranslation: sequence.baseTranslation + baseTranslation,
    baseObjectState: sequence.baseObjectState + objectStateShift,
    rotationMatters: remapMembers(sequence.rotationMatters, nodeMap),
    translationMatters: remapMembers(sequence.translationMatters, nodeMap),
    scaleMatters: remapMembers(sequence.scaleMatters, nodeMap),
  };
}

/** `importSequences`' membership remap (`:1276-1293`): it walks the file's node indices
 *  ascending and sets the mapped shape index in a fresh `TSIntegerSet`, so the mapped set
 *  holds *shape* indices and iterates ascending — the order `TSShapeInstance::animate` walks
 *  it in, counting `j` up as it goes to address each member's keys by rank
 *  (`ts/tsAnimate.cc:126-138`). The members are therefore sorted here too, which is the
 *  identity when the sequence file's node order is a subsequence of the shape's own — true for
 *  every player clip, and asserted where the clips are converted. */
function remapMembers(members: readonly number[], nodeMap: readonly number[]): number[] {
  const mapped = members.flatMap((member) => {
    const mappedIndex = nodeMap[member];
    return mappedIndex === undefined ? [] : [mappedIndex];
  });
  return mapped.sort((left, right) => left - right);
}
