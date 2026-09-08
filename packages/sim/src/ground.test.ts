import { describe, expect, it } from 'vitest';
import { buildInteriorCollider, createWorld, type Heightfield } from './index.js';
import { groundHeightAt } from './ground.js';

const terrain: Heightfield = {
  gridSize: 2,
  squareSize: 10,
  originX: 0,
  originY: 0,
  originZ: 10,
  heightScale: 1,
  heights: new Uint16Array(4),
  emptySquares: new Set([0]),
};

describe('groundHeightAt', () => {
  it('finds an interior floor below removed terrain, but not above the object', () => {
    const world = createWorld(terrain, 1);
    world.interiors = [
      buildInteriorCollider(
        {
          positions: new Float32Array([
            0, -10, 0, 10, -10, 0, 10, -10, 10, 0, -10, 0, 10, -10, 10, 0, -10, 10,
          ]),
        },
        { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } },
      ),
    ];
    expect(groundHeightAt(world, { x: 5, y: -5, z: 5 })).toBe(-10);
    expect(groundHeightAt(world, { x: 5, y: -10, z: 5 })).toBe(-10);
    expect(groundHeightAt(world, { x: 5, y: -15, z: 5 })).toBeNull();
  });

  it('keeps solid terrain available for penetration correction', () => {
    const world = createWorld({ ...terrain, emptySquares: new Set() }, 1);
    expect(groundHeightAt(world, { x: 5, y: -5, z: 5 })).toBe(0);
  });
});
