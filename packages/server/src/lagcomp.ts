import type { World } from '@clans/sim';

// Ours: 32 ticks (~1.02 s at 32 ms/tick) comfortably covers the spec's 200 ms lag-comp cap.
const HISTORY_TICKS = 32;

export interface PositionSample {
  tick: number;
  x: number;
  y: number;
  z: number;
}
export interface PositionHistory {
  capacity: number;
  samples: Map<number, PositionSample[]>;
}

export function createPositionHistory(capacity = HISTORY_TICKS): PositionHistory {
  return { capacity, samples: new Map() };
}

export function recordHistory(history: PositionHistory, world: World): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id]) {
      history.samples.delete(id);
      continue;
    }
    const base = id * 3;
    const list = history.samples.get(id) ?? [];
    list.push({
      tick: world.tick,
      x: world.players.position[base] ?? 0,
      y: world.players.position[base + 1] ?? 0,
      z: world.players.position[base + 2] ?? 0,
    });
    if (list.length > history.capacity) list.shift();
    history.samples.set(id, list);
  }
}

/** The newest recorded sample at or before `tick`, clamped to the oldest kept sample. */
export function positionAtTick(
  history: PositionHistory,
  playerId: number,
  tick: number,
): PositionSample | null {
  const list = history.samples.get(playerId);
  if (!list || list.length === 0) return null;
  let chosen = list[0]!;
  for (const sample of list) {
    if (sample.tick > tick) break;
    chosen = sample;
  }
  return chosen;
}

export interface RewindHandle {
  saved: Array<{ id: number; x: number; y: number; z: number }>;
}

/**
 * Moves every active player except `excludeIds` back to its recorded position
 * `rewindTicks` ago, for this tick's hit resolution. `restorePositions` must run right
 * after `stepWorld`, in the same tick — see the note there for what this costs.
 */
export function rewindOthers(
  world: World,
  history: PositionHistory,
  excludeIds: readonly number[],
  rewindTicks: number,
): RewindHandle {
  const targetTick = world.tick - rewindTicks;
  const saved: RewindHandle['saved'] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || excludeIds.includes(id)) continue;
    const base = id * 3;
    saved.push({
      id,
      x: world.players.position[base] ?? 0,
      y: world.players.position[base + 1] ?? 0,
      z: world.players.position[base + 2] ?? 0,
    });
    const sample = positionAtTick(history, id, targetTick);
    if (sample) world.players.position.set([sample.x, sample.y, sample.z], base);
  }
  return { saved };
}

/**
 * Restores the true position `rewindOthers` saved. A rewound player does not advance this
 * tick — the movement `stepWorld` computed for them from the borrowed position is discarded
 * along with it. This is a known one-tick freeze for whichever players a hitscan/tracer shot
 * rewound that tick; it is invisible client-side because the server position is authoritative
 * and the very next tick moves them normally again. Accepted for this milestone, same spirit
 * as Task 3's tunneling note.
 */
export function restorePositions(world: World, handle: RewindHandle): void {
  for (const entry of handle.saved) {
    world.players.position.set([entry.x, entry.y, entry.z], entry.id * 3);
  }
}
