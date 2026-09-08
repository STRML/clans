import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  addPlayer,
  buildInteriorCollider,
  createWorld,
  raycastInteriors,
  stepWorld,
  type Heightfield,
  type PlayerInput,
} from './index.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

const idle: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  jet: false,
  fire: false,
  altFire: false,
  slot: 0,
  packActive: false,
  use: false,
};

function lowCeiling(height: number): Float32Array {
  return new Float32Array([
    -10,
    height,
    -10,
    10,
    height,
    10,
    10,
    height,
    -10,
    -10,
    height,
    -10,
    -10,
    height,
    10,
    10,
    height,
    10,
  ]);
}

function inputMap(id: number, input: Partial<PlayerInput>) {
  return new Map([[id, { ...idle, ...input }]]);
}

describe('movement under interior ceilings', () => {
  it('keeps a jumping and jetting player below a low ceiling and preserves strafe', () => {
    const world = createWorld(flat, 1);
    world.interiors = [
      buildInteriorCollider(
        { positions: lowCeiling(3) },
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        },
      ),
    ];
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    let maxY = -Infinity;
    for (let tick = 0; tick < 40; tick += 1) {
      stepWorld(world, inputMap(id, { jump: tick === 0, jet: true, moveX: 1 }));
      maxY = Math.max(maxY, world.players.position[id * 3 + 1] ?? -Infinity);
    }

    // Light armor's chest sphere has radius 0.6. The chest must stay below the roof by
    // that radius, with a small tolerance for fixed-tick integration.
    expect(maxY).toBeLessThanOrEqual(3 - 1.7 - 0.6 + 1e-3);
    expect(world.players.position[id * 3]).toBeLessThan(-0.05);
    expect(world.players.position[id * 3 + 1]).toBeLessThan(3 - 1.7 - 0.6 + 1e-3);
    expect(Number.isFinite(world.players.position[id * 3 + 1])).toBe(true);
  });

  it('does not cross the roof of the real Katabatic bunker collider', () => {
    const bytes = readFileSync(
      new URL('../../../assets/out/katabatic/collision/sbunk2.collision.bin', import.meta.url),
    );
    const positions = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const world = createWorld(flat, 1);
    world.interiors = [
      buildInteriorCollider(
        { positions },
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        },
      ),
    ];
    // At local x=20,z=0, sbunk2 has a floor and roof. Seed the player one metre below the
    // roof, then cross the chest plane at high speed in one tick to exercise the ordinary
    // swept collision path against real Katabatic geometry.
    const roof = raycastInteriors(world.interiors, { x: 20, y: 9, z: 0 }, { x: 0, y: 1, z: 0 }, 5);
    expect(roof).not.toBeNull();
    const roofY = roof?.point.y ?? 0;
    const id = addPlayer(world, { x: 20, y: roofY - 1.7 - 1, z: 0 });
    world.players.velocity[id * 3 + 1] = 60;
    world.players.wasGrounded[id] = 0;
    stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.position[id * 3 + 1]).toBeLessThanOrEqual(roofY - 1.7 - 0.6 + 1e-3);
    for (let tick = 0; tick < 8; tick += 1) {
      stepWorld(world, inputMap(id, { jet: true }));
      expect(world.players.position[id * 3 + 1]).toBeLessThanOrEqual(roofY - 1.7 - 0.6 + 1e-3);
    }
    const startX = world.players.position[id * 3] ?? 20;
    for (let tick = 0; tick < 30; tick += 1)
      stepWorld(world, inputMap(id, { jet: true, moveX: 1 }));
    const escapedX = world.players.position[id * 3] ?? startX;
    expect(Math.abs(escapedX - startX)).toBeGreaterThan(0.05);
    for (let tick = 0; tick < 45; tick += 1) stepWorld(world, inputMap(id, {}));
    expect(world.players.onGround[id]).toBe(1);
    expect(Number.isFinite(world.players.position[id * 3 + 1])).toBe(true);
  });

  it('keeps an ordinary jump and held jet below the real Katabatic bunker roof', () => {
    const bytes = readFileSync(
      new URL('../../../assets/out/katabatic/collision/sbunk2.collision.bin', import.meta.url),
    );
    const positions = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const world = createWorld(flat, 1);
    world.interiors = [
      buildInteriorCollider(
        { positions },
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        },
      ),
    ];
    const roof = raycastInteriors(world.interiors, { x: 20, y: 9, z: 0 }, { x: 0, y: 1, z: 0 }, 5);
    const floor = raycastInteriors(
      world.interiors,
      { x: 20, y: 9, z: 0 },
      { x: 0, y: -1, z: 0 },
      10,
    );
    expect(roof).not.toBeNull();
    expect(floor).not.toBeNull();
    const roofY = roof?.point.y ?? 0;
    const floorY = floor?.point.y ?? 0;
    const id = addPlayer(world, { x: 20, y: floorY, z: 0 });
    let maxY = floorY;
    for (let tick = 0; tick < 45; tick += 1) {
      stepWorld(world, inputMap(id, { jump: tick === 0, jet: true }));
      maxY = Math.max(maxY, world.players.position[id * 3 + 1] ?? -Infinity);
    }
    expect(maxY).toBeLessThanOrEqual(roofY - 1.7 - 0.6 + 1e-3);
    expect(world.players.onGround[id]).toBe(0);
  });

  it('recovers when a prior sweep left the chest exactly on the roof plane', () => {
    const world = createWorld(flat, 1);
    world.interiors = [
      buildInteriorCollider(
        { positions: lowCeiling(3) },
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        },
      ),
    ];
    const id = addPlayer(world, { x: 0, y: 1.3, z: 0 });
    world.players.velocity[id * 3 + 1] = 1;
    world.players.wasGrounded[id] = 0;
    stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.position[id * 3 + 1]).toBeLessThanOrEqual(3 - 1.7 - 0.6 + 1e-3);
  });
});
