import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { dtsToGlb, parseDts, type DtsShape } from './dts.js';
import { NodeIO, type Node } from '@gltf-transform/core';

/** `turret_muzzlepoint.dts` (809 bytes, version 19) and `reticle_bomber.dts` (1,448 bytes,
 *  version 22) are unmodified `base/@vl2/shapes.vl2/shapes` files from the same mirror the
 *  rest of this package's assets come from. Two of them because the reader branches on the
 *  version word — a version 19 shape has no node-scale block, no encoded normals and legacy
 *  decal fields, all of which the version 22 shape exercises the other way — and both
 *  together are smaller than one compressed screenshot. */
async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./__fixtures__/${name}`, import.meta.url)));
}

describe('parseDts', () => {
  it('reads a version 22 shape, its names, its triangles and its material', async () => {
    const shape = parseDts(await fixture('reticle_bomber.dts'));
    expect(shape.version).toBe(22);
    expect(shape.exporterVersion).toBe(122);
    expect(shape.nodes.map((node) => node.name)).toEqual(['Shape', 'Start', 'ObjectB1']);
    expect(shape.nodes.map((node) => node.parentIndex)).toEqual([-1, 0, 1]);
    expect(shape.detailLevels).toEqual([
      {
        name: 'Detail1',
        size: 1,
        subShapeNum: 0,
        objectDetailNum: 0,
        averageError: -1,
        maxError: -1,
        polyCount: 37,
      },
    ]);
    expect(shape.meshes).toHaveLength(1);
    const mesh = shape.meshes[0];
    // The mesh takes its name from the object that owns it, which the author named
    // separately from the node it renders under (`ObjectB1`).
    expect(mesh?.name).toBe('ObjectB');
    expect(shape.nodes[2]?.name).toBe('ObjectB1');
    expect(mesh?.kind).toBe('standard');
    expect(mesh?.nodeIndex).toBe(2);
    expect(mesh?.triangleCount).toBe(20);
    expect(mesh?.primitives).toHaveLength(1);
    expect(mesh?.primitives[0]?.materialIndex).toBe(0);
    // The authored texture path, which the build's attachShapeTextures resolves by name.
    expect(shape.materials).toEqual([
      {
        name: 'gui\\hud_ret_bomber',
        flags: 79,
        flagNames: ['SWrap', 'TWrap', 'Translucent', 'Additive', 'NeverEnvMap'],
      },
    ]);
    expect(shape.objects).toEqual([
      { name: 'ObjectB', numMeshes: 1, startMeshIndex: 0, nodeIndex: 2 },
    ]);
    expect(shape.subShapes).toEqual([{ firstNode: 0, numNodes: 3, firstObject: 0, numObjects: 1 }]);
  });

  it('steps over a pre-v22 sequence section to reach the material list', async () => {
    // `weapon_energy.dts` is version 21 — the only fixture older than 22 that carries
    // sequences (`turret_muzzlepoint` is version 19 with none) — and 21 is inside the
    // version window this reader claims, so it is the one sample that exercises the older
    // sequence fields: three separate Blend/Cyclic/MakePath bytes after `duration`, and no
    // stored translation/scale membership sets at all, because the engine copies
    // `rotationMatters` into `translationMatters` instead. Getting either wrong walks the
    // cursor off the sequence section, and the material list is then read from the wrong
    // offset: it used to surface as "sequence 1's rotationMatters claims 143170048 words",
    // which names the field that happens to be misread rather than the one at fault.
    const shape = parseDts(await fixture('weapon_energy.dts'));
    expect(shape.version).toBe(21);
    expect(shape.exporterVersion).toBe(121);
    expect(shape.sequenceCount).toBe(4);
    expect(shape.nodes).toHaveLength(13);
    expect(shape.detailLevels.map((detail) => detail.name)).toEqual([
      'Detail63',
      'Detail31',
      'Detail15',
      'Detail10',
      'Detail2',
    ]);
    // The material list sits after the sequences, so reaching it intact is the evidence the
    // walk landed where the engine's does.
    expect(shape.materials.map((material) => material.name)).toEqual([
      'skins\\weapon_energy',
      'skins\\weapon_energy',
      'skins\\energy_muzzle00',
      'skins\\energy_side_muzzle00',
    ]);
    expect(shape.meshes[0]?.name).toBe('Barrel');
    expect(shape.meshes[0]?.triangleCount).toBe(198);
  });

  it('reads a version 19 shape through the older container branches', async () => {
    const shape = parseDts(await fixture('turret_muzzlepoint.dts'));
    expect(shape.version).toBe(19);
    expect(shape.nodes.map((node) => node.name)).toEqual([
      'Shape',
      'Start',
      'Mountpoint',
      'Muzzlepoint',
      'Mesh1',
    ]);
    expect(shape.detailLevels.map((detail) => detail.name)).toEqual(['Detail1']);
    expect(shape.meshes.map((mesh) => mesh.triangleCount)).toEqual([1]);
    // An older shape can carry no material list at all; the mesh's single primitive then has
    // no material slot rather than a fabricated one.
    expect(shape.materials).toEqual([]);
  });

  it('rejects a version it does not implement, naming the version', async () => {
    const newer = await fixture('reticle_bomber.dts');
    new DataView(newer.buffer).setUint32(0, 24 | (122 << 16), true);
    expect(() => parseDts(newer)).toThrow(
      'Unsupported DTS version 24 (exporter 122): this reader implements versions 19..23',
    );
    const older = await fixture('reticle_bomber.dts');
    new DataView(older.buffer).setUint32(0, 12, true);
    expect(() => parseDts(older)).toThrow('Unsupported DTS version 12 (exporter 0)');
  });

  it('rejects a truncated buffer instead of parsing garbage out of it', async () => {
    const bytes = await fixture('reticle_bomber.dts');
    expect(() => parseDts(bytes.subarray(0, 400))).toThrow(/Truncated DTS/);
    expect(() => parseDts(bytes.subarray(0, 8))).toThrow(/Truncated DTS/);
    expect(() => parseDts(new Uint8Array(0))).toThrow(/Truncated DTS/);
    // Cut inside the model's own data rather than the header: the engine's guard values are
    // what catch that, and they must not be papered over.
    expect(() => parseDts(bytes.subarray(0, bytes.byteLength - 64))).toThrow(
      /Truncated DTS|out of step/,
    );
  });

  it('rejects a stream whose field order was disturbed instead of returning shifted data', async () => {
    // `numNodes` sits in the shape buffer's first dword (the file header precedes it): one
    // extra node makes every later read land elsewhere, which the engine's guard values
    // detect. The old shape's counts are still intact, so this is a pure ordering failure.
    const bytes = await fixture('reticle_bomber.dts');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setInt32(16, view.getInt32(16, true) + 1, true);
    expect(() => parseDts(bytes)).toThrow(/out of step with the engine write order/);
  });

  it('publishes the conjugate of a stored node rotation, the rotation the engine applies', async () => {
    const shape = parseDts(await fixture('weapon_energy.dts'));
    // The engine turns a stored `Quat16` into a matrix through `QuatF::setMatrix`, whose
    // `m_quatF_set_matF_C` (`math/mMath_C.cc:135`) writes the transpose of the standard
    // rotation matrix — the inverse rotation. The rotation a node actually gets is therefore
    // the conjugate of the four components in the file, and that is what a glTF node has to
    // carry: the shipped `weapon_energy.glb` agrees with the conjugate and not with the
    // stored sign, and dropping the conjugation moves every non-180-degree node.
    const barrel = shape.nodes[5];
    expect(barrel?.name).toBe('Barrel63');
    expect(barrel?.rotation[0]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(barrel?.rotation[3]).toBeCloseTo(Math.SQRT1_2, 4);
    const diagonal = shape.nodes.find((node) => node.name === 'Muzzle_Flash_Left_Diagonal_63');
    expect(diagonal?.rotation.map((value) => Number(value.toFixed(4)))).toEqual([
      -0.6091, 0.6091, 0.3592, -0.3592,
    ]);
    // A half turn is its own conjugate, so a node that rotates by 180 degrees reads the same
    // either way; that is why the sign only shows up on some nodes of a shape.
    const halfTurn = shape.nodes.find((node) => node.name === 'Muzzle_Flash_Horizontal_63');
    expect(halfTurn?.rotation[3]).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

describe('dtsToGlb', () => {
  it('round-trips through @gltf-transform/core with names, triangles and materials intact', async () => {
    const shape = parseDts(await fixture('reticle_bomber.dts'));
    const glb = dtsToGlb(shape, { name: 'reticle_bomber' });
    const document = await new NodeIO().readBinary(glb);
    const root = document.getRoot();
    // The shape's own nodes plus the one root node carrying the shipped Torque-to-glTF
    // basis; the DTS nodes keep their authored names and order beneath it, and the mesh's
    // own node follows them, named the object (`ObjectB`) rather than the node (`ObjectB1`).
    expect(root.listNodes().map((node) => node.getName())).toEqual([
      'TorqueModelSpace',
      'Shape',
      'Start',
      'ObjectB1',
      'ObjectB',
    ]);
    expect(root.listScenes()[0]?.getName()).toBe('reticle_bomber');
    const mesh = root.listMeshes()[0];
    expect(mesh?.getName()).toBe('ObjectB');
    const primitive = mesh?.listPrimitives()[0];
    expect(primitive?.getIndices()?.getCount()).toBe(60);
    expect(primitive?.getAttribute('POSITION')?.getCount()).toBe(
      primitive?.getAttribute('NORMAL')?.getCount() ?? -1,
    );
    expect(primitive?.getAttribute('POSITION')?.getCount()).toBe(
      primitive?.getAttribute('TEXCOORD_0')?.getCount() ?? -1,
    );
    const material = root.listMaterials()[0];
    expect(material?.getName()).toBe('gui\\hud_ret_bomber');
    expect(material?.getExtras()).toEqual({
      resource_path: 'gui\\hud_ret_bomber',
      flags: 79,
      flag_names: ['SWrap', 'TWrap', 'Translucent', 'Additive', 'NeverEnvMap'],
    });
    // Torque draws a translucent material without culling.
    expect(material?.getDoubleSided()).toBe(true);
  });

  it('attaches every mesh to the scene, so a loader walking from the root finds them', async () => {
    const shape = parseDts(await fixture('reticle_bomber.dts'));
    const document = await new NodeIO().readBinary(dtsToGlb(shape));
    const root = document.getRoot();
    // A document-level `listMeshes()` is not the contract. A mesh-bearing node that never
    // reaches the scene graph is still listed there while every real consumer — three's
    // GLTFLoader, and therefore `loadShapeInto` — starts at the scene's own root nodes and
    // walks down. That difference is exactly how a holder attached as its own child used to
    // detach the whole model: `Node.addChild` removes the argument from its previous parent
    // first, so the node became its own only child and vanished from its parent's list.
    const scene = root.listScenes()[0];
    const reachable = new Set<Node>();
    const walk = (node: Node): void => {
      if (reachable.has(node)) return;
      reachable.add(node);
      for (const child of node.listChildren()) walk(child);
    };
    for (const child of scene?.listChildren() ?? []) walk(child);
    const triangleCount = (nodes: Iterable<Node>): number => {
      let total = 0;
      for (const node of nodes) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        for (const primitive of mesh.listPrimitives()) {
          total += (primitive.getIndices()?.getCount() ?? 0) / 3;
        }
      }
      return total;
    };
    const documentTriangles = triangleCount(root.listNodes());
    expect(documentTriangles).toBe(shape.meshes[0]?.triangleCount);
    // Every node — the mesh's node included — hangs off the scene, and the triangles a
    // loader can actually reach are all of them rather than none.
    expect(reachable.size).toBe(root.listNodes().length);
    expect(triangleCount(reachable)).toBe(documentTriangles);
  });

  it('keeps mesh data as authored and applies the shipped basis at the scene root', async () => {
    const shape = parseDts(await fixture('reticle_bomber.dts'));
    const document = await new NodeIO().readBinary(dtsToGlb(shape));
    const material = document.getRoot().listMaterials()[0];
    expect(material?.getBaseColorTexture()).toBeNull();
    // The reticle is a flat panel authored in the XY plane, 0.09 m thick in Z. The mesh
    // accessor keeps those exact numbers — the basis change lives on the scene root, so it
    // cannot be folded into geometry here and then applied a second time by a consumer.
    const position = document.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute('POSITION');
    // Min/max recomputed from the parsed mesh: a vertex-space axis conversion or a
    // recentring anywhere between the file and the emitted accessor would move them.
    const source = shape.meshes[0]?.primitives[0]?.positions ?? new Float32Array(0);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index + 2 < source.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis] ?? 0, source[index + axis] ?? 0);
        max[axis] = Math.max(max[axis] ?? 0, source[index + axis] ?? 0);
      }
    }
    expect(position?.getMin([])).toEqual(min);
    expect(position?.getMax([])).toEqual(max);
    const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === 'ObjectB1');
    expect(node?.getTranslation()).toEqual([...shape.nodes[2]!.translation]);
    // ...and its *world* transform is the shipped basis applied to its authored chain. The
    // fixture places `Shape` at (141.00413513183594, 53.27435302734375, 0.024941444396972656)
    // and `ObjectB1` at (-141.10877990722656, -53.281307220458984, 0) with no node rotation,
    // so ObjectB1's model-space world position is (-0.104644775390625, -0.006954193115234375,
    // 0.024941444396972656); the shipped basis maps a Torque point to `(-x, z, y)`. Dropping
    // the basis, or folding it into the vertices, breaks this — and breaks every consumer,
    // which reads orientation from these world transforms.
    const world = node?.getWorldTranslation() ?? [NaN, NaN, NaN];
    expect(world[0]).toBeCloseTo(0.1046447753906251, 6);
    expect(world[1]).toBeCloseTo(0.024941444396972656, 6);
    expect(world[2]).toBeCloseTo(-0.006954193115234375, 6);
  });

  it('refuses a detail level the shape does not have', async () => {
    const shape = parseDts(await fixture('turret_muzzlepoint.dts'));
    expect(() => dtsToGlb(shape, { detailLevel: 4 })).toThrow(
      'dtsToGlb: detail level 4 does not exist; the shape has 1 (Detail1).',
    );
  });
});

describe('DtsShape shape', () => {
  it('carries the shape-level bounds and radius the engine loads', async () => {
    const shape: DtsShape = parseDts(await fixture('turret_muzzlepoint.dts'));
    expect(shape.radius).toBeCloseTo(0.0866, 4);
    expect(shape.center).toEqual([0, 0, 0.05000000074505806]);
    expect(shape.bounds).toEqual({
      min: [-0.05000000074505806, -0.05000000074505806, 0],
      max: [0.05000000074505806, 0.05000000074505806, 0.10000000149011612],
    });
  });
});
