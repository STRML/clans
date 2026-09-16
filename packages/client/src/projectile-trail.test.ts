import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ProjectileTrail, TRAIL_HEAD_WIDTH, TRAIL_SAMPLES } from './projectile-trail.js';

// Level flight along +x at height 1: one parameter names the whole sample, the way the
// weapons-view fixtures' `disc(id, x)` does.
const at = (x: number): { x: number; y: number; z: number } => ({ x, y: 1, z: 0 });

describe('ProjectileTrail', () => {
  it('samples only on movement and caps the history', () => {
    const trail = new ProjectileTrail(0x7fa8ff);
    trail.update(at(0));
    trail.update(at(0)); // the same pose again: nothing stored
    expect(trail.samples).toBe(1);
    for (let step = 1; step <= TRAIL_SAMPLES + 3; step += 1) trail.update(at(step));
    expect(trail.samples).toBe(TRAIL_SAMPLES);
  });

  it('draws nothing until two distinct positions exist', () => {
    const trail = new ProjectileTrail(0x7fa8ff);
    trail.update(at(5));
    expect(trail.mesh.geometry.drawRange.count).toBe(0);
    trail.update(at(5)); // still stationary
    expect(trail.mesh.geometry.drawRange.count).toBe(0);
    trail.update(at(6));
    expect(trail.mesh.geometry.drawRange.count).toBe(12); // one segment, both ribbons
  });

  it('spans a crossed ribbon, widest and brightest at the head, collapsed at the tail', () => {
    const trail = new ProjectileTrail(0x7fa8ff);
    for (let step = 0; step < 4; step += 1) trail.update(at(step));
    const geometry = trail.mesh.geometry;
    const position = geometry.getAttribute('position');
    const color = geometry.getAttribute('color');
    // Four sections x four vertices written into the preallocated buffers; the drawn range
    // covers exactly the three segments x two ribbons x two triangles they fill.
    expect(position.count).toBe(TRAIL_SAMPLES * 4);
    expect(color.count).toBe(TRAIL_SAMPLES * 4);
    expect(geometry.drawRange.count).toBe(36);
    // Newest first: the head section sits at the last recorded x, the tail at the first.
    const centre = (section: number): number =>
      (position.getX(section * 4) + position.getX(section * 4 + 1)) / 2;
    expect(centre(0)).toBeCloseTo(3);
    expect(centre(3)).toBeCloseTo(0);
    // Head width is the full head width on the flat ribbon; the tail collapses to a point,
    // tapering monotonically in between.
    const span = (section: number): number =>
      Math.hypot(
        position.getX(section * 4) - position.getX(section * 4 + 1),
        position.getY(section * 4) - position.getY(section * 4 + 1),
        position.getZ(section * 4) - position.getZ(section * 4 + 1),
      );
    expect(span(0)).toBeCloseTo(TRAIL_HEAD_WIDTH);
    expect(span(1)).toBeGreaterThan(span(2));
    expect(span(3)).toBe(0);
    // The pair is crossed: on this level flight ribbon A lies flat and ribbon B stands, so
    // some viewer angle always presents the trail a face.
    expect(position.getY(0)).toBeCloseTo(position.getY(1));
    expect(position.getZ(2)).toBeCloseTo(position.getZ(3));
    // Alpha fades head -> tail monotonically, from full to gone.
    const alpha = (section: number): number => color.getW(section * 4);
    expect(alpha(0)).toBe(1);
    for (let section = 1; section < 4; section += 1) {
      expect(alpha(section)).toBeLessThan(alpha(section - 1));
    }
    expect(alpha(3)).toBe(0);
  });

  it('keeps a straight-down flight finite, where the horizontal cross degenerates', () => {
    // A mortar at the end of its arc: the horizontal width axis (up x flight) collapses, and
    // the fixed-axis fallback must keep every vertex a real position, not a NaN.
    const trail = new ProjectileTrail(0x55aa55);
    trail.update({ x: 0, y: 30, z: 0 });
    trail.update({ x: 0, y: 25, z: 0 });
    trail.update({ x: 0, y: 20, z: 0 });
    const position = trail.mesh.geometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      expect(Number.isFinite(position.getX(vertex))).toBe(true);
      expect(Number.isFinite(position.getY(vertex))).toBe(true);
      expect(Number.isFinite(position.getZ(vertex))).toBe(true);
    }
  });

  it('releases its geometry and material on dispose', () => {
    const trail = new ProjectileTrail(0x7fa8ff);
    const geometryDispose = vi.spyOn(trail.mesh.geometry, 'dispose');
    const material = trail.mesh.material as THREE.Material;
    const materialDispose = vi.spyOn(material, 'dispose');
    trail.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});
