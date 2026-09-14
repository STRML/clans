import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  SNOW_BOX_DEPTH,
  SNOW_FLAKE_COUNT,
  SNOW_BOX_HEIGHT,
  SNOW_BOX_WIDTH,
  SNOW_FALL_SPEED,
  SNOW_WIND_X,
  SNOW_WIND_Z,
  createSnowField,
} from './snow.js';

const origin = new THREE.Vector3(100, 50, -40);

describe('katabatic snow field', () => {
  it('carries the pinned Katabatic density', () => {
    // Moderate Katabatic snowfall: 320 flakes in a 60 m × 40 m × 60 m camera box.
    expect(SNOW_FLAKE_COUNT).toBe(320);
    expect(SNOW_BOX_WIDTH).toBe(60);
    expect(SNOW_BOX_HEIGHT).toBe(40);
    expect(SNOW_BOX_DEPTH).toBe(60);
  });

  it('spawns exactly SNOW_FLAKE_COUNT points inside the box', () => {
    const { points } = createSnowField(7);
    expect(points.name).toBe('katabatic-snow');
    const positions = points.geometry.getAttribute('position');
    expect(positions.count).toBe(SNOW_FLAKE_COUNT);
    for (let i = 0; i < SNOW_FLAKE_COUNT; i += 1) {
      expect(Math.abs(positions.getX(i))).toBeLessThanOrEqual(SNOW_BOX_WIDTH / 2);
      expect(Math.abs(positions.getY(i))).toBeLessThanOrEqual(SNOW_BOX_HEIGHT / 2);
      expect(Math.abs(positions.getZ(i))).toBeLessThanOrEqual(SNOW_BOX_DEPTH / 2);
    }
  });

  it('falls at the documented rate (6 m/s ± 20% jitter) with wind drift', () => {
    const { points, update } = createSnowField(42);
    const before = points.geometry.getAttribute('position');
    const x0 = before.getX(0);
    const y0 = before.getY(0);
    const z0 = before.getZ(0);
    update(0.001, origin);
    const after = points.geometry.getAttribute('position');
    const fall = y0 - after.getY(0);
    expect(fall).toBeGreaterThanOrEqual(SNOW_FALL_SPEED * 0.8 * 0.001 - 1e-6);
    expect(fall).toBeLessThanOrEqual(SNOW_FALL_SPEED * 1.2 * 0.001 + 1e-6);
    // Wind drifts +x and +z at 0.5×–1.5× the base wind; dt is small enough that
    // flake 0 cannot cross a wrap boundary mid-step for this seed.
    expect(after.getX(0) - x0).toBeGreaterThan(0);
    expect(after.getX(0) - x0).toBeLessThan(SNOW_WIND_X * 1.5 * 0.001 + 1e-6);
    expect(after.getZ(0) - z0).toBeGreaterThan(0);
    expect(after.getZ(0) - z0).toBeLessThan(SNOW_WIND_Z * 1.5 * 0.001 + 1e-6);
  });

  it('wraps flakes back into the box instead of accumulating behind the camera', () => {
    const { points, update } = createSnowField(1);
    update(120, origin); // far beyond one box height: every flake wrapped
    const positions = points.geometry.getAttribute('position');
    for (let i = 0; i < SNOW_FLAKE_COUNT; i += 1) {
      expect(Math.abs(positions.getX(i))).toBeLessThanOrEqual(SNOW_BOX_WIDTH / 2 + 1e-6);
      expect(Math.abs(positions.getY(i))).toBeLessThanOrEqual(SNOW_BOX_HEIGHT / 2 + 1e-6);
      expect(Math.abs(positions.getZ(i))).toBeLessThanOrEqual(SNOW_BOX_DEPTH / 2 + 1e-6);
    }
    // The whole volume rides the camera, so nothing is left behind at the origin.
    expect(points.position.equals(origin)).toBe(true);
  });

  it('is deterministic given dt and seed', () => {
    const a = createSnowField(99);
    const b = createSnowField(99);
    const c = createSnowField(100);
    const dt = [1 / 60, 1 / 60, 0.033, 0.05];
    for (const step of dt) {
      a.update(step, origin);
      b.update(step, origin);
      c.update(step, origin);
    }
    const pa = a.points.geometry.getAttribute('position');
    const pb = b.points.geometry.getAttribute('position');
    const pc = c.points.geometry.getAttribute('position');
    for (let i = 0; i < pa.count * 3; i += 1) {
      expect(pa.array[i]).toBe(pb.array[i]);
      expect(pa.array[i]).not.toBe(pc.array[i]);
    }
  });
});
