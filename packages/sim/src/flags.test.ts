import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  createWorld,
  dueForRespawn,
  respawnPlayer,
  stepWorld,
  type Heightfield,
  type PlayerInput,
} from './index.js';
import { applyDamage } from './damage.js';
import { LIGHT_ARMOR } from './armor.js';
import { createFlags, FlagState, GameOverReason, RETURN_TICKS, stepFlags } from './flags.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};
const FIXED_DT = 32 / 1000;
const stands = [
  { team: 1, position: { x: 0, y: 0, z: 0 } },
  { team: 2, position: { x: 100, y: 0, z: 0 } },
];
const idle: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  jet: false,
  fire: false,
  altFire: false,
  slot: 0,
};

describe('pickup, capture, and scoring', () => {
  it('touching the enemy flag carries it and scores +20', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Carried);
    expect(world.flags.carrierId[1]).toBe(attacker);
    expect(world.players.score[attacker]).toBe(20);
  });

  it('bringing the enemy flag home while your own flag is home captures: +30 player, +100 team', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT); // pick up
    world.players.position.set([0, 0, 0], attacker * 3);
    stepFlags(world, FIXED_DT); // capture
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.players.score[attacker]).toBe(20 + 30);
    expect(world.teamScores[1]).toBe(100);
  });

  it('game over fires at 8 captures (800 team points)', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    for (let capture = 0; capture < 8; capture += 1) {
      world.players.position.set([100, 0, 0], attacker * 3);
      stepFlags(world, FIXED_DT);
      world.players.position.set([0, 0, 0], attacker * 3);
      stepFlags(world, FIXED_DT);
    }
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1);
    expect(world.teamScores[1]).toBe(800);
  });
});

describe('failure matrix row 3: capture with own flag away is refused', () => {
  it('carrying the enemy flag at your own stand does not capture while your flag is stolen', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    const thief = addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    stepFlags(world, FIXED_DT); // team 1 steals team 2's flag
    stepFlags(world, FIXED_DT); // team 2's thief steals team 1's flag from its stand
    expect(world.flags.state[0]).toBe(FlagState.Carried);
    world.players.position.set([0, 0, 0], attacker * 3);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Carried); // no capture: flags[0] (team 1's own) is not home
    expect(world.players.score[attacker]).toBe(20); // only the touch score, no +30
    void thief;
  });
});

describe('failure matrix row 1: carrier dies, flag drops at the nearest walkable point', () => {
  it('clamps the drop Y to terrain height even if the death position was below the surface', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT); // carry
    world.players.position.set([50, -20, 50], attacker * 3); // inside/under the terrain
    applyDamage(world, attacker, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Dropped);
    expect(world.flags.position[1 * 3 + 1]).toBe(0); // flat terrain height at (50, 50) is 0
    expect(world.flags.carrierId[1]).toBe(-1);
  });
});

describe('failure matrix row 2: pickup one tick before expiry cancels the return timer', () => {
  it('a return-in-progress flag picked up before its timer fires never auto-returns', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const carrier = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    world.players.position.set([50, 0, 50], carrier * 3);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT); // drop, timer starts
    expect(world.flags.state[1]).toBe(FlagState.Dropped);
    world.tick += RETURN_TICKS - 1;
    // Team 1, not team 2: flag 1 belongs to team 2, and a team-2 toucher on their own
    // dropped flag returns it home instantly (see the "touching your own dropped flag"
    // describe block below) rather than picking it up. Only an enemy of the flag's own
    // team can carry a dropped flag, which is what this test needs to exercise the
    // return-timer cancellation.
    const rescuer = addPlayer(world, { x: 50, y: 0, z: 50 }, 1);
    stepFlags(world, FIXED_DT); // pick up one tick before the timer would have fired
    expect(world.flags.state[1]).toBe(FlagState.Carried);
    expect(world.flags.carrierId[1]).toBe(rescuer);
    world.tick += 1; // the tick the timer would have fired on
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Carried); // still carried: the return is a no-op
  });

  it('an untouched dropped flag returns home exactly at the timer', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const carrier = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    world.players.position.set([50, 0, 50], carrier * 3);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT);
    world.tick += RETURN_TICKS;
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.flags.position[1 * 3]).toBe(100);
  });
});

describe('touching your own dropped flag returns it instantly', () => {
  it('a teammate standing on their dropped flag returns it without waiting for the timer', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const carrier = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    world.players.position.set([5, 0, 5], carrier * 3);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT); // drops near team 1's stand at (0,0,0)
    const defender = addPlayer(world, { x: 5, y: 0, z: 5 }, 2);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.flags.position[1 * 3]).toBe(100);
    void defender;
  });
});

describe('match clock: time limit game over', () => {
  const TICKS = 10; // a small time limit so the test does not need 46,875 real ticks.
  // stepFlags runs before stepWorld's `world.tick += 1`, so the tick that is about to
  // complete is `world.tick + 1`. The clock must fire on the call that completes tick
  // TICKS, i.e. when `world.tick` (pre-increment) is TICKS - 1 (Codex review round 1,
  // finding 8) -- not a tick later, on the call where `world.tick` already equals TICKS.
  const BOUNDARY = TICKS - 1;

  it('expires with a leader: the higher-scoring team wins', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, TICKS);
    world.teamScores[1] = 300;
    world.teamScores[2] = 100;
    world.tick = BOUNDARY - 1;
    stepFlags(world, FIXED_DT);
    expect(world.gameOver).toBe(false);
    world.tick = BOUNDARY;
    stepFlags(world, FIXED_DT);
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1);
    expect(world.gameOverReason).toBe(GameOverReason.TimeLimit);
  });

  it('expires tied: winnerTeam is 0, not either team', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, TICKS);
    world.teamScores[1] = 200;
    world.teamScores[2] = 200;
    world.tick = BOUNDARY;
    stepFlags(world, FIXED_DT);
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(0);
    expect(world.gameOverReason).toBe(GameOverReason.TimeLimit);
  });

  it('a capture-limit win landing on the same tick the clock expires still wins by capture, not by the clock', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, TICKS);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    world.teamScores[1] = 700; // one capture short of the 8-capture, 800-point win
    world.teamScores[2] = 750; // leading on score, but the clock never gets a turn to say so
    world.tick = BOUNDARY - 1;
    stepFlags(world, FIXED_DT); // picks up team 2's flag, one tick before the clock expires
    expect(world.gameOver).toBe(false);
    world.players.position.set([0, 0, 0], attacker * 3); // home, own flag untouched
    world.tick = BOUNDARY; // the exact tick the clock would otherwise expire on
    stepFlags(world, FIXED_DT); // the capture resolves before the clock check runs
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1); // the capturer, not team 2 who was leading on the clock
    expect(world.gameOverReason).toBe(GameOverReason.CaptureLimit);
  });
});

describe('Codex review round 7, finding 2: game over stops flag processing for the rest of that tick', () => {
  it('a teammate touching the just-returned enemy flag in the same tick as the game-ending capture does not score', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    // Parked exactly on team 2's stand -- right where completeCapture is about to return
    // team 2's flag to, in the very same tick attacker's capture ends the match.
    const teammate = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    world.teamScores[1] = 700; // one capture short of the 800-point win
    stepFlags(world, FIXED_DT); // attacker carries team 2's flag; teammate's touch is a no-op
    expect(world.flags.carrierId[1]).toBe(attacker);
    world.players.position.set([0, 0, 0], attacker * 3); // attacker heads home to capture
    stepFlags(world, FIXED_DT); // attacker's capture wins the game; teammate is still due a turn
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1);
    // Without the fix, teammate's still-pending touch (processed right after attacker's,
    // same loop) would pick the just-returned flag back up and score +20.
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.flags.carrierId[1]).toBe(-1);
    expect(world.players.score[teammate]).toBe(0);
  });
});

describe('Codex review round 1, finding 8: time-limit game over must not land a tick late', () => {
  it('stepWorld ends the match on the tick that reaches the limit, not the tick after', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, 1); // time limit of a single tick
    stepWorld(world, new Map());
    expect(world.tick).toBe(1);
    expect(world.gameOver).toBe(true);
    expect(world.gameOverReason).toBe(GameOverReason.TimeLimit);
  });
});

describe('Codex review round 9, PR #9, P1: a flag carrier falling out of the world', () => {
  it('drops the carried flag and dies for real, instead of teleporting home still holding it', () => {
    // Before the fix, movement.ts's kill-plane handling repositioned the player directly
    // and never touched pendingDeaths, so stepFlags never saw a death: a flag carrier who
    // fell out of the world stayed "alive", kept the flag, and the flag's carried-position
    // sync just followed them back to their spawn -- a real exploit (fall out of the map to
    // instantly and safely relocate a stolen flag). A terrain hole, not just a low y: on
    // solid ground movement.ts's own ground-contact resolution snaps a falling player back
    // onto the surface before the kill-plane check ever runs (see movement.ts's
    // integrate/classify -- empty square means no snap). `flat`'s 2x2 grid is a single
    // square (col/row always clamp to 0 -- see terrain.ts's sampleTerrain), so marking
    // square 0 empty makes the whole map a hole and the carrier starts falling immediately.
    const holed: Heightfield = { ...flat, emptySquares: new Set([0]) };
    const world = createWorld(holed, 1);
    createFlags(world, stands);
    const carrier = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepWorld(world, new Map([[carrier, idle]])); // parked on team 2's stand: picks it up
    expect(world.flags.state[1]).toBe(FlagState.Carried);
    expect(world.flags.carrierId[1]).toBe(carrier);
    let ticks = 0;
    while (world.players.alive[carrier] === 1 && ticks < 300) {
      stepWorld(world, new Map([[carrier, idle]]));
      ticks += 1;
    }
    expect(ticks).toBeLessThan(300); // sanity: the carrier actually died within the budget
    expect(world.players.alive[carrier]).toBe(0);
    // The flag dropped -- not carried into the void, not teleported home with the player.
    expect(world.flags.state[1]).toBe(FlagState.Dropped);
    expect(world.flags.carrierId[1]).toBe(-1);
    expect(world.flags.position[1 * 3]).toBe(100); // dropped near the fall-out point
    expect(world.flags.position[1 * 3 + 1]).toBe(0); // clamped to the flat terrain height there
    expect(world.flags.position[1 * 3 + 2]).toBe(0);
    // A real death, not an instant reset: the standard 5 s respawn timer is running, and
    // the player does not come back alive on their own without going through it.
    expect(world.players.respawnAt[carrier]).toBeGreaterThan(world.tick);
    // Drive the standard respawn cycle to confirm damage/loadout come back clean, exactly
    // like every other death (weapons.test.ts covers ammo/grenades in detail).
    while (dueForRespawn(world).length === 0) stepWorld(world, new Map([[carrier, idle]]));
    for (const id of dueForRespawn(world)) respawnPlayer(world, id, { x: 100, y: 0, z: 0 });
    expect(world.players.alive[carrier]).toBe(1);
    expect(world.players.damage[carrier]).toBe(0);
    // The dropped flag is still where it fell, recoverable by either team.
    expect(world.flags.state[1]).toBe(FlagState.Dropped);
  });
});
