import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDts, type DtsNode, type DtsShape } from './dts.js';
import { appendSequences, parseDsq, type DsqFile } from './dsq.js';

/** `light_male_forward.dsq` is an unmodified `base/@vl2/shapes.vl2/shapes` file from the same
 *  mirror the rest of this package's assets come from: 2,062 bytes, version 22, and the only
 *  clip source small enough to sit in the repository as a fixture. It is the real article —
 *  the file `TSShapeConstructor::onAdd` opens for `light_male`'s `run` sequence — so its
 *  numbers are the file's own, not a hand-written stand-in. */
async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./__fixtures__/${name}`, import.meta.url)));
}

/** The nodes the fixture clip names, in the clip's own order (`importSequences` maps these
 *  onto the shape by name — `ts/tsShapeOldRead.cc:1090-1129`). `light_male.dts` holds the same
 *  twenty biped joints among its 32 nodes, so this list is the reader's map input and the
 *  shape's node table is its output. */
const FIXTURE_NODES = [
  'Bip01 Pelvis',
  'Bip01 Spine',
  'Bip01 Spine1',
  'Bip01 Spine2',
  'Bip01 Neck',
  'Bip01 Head',
  'Bip01 L Clavicle',
  'Bip01 L UpperArm',
  'Bip01 L Forearm',
  'Bip01 L Hand',
  'Bip01 R Clavicle',
  'Bip01 R UpperArm',
  'Bip01 R Forearm',
  'Bip01 R Hand',
  'Bip01 L Thigh',
  'Bip01 L Calf',
  'Bip01 L Foot',
  'Bip01 R Thigh',
  'Bip01 R Calf',
  'Bip01 R Foot',
];

/** A minimal `.dsq` writer, in `TSShape::exportSequences`' write order
 *  (`ts/tsShapeOldRead.cc:941-1071`). The real fixture proves this reader against a real file;
 *  this proves the *merge* below against bytes whose every number is known here, which is how
 *  the node-name matching rules (case, repeated names, an out-of-range member) get an input
 *  the mirror has no file for. */
function writeDsq(options: {
  nodeNames: readonly string[];
  sequences: Array<{
    name: string;
    numKeyframes: number;
    duration: number;
    flags: number;
    baseRotation: number;
    baseTranslation: number;
    rotationMatters: readonly number[];
    translationMatters: readonly number[];
  }>;
  /** `Quat16` keys, four `S16` per key. */
  rotations?: readonly number[];
  /** `Point3F` keys, three `F32` per key. */
  translations?: readonly number[];
}): Uint8Array {
  const bytes: number[] = [];
  const i32 = (value: number): void => {
    for (let byte = 0; byte < 4; byte += 1) bytes.push((value >> (byte * 8)) & 0xff);
  };
  const f32 = (value: number): void => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let byte = 0; byte < 4; byte += 1) bytes.push(view.getUint8(byte));
  };
  const i16 = (value: number): void => {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
  };
  const name = (value: string): void => {
    i32(value.length);
    for (const character of value) bytes.push(character.charCodeAt(0) & 0xff);
  };
  const set = (members: readonly number[]): void => {
    i32(0); // TSIntegerSet::write: a leading word that is always zero
    const words = members.length === 0 ? 0 : Math.ceil((Math.max(...members) + 1) / 32);
    i32(words);
    for (let word = 0; word < words; word += 1) {
      let bits = 0;
      for (const member of members) {
        if (Math.floor(member / 32) === word) bits |= 1 << (member % 32);
      }
      i32(bits);
    }
  };

  i32(22); // version
  i32(options.nodeNames.length);
  for (const nodeName of options.nodeNames) name(nodeName);
  i32(0); // legacy zero objects
  i32(0); // source shape's object count
  const rotations = options.rotations ?? [];
  i32(rotations.length / 4);
  for (const component of rotations) i16(component);
  const translations = options.translations ?? [];
  i32(translations.length / 3);
  for (const component of translations) f32(component);
  i32(0); // uniform scales
  i32(0); // aligned scales
  i32(0); // arbitrary scale rotations, and so no factors after them
  i32(0); // ground translations, and so no ground rotations after them
  i32(0); // legacy object states
  i32(options.sequences.length);
  for (const sequence of options.sequences) {
    name(sequence.name);
    i32(sequence.flags);
    i32(sequence.numKeyframes);
    f32(sequence.duration);
    i32(0); // priority
    i32(0); // first ground frame
    i32(0); // ground frame count
    i32(sequence.baseRotation);
    i32(sequence.baseTranslation);
    i32(0); // base scale
    i32(0); // base object state
    i32(0); // base decal state
    i32(0); // first trigger
    i32(0); // trigger count
    f32(0); // tool begin
    set(sequence.rotationMatters);
    set(sequence.translationMatters);
    set([]); // scale matters
    set([]); // decal matters
    set([]); // IFL matters
    set([]); // visibility matters
    set([]); // frame matters
    set([]); // material frame matters
  }
  i32(0); // triggers
  return new Uint8Array(bytes);
}

/** A shape whose animation the merge below can be read off: `weapon_energy.dts` is version 21
 *  with real keyframes, so an appended clip's base indices have somewhere to move to. */
async function keyedShape(): Promise<DtsShape> {
  return parseDts(await fixture('weapon_energy.dts'));
}

/** Nodes with the names a merge test needs — including a repeated name, which is the case the
 *  engine's map resolves by occurrence rather than by first match. */
function nodesNamed(names: readonly string[]): DtsNode[] {
  return names.map((name) => ({
    name,
    parentIndex: -1,
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    meshIndexes: [],
  }));
}

/** A sequence's node members as the keyframe arrays are addressed by them: each member an
 *  index into the file's own node list (nothing else can address a key there), and ascending,
 *  which is the order the engine's `TSIntegerSet` iterates and the order `rank` is counted in
 *  (`ts/tsAnimate.cc:126-138`). */
function expectMemberIndices(members: readonly number[], nodeCount: number): void {
  for (const member of members) expect(member).toBeLessThan(nodeCount);
  expect(members).toEqual([...members].sort((left, right) => left - right));
}

describe('parseDsq', () => {
  it('reads the real light_male forward clip into one sequence', async () => {
    const dsq = parseDsq(await fixture('light_male_forward.dsq'));
    expect(dsq.version).toBe(22);
    expect(dsq.nodeNames).toEqual(FIXTURE_NODES);
    // The file's own internal name is capitalised; the clip name the build publishes is the
    // `.dsq` suffix (`forward`), which is the contract the client looks clips up by.
    expect(dsq.sequences.map((sequence) => sequence.name)).toEqual(['Forward']);
    const sequence = dsq.sequences[0];
    expect(sequence?.numKeyframes).toBe(11);
    expect(sequence?.duration).toBeCloseTo(0.7667, 3);
    expect(sequence?.cyclic).toBe(true);
    // 121 rotation keys and 44 translation keys: the file's own counts, and the arrays hold
    // four `S16` and three `F32` per key respectively — 11 rotation members over 11 keyframes,
    // and 4 translation members over the same 11.
    expect(dsq.nodeRotationKeys).toHaveLength(121 * 4);
    expect(dsq.nodeTranslationKeys).toHaveLength(44 * 3);
    expect(sequence?.rotationMatters).toHaveLength(11);
    expect(sequence?.translationMatters).toHaveLength(4);
    // The clip moves: the first member's second sample differs from its first, which is the
    // addressing `base + rank * numKeyframes + k` read at rank 0.
    expect(Array.from(dsq.nodeRotationKeys.slice(4, 8))).not.toEqual(
      Array.from(dsq.nodeRotationKeys.slice(0, 4)),
    );
    expectMemberIndices(sequence?.rotationMatters ?? [], dsq.nodeNames.length);
    expectMemberIndices(sequence?.translationMatters ?? [], dsq.nodeNames.length);
    // `oldShapeNumObjects` (`:1119`): the object count of the shape this clip was written
    // against, which shifts the sequence's object-state index onto the target shape.
    expect(dsq.objectCount).toBe(25);
  });

  it('rejects a version whose node states are interleaved', async () => {
    const bytes = await fixture('light_male_forward.dsq');
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(0, 21, true);
    expect(() => parseDsq(bytes)).toThrow(/Unsupported DSQ version 21/);
  });

  it('rejects a truncated file and a file with bytes left over', async () => {
    const bytes = await fixture('light_male_forward.dsq');
    expect(() => parseDsq(bytes.subarray(0, 400))).toThrow(/Truncated DSQ/);
    const padded = new Uint8Array(bytes.byteLength + 8);
    padded.set(bytes);
    expect(() => parseDsq(padded)).toThrow(/left over after the trigger list/);
  });
});

describe('appendSequences', () => {
  it('maps the clip nodes onto the shape by name, case-insensitively and by occurrence', async () => {
    const shape = await keyedShape();
    const mapped: DtsShape = {
      ...shape,
      nodes: nodesNamed(['Shape', 'Start', 'Start', 'ObjectB1']),
      nodeRotationKeys: new Int16Array([1, 2, 3, 4]),
      nodeTranslationKeys: new Float32Array([1, 2, 3]),
      sequences: [],
      sequenceCount: 0,
    };
    const dsq = writeDsq({
      nodeNames: ['shape', 'START', 'Start', 'ObjectB1'],
      rotations: [0, 0, 0, 32767, 0, 0, 0, 32767],
      translations: [1, 2, 3, 4, 5, 6],
      sequences: [
        {
          name: 'Forward',
          numKeyframes: 2,
          duration: 0.5,
          flags: 1 << 4,
          baseRotation: 0,
          baseTranslation: 0,
          // File order: the fourth node first, the repeated `Start` second, and one index
          // past the end of the file's node list, which the engine's remap loop never visits
          // and so drops (`ts/tsShapeOldRead.cc:1281-1291`).
          rotationMatters: [3, 2, 1, 4],
          translationMatters: [0, 3],
        },
      ],
    });
    const merged = appendSequences(mapped, parseDsq(dsq), 'forward');
    const sequence = merged.sequences[0];
    // The stored name (`Forward`) is replaced by the caller's clip name, which is how the
    // engine's own sequence constructor renames a clip it imports.
    expect(sequence?.name).toBe('forward');
    // `shape`/`START`/`Start`/`ObjectB1` -> nodes 0, 1, 2, 3, so file members 3, 2, 1 become
    // shape nodes 3, 2, 1 and member 4 is dropped for want of a fifth node.
    expect(sequence?.rotationMatters).toEqual([1, 2, 3]);
    expect(sequence?.translationMatters).toEqual([0, 3]);
    // The appended keys land after the shape's own: base indices move by their lengths.
    expect(sequence?.baseRotation).toBe(1);
    expect(sequence?.baseTranslation).toBe(1);
    expect(Array.from(merged.nodeRotationKeys)).toEqual([
      1, 2, 3, 4, 0, 0, 0, 32767, 0, 0, 0, 32767,
    ]);
    expect(Array.from(merged.nodeTranslationKeys)).toEqual([1, 2, 3, 1, 2, 3, 4, 5, 6]);
    expect(merged.sequenceCount).toBe(1);
  });

  it('fails the import when the clip names a node the shape does not have', async () => {
    const shape = await keyedShape();
    const dsq = writeDsq({
      nodeNames: ['Shape', 'Bip01 Pelvis'],
      sequences: [
        {
          name: 'Forward',
          numKeyframes: 1,
          duration: 0.1,
          flags: 0,
          baseRotation: 0,
          baseTranslation: 0,
          rotationMatters: [1],
          translationMatters: [],
        },
      ],
    });
    expect(() => appendSequences(shape, parseDsq(dsq), 'forward')).toThrow(
      /sequence node "Bip01 Pelvis" not found in base shape/,
    );
  });

  it('keeps the shape a clip does not touch', async () => {
    const shape = await keyedShape();
    const dsq: DsqFile = parseDsq(
      writeDsq({ nodeNames: [], sequences: [], rotations: [], translations: [] }),
    );
    const merged = appendSequences(shape, dsq, 'forward');
    expect(merged.sequences).toEqual(shape.sequences);
    expect(merged.nodeRotationKeys).toEqual(shape.nodeRotationKeys);
    expect(merged.meshes).toBe(shape.meshes);
    expect(merged.materials).toBe(shape.materials);
  });
});
