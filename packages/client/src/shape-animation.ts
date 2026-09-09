import * as THREE from 'three';
import { assetUrl } from './assets.js';

/** DTS visibility tracks live in node extras because glTF has no visibility channel. */
export function withVisibility(
  root: THREE.Object3D,
  source: THREE.AnimationClip[],
): THREE.AnimationClip[] {
  const clips = new Map(source.map((clip) => [clip.name.toLowerCase(), clip.clone()]));
  root.traverse((node) => appendVisibilityTracks(node, clips));
  // IFL bindings come from the same node-extras channel: the exporter stores the DTS
  // sequence that animates each IflMaterial (ifl_sequence/ifl_duration/ifl_cyclic), and
  // the frame list itself is the authored .ifl transcription in IFL_FRAME_LISTS below.
  root.traverse((node) => appendIflTrack(node, clips));
  return [...clips.values()].map((clip) => {
    // Use the Float32 track endpoint so a clamped one-shot reaches its final off key.
    clip.resetDuration();
    return clip;
  });
}

type ClipMap = Map<string, THREE.AnimationClip>;

/** DTS visibility keyframes (vis_keyframes_<sequence> node extras) become boolean tracks
 * on the sequence's clip, because glTF has no visibility channel for the exporter to use. */
function appendVisibilityTracks(node: THREE.Object3D, clips: ClipMap): void {
  for (const [key, value] of Object.entries(node.userData)) {
    if (!key.startsWith('vis_keyframes_') || !Array.isArray(value)) continue;
    const name = key.slice('vis_keyframes_'.length);
    const duration = Number(node.userData[`vis_duration_${name}`]);
    if (!(duration > 0) || value.length < 2) continue;
    const clip = clips.get(name) ?? new THREE.AnimationClip(name, duration, []);
    clip.tracks.push(
      new THREE.BooleanKeyframeTrack(
        `${node.uuid}.visible`,
        value.map((_, index) => (index * duration) / (value.length - 1)),
        value.map((visibility: number) => visibility > 0),
      ),
    );
    clip.duration = Math.max(clip.duration, duration);
    clips.set(name, clip);
  }
}

/** The engine advances an IflMaterial's matFrame at 30 Hz while its sequence plays,
 * wrapping when the sequence is cyclic (t2-mapper's dtsTextures.ts: "IFL counts are 30 Hz
 * ticks"). Key k carries the entry that holds from its tick onward -- three's discrete
 * sampler shows the left key on exact boundaries -- so the texture change the engine
 * renders at tick N is keyed at N / 30 s. */
export function iflTrackSamples(
  entries: Array<[string, number]>,
  duration: number,
  cyclic: boolean,
): { times: number[]; values: number[] } {
  const totalTicks = entries.reduce((sum, [, ticks]) => sum + ticks, 0);
  const ends: number[] = [];
  for (const [, ticks] of entries) ends.push((ends[ends.length - 1] ?? 0) + ticks);
  const entryAt = (tick: number): number => {
    const wrapped = cyclic ? tick % totalTicks : Math.min(tick, totalTicks - 1);
    let entry = 0;
    while (entry < ends.length && ends[entry]! <= wrapped) entry += 1;
    return entry;
  };
  const times: number[] = [];
  const values: number[] = [];
  for (let tick = 0; ; tick += 1) {
    const time = Math.min(tick / IFL_TICKS_PER_SECOND, duration);
    const entry = entryAt(tick);
    if (values.length === 0 || values[values.length - 1] !== entry) {
      times.push(time);
      values.push(entry);
    }
    if (time >= duration) break;
  }
  return { times, values };
}

/** IFL bindings come from the same node-extras channel: the exporter stores the DTS
 * sequence that animates each IflMaterial (ifl_sequence/ifl_duration/ifl_cyclic), and the
 * frame list itself is the authored .ifl transcription in IFL_FRAME_LISTS. */
function appendIflTrack(node: THREE.Object3D, clips: ClipMap): void {
  if (!(node instanceof THREE.Mesh) || typeof node.userData.ifl_sequence !== 'string') return;
  const material = Array.isArray(node.material) ? node.material.find(isIflMaterial) : node.material;
  if (!isIflMaterial(material)) return;
  const name = (node.userData.ifl_sequence as string).toLowerCase();
  const duration = Number(node.userData.ifl_duration);
  const cyclic = Number(node.userData.ifl_cyclic) > 0;
  const entries =
    IFL_FRAME_LISTS[textureKey((material.userData.resource_path as string | undefined) ?? '')];
  if (!entries || !(duration > 0)) return;
  const { times, values } = iflTrackSamples(entries, duration, cyclic);
  const clip = clips.get(name) ?? new THREE.AnimationClip(name, duration, []);
  // Initialize the frame cell before the mixer binds: PropertyBinding resolves
  // userData[ifl] at bind time and errors out if the object is absent.
  (node.userData.ifl ??= { frame: 0 }).frame = 0;
  clip.tracks.push(
    new THREE.NumberKeyframeTrack(
      `${node.uuid}.userData[ifl].frame`,
      times,
      values,
      THREE.InterpolateDiscrete,
    ),
  );
  clip.duration = Math.max(clip.duration, duration);
  clips.set(name, clip);
}

export const IFL_TICKS_PER_SECOND = 30;

function textureKey(resource: string): string {
  return resource.replaceAll('\\', '/').toLowerCase();
}

function isIflMaterial(material: THREE.Material | undefined): material is THREE.Material {
  const flags = material?.userData.flag_names as string[] | undefined;
  return Array.isArray(flags) && flags.includes('IflMaterial');
}

/**
 * The authored frame lists for every IflMaterial in the shipped shapes, transcribed from
 * the original `.ifl` files in the authoritative mirror (docs/ui-audio-reference.md:28)
 * at docs/base/@vl2/skins.vl2/textures/skins/*.ifl: each line is a bitmap name and how
 * many 30 Hz ticks it holds. Keys are textureKey-form material resource paths; frame
 * names are lowercase stems, exported (and loaded at runtime) as
 * `textures/<resource-directory>/<frame>.png` per iflFrameKey.
 */
export const IFL_FRAME_LISTS: Record<string, Array<[string, number]>> = {
  // blue00.ifl: the disc_explosion blue flash front.
  'skins/blue00': [
    ['blue00', 10],
    ['blue01', 4],
    ['blue02', 4],
    ['blue03', 3],
    ['blue04', 20],
  ],
  // disc00.ifl: the disc_explosion's expanding ring, one tick per frame.
  'skins/disc00': Array.from(
    { length: 28 },
    (_, frame) => [`disc${String(frame).padStart(2, '0')}`, 1] as [string, number],
  ),
  // greenlight.ifl: the Laser Rifle's green indicator sweep.
  'skins/greenlight': [
    ['lite_green0', 25],
    ['lite_green1', 2],
    ['lite_green2', 2],
    ['lite_green3', 2],
    ['lite_green4', 2],
    ['lite_green3', 2],
    ['lite_green2', 2],
    ['lite_green1', 2],
    ['lite_green0', 32],
    ['lite_green1', 1],
    ['lite_green2', 1],
    ['lite_green3', 1],
    ['lite_green4', 1],
    ['lite_green3', 1],
    ['lite_green2', 1],
    ['lite_green1', 1],
  ],
  // lite_red.ifl: the Laser Rifle's red indicator sweep.
  'skins/lite_red': [
    ['lite_red0', 10],
    ['lite_red1', 2],
    ['lite_red2', 2],
    ['lite_red3', 2],
    ['lite_red4', 2],
    ['lite_red3', 2],
    ['lite_red2', 2],
    ['lite_red1', 2],
    ['lite_red0', 47],
    ['lite_red1', 1],
    ['lite_red2', 1],
    ['lite_red3', 1],
    ['lite_red4', 1],
    ['lite_red3', 1],
    ['lite_red2', 1],
    ['lite_red1', 1],
  ],
  // dcase00.ifl: the Spinfusor casing flash while discSpin plays.
  'skins/dcase00': [
    ['dcase00', 21],
    ['dcase01', 1],
    ['dcase02', 1],
    ['dcase03', 1],
    ['dcase04', 1],
    ['dcase05', 1],
  ],
  // energy_muzzle00.ifl / energy_side_muzzle00.ifl: the Blaster's muzzle flash windows.
  'skins/energy_muzzle00': [
    ['enrg_frnt_muzl00', 29],
    ...Array.from(
      { length: 7 },
      (_, frame) => [`enrg_frnt_muzl${String(frame + 1).padStart(2, '0')}`, 1] as [string, number],
    ),
  ],
  'skins/energy_side_muzzle00': [
    ['enrg_side_muzl00', 29],
    ...Array.from(
      { length: 7 },
      (_, frame) => [`enrg_side_muzl${String(frame + 1).padStart(2, '0')}`, 1] as [string, number],
    ),
  ],
  // light_red.ifl: the vehicle pad's power light ramp.
  'skins/light_red': [
    ['light_red06', 10],
    ['light_red05', 2],
    ['light_red04', 2],
    ['light_red03', 2],
    ['light_red02', 2],
    ['light_red01', 2],
    ['light_red02', 2],
    ['light_red03', 2],
    ['light_red04', 2],
    ['light_red05', 2],
    ['light_red06', 10],
    ['light_red05', 1],
    ['light_red04', 1],
    ['light_red03', 1],
    ['light_red02', 1],
    ['light_red01', 1],
    ['light_red02', 1],
    ['light_red03', 1],
    ['light_red04', 1],
    ['light_red05', 1],
    ['light_red06', 10],
  ],
  // blue_blink0.ifl: the inventory station's blink light — the authored file repeats its
  // eight-entry run 21 times separated by blank lines.
  'skins/blue_blink0': repeatIflRun(
    [
      ['blue_blink0', 5],
      ['blue_blink1', 1],
      ['blue_blink2', 1],
      ['blue_blink3', 1],
      ['blue_blink4', 1],
      ['blue_blink3', 1],
      ['blue_blink2', 1],
      ['blue_blink1', 1],
    ],
    21,
  ),
  // screenstatic1.ifl: the vehicle-pad station screen static — its five-entry run
  // repeats 24 times in the authored file.
  'skins/screenstatic1': repeatIflRun(
    [
      ['screenstatic1', 1],
      ['screenstatic2', 1],
      ['screenstatic3', 1],
      ['screenstatic4', 1],
      ['screenstatic5', 1],
    ],
    24,
  ),
  // plasmaTurret.ifl: the fusion turret's barrel glow idle.
  'skins/plasmaturret': [
    ['plsre22', 50],
    ...Array.from(
      { length: 23 },
      (_, frame) => [`plsre${String(frame).padStart(2, '0')}`, 1] as [string, number],
    ),
  ],
  // jets00.ifl: vehicle jet exhaust — its six-entry run repeats 20 times.
  'skins/jets00': repeatIflRun(
    [
      ['jets00', 1],
      ['jets01', 1],
      ['jets02', 1],
      ['jets03', 1],
      ['jets04', 1],
      ['jets05', 1],
    ],
    20,
  ),
};

/** Several authored .ifl files are one short run of frames repeated a fixed number of
 * times (blank-line separated in the original). Transcribing the repetition verbatim
 * would bury the run; this reproduces it exactly while keeping the run readable. */
function repeatIflRun(run: Array<[string, number]>, times: number): Array<[string, number]> {
  return Array.from({ length: times }, () => run).flat();
}

/** The exported-filename rule for an IFL frame: the resource's directory plus the frame's
 * lowercase stem. attachShapeTextures ships frame 0 of each material from
 * texture-sources.json; the asset build copies the remaining frames under these keys so
 * bindIflPlayback can load them at runtime. */
export function iflFrameKey(resource: string, frame: string): string {
  return `${textureKey(resource).split('/')[0]}/${frame.toLowerCase()}`;
}

// One shared texture array per resource: every instance of a shape (four Laser Rifle
// indicator meshes, every pad light) reads the same decoded frames, and a frame that
// finishes loading lights up already-bound instances too. Entries stay null until their
// texture arrives — a missing frame file keeps the last map instead of fabricating a frame.
const iflFrameTextures = new Map<string, Array<THREE.Texture | null>>();

/** A seek-only animation session over a shape's clips, including the injected
 * visibility and IFL tracks. */
export interface ShapeAnimation {
  seek(name: string, seconds: number): void;
  dispose(): void;
}

/**
 * Bind a mesh's IflMaterial so the mixer-driven `userData.ifl.frame` track swaps
 * material.map at render time. Frame 0 is the map attachShapeTextures already assigned;
 * the remaining frames load asynchronously, and any that fail to load simply never enter
 * the rotation — a shape whose frame files are absent keeps its first frame, which is
 * exactly the pre-IFL presentation (the loading fallback stays honest).
 */
export function bindIflPlayback(mesh: THREE.Mesh): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const material = materials.find(isIflMaterial);
  if (!material) return;
  const resource = textureKey((material.userData.resource_path as string | undefined) ?? '');
  const entries = IFL_FRAME_LISTS[resource];
  if (!entries) return;
  let frames = iflFrameTextures.get(resource);
  if (!frames) {
    frames = entries.map(() => null);
    iflFrameTextures.set(resource, frames);
  }
  if (typeof document !== 'undefined') {
    const pending = frames;
    const loader = new THREE.TextureLoader();
    entries.forEach(([frame], index) => {
      // Every entry loads under its own frame key (the asset build exports these);
      // until a frame file exists its slot stays null and the applier keeps the
      // material's current map -- the shipped first-frame PNG, per the manifest.
      loader.load(
        assetUrl(`textures/${iflFrameKey(resource, frame)}.png`),
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          pending[index] = texture;
        },
        undefined,
        () => {}, // Missing frame file: keep the previous frame's map, as documented.
      );
    });
  }
  (mesh.userData.ifl ??= { frame: 0 }).frame = 0;
  mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
    if (!isIflMaterial(material as THREE.Material)) return;
    const entry = Math.floor(Number((mesh.userData.ifl as { frame: number }).frame) || 0);
    const texture = frames[entry];
    if (texture && (material as THREE.MeshStandardMaterial).map !== texture) {
      (material as THREE.MeshStandardMaterial).map = texture;
    }
  };
}

/** Test seam for the shared per-resource frame cache: shape-loader tests inject decoded
 * frames here to prove the applier swaps maps and that nulls keep the last frame. */
export function iflFramesFor(resource: string): Array<THREE.Texture | null> {
  let frames = iflFrameTextures.get(resource);
  if (!frames) {
    frames = (IFL_FRAME_LISTS[resource] ?? []).map(() => null);
    iflFrameTextures.set(resource, frames);
  }
  return frames;
}

/** Seek original DTS clips by simulation time, including late-loaded assets. */
export function poseShape(root: THREE.Object3D, name: string, seconds: number): void {
  const clips = root.userData.animationClips as THREE.AnimationClip[] | undefined;
  if (!clips) return;
  let animation = root.userData.shapeAnimation as ShapeAnimation | undefined;
  if (!animation) {
    animation = createAnimation(root, clips);
    root.userData.shapeAnimation = animation;
  }
  animation.seek(name, seconds);
}

function createAnimation(root: THREE.Object3D, clips: THREE.AnimationClip[]): ShapeAnimation {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map(
    withVisibility(root, clips).map((clip) => [clip.name.toLowerCase(), mixer.clipAction(clip)]),
  );
  return {
    seek(name: string, seconds: number): void {
      const action = actions.get(name.toLowerCase());
      if (!action) return;
      action.play();
      action.paused = true;
      action.time = Math.min(Math.max(0, seconds), action.getClip().duration);
      mixer.update(0);
    },
    dispose(): void {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
