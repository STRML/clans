import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeShape, loadShapeInto } from './shape-loader.js';
import {
  IFL_FRAME_LISTS,
  IFL_TICKS_PER_SECOND,
  bindIflPlayback,
  iflFrameKey,
  iflFramesFor,
  withVisibility,
} from './shape-animation.js';

afterEach(() => vi.restoreAllMocks());

/** One Laser Rifle indicator mesh bound the way the exported GLB presents it: node
 * extras carry the sequence binding, material.userData the exporter's material extras. */
function iflMesh(sequence: string, duration: number, cyclic: number): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  material.userData.flag_names = ['SelfIlluminating', 'Translucent', 'Additive', 'IflMaterial'];
  material.userData.resource_path = 'skins\\lite_red';
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  mesh.userData.ifl_sequence = sequence;
  mesh.userData.ifl_duration = duration;
  mesh.userData.ifl_cyclic = cyclic;
  return mesh;
}
it('disposes shared geometry, materials, and textures exactly once', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture });
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const spies = [geometry, texture, material].map((resource) => vi.spyOn(resource, 'dispose'));
  disposeShape(root);
  for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  expect(root.children).toHaveLength(0);
});

it('disposes a late load instead of attaching it to a despawned vehicle', () => {
  const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
  const root = new THREE.Group();
  loadShapeInto(root, 'vehicle_wildcat');
  disposeShape(root);
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  const dispose = vi.spyOn(mesh.geometry, 'dispose');
  load.mock.calls[0]![1]({ scene } as never);
  expect(dispose).toHaveBeenCalledOnce();
  expect(root.children).toHaveLength(0);
});

it('restores additive DTS glow blending without solid white surfaces or depth occlusion', () => {
  const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
  const root = new THREE.Group();
  loadShapeInto(root, 'weapon_sniper');
  const material = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  material.userData.flag_names = ['SelfIlluminating', 'Translucent', 'Additive'];
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
  load.mock.calls[0]![1]({ scene } as never);
  expect(material.blending).toBe(THREE.AdditiveBlending);
  expect(material.transparent).toBe(true);
  expect(material.depthWrite).toBe(false);
  disposeShape(root);
});

describe('original IFL texture-sequence playback', () => {
  it('advances an Ambient indicator through the authored lite_red frame sequence', () => {
    // lite_red.ifl: lite_red0 holds 10 ticks, the blink run 2 ticks each, then the long
    // 47-tick lite_red0 hold -- at 30 Hz the first texture change lands at 10/30 s.
    const root = new THREE.Group();
    const mesh = iflMesh('Ambient', 1, 1);
    root.add(mesh);
    const clip = withVisibility(root, [new THREE.AnimationClip('ambient', 1, [])])[0]!;
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    expect(mesh.userData.ifl.frame).toBe(0);
    mixer.update(10 / IFL_TICKS_PER_SECOND - 1e-9);
    expect(mesh.userData.ifl.frame).toBe(0); // tick 9 is the last tick of frame 0
    mixer.update(1 / IFL_TICKS_PER_SECOND);
    expect(mesh.userData.ifl.frame).toBe(1);
    // The track is discrete: between authored boundaries the value holds, never blends.
    mixer.update(1.5 / IFL_TICKS_PER_SECOND); // lands inside the 12..14-tick window
    expect(mesh.userData.ifl.frame).toBe(2);
    mixer.uncacheRoot(root);
  });

  it('advances the real lite_red table through successive decoded frame textures', () => {
    // The tick math above is exercised against the real table, but a viewer never sees
    // an index: it sees material.map change. Decode-equivalent textures stand in for the
    // PNGs the asset build commits under iflFrameKey (one per authored frame), so the
    // applier has to select a different texture at each authored boundary.
    const resource = 'skins/lite_red';
    const entries = IFL_FRAME_LISTS[resource]!;
    const totalTicks = entries.reduce((sum, [, ticks]) => sum + ticks, 0);
    const root = new THREE.Group();
    const mesh = iflMesh('Ambient', totalTicks / IFL_TICKS_PER_SECOND, 1);
    root.add(mesh);
    bindIflPlayback(mesh);
    const material = mesh.material as THREE.MeshStandardMaterial;
    const frames = iflFramesFor(resource);
    expect(frames).toHaveLength(entries.length);
    const decoded = entries.map(() => new THREE.Texture());
    decoded.forEach((texture, index) => {
      frames[index] = texture;
    });
    const clip = withVisibility(root, [new THREE.AnimationClip('ambient', 1, [])])[0]!;
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    const render = (): void => {
      mesh.onBeforeRender(
        {} as never,
        new THREE.Scene(),
        {} as never,
        mesh.geometry,
        material,
        new THREE.Group(),
      );
    };
    render();
    expect(material.map).toBe(decoded[0]);
    // lite_red.ifl holds lite_red0 for its first 10 ticks, so the map is unchanged at 9.
    mixer.update(10 / IFL_TICKS_PER_SECOND - 1e-9);
    render();
    expect(material.map).toBe(decoded[0]);
    // Tick 10 crosses into lite_red1's 2-tick run: a different texture, not a blend.
    mixer.update(1 / IFL_TICKS_PER_SECOND);
    render();
    expect(material.map).toBe(decoded[1]);
    expect(decoded[1]).not.toBe(decoded[0]);
    mixer.update(1.5 / IFL_TICKS_PER_SECOND); // inside the second entry's 12..14-tick window
    render();
    expect(material.map).toBe(decoded[2]);
    mixer.uncacheRoot(root);
  });

  it('wraps a cyclic list and clamps a one-shot list per the source sequence definition', () => {
    // No shipped binding is shorter than its list, so exercise both ends of Torque's
    // matFrame rule (wrap when cyclic, clamp when not) on a synthetic two-tick list.
    IFL_FRAME_LISTS['test/loop'] = [
      ['loop_a', 1],
      ['loop_b', 1],
    ];
    try {
      for (const cyclic of [1, 0]) {
        const root = new THREE.Group();
        const mesh = iflMesh('Power', 0.2, cyclic);
        (mesh.material as THREE.MeshStandardMaterial).userData.resource_path = 'test/loop';
        root.add(mesh);
        const clip = withVisibility(root, [new THREE.AnimationClip('power', 0.2, [])])[0]!;
        const mixer = new THREE.AnimationMixer(root);
        const action = mixer.clipAction(clip);
        if (cyclic) action.setLoop(THREE.LoopRepeat, Infinity);
        else {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        action.play();
        // The cyclic action runs past its end and wraps back to tick 0's entry; the
        // one-shot runs into its clamped end and holds the final entry (entry 1).
        mixer.update(cyclic ? 0.2 + 1 / IFL_TICKS_PER_SECOND : 0.2);
        expect(mesh.userData.ifl.frame).toBe(cyclic ? 0 : 1);
        mixer.uncacheRoot(root);
      }
    } finally {
      delete IFL_FRAME_LISTS['test/loop'];
    }
  });

  it('swaps material.map only for decoded frames and keeps the last frame while a file is missing', () => {
    // The loading fallback stays honest: until a frame texture actually decodes the
    // material keeps its previous map, and non-IflMaterial materials are never touched.
    const root = new THREE.Group();
    const mesh = iflMesh('Ambient', 1, 1);
    root.add(mesh);
    bindIflPlayback(mesh);
    const material = mesh.material as THREE.MeshStandardMaterial;
    const firstFrame = new THREE.Texture();
    const blinkFrame = new THREE.Texture();
    iflFramesFor('skins/lite_red')[0] = firstFrame;
    iflFramesFor('skins/lite_red')[1] = blinkFrame;
    const renderScene = new THREE.Scene();
    const render = (): void => {
      mesh.onBeforeRender(
        {} as never,
        renderScene,
        {} as never,
        mesh.geometry,
        material,
        new THREE.Group(),
      );
    };
    render();
    expect(material.map).toBe(firstFrame);
    mesh.userData.ifl.frame = 1;
    render();
    expect(material.map).toBe(blinkFrame);
    mesh.userData.ifl.frame = 2;
    iflFramesFor('skins/lite_red')[2] = null; // frame file absent
    render();
    expect(material.map).toBe(blinkFrame);
    const plain = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    bindIflPlayback(plain);
    expect(plain.onBeforeRender).toBe(THREE.Mesh.prototype.onBeforeRender);
  });

  it('binds playback when a shape loads and agrees with the manifest first-frame mapping', async () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    const root = new THREE.Group();
    loadShapeInto(root, 'weapon_sniper');
    const scene = new THREE.Group();
    scene.add(iflMesh('Ambient', 1, 1));
    load.mock.calls[0]![1]({ scene } as never);
    const mesh = scene.children[0] as THREE.Mesh;
    expect(mesh.userData.ifl).toEqual({ frame: 0 });
    expect(mesh.onBeforeRender).not.toBe(THREE.Mesh.prototype.onBeforeRender);

    // The transcription's frame 0 must be the exact bitmap texture-sources.json already
    // ships for the material (the manifest/decode path is the source of frame 1).
    const manifest = JSON.parse(
      await readFile(new URL('../../assets/src/texture-sources.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    for (const [resource, entries] of Object.entries(IFL_FRAME_LISTS)) {
      const shipped = manifest[resource];
      if (!shipped) throw new Error(`missing manifest entry for IFL resource: ${resource}`);
      // Eleven of twelve materials resolve frame 1 exactly; light_red alone pins a
      // mid-sequence frame (light_red01) where the .ifl file's first line is light_red06
      // -- the exporter resolved that material's static frame from its initial matFrame,
      // not from line 1. The binding invariant that matters: the manifest frame is a
      // member of the authored sequence, so the shipped PNG is always a real frame of it.
      const stem = shipped
        .split('/')
        .pop()!
        .replace(/\.[a-z]+$/i, '')
        .toLowerCase();
      const authored = new Set(entries.map(([frame]) => frame));
      expect(authored.has(stem), resource).toBe(true);
      // Frame 0 loads under the manifest key (always exported); later frames under
      // iflFrameKey once the asset build copies them.
      expect(iflFrameKey(resource, entries[1]![0]), resource).toBe(
        `${resource.split('/')[0]}/${entries[1]![0]}`,
      );
    }
    disposeShape(root);
  });

  it('commits an 8-bit PNG under the frame key the driver loads for every authored frame', async () => {
    // Issue #53: playback stays on frame 0 unless the remaining frames of each sequence
    // exist on disk. The asset build copies them from the cached skins.vl2 mirror under
    // iflFrameKey, so every frame of the real table must resolve to a committed file.
    const manifest = JSON.parse(
      await readFile(new URL('../../assets/src/texture-sources.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    const checked = new Set<string>();
    for (const [resource, entries] of Object.entries(IFL_FRAME_LISTS)) {
      for (const [frame] of entries) {
        const key = iflFrameKey(resource, frame);
        if (checked.has(key)) continue;
        checked.add(key);
        // The build copies out/textures/<key>.png from this manifest entry, so a key
        // missing here means the file can never ship.
        expect(key in manifest, key).toBe(true);
        const bytes = await readFile(
          new URL(`../../../assets/out/katabatic/textures/${key}.png`, import.meta.url),
        );
        // PNG signature, then IHDR: the mirror's bitmaps are 8 bits per channel and the
        // build copies them verbatim, so the bit-depth byte at offset 24 stays <= 8.
        expect([...bytes.subarray(0, 8)], key).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(bytes[24]!, key).toBeLessThanOrEqual(8);
      }
    }
  });
});
