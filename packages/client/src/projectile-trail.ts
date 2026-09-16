import * as THREE from 'three';

/**
 * T2's projectile trail, as a position-history ribbon.
 *
 * The source presents a fast projectile partly BY its trail: `ProjectileData` mounts a
 * `particleEmitter` (disc.cs's datablock pairs it with the blue light `0.175 0.175 0.5` at
 * :350-378; the mortar's read is green smoke), and the CLIENT emits its particles along the
 * projectile's movement sampled between frames, the emitter axis derived from the inverse
 * velocity so the stream lies behind the shot (Torque's Projectile implementation;
 * modding.tribes2wiki's particle recipes). The same evidence, rendered without a particle
 * system, is the sampled path itself: this class records the RENDERED position the projectile
 * was drawn at, each frame it moved, and spans a ribbon over the consecutive samples -- the
 * envelope of exactly the region those particles would occupy -- thinning and fading toward
 * the tail the way particle lifetimes do. A per-frame sample of a position that is already
 * being interpolated per frame is the same job Torque does, at the same cadence.
 */
export const TRAIL_SAMPLES = 16; // ~250 ms of flight at 60 fps.
export const TRAIL_HEAD_WIDTH = 0.35;

/** One recorded rendered position (structurally weapons-view's own ProjectilePose). */
export interface TrailSample {
  x: number;
  y: number;
  z: number;
}

// Two flat ribbons cross at each section -- the same answer addTracerCross gives the
// tracers' glows: a single quad swings its face off the view axis, two a quarter turn apart
// never both do. Four vertices per sample.
const VERTICES_PER_SAMPLE = 4;
// Fixed connectivity: the strip is rewritten in place per movement, so the index pattern is
// built once and drawRange limits what renders.
const MAX_INDICES = (TRAIL_SAMPLES - 1) * 12;
const UP = new THREE.Vector3(0, 1, 0);
// Scratch: rebuild runs per movement per trail; these are written, never retained.
const DIRECTION = new THREE.Vector3();
const HORIZONTAL = new THREE.Vector3();
const VERTICAL = new THREE.Vector3();

export class ProjectileTrail {
  /** The world-space ribbon. Vertices are authored in the scene's frame -- they record where
   *  the projectile HAS been -- so this cannot ride the moving mesh as a child: the mesh's
   *  frame is reset to the flight pose every frame and spun (discs, 30 rad/s), which would
   *  whip a child ribbon around. The owner adds it beside the mesh and removes it with it. */
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.MeshBasicMaterial;
  /** Newest first: history[0] is the head at the projectile's rendered position. */
  private readonly history: TrailSample[] = [];
  private last: TrailSample | undefined;

  constructor(tint: number) {
    this.material = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    // Preallocated once, written in place per movement: a fresh geometry per rebuild would be
    // allocation plus GPU upload churn on every frame of flight.
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(
      new Float32Array(TRAIL_SAMPLES * VERTICES_PER_SAMPLE * 3),
      3,
    ).setUsage(THREE.DynamicDrawUsage);
    // A 4-component color attribute is vertex alpha under vertexColors: true.
    const color = new THREE.BufferAttribute(
      new Float32Array(TRAIL_SAMPLES * VERTICES_PER_SAMPLE * 4),
      4,
    ).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('color', color);
    const index = new Uint16Array(MAX_INDICES);
    let cursor = 0;
    for (let section = 0; section < TRAIL_SAMPLES - 1; section += 1) {
      for (let ribbon = 0; ribbon < 2; ribbon += 1) {
        const near = section * VERTICES_PER_SAMPLE + ribbon * 2;
        const far = near + VERTICES_PER_SAMPLE;
        index[cursor++] = near;
        index[cursor++] = far;
        index[cursor++] = near + 1;
        index[cursor++] = near + 1;
        index[cursor++] = far;
        index[cursor++] = far + 1;
      }
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'projectile-trail';
    // The vertices are world-space and the transform stays identity; the ribbon follows the
    // projectile, which frustum-culls by its own mesh, so no bounding volume is maintained.
    this.mesh.frustumCulled = false;
  }

  /** How many rendered positions the ribbon currently spans. */
  get samples(): number {
    return this.history.length;
  }

  /** Records one rendered position, newest first. Sampling is on MOVEMENT: an unchanged pose
   *  (the caller re-observing the same state -- the exact-equality reasoning weapons-view's
   *  sameFlight applies to the snapshots) is not stored, so a projectile at rest -- or frozen
   *  by interpolation's extrapolation bound -- never grows a ribbon. The cap keeps the
   *  ribbon at ~250 ms of flight at 60 fps. */
  update(pose: TrailSample): void {
    const last = this.last;
    if (last && last.x === pose.x && last.y === pose.y && last.z === pose.z) return;
    const sample = { x: pose.x, y: pose.y, z: pose.z };
    this.last = sample;
    this.history.unshift(sample);
    if (this.history.length > TRAIL_SAMPLES) this.history.pop();
    this.rebuild();
  }

  /** Releases the ribbon's own GPU resources -- the rule every owned mesh in weapons-view
   *  follows (its disposeMesh). */
  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  /** Rewrites the preallocated buffers from the history: a cross-section at each sample,
   *  ribbon vertices offset along the section's width axes, width and alpha tapering
   *  linearly from the head (newest) to the tail (oldest). */
  private rebuild(): void {
    const geometry = this.mesh.geometry;
    const count = this.history.length;
    if (count < 2) {
      geometry.setDrawRange(0, 0);
      return;
    }
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = geometry.getAttribute('color') as THREE.BufferAttribute;
    const sections = count - 1;
    for (let section = 0; section <= sections; section += 1) {
      const sample = this.history[section]!;
      const other = this.history[section + 1] ?? this.history[section - 1]!;
      DIRECTION.set(sample.x - other.x, sample.y - other.y, sample.z - other.z);
      if (DIRECTION.lengthSq() > 1e-8) {
        DIRECTION.normalize();
        // Width axes: a horizontal perpendicular to the flight line, and its cross with the
        // line itself -- the two planes a viewer can face the trail from. A straight-down
        // flight (a mortar at the end of its arc) degenerates the horizontal cross; a fixed
        // axis stands in for it.
        HORIZONTAL.crossVectors(UP, DIRECTION);
        if (HORIZONTAL.lengthSq() < 1e-8) HORIZONTAL.set(1, 0, 0);
        HORIZONTAL.normalize();
        VERTICAL.crossVectors(DIRECTION, HORIZONTAL);
      }
      const taper = 1 - section / sections;
      const half = (TRAIL_HEAD_WIDTH * taper) / 2;
      const base = section * VERTICES_PER_SAMPLE;
      position.setXYZ(
        base,
        sample.x + HORIZONTAL.x * half,
        sample.y + HORIZONTAL.y * half,
        sample.z + HORIZONTAL.z * half,
      );
      position.setXYZ(
        base + 1,
        sample.x - HORIZONTAL.x * half,
        sample.y - HORIZONTAL.y * half,
        sample.z - HORIZONTAL.z * half,
      );
      position.setXYZ(
        base + 2,
        sample.x + VERTICAL.x * half,
        sample.y + VERTICAL.y * half,
        sample.z + VERTICAL.z * half,
      );
      position.setXYZ(
        base + 3,
        sample.x - VERTICAL.x * half,
        sample.y - VERTICAL.y * half,
        sample.z - VERTICAL.z * half,
      );
      for (let vertex = base; vertex < base + VERTICES_PER_SAMPLE; vertex += 1) {
        color.setXYZW(vertex, 1, 1, 1, taper);
      }
    }
    geometry.setDrawRange(0, sections * 12);
    position.needsUpdate = true;
    color.needsUpdate = true;
  }
}
