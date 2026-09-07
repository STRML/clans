import { describe, expect, it, vi } from 'vitest';
import { loadInteriorColliders } from './interior-collision.js';

describe('loadInteriorColliders', () => {
  it('builds one InteriorInstance per scene interior placement', async () => {
    const fetchCollision = vi.fn(async () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const assets = {
      scene: {
        interiors: [
          {
            shape: 'sbunk2',
            position: [5, 0, 0] as [number, number, number],
            rotation: { axis: [0, 1, 0] as [number, number, number], degrees: 0 },
          },
        ],
      },
    } as never;
    const instances = await loadInteriorColliders(assets, fetchCollision);
    expect(instances).toHaveLength(1);
    expect(fetchCollision).toHaveBeenCalledWith('sbunk2');
  });
});
