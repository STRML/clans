import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addPlayer, createFlags, createWorld, FIXED_DT, type Heightfield } from '@clans/sim';
import type { FlagSnapshotData } from '@clans/protocol';
import { flagsFromWorld, syncFlagMeshes } from './flag-view.js';

const homeFlag = (id: number, team: number): FlagSnapshotData => ({
  id,
  team,
  state: 0,
  x: team * 10,
  y: 0,
  z: 0,
  carrierId: -1,
  returnInS: -1,
});

describe('syncFlagMeshes', () => {
  it('adds one group per flag, positioned at the flag, and removes it once the flag disappears', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Group>();
    syncFlagMeshes(scene, meshes, [homeFlag(0, 1), homeFlag(1, 2)]);
    expect(scene.children).toHaveLength(2);
    expect(meshes.get(0)?.position.x).toBe(10);
    syncFlagMeshes(scene, meshes, [homeFlag(1, 2)]);
    expect(scene.children).toHaveLength(1);
  });

  it('lifts a carried flag above the ground and hides its pole', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Group>();
    const carried: FlagSnapshotData = {
      id: 0,
      team: 1,
      state: 1,
      x: 3,
      y: 0,
      z: 3,
      carrierId: 5,
      returnInS: -1,
    };
    syncFlagMeshes(scene, meshes, [carried]);
    const group = meshes.get(0);
    expect(group?.position.y).toBeGreaterThan(0);
    expect(group?.getObjectByName('pole')?.visible).toBe(false);
  });

  it("fades a dropped flag over the spec's 2 s pre-return window, full opacity before it", () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Group>();
    const farFromReturn: FlagSnapshotData = {
      id: 0,
      team: 1,
      state: 2,
      x: 0,
      y: 0,
      z: 0,
      carrierId: -1,
      returnInS: 10,
    };
    syncFlagMeshes(scene, meshes, [farFromReturn]);
    const cloth = meshes.get(0)?.getObjectByName('cloth') as THREE.Mesh;
    const material = cloth.material as THREE.MeshStandardMaterial;
    expect(material.opacity).toBe(1);
    const atReturn: FlagSnapshotData = { ...farFromReturn, returnInS: 0 };
    syncFlagMeshes(scene, meshes, [atReturn]);
    expect(material.opacity).toBeCloseTo(0.25, 2);
  });
});

describe('flagsFromWorld', () => {
  it('reads flag state directly from the sim store for single-player mode', () => {
    const flat: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: new Uint16Array(4),
    };
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 100, y: 0, z: 0 } },
    ]);
    addPlayer(world, { x: 0, y: 0, z: 0 });
    const flags = flagsFromWorld(world);
    expect(flags).toHaveLength(2);
    expect(flags[1]).toMatchObject({ team: 2, x: 100 });
  });

  it('reports -1 for a flag that is home or carried, with no return timer running', () => {
    const flat: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: new Uint16Array(4),
    };
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 0, y: 0, z: 0 } }]);
    addPlayer(world, { x: 0, y: 0, z: 0 });

    expect(flagsFromWorld(world)[0]?.returnInS).toBe(-1);
  });

  it("computes returnInS from world.flags.returnAt and the current tick, the same formula the networked path (server's snapshotWorldFlag) uses, instead of always hardcoding -1 (Codex review round 6, finding P3)", () => {
    // Codex review round 6, finding P3 (PR #9): the single-player adapter used to hardcode
    // returnInS: -1 no matter what, so a single-player dropped flag never fades over its
    // final 2 s before auto-return the way the networked path (which gets returnInS from the
    // server) already does. This drops a flag by hand (setting returnAt directly, the same
    // field flags.ts's dropFlag sets) and checks the derived seconds-remaining matches the
    // exact (returnAt - tick) * FIXED_DT formula packages/server/src/net.ts's
    // snapshotWorldFlag uses for the wire snapshot.
    const flat: Heightfield = {
      gridSize: 2,
      squareSize: 1000,
      originX: 0,
      originY: 0,
      originZ: 1000,
      heightScale: 1,
      heights: new Uint16Array(4),
    };
    const world = createWorld(flat, 1);
    createFlags(world, [{ team: 1, position: { x: 0, y: 0, z: 0 } }]);
    addPlayer(world, { x: 0, y: 0, z: 0 });

    const ticksRemaining = 63; // an arbitrary in-flight return countdown, not a round number of seconds
    world.tick = 100;
    world.flags.returnAt[0] = world.tick + ticksRemaining;

    expect(flagsFromWorld(world)[0]?.returnInS).toBeCloseTo(ticksRemaining * FIXED_DT, 10);
  });
});
