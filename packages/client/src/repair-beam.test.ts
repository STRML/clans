import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BaseObjectKind, type RepairTargetInfo } from '@clans/sim';
import {
  createRepairBeamView,
  repairBeamStatusText,
  repairTargetLabel,
  type RepairBeamStatusInput,
} from './repair-beam.js';

const eye = { x: 0, y: 1.6, z: 0 };
const targetPoint = { x: 5, y: 1, z: 0 };

function targetInfo(overrides: Partial<RepairTargetInfo> = {}): RepairTargetInfo {
  return {
    kind: 'baseObject',
    id: 0,
    distance: 5.02,
    origin: eye,
    point: targetPoint,
    healthFraction: 0.4,
    baseObjectKind: BaseObjectKind.Generator,
    ...overrides,
  };
}

function statusInput(overrides: Partial<RepairBeamStatusInput> = {}): RepairBeamStatusInput {
  return { held: true, active: true, energyFraction: 0.78, target: targetInfo(), ...overrides };
}

describe('repairTargetLabel', () => {
  it('names base assets by their kind, turrets, vehicles and players', () => {
    expect(repairTargetLabel(targetInfo())).toBe('Generator');
    expect(repairTargetLabel(targetInfo({ baseObjectKind: BaseObjectKind.StationInventory }))).toBe(
      'Inventory Station',
    );
    // Non-base kinds never read baseObjectKind, so the default key is simply ignored.
    expect(repairTargetLabel(targetInfo({ kind: 'turret' }))).toBe('Turret');
    expect(repairTargetLabel(targetInfo({ kind: 'vehicle' }))).toBe('Vehicle');
    expect(repairTargetLabel(targetInfo({ kind: 'player' }))).toBe('Player');
  });

  it('falls back to Structure for a base kind the label table does not name', () => {
    expect(repairTargetLabel(targetInfo({ baseObjectKind: 255 }))).toBe('Structure');
  });
});

describe('repairBeamStatusText', () => {
  it('is empty while the pack trigger is not held', () => {
    expect(repairBeamStatusText(statusInput({ held: false, target: null }))).toBe('');
  });

  it('reports target, health, range and energy while repairing', () => {
    const text = repairBeamStatusText(statusInput());
    expect(text).toContain('REPAIRING Generator');
    expect(text).toContain('40%');
    expect(text).toContain('5.0 m');
    expect(text).toContain('ENERGY 78%');
  });

  it('reports depletion as its own state while still holding on a valid target', () => {
    const text = repairBeamStatusText(statusInput({ active: false }));
    expect(text).toContain('ENERGY DEPLETED');
    expect(text).toContain('Generator');
    expect(text).not.toContain('REPAIRING');
  });

  it('reports the beam range when held without a valid target', () => {
    const text = repairBeamStatusText(statusInput({ active: false, target: null }));
    expect(text).toContain('NO TARGET');
    expect(text).toContain('10 m');
  });
});

describe('createRepairBeamView', () => {
  it('shows a stretched beam between the target origin and point while active', () => {
    const scene = new THREE.Scene();
    const view = createRepairBeamView(scene);
    const beam = scene.getObjectByName('repair-beam');
    expect(beam).toBeDefined();
    expect(beam!.visible).toBe(false);
    view.sync(targetInfo());
    expect(beam!.visible).toBe(true);
    const line = beam!.children[0] as THREE.Line;
    // Float32 storage rounds 1.6 slightly, so compare componentwise with tolerance.
    const positions = line.geometry.getAttribute('position').array as Float32Array;
    expect(positions[0]).toBeCloseTo(eye.x);
    expect(positions[1]).toBeCloseTo(eye.y);
    expect(positions[2]).toBeCloseTo(eye.z);
    expect(positions[3]).toBeCloseTo(targetPoint.x);
    expect(positions[4]).toBeCloseTo(targetPoint.y);
    expect(positions[5]).toBeCloseTo(targetPoint.z);
    // The core cylinder spans the full eye-to-target length.
    const core = beam!.children[1] as THREE.Mesh;
    expect(core.scale.y).toBeCloseTo(Math.hypot(5, -0.6));
    view.dispose();
  });

  it('hides instead of removing on stop, so the next hold reuses the same object', () => {
    const scene = new THREE.Scene();
    const view = createRepairBeamView(scene);
    view.sync(targetInfo());
    view.sync(null);
    const beam = scene.getObjectByName('repair-beam');
    expect(beam).toBe(scene.children[0]); // still owned by the scene, just invisible
    expect(beam!.visible).toBe(false);
    view.sync(targetInfo());
    expect(beam!.visible).toBe(true);
    view.dispose();
  });

  it('dispose removes the beam from the scene and frees its GPU resources', () => {
    const scene = new THREE.Scene();
    const view = createRepairBeamView(scene);
    const beam = scene.getObjectByName('repair-beam')!;
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    beam.traverse((node) => {
      if (node instanceof THREE.Line || node instanceof THREE.Mesh) {
        geometries.push(node.geometry);
        materials.push(node.material as THREE.Material);
      }
    });
    const geoSpies = geometries.map((geo) => vi.spyOn(geo, 'dispose'));
    const matSpies = materials.map((mat) => vi.spyOn(mat, 'dispose'));
    view.dispose();
    expect(scene.children).toHaveLength(0);
    for (const spy of geoSpies) expect(spy).toHaveBeenCalled();
    for (const spy of matSpies) expect(spy).toHaveBeenCalled();
  });

  it('stays visible-safe when asked to draw a zero-length beam', () => {
    const scene = new THREE.Scene();
    const view = createRepairBeamView(scene);
    expect(() => view.sync(targetInfo({ origin: eye, point: eye }))).not.toThrow();
    expect(scene.getObjectByName('repair-beam')!.visible).toBe(true);
    view.dispose();
  });
});
