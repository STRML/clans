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

/**
 * Drops a player id's recorded position history immediately, e.g. on disconnect.
 * `recordHistory` already deletes an inactive id's entry, but only the next time it runs
 * for every currently-active player -- it never touches an id that has already been
 * reused by a new player before that next call. Without this, an id reused right after a
 * disconnect could get rewound onto the previous occupant's recorded trail for up to one
 * tick (Codex PR #9 round 2, finding 7).
 */
export function clearHistory(history: PositionHistory, playerId: number): void {
  history.samples.delete(playerId);
}

export function recordHistory(history: PositionHistory, world: World): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id]) {
      history.samples.delete(id);
      continue;
    }
    // A dead player doesn't move, so recording their frozen position here would just pad
    // the history with "corpse" samples. Left unfiltered, those corpse samples are still
    // within the ~1 s window by the time the id respawns, and a high-latency shooter firing
    // shortly after could rewind the new spawn back onto them (Codex PR #9 round 3, P1
    // finding 2). net.ts's respawnDuePlayers also calls clearHistory on respawn so no
    // pre-death sample -- corpse or otherwise -- survives into the new life at all; this
    // stops new ones from accumulating in the first place.
    if (!world.players.alive[id]) continue;
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
 * `rewindTicks` ago. Callers use this for a narrow, position-only recheck of a single
 * already-resolved fire event's hit-test AFTER `stepWorld` has already run to completion
 * against everyone's true position -- never to substitute positions before or during
 * `stepWorld` itself, which is what corrupted unrelated player state (energy, ammo,
 * velocity, ...) in the design this replaced (Codex PR #9 round 3, P1 finding 1).
 * `restorePositions` must run immediately after the recheck, in the same tick.
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
 * Restores the true position `rewindOthers` saved. Because the substitution now only ever
 * brackets a narrow, side-effect-free hit-test recheck run after `stepWorld` has already
 * completed against true positions, nothing else needs restoring and no tick is lost: the
 * player already moved normally this tick before their position was ever borrowed.
 */
export function restorePositions(world: World, handle: RewindHandle): void {
  for (const entry of handle.saved) {
    world.players.position.set([entry.x, entry.y, entry.z], entry.id * 3);
  }
}
