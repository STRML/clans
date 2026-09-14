import * as THREE from 'three';

// Design-spec environment bullet: "snow particles". Katabatic is a snow map, so the
// scene carries a lightweight precip field mounted from terrain.ts's addEnvironment.
// T2 rendered snowfall via precipitation objects whose bitmap came from
// textures/precip.dml (game/data base); no such bitmap is committed under
// assets/out/katabatic (only terrain.IceWorld.* and textures/{ice,lava,skins}),
// so we generate a small radial-gradient flake sprite on a canvas instead.
//
// Density/rate, pinned here and asserted in snow.test.ts / e2e/snow.spec.ts:
// Katabatic snowfall reads as moderate — a light dusting that never obscures
// sightlines — so 320 flakes inside a 60 m × 40 m × 60 m box centered on the
// camera is the ballpark (T2-era precipitation boxes were sized against the
// visible distance, wrapping flakes that fall out or drift behind the camera
// back to the top / opposite face; flakes never accumulate behind the camera
// beyond the box bounds because the box itself rides the camera).
export const SNOW_FLAKE_COUNT = 320;
export const SNOW_BOX_WIDTH = 60;
export const SNOW_BOX_HEIGHT = 40;
export const SNOW_BOX_DEPTH = 60;
// Fall rate and wind drift in m/s. T2's precipitationData fell in the single-digit
// m/s range for snow (rain ran faster); 6 m/s down with a slight 1.2/0.5 m/s
// cross-wind gives the lazy Katabatic drift without looking like rain.
export const SNOW_FALL_SPEED = 6; // m/s
export const SNOW_WIND_X = 1.2; // m/s
export const SNOW_WIND_Z = 0.5; // m/s

// Deterministic PRNG (mulberry32) so per-flake phase/speed jitter is reproducible
// from the seed; the per-frame update is a pure function of (dt, camera position,
// current state) — no wall-clock reads inside the math.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrap(value: number, half: number): number {
  const size = half * 2;
  return ((((value + half) % size) + size) % size) - half;
}

export interface SnowField {
  points: THREE.Points;
  /**
   * Advance the simulation. Deterministic: same seed + same (dt, camera) sequence
   * yields the same flake positions. dt is clamped so a tab-background pause does
   * not teleport flakes through the wrap box.
   */
  update(dt: number, cameraPosition: THREE.Vector3): void;
}

// 32×32 radial-gradient canvas sprite: opaque white core fading to transparent —
// reads as a soft round flake at distance. Skipped under node (unit tests have no
// canvas); a plain white point reads identically through the vitest math asserts.
function createFlakeTexture(): THREE.Texture | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.8)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createSnowField(seed = 1337): SnowField {
  const random = mulberry32(seed);
  const positions = new Float32Array(SNOW_FLAKE_COUNT * 3);
  // Per-flake jitter (fall-speed and wind multipliers) drawn once from the seed;
  // stored outside the per-frame loop so the update allocates nothing.
  const fallJitter = new Float32Array(SNOW_FLAKE_COUNT);
  const windJitter = new Float32Array(SNOW_FLAKE_COUNT);
  for (let i = 0; i < SNOW_FLAKE_COUNT; i += 1) {
    positions[i * 3] = (random() - 0.5) * SNOW_BOX_WIDTH;
    positions[i * 3 + 1] = (random() - 0.5) * SNOW_BOX_HEIGHT;
    positions[i * 3 + 2] = (random() - 0.5) * SNOW_BOX_DEPTH;
    fallJitter[i] = 0.8 + random() * 0.4; // 0.8×–1.2× fall speed
    windJitter[i] = 0.5 + random(); // 0.5×–1.5× wind drift
  }
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute('position', attribute);
  const material = new THREE.PointsMaterial({
    size: 0.35,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
    opacity: 0.9,
  });
  const flakeMap = createFlakeTexture();
  if (flakeMap) material.map = flakeMap;
  const points = new THREE.Points(geometry, material);
  points.name = 'katabatic-snow';
  const halfW = SNOW_BOX_WIDTH / 2;
  const halfH = SNOW_BOX_HEIGHT / 2;
  const halfD = SNOW_BOX_DEPTH / 2;
  const update = (dt: number, cameraPosition: THREE.Vector3): void => {
    const step = Math.min(Math.max(dt, 0), 0.1);
    for (let i = 0; i < SNOW_FLAKE_COUNT; i += 1) {
      const windJ = windJitter[i] ?? 1;
      const fallJ = fallJitter[i] ?? 1;
      attribute.setX(i, wrap(attribute.getX(i) + SNOW_WIND_X * windJ * step, halfW));
      attribute.setY(i, wrap(attribute.getY(i) - SNOW_FALL_SPEED * fallJ * step, halfH));
      attribute.setZ(i, wrap(attribute.getZ(i) + SNOW_WIND_Z * windJ * step, halfD));
    }
    attribute.needsUpdate = true;
    // Ride the camera: flakes are stored box-local, so moving the object moves the
    // whole volume. Camera motion re-frames flakes via the per-axis wrap above —
    // nothing ever sits behind the camera outside the box bounds.
    points.position.copy(cameraPosition);
  };

  // Drive from the renderer instead of app.ts (owned elsewhere): Points get
  // onBeforeRender once per rendered frame, with the active camera in hand.
  let lastTime = -1;
  points.onBeforeRender = (_renderer, _scene, camera) => {
    const now = performance.now();
    if (lastTime >= 0) update(Math.min((now - lastTime) / 1000, 0.1), camera.position);
    lastTime = now;
  };

  // Deterministic handle for tests: step the field directly with a fixed dt.
  points.userData.snow = { update };
  return { points, update };
}
