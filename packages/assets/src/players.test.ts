import { readFile, stat } from 'node:fs/promises';
import { mat4, quat, vec3 } from 'gl-matrix';
import { describe, expect, it } from 'vitest';
import { parseDts, type DtsSequence, type DtsShape } from './dts.js';
import { parseDsq, type DsqFile } from './dsq.js';
import {
  PLAYER_BODIES,
  playerClipSource,
  playerShapeSource,
  type PlayerBody,
} from './player-sources.js';
import textureSources from './texture-sources.json' with { type: 'json' };

/** The published player models, read from the repository rather than built here: the build is
 *  `build.ts`'s job, and a committed `.glb` is what a clean clone has (the same reason
 *  `textures.test.ts` reads `shapes/sbunk2.glb` instead of the fetch cache). */
const OUTPUT = new URL('../../../assets/out/katabatic/players/', import.meta.url);
/** The `.dsq` fixture `dsq.test.ts` parses: the real `light_male_forward.dsq`, and the file
 *  the published `forward` clip is converted from — so the emitted keys can be checked against
 *  the source they came from rather than against the emitter that wrote them. */
const FORWARD_FIXTURE = new URL('./__fixtures__/light_male_forward.dsq', import.meta.url);

/** The fetch cache the build converts from. Gitignored, so the tests that need it skip on a
 *  clone that has not fetched; the committed output above is what those clues are about. */
const CACHE = new URL('../cache/', import.meta.url);

/** The biped joints all three bodies carry: the hierarchy the `.dsq` clip files are written
 *  against (`Bip01 Pelvis` down through both legs) plus the attachment points — the two hands'
 *  `Mount0`, the jetpack's `Jetnozzle0`, the skis, `Eye`/`Cam` for a camera, and the `Unlink`
 *  root the biped hangs off. `light_male` also has the jetpack's `Jetfire145` joint, while the
 *  two heavier bodies' exports replace it with their own flare/stream joints (`Jetnozzle1`,
 *  `FlareL145`, `JetstreamL145`), so it is listed with light's own hierarchy below rather than
 *  as a joint in common. */
const BIPED_NODES = [
  'Bip01 Pelvis',
  'Bip01 Spine',
  'Bip01 Spine1',
  'Bip01 Spine2',
  'Bip01 Neck',
  'Bip01 Head',
  'Eye',
  'Bip01 L Clavicle',
  'Bip01 L UpperArm',
  'Bip01 L Forearm',
  'Bip01 L Hand',
  'Bip01 R Clavicle',
  'Bip01 R UpperArm',
  'Bip01 R Forearm',
  'Bip01 R Hand',
  'Mount0',
  'Jetnozzle0',
  'Mount1',
  'Mount2',
  'Light0',
  'Light1',
  'Bip01 L Thigh',
  'Bip01 L Calf',
  'Bip01 L Foot',
  'Ski0',
  'Bip01 R Thigh',
  'Bip01 R Calf',
  'Bip01 R Foot',
  'Ski1',
  'Unlink',
  'Cam',
];

/** `light_male.dts`'s whole node table, in the shape's own order — the contract's "32 nodes:
 *  Bip01 Pelvis, Spine, Head, L/R arms/legs, Mount0-2, Jetnozzle0, Ski0/1, Eye, Cam", as the
 *  emitted file carries it. The two heavier bodies hold the same joints plus one `Submesh_*`
 *  node per body part (their meshes hang off holder nodes rather than off the joints), so only
 *  this body's node list can be asserted exactly. */
const LIGHT_NODES = [
  'Bip01 Pelvis',
  'Bip01 Spine',
  'Bip01 Spine1',
  'Bip01 Spine2',
  'Bip01 Neck',
  'Bip01 Head',
  'Eye',
  'Bip01 L Clavicle',
  'Bip01 L UpperArm',
  'Bip01 L Forearm',
  'Bip01 L Hand',
  'Bip01 R Clavicle',
  'Bip01 R UpperArm',
  'Bip01 R Forearm',
  'Bip01 R Hand',
  'Mount0',
  'Jetnozzle0',
  'Mount1',
  'Mount2',
  'Jetfire145',
  'Light0',
  'Light1',
  'Bip01 L Thigh',
  'Bip01 L Calf',
  'Bip01 L Foot',
  'Ski0',
  'Bip01 R Thigh',
  'Bip01 R Calf',
  'Bip01 R Foot',
  'Ski1',
  'Unlink',
  'Cam',
];

/** The clips the client's `clipFor` selects by name: the movement set plus one death clip.
 *  `dead` is not a clip — it is the local player's shell — and the client picks one `die*`
 *  clip for a corpse, so a body carrying any one of them is enough. */
const REQUIRED_CLIPS = [
  'root',
  'forward',
  'back',
  'side',
  'jump',
  'standjump',
  'fall',
  'land',
  'jet',
  'ski',
];

/** Every clip the mirror does not ship for a body but the contract's list asks for: `newland`
 *  exists only for `light_male` (no `medium_male_newland.dsq` or `heavy_male_newland.dsq` is
 *  published at all, and no datablock references the light one either). The build carries what
 *  each body has, and this is where that difference is written down. */
const BODY_ONLY_CLIPS: Record<string, string[]> = { light_male: ['newland'] };

/** The two sequences each `.dts` carries itself, appended to the body's clips in the emitted
 *  file: both are IFL material markers (`JetFlare`/`Jetflare` for the jetpack's flare texture,
 *  `Damage` for the damage overlay), which is why the base shapes hold no poses at all. Listed
 *  per body because the mirror's exports spell the jetpack marker two ways. */
const SHAPE_CLIPS: Record<string, string[]> = {
  light_male: ['Damage', 'JetFlare'],
  medium_male: ['Damage', 'Jetflare'],
  heavy_male: ['Damage', 'JetFlare'],
};

/** The parts of one committed player GLB this file reads: its node graph, its animations and
 *  the accessor counts their samplers point at. Read from the JSON chunk directly rather than
 *  through a glTF library, because these GLBs' materials point at texture files by relative
 *  URI and `NodeIO.readBinary` refuses a binary whose images it cannot resolve
 *  (`textures.test.ts` reads the same chunk of the committed shape GLBs for the same reason). */
interface GltfJson {
  nodes: Array<{
    name?: string;
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    children?: number[];
  }>;
  accessors: Array<{ count: number; bufferView: number; byteOffset?: number; type: string }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
  meshes: unknown[];
  materials: unknown[];
  animations?: Array<{
    name?: string;
    channels: Array<{ target: { node: number; path: string }; sampler: number }>;
    samplers: Array<{ input: number; output: number }>;
  }>;
}

/** How many floats one accessor element holds, by the glTF `type` word of the accessor. */
const COMPONENT_COUNTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** The JSON chunk and the binary chunk of one committed player GLB. Both, because the
 *  animation assertions below read the keyframes themselves. */
async function readPlayerGlb(body: string): Promise<{ json: GltfJson; bin: Uint8Array }> {
  const bytes = await readFile(new URL(`${body}.glb`, OUTPUT));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
  ) as GltfJson;
  // glTF 2.0 §4.4: the chunks follow the header in order, each with its own length and type,
  // and the binary chunk starts after this one's eight-byte header.
  const binStart = 20 + jsonLength + 8;
  return { json, bin: bytes.subarray(binStart, binStart + view.getUint32(20 + jsonLength, true)) };
}

/** One accessor's floats, out of the GLB's binary chunk: the view's offset into the chunk plus
 *  the accessor's own, for `count` elements of the accessor's component count. Enough of a
 *  reader for the `FLOAT` keys and times here, and independent of any glTF library (`NodeIO`
 *  cannot read these files back at all — their materials point at texture files by relative
 *  URI, which is the same reason the shape tests read the JSON chunk by hand). */
function accessorFloats(
  glb: { json: GltfJson; bin: Uint8Array },
  index: number,
): Float32Array<ArrayBuffer> {
  const accessor = glb.json.accessors[index];
  const view = glb.json.bufferViews[accessor?.bufferView ?? -1];
  if (!accessor || !view) throw new Error(`No accessor ${String(index)} in this GLB.`);
  const start = glb.bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return new Float32Array(
    glb.bin.buffer as ArrayBuffer,
    start,
    accessor.count * (COMPONENT_COUNTS[accessor.type] ?? 1),
  );
}

/** Every node's parent, for the one walk below: a glTF file stores the graph as child lists. */
function parentIndexes(json: GltfJson): Map<number, number> {
  const parents = new Map<number, number>();
  for (const [parent, node] of json.nodes.entries())
    for (const child of node.children ?? []) parents.set(child, parent);
  return parents;
}

/** One node's world translation, composed from the file's own node graph — the TRS chain a
 *  loader builds, computed here so the orientation assertion below is independent of any
 *  reader's own maths. */
function worldTranslation(json: GltfJson, index: number): vec3 {
  const parents = parentIndexes(json);
  const chain: number[] = [];
  for (let at: number | undefined = index; at !== undefined; at = parents.get(at)) chain.push(at);
  let world = mat4.create();
  for (const nodeIndex of chain.reverse()) {
    const node = json.nodes[nodeIndex];
    const rotation = node?.rotation ?? [0, 0, 0, 1];
    const translation = node?.translation ?? [0, 0, 0];
    const local = mat4.fromRotationTranslation(
      mat4.create(),
      quat.fromValues(rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!),
      vec3.fromValues(translation[0]!, translation[1]!, translation[2]!),
    );
    world = mat4.multiply(mat4.create(), world, local);
  }
  return vec3.fromValues(world[12]!, world[13]!, world[14]!);
}

/** The index of a node by name: the names are what the clips target, so every assertion here
 *  goes through them rather than through an index. */
function nodeIndexNamed(json: GltfJson, name: string): number {
  return json.nodes.findIndex((node) => node.name === name);
}

/** One channel's two accessors: the shared timebase and the values, as the file stores them. */
function channelKeys(
  glb: { json: GltfJson; bin: Uint8Array },
  animation: NonNullable<GltfJson['animations']>[number],
  channel: NonNullable<GltfJson['animations']>[number]['channels'][number],
): { times: Float32Array<ArrayBuffer>; values: Float32Array<ArrayBuffer> } {
  const sampler = animation.samplers[channel.sampler];
  return {
    times: accessorFloats(glb, sampler?.input ?? -1),
    values: accessorFloats(glb, sampler?.output ?? -1),
  };
}

/** Every key of a rotation channel is a unit quaternion: `Quat16` decodes to within a rounding
 *  step of one and the emitter normalizes it, so a wrong `S16` scale factor or a missing
 *  normalization shows up here as a length far from one. */
function expectUnitQuaternions(values: Float32Array<ArrayBuffer>): void {
  for (let at = 0; at + 3 < values.length; at += 4) {
    const length = Math.hypot(values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!);
    expect(length).toBeCloseTo(1, 5);
  }
}

async function cacheExists(): Promise<boolean> {
  try {
    await stat(CACHE);
    return true;
  } catch {
    return false;
  }
}

/** One channel's sampler lines its values up with its keys: one *element* per key, of the width
 *  the target path needs (`VEC4` for a rotation, `VEC3` for a translation), over `SCALAR` times.
 *
 *  This is the check three.js needs, not a formality: it divides the two element counts to get
 *  a track's `valueSize`, so a track whose output holds fewer elements than its input holds
 *  keys gives it a fractional stride that its mixer walks forever
 *  (`PropertyMixer.saveOriginalState`, `three.core.js`) instead of playing the clip — which is
 *  what a two-element output over an eleven-key input did to the IFL-marker clips, whose single
 *  held value has to be written once per key for exactly this reason. */
function expectSamplerMatchesKeys(
  glb: { json: GltfJson },
  animation: NonNullable<GltfJson['animations']>[number],
  channel: NonNullable<GltfJson['animations']>[number]['channels'][number],
): void {
  const sampler = animation.samplers[channel.sampler];
  if (!sampler) throw new Error(`A channel of \`${animation.name ?? ''}\` has no sampler.`);
  const input = glb.json.accessors[sampler.input];
  const output = glb.json.accessors[sampler.output];
  expect(input?.type).toBe('SCALAR');
  expect(input?.count ?? 0).toBeGreaterThan(1);
  expect(output?.count).toBe(input?.count);
  expect(output?.type).toBe(channel.target.path === 'rotation' ? 'VEC4' : 'VEC3');
}

/** Every clip the body's file carries is a real animation of this shape: named nodes, and
 *  samplers whose keys hold values rather than an empty accessor — a clip with no keys plays
 *  nothing, which is the exact failure a mis-addressed keyframe array would produce. */
function expectClipsAnimateNodes(glb: { json: GltfJson }, nodeNames: (string | undefined)[]): void {
  for (const animation of glb.json.animations ?? []) {
    expect(animation.samplers.length).toBeGreaterThan(0);
    for (const channel of animation.channels) {
      expect(nodeNames[channel.target.node]).toBeDefined();
      expectSamplerMatchesKeys(glb, animation, channel);
    }
  }
}

/** The published `forward` clip of `light_male` together with the fixture sequence it was
 *  converted from. The fixture is committed beside this test, so the clip is compared against
 *  the keys it came from rather than against the emitter that wrote them. Throws when either
 *  half is missing, which is the assertion: a body without its clip, or a fixture without its
 *  sequence, is a broken conversion rather than a test to skip. */
async function forwardClip(): Promise<{
  glb: { json: GltfJson; bin: Uint8Array };
  animation: NonNullable<GltfJson['animations']>[number];
  source: DtsSequence;
}> {
  const glb = await readPlayerGlb('light_male');
  const animation = glb.json.animations?.find((item) => item.name === 'forward');
  const source = parseDsq(new Uint8Array(await readFile(FORWARD_FIXTURE))).sequences[0];
  if (!animation || !source) throw new Error('light_male.glb has no `forward` clip to check.');
  return { glb, animation, source };
}

describe('player body glbs', () => {
  for (const body of PLAYER_BODIES) {
    it(`publishes ${body.body} with the biped hierarchy and its clips`, async () => {
      const glb = await readPlayerGlb(body.body);
      const nodeNames = glb.json.nodes.map((node) => node.name);
      // One glTF node per DTS node, in the shape's own order, under the basis node every
      // shape in this repository hangs its roots from.
      expect(nodeNames[0]).toBe('TorqueModelSpace');
      for (const name of BIPED_NODES) expect(nodeNames).toContain(name);
      // The node layer is exactly the shape's node table, in order, after the basis node; the
      // objects' own nodes (one per drawn object, named after it — `Submesh_pelvis` and the
      // rest) follow it, which is why this is a prefix assertion.
      if (body.body === 'light_male')
        expect(nodeNames.slice(0, LIGHT_NODES.length + 1)).toEqual([
          'TorqueModelSpace',
          ...LIGHT_NODES,
        ]);
      expect(nodeNames.length).toBeGreaterThan(BIPED_NODES.length);
      // The meshes are the body's own: detail level 0 of the shape, whose objects each draw
      // one mesh, through the body's own materials.
      expect(glb.json.meshes.length).toBeGreaterThan(0);
      expect(glb.json.materials.length).toBeGreaterThan(0);

      const clips = (glb.json.animations ?? []).map((animation) => animation.name ?? '');
      for (const clip of [...REQUIRED_CLIPS, ...(BODY_ONLY_CLIPS[body.body] ?? [])])
        expect(clips).toContain(clip);
      expect(clips.some((clip) => clip.startsWith('die'))).toBe(true);
      // A body is published with the clips the mirror ships for it and no others, plus the two
      // the shape file carries itself — the IFL material markers `player-sources.ts` notes
      // (light and medium spell their jet-flare marker differently, so they are listed per
      // body rather than assumed shared).
      expect(clips.slice().sort()).toEqual(
        [...(SHAPE_CLIPS[body.body] ?? []), ...body.clips].sort(),
      );
      expectClipsAnimateNodes(glb, nodeNames);
    });
  }

  it('lands the biped facing +Z, the direction the client steers every model by', async () => {
    // The client orients a model with `rotation.y = yaw` and no offset of its own, which
    // requires the model to face +Z in glTF (the vehicles do: `vehicle_shrike`'s `Eye` sits at
    // +Z with its `Jetnozzle0` behind at -Z). The biped is authored with Torque's +X forward
    // and Torque's +Y left, and the basis `(-x, z, y)` maps that left axis onto glTF's +Z, so
    // the face lands forward — but only the emitted file can say so, so it is asserted here
    // rather than assumed. Eye is the head's forward reference and Jetnozzle0 the jetpack's
    // rear one, which makes the pair a front/back discriminator, not just a forward one.
    for (const body of PLAYER_BODIES) {
      const { json } = await readPlayerGlb(body.body);
      const eye = worldTranslation(json, nodeIndexNamed(json, 'Eye'));
      const nozzle = worldTranslation(json, nodeIndexNamed(json, 'Jetnozzle0'));
      expect(eye[2]).toBeGreaterThan(0.1);
      expect(nozzle[2]).toBeLessThan(-0.1);
    }
  });

  it('emits light_male’s forward clip over the source file’s own channels and timebase', async () => {
    // The end-to-end check on the merge: `light_male_forward.dsq` is the fixture `dsq.test.ts`
    // parses, and this is the clip the build publishes from it. The fixture's own membership
    // sets say how many channels the clip must have, its duration says how long the sampler
    // runs, and its keyframe count says how many samples each channel carries — for the cyclic
    // clip this is, one more than the file's count, because the emitter wraps the cycle with a
    // final key at `duration` (`sequenceTimes`). A merge that dropped a member, mis-based a
    // key list or dropped the cycle would move at least one of those three.
    const { glb, animation, source } = await forwardClip();
    expect(source.cyclic).toBe(true);
    const paths = animation.channels.map((channel) => channel.target.path);
    expect(paths.filter((path) => path === 'rotation')).toHaveLength(source.rotationMatters.length);
    expect(paths.filter((path) => path === 'translation')).toHaveLength(
      source.translationMatters.length,
    );
    for (const channel of animation.channels) {
      const { times } = channelKeys(glb, animation, channel);
      expect(times).toHaveLength(source.numKeyframes + 1);
      expect(times.at(-1)).toBeCloseTo(source.duration, 5);
    }
  });

  it('decodes forward’s keys as unit quaternions that move between samples', async () => {
    // `Quat16` decodes to within a rounding step of a unit quaternion and the emitter
    // normalizes it, so a wrong `S16` scale factor or a missing normalization shows up as a
    // key length far from one; and the clip's first rotation channel has to differ between its
    // first two samples, which is what tells an addressed key apart from a held one.
    const { glb, animation } = await forwardClip();
    const rotations = animation.channels.filter((channel) => channel.target.path === 'rotation');
    for (const channel of rotations)
      expectUnitQuaternions(channelKeys(glb, animation, channel).values);
    const keys = channelKeys(glb, animation, rotations[0]!).values;
    expect(Array.from(keys.slice(0, 4))).not.toEqual(Array.from(keys.slice(4, 8)));
  });
});

/** The material names one body's shape draws at detail level 0 that the texture manifest
 *  cannot resolve — the exact failure `attachShapeTextures` raises during a build, where it
 *  throws on a material whose resource has no source. */
function unresolvedMaterials(body: PlayerBody, shape: DtsShape): string[] {
  const missing: string[] = [];
  const detail = shape.detailLevels[0];
  for (const object of shape.objects) {
    const mesh = shape.meshes[object.startMeshIndex + (detail?.objectDetailNum ?? 0)];
    for (const primitive of mesh?.primitives ?? []) {
      const material = shape.materials[primitive.materialIndex];
      if (!material) continue;
      const key = material.name.replaceAll('\\', '/').toLowerCase();
      if (!(key in textureSources)) missing.push(`${body.body}: ${material.name}`);
    }
  }
  return missing;
}

/** Why one clip file cannot stand in for the clip its name promises, or null when it can. The
 *  clip a body publishes from a file is the file's *last* sequence: that is the one
 *  `TSShapeConstructor::onAdd` renames (`ts/tsShapeConstruct.cc:104-116`) and the one the build
 *  passes the suffix to. It has to be a real animation — an empty sequence emits no clip at
 *  all, which is how `medium_male_idlepda.dsq`'s leading one-keyframe, memberless `Root` drops
 *  out of that body's clip list. */
function clipProblem(body: string, clip: string, dsq: DsqFile): string | null {
  const sequence = dsq.sequences.at(-1);
  if (!sequence) return `${body}_${clip}: no sequence`;
  if (sequence.numKeyframes < 2) return `${body}_${clip}: ${String(sequence.numKeyframes)} keys`;
  if (sequence.rotationMatters.length === 0) return `${body}_${clip}: no rotation members`;
  return null;
}

describe('player clip sources', () => {
  it('resolves every material the bodies draw to a texture the build can attach', async () => {
    if (!(await cacheExists())) return;
    const missing: string[] = [];
    for (const body of PLAYER_BODIES) {
      const shape = parseDts(
        new Uint8Array(await readFile(new URL(playerShapeSource(body), CACHE))),
      );
      missing.push(...unresolvedMaterials(body, shape));
    }
    expect(missing).toEqual([]);
  });

  it('reads every clip the manifest names, including the file that holds two sequences', async () => {
    if (!(await cacheExists())) return;
    const problems: string[] = [];
    for (const body of PLAYER_BODIES) {
      for (const clip of body.clips) {
        const bytes = new Uint8Array(await readFile(new URL(playerClipSource(body, clip), CACHE)));
        const problem = clipProblem(body.body, clip, parseDsq(bytes));
        if (problem) problems.push(problem);
      }
    }
    expect(problems).toEqual([]);
  });
});
