import { buildInteriorCollider, type InteriorInstance, type InteriorTriangles } from '@clans/sim';
import { collisionUrl, type KatabaticAssets } from './assets.js';

type CollisionFetcher = (shape: string) => Promise<ArrayBuffer>;

async function defaultFetchCollision(shape: string): Promise<ArrayBuffer> {
  const response = await fetch(collisionUrl(shape));
  if (!response.ok) throw new Error(`Collision fetch failed ${String(response.status)}: ${shape}`);
  return response.arrayBuffer();
}

export async function loadInteriorColliders(
  assets: Pick<KatabaticAssets, 'scene'>,
  fetchCollision: CollisionFetcher = defaultFetchCollision,
): Promise<InteriorInstance[]> {
  const instances: InteriorInstance[] = [];
  for (const placement of assets.scene.interiors) {
    const buffer = await fetchCollision(placement.shape);
    const triangles: InteriorTriangles = { positions: new Float32Array(buffer) };
    instances.push(
      buildInteriorCollider(triangles, {
        position: { x: placement.position[0], y: placement.position[1], z: placement.position[2] },
        rotation: {
          axis: {
            x: placement.rotation.axis[0],
            y: placement.rotation.axis[1],
            z: placement.rotation.axis[2],
          },
          degrees: placement.rotation.degrees,
        },
      }),
    );
  }
  return instances;
}
