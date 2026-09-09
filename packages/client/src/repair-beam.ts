import * as THREE from 'three';
import { BaseObjectKind, REPAIR_BEAM_RANGE, type RepairTargetInfo } from '@clans/sim';

// packs/repairpack.cs's DefaultRepairBeam: the heal beam is green (the same family as the
// T2 repair disc), and slim -- a repair tool, not a weapon tracer.
const REPAIR_BEAM_COLOR = 0x33ff66;
const CORE_RADIUS = 0.05;
const UP = new THREE.Vector3(0, 1, 0);

/** Static kind -> feedback label. BaseObjectKind's own enum names are wire-stable ids, so a
 *  plain Record keyed by the numeric kind is the whole lookup -- no per-frame branching. */
const BASE_OBJECT_LABEL: Record<number, string> = {
  [BaseObjectKind.Generator]: 'Generator',
  [BaseObjectKind.Sensor]: 'Sensor',
  [BaseObjectKind.StationInventory]: 'Inventory Station',
  [BaseObjectKind.StationVehiclePad]: 'Vehicle Pad',
  [BaseObjectKind.ForceField]: 'Force Field',
};

export function repairTargetLabel(target: RepairTargetInfo): string {
  if (target.kind === 'baseObject') {
    return BASE_OBJECT_LABEL[target.baseObjectKind ?? -1] ?? 'Structure';
  }
  if (target.kind === 'turret') return 'Turret';
  if (target.kind === 'vehicle') return 'Vehicle';
  return 'Player';
}

export interface RepairBeamStatusInput {
  /** Pack trigger held this frame (after the pack/alive/menu/free-cam gates). */
  held: boolean;
  /** The beam is actually live: held, energized, and pointed at a valid target. */
  active: boolean;
  /** 0-1 share of the armor energy pool left (the pool the beam fires out of). */
  energyFraction: number;
  target: RepairTargetInfo | null;
}

/** The feedback row under the crosshair: target/range/energy feedback while the trigger is
 *  held (issue #51). Empty string when the player is not holding the pack at all -- silence
 *  is the resting state, distinct from a held-but-invalid aim. */
export function repairBeamStatusText(input: RepairBeamStatusInput): string {
  if (!input.held) return '';
  if (!input.target) return `NO TARGET · REPAIR RANGE ${String(REPAIR_BEAM_RANGE)} m`;
  const label = repairTargetLabel(input.target);
  const health = Math.round(input.target.healthFraction * 100);
  const distance = input.target.distance.toFixed(1);
  if (!input.active) {
    // Held on a live target but the energy pool is dry: depletion is its own stop reason.
    return `ENERGY DEPLETED · ${label} ${String(health)}% · ${distance} m`;
  }
  const energy = Math.round(input.energyFraction * 100);
  return `REPAIRING ${label} ${String(health)}% · ${distance} m · ENERGY ${String(energy)}%`;
}

/** Minimal feedback surface app.ts backs with a real DOM node (created next to the
 *  crosshair); a plain object satisfies it in tests, where node has no document. */
export interface RepairBeamFeedback {
  textContent: string;
  hidden: boolean;
}

export interface RepairBeamView {
  /** Shows the beam stretched origin→point while a target is given; hides it otherwise.
   *  Passing null is the stop path (release, occlusion, range, depletion, death, menu). */
  sync(target: RepairTargetInfo | null): void;
  dispose(): void;
}

/** The repair beam's rendering path (issue #51). Unlike the one-shot laser Effect, a repair
 *  beam lives exactly as long as the trigger is held, so it is one persistent object whose
 *  endpoints move in place each frame -- no per-frame geometry or material allocation, and
 *  no ttl-driven Effect churn. Same dispose-everything hygiene as weapons-view.ts's meshes:
 *  the line and core each own geometry and material created just for them. */
export function createRepairBeamView(scene: THREE.Scene): RepairBeamView {
  const positions = new Float32Array(6);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    color: REPAIR_BEAM_COLOR,
    transparent: true,
    opacity: 0.9,
  });
  const line = new THREE.Line(lineGeometry, lineMaterial);
  const coreGeometry = new THREE.CylinderGeometry(CORE_RADIUS, CORE_RADIUS, 1, 6, 1, true);
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: REPAIR_BEAM_COLOR,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const core = new THREE.Mesh(coreGeometry, coreMaterial);
  const group = new THREE.Group();
  group.name = 'repair-beam';
  group.add(line, core);
  group.visible = false;
  scene.add(group);

  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  const direction = new THREE.Vector3();

  return {
    sync(target) {
      if (!target) {
        group.visible = false;
        return;
      }
      start.set(target.origin.x, target.origin.y, target.origin.z);
      end.set(target.point.x, target.point.y, target.point.z);
      positions[0] = start.x;
      positions[1] = start.y;
      positions[2] = start.z;
      positions[3] = end.x;
      positions[4] = end.y;
      positions[5] = end.z;
      (lineGeometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
      direction.copy(end).sub(start);
      const length = direction.length();
      if (length > 0) {
        core.scale.set(1, length, 1);
        core.position.copy(start).add(end).multiplyScalar(0.5);
        core.quaternion.setFromUnitVectors(UP, direction.normalize());
      }
      group.visible = true;
    },
    dispose() {
      scene.remove(group);
      lineGeometry.dispose();
      lineMaterial.dispose();
      coreGeometry.dispose();
      coreMaterial.dispose();
    },
  };
}
