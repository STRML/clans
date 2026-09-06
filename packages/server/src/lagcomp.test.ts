import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createWorld,
  removePlayer,
  respawnPlayer,
  stepWorld,
  type Heightfield,
} from '@clans/sim';
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

// A 3x3 grid of points (2x2 squares): every corner is 0 except the very last one, so
// square (col0,row0) -- (x, z) in [0,10] x [10,20] -- is perfectly flat (normal straight
// up), while square (col1,row1) -- (x, z) in [10,20] x [0,10] -- ramps up to height 90 at
// its (20, 0) corner. Used to prove a rewound *position* drags a steep, wrong terrain
// normal into stepWorld's ground-contact physics for a player who never actually left the
// flat square (Codex PR #9 round 3, P1 finding 1).
const bumpySquareSize = 10;
const bumpy: Heightfield = {
  gridSize: 3,
  squareSize: bumpySquareSize,
  originX: 0,
  originY: 0,
  originZ: 20,
  heightScale: 1,
  heights: Uint16Array.from([0, 0, 0, 0, 0, 0, 0, 0, 90]),
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
    // capacity 4: ticks 0-1 fell off, so the oldest kept sample is tick 2 -- a request for
    // tick 0 asks for history older than anything kept, and must come back null rather than
    // clamping to that oldest sample (Codex review round 7, P2).
    expect(positionAtTick(history, id, 0)).toBeNull();
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

    // A rewind target before that first sample has no coverage at all -- with clearHistory
    // in place there's no stale trail to clamp onto, and round 7's fix (positionAtTick
    // rejects a sample newer than the requested tick) means it also no longer clamps to the
    // new occupant's own first sample; it returns null for "no evidence" either way.
    expect(positionAtTick(history, newPlayer, world.tick - 1)).toBeNull();
    // The sample that does exist at tick 10 is the new occupant's own, not a stale one.
    expect(positionAtTick(history, newPlayer, world.tick)?.z).toBe(10);
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

describe('rewinding a position before stepWorld corrupts everything else it touches (Codex PR #9 round 3, P1 finding 1)', () => {
  // Both tests share this setup: a player resting exactly on the ground, holding no keys,
  // once at their TRUE position (flat square, normal straight up) and once at a recorded
  // HISTORICAL position (the far corner of the sloped square). Idle input makes applyRun a
  // no-op in both cases, so any velocity change comes only from applyGround's slope-gravity
  // term -- which depends on nothing but the terrain normal under the player's feet.
  const truePosition = { x: 1, y: 0, z: 19 }; // deep in the flat square: height 0, normal (0,1,0)
  const historicalPosition = { x: 19, y: 81, z: 1 }; // deep in the sloped square, on the ramp

  it('documents the bug: stepWorld run against a rewound position leaves a lasting velocity that restoring position afterward never undoes', () => {
    const world = createWorld(bumpy, 1);
    const bystander = addPlayer(world, truePosition);
    const history = createPositionHistory();
    // This player really was standing at historicalPosition a few ticks ago.
    history.samples.set(bystander, [{ tick: 0, ...historicalPosition }]);
    world.tick = 5; // "a few ticks ago": targetTick below lands exactly on the tick-0 sample

    // The exact pattern net.ts used to run: rewind first, run the FULL simulation against
    // the rewound position, restore position afterward -- and nothing else.
    const handle = rewindOthers(world, history, [], 5);
    stepWorld(world, new Map());
    restorePositions(world, handle);

    // Position is back to normal...
    expect(world.players.position[bystander * 3]).toBeCloseTo(truePosition.x);
    expect(world.players.position[bystander * 3 + 2]).toBeCloseTo(truePosition.z);
    // ...but velocity was computed against the sloped terrain at historicalPosition, and
    // restorePositions has no way to know that needed undoing too: a player who never left
    // flat ground now carries a slope-induced push that will move them next tick.
    expect(world.players.velocity[bystander * 3 + 1]).toBeLessThan(-0.1);
    expect(world.players.velocity[bystander * 3 + 2]).toBeGreaterThan(0.01);
  });

  it('the fix: stepWorld always runs against the true position, so no rewind can leave this residue', () => {
    const world = createWorld(bumpy, 1);
    const bystander = addPlayer(world, truePosition);

    // No rewind before or during stepWorld -- this is what net.ts's runOneTick does now.
    stepWorld(world, new Map());

    // Flat ground, idle, resting: velocity is untouched, exactly.
    expect(world.players.velocity[bystander * 3]).toBe(0);
    expect(world.players.velocity[bystander * 3 + 1]).toBe(0);
    expect(world.players.velocity[bystander * 3 + 2]).toBe(0);
  });
});

describe('clearHistory on respawn (Codex PR #9 round 3, P1 finding 2)', () => {
  it("drops a respawned player's pre-death trail so a shot arriving right after finds nothing to rewind onto", () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory();
    // The corpse's trail: this player's position right before dying.
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 500], id * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    // net.ts's respawnDuePlayers calls respawnPlayer then clearHistory, in that order, for
    // every id dueForRespawn reports each tick -- reproduced directly here since
    // respawnDuePlayers itself isn't exported.
    respawnPlayer(world, id, { x: 0, y: 0, z: 10 }); // the fresh spawn point
    clearHistory(history, id); // the fix

    world.tick = 6; // shortly after respawn, well within the ~1s history window
    // No sample recorded yet since the respawn -- a shot arriving now has nothing to
    // rewind this id onto at all. rewindOthers excludes this id from the recheck entirely
    // rather than substituting its current position (Codex review round 6, P2 -- see the
    // "rewindOthers excludes a player with no history sample" describe block below).
    expect(positionAtTick(history, id, world.tick - 1)).toBeNull();
  });

  it('without clearing on respawn, a shot shortly after respawn still finds the corpse (documents the bug)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory();
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 500], id * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    respawnPlayer(world, id, { x: 0, y: 0, z: 10 });
    // No clearHistory call: reproduces the pre-fix behavior.

    world.tick = 6;
    const sample = positionAtTick(history, id, world.tick - 1);
    expect(sample?.z).toBe(500); // the corpse's old position, not the new spawn's
  });
});

describe('rewindOthers excludes a player with no history sample (Codex review round 6, P2)', () => {
  it('deactivates a no-history player instead of leaving them targetable at their current position', () => {
    const world = createWorld(flat, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 });
    // A player who just respawned this same tick: clearHistory already ran (or, as here,
    // no sample was ever recorded), so positionAtTick has nothing to hand back for them.
    const target = addPlayer(world, { x: 5, y: 0, z: 5 });
    const history = createPositionHistory();
    world.tick = 10;

    const handle = rewindOthers(world, history, [shooter], 5);

    // The old, buggy fallback left the target both active and at their current position --
    // exactly what let a lag-compensated recheck see a freshly-respawned player standing at
    // their spawn point as though that were where they had always been. The fix removes them
    // from consideration entirely: `isValidTarget` (@clans/sim) requires `players.active`.
    expect(world.players.active[target]).toBe(0);
    expect(handle.deactivated).toEqual([target]);
    // Position itself is untouched (nothing to rewind it to); only eligibility changes.
    expect(world.players.position[target * 3]).toBe(5);
    expect(world.players.position[target * 3 + 2]).toBe(5);

    restorePositions(world, handle);
    expect(world.players.active[target]).toBe(1); // reactivated once the recheck is done
  });

  it('still rewinds a player who does have a history sample, unaffected by the no-history path', () => {
    const world = createWorld(flat, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 });
    const target = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory();
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, step], target * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    world.players.position.set([0, 0, 100], target * 3);
    world.tick = 10;

    const handle = rewindOthers(world, history, [shooter], 5);

    expect(handle.deactivated).toEqual([]);
    expect(world.players.active[target]).toBe(1);
    expect(world.players.position[target * 3 + 2]).toBe(4); // newest sample at or before tick 5

    restorePositions(world, handle);
    expect(world.players.position[target * 3 + 2]).toBe(100);
  });
});

describe('positionAtTick rejects a sample newer than the requested tick (Codex review round 7, P2)', () => {
  it('excludes a just-respawned player from rewindOthers instead of rewinding them onto their current, post-respawn position', () => {
    const world = createWorld(flat, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 });
    const target = addPlayer(world, { x: 0, y: 0, z: 500 }); // pre-respawn corpse trail
    const history = createPositionHistory();
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 500], target * 3);
      world.tick = step;
      recordHistory(history, world);
    }

    // Respawn clears the trail -- net.ts's respawnDuePlayers calls respawnPlayer then
    // clearHistory, in that order, reproduced directly here as in the round-3 block above.
    respawnPlayer(world, target, { x: 0, y: 0, z: 10 });
    clearHistory(history, target);

    // Exactly one fresh post-respawn sample gets recorded, on the very next tick.
    world.tick = 6;
    recordHistory(history, world);

    // A laggy shooter's rewind window reaches back further than that one fresh sample: there
    // is still no evidence of where this player was at tick 4, only where they are now (tick
    // 6). The oldest -- and only -- kept sample is newer than the requested tick, so this
    // must come back null rather than clamping to it.
    expect(positionAtTick(history, target, 4)).toBeNull();

    const handle = rewindOthers(world, history, [shooter], 2); // targetTick = world.tick - 2 = 4
    // Pre-fix, positionAtTick fell back to the one post-respawn sample it had (tick 6, z=10)
    // instead of recognizing tick 4 isn't covered, so rewindOthers treated the
    // freshly-respawned player as legitimately rewound to exactly where they now stand --
    // letting a shot the live simulation correctly missed still land right after respawn.
    expect(world.players.active[target]).toBe(0);
    expect(handle.deactivated).toEqual([target]);
    expect(world.players.position[target * 3 + 2]).toBe(10); // untouched: nothing to rewind to

    restorePositions(world, handle);
    expect(world.players.active[target]).toBe(1);
  });
});
