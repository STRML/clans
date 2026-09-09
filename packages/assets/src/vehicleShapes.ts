export interface VehicleShapeResult {
  source: 'glb' | 'stl' | 'procedural';
  bytes: Uint8Array | null;
}

// Matches fetch.ts's own error-handling style: a non-ok response and a thrown
// error both count as "this tier failed", not a crash.
async function tryFetch(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

export async function convertVehicleShape(glbUrl: string): Promise<VehicleShapeResult> {
  const glb = await tryFetch(glbUrl);
  if (glb) return { source: 'glb', bytes: glb };

  // Issue #29 (PR #23 review round 2, finding 8): this function used to fetch the raw
  // .stl source here and return those bytes under source: 'stl', but no consumer can
  // render them — build.ts writes a shape result straight to its .glb output path and
  // the client hands that file to GLTFLoader, which cannot parse STL data; the loader's
  // failure is swallowed and the procedural placeholder stays up anyway. Only
  // prepareVehicleAsset's discard guard kept those bytes out of the published asset, so
  // the fetch bought nothing but a guaranteed-discarded network round trip. Skip the
  // tier explicitly and fall through to the procedural tier, which is what rendered
  // regardless. 'stl' deliberately remains in the VehicleShapeResult union (and
  // prepareVehicleAsset keeps defending against it) for the day a real STL -> glb
  // converter lands; neither Katabatic vehicle exercises this path today — both resolve
  // the glb tier from the fetch.ts cache.
  return { source: 'procedural', bytes: null };
}
