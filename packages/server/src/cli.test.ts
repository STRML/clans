import { describe, expect, it } from 'vitest';
import { FIXED_DT, TIME_LIMIT_TICKS } from '@clans/sim';
import { parseArgs } from './cli.js';
import { TARGET_TEAM_SIZE } from './bots.js';
import { WORLD_CAPACITY } from './world.js';

describe('parseArgs', () => {
  // The sim's own default match length, in seconds -- the CLI derives it from flags.ts's
  // TIME_LIMIT_TICKS rather than repeating 1500, so this is what "no --time-limit" means.
  const defaultTimeLimit = TIME_LIMIT_TICKS * FIXED_DT;
  const defaults = {
    bots: 0,
    teamSize: TARGET_TEAM_SIZE,
    port: 7777,
    timeLimitSeconds: defaultTimeLimit,
    intermissionSeconds: 5,
  };

  it('reads --bots and --port', () => {
    expect(parseArgs(['--bots', '31', '--port', '7777'])).toEqual({
      ...defaults,
      bots: 31,
    });
  });
  it('defaults bots to 0, team size to TARGET_TEAM_SIZE, port to 7777, and the clock to the sim default', () => {
    expect(parseArgs([])).toEqual(defaults);
  });
  it('reads a raised --team-size so --bots 48 can seat the 24-versus-24 target', () => {
    expect(parseArgs(['--bots', '48', '--team-size', '24'])).toEqual({
      ...defaults,
      bots: 48,
      teamSize: 24,
    });
  });
  it('reads --time-limit and --intermission in seconds, so a test can drive a whole cycle', () => {
    expect(parseArgs(['--time-limit', '20', '--intermission', '0.5'])).toEqual({
      ...defaults,
      timeLimitSeconds: 20,
      intermissionSeconds: 0.5,
    });
    // 0 is legal for the pause (play the next match immediately) but never for the clock.
    expect(parseArgs(['--intermission', '0']).intermissionSeconds).toBe(0);
  });
  it('rejects a clock or pause that would leave the sim with nothing to measure', () => {
    expect(() => parseArgs(['--time-limit', '0'])).toThrow(RangeError);
    expect(() => parseArgs(['--time-limit', '-1'])).toThrow(RangeError);
    expect(() => parseArgs(['--time-limit', 'x'])).toThrow(RangeError);
    expect(() => parseArgs(['--intermission', '-1'])).toThrow(RangeError);
    expect(() => parseArgs(['--intermission', 'x'])).toThrow(RangeError);
    expect(() => parseArgs(['--time-limit'])).toThrow(RangeError);
  });
  it('rejects a non-positive or non-numeric --team-size, and one above world capacity', () => {
    expect(() => parseArgs(['--team-size', '0'])).toThrow(RangeError);
    expect(() => parseArgs(['--team-size', '-1'])).toThrow(RangeError);
    expect(() => parseArgs(['--team-size', 'x'])).toThrow(RangeError);
    expect(() => parseArgs(['--team-size', String(WORLD_CAPACITY + 1)])).toThrow(RangeError);
    expect(parseArgs(['--team-size', String(WORLD_CAPACITY)]).teamSize).toBe(WORLD_CAPACITY);
  });
  it('rejects a negative or non-numeric --bots', () => {
    expect(() => parseArgs(['--bots', '-1'])).toThrow(RangeError);
    expect(() => parseArgs(['--bots', 'x'])).toThrow(RangeError);
  });
  it('rejects a --bots count beyond world capacity instead of crashing startup later', () => {
    // Codex round 8 (PR #4): parseArgs let any non-negative integer through; index.ts's
    // addBots(world, spawns, options.bots) then threw a RangeError deep inside the sim
    // package once capacity ran out, crashing startup with a stack trace pointing nowhere
    // near the --bots argument that actually caused it.
    expect(() => parseArgs(['--bots', String(WORLD_CAPACITY + 1)])).toThrow(RangeError);
    expect(parseArgs(['--bots', String(WORLD_CAPACITY)]).bots).toBe(WORLD_CAPACITY);
  });
  it('rejects a --port outside the valid TCP range instead of crashing startup later', () => {
    // Codex round 10 (PR #4): parseArgs only checked positivity, so --port 65536 passed
    // validation here and then threw ERR_SOCKET_BAD_PORT deep inside startNetServer
    // instead of a clear error naming the actual bad argument.
    expect(() => parseArgs(['--port', '65536'])).toThrow(RangeError);
    expect(() => parseArgs(['--port', '0'])).toThrow(RangeError);
    expect(parseArgs(['--port', '65535']).port).toBe(65535);
  });
});
