import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, removePlayer, type Heightfield } from '@clans/sim';
import {
  clearHistory,
  createPositionHistory,
  positionAtTick,
  recordHistory,
  restorePositions,
  rewindOthers,
} from './lagcomp.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('recordHistory and positionAtTick', () => {
  it('keeps a bounded per-player ring buffer and finds the newest sample at or before a tick', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory(4);
    for (let step = 0; step < 6; step += 1) {
      world.players.position.set([step, 0, 0], id * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    expect(positionAtTick(history, id, 0)?.x).toBe(2); // capacity 4: ticks 0-1 fell off
    expect(positionAtTick(history, id, 3)?.x).toBe(3);
    expect(positionAtTick(history, id, 100)?.x).toBe(5); // clamps to the newest sample
  });

  it('returns null for a player with no recorded history', () => {
    const history = createPositionHistory();
    expect(positionAtTick(history, 9, 0)).toBeNull();
  });
});

describe('rewindOthers and restorePositions', () => {
  it('moves every non-excluded player back in time, then restores them exactly', () => {
    const world = createWorld(flat, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 });
    const target = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory();
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, step], target * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    world.players.position.set([0, 0, 100], target * 3); // moved far away since
    world.tick = 10;
    const handle = rewindOthers(world, history, [shooter], 5); // rewind to tick 5
    expect(world.players.position[target * 3 + 2]).toBe(4); // newest sample at or before tick 5
    expect(world.players.position[shooter * 3 + 2]).toBe(0); // excluded: untouched
    restorePositions(world, handle);
    expect(world.players.position[target * 3 + 2]).toBe(100); // back to its true current position
  });
});

describe('clearHistory', () => {
  it("drops a reused id's trail so a new occupant does not inherit the old one's rewind history", () => {
    // Codex PR #9 round 2, finding 7: recordHistory only forgets an inactive id the next
    // time it runs for every currently-active player. An id reused before any tick ever
    // ran while it was inactive skips that cleanup entirely, so without an explicit clear
    // on disconnect the new occupant's history list still carries the old occupant's
    // stale samples alongside its own.
    const world = createWorld(flat, 1);
    const oldPlayer = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory();
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 500], oldPlayer * 3); // the old occupant's trail
      world.tick = step;
      recordHistory(history, world);
    }
    removePlayer(world, oldPlayer);
    clearHistory(history, oldPlayer); // the fix: clear immediately on disconnect

    // Immediate id reuse, with no recordHistory call running in between while the id was
    // inactive -- the exact window recordHistory's own lazy cleanup cannot cover.
    const newPlayer = addPlayer(world, { x: 0, y: 0, z: 10 });
    expect(newPlayer).toBe(oldPlayer); // freeIds is LIFO: the freed slot is reused first
    world.tick = 10;
    recordHistory(history, world); // the new occupant's first-ever recorded sample

    // A rewind target close to but before that first sample would, without the fix,
    // clamp to the old occupant's stale trail instead of finding nothing meaningful yet.
    const sample = positionAtTick(history, newPlayer, world.tick - 1);
    expect(sample?.z).toBe(10);
  });

  it("without clearing, a reused id inherits the old occupant's stale position (documents the bug)", () => {
    const world = createWorld(flat, 1);
    const oldPlayer = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory();
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 500], oldPlayer * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    removePlayer(world, oldPlayer);
    // No clearHistory call here: reproduces the pre-fix behavior.

    const newPlayer = addPlayer(world, { x: 0, y: 0, z: 10 });
    expect(newPlayer).toBe(oldPlayer);
    world.tick = 10;
    recordHistory(history, world);

    const sample = positionAtTick(history, newPlayer, world.tick - 1);
    expect(sample?.z).toBe(500); // the old occupant's location, not the new one's
  });
});
