import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from './index.js';
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

  it('expires with a leader: the higher-scoring team wins', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, TICKS);
    world.teamScores[1] = 300;
    world.teamScores[2] = 100;
    world.tick = TICKS - 1;
    stepFlags(world, FIXED_DT);
    expect(world.gameOver).toBe(false);
    world.tick = TICKS;
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
    world.tick = TICKS;
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
    world.tick = TICKS - 1;
    stepFlags(world, FIXED_DT); // picks up team 2's flag, one tick before the clock expires
    expect(world.gameOver).toBe(false);
    world.players.position.set([0, 0, 0], attacker * 3); // home, own flag untouched
    world.tick = TICKS; // the exact tick the clock would otherwise expire on
    stepFlags(world, FIXED_DT); // the capture resolves before the clock check runs
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1); // the capturer, not team 2 who was leading on the clock
    expect(world.gameOverReason).toBe(GameOverReason.CaptureLimit);
  });
});
