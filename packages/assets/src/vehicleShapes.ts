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

export async function convertVehicleShape(
  glbUrl: string,
  stlUrl: string,
): Promise<VehicleShapeResult> {
  const glb = await tryFetch(glbUrl);
  if (glb) return { source: 'glb', bytes: glb };

  // Full STL -> glb triangle conversion is deferred: this tier is not exercised
  // by the real Katabatic build this milestone, since the glb tier already
  // resolves for both vehicles (see the plan's Task 11 numbers table). Return
  // the raw STL bytes so callers/tests can observe that the fallback happened.
  const stl = await tryFetch(stlUrl);
  if (stl) return { source: 'stl', bytes: stl };

  return { source: 'procedural', bytes: null };
}
