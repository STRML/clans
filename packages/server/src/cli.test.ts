import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';
import { WORLD_CAPACITY } from './world.js';

describe('parseArgs', () => {
  it('reads --bots and --port', () => {
    expect(parseArgs(['--bots', '31', '--port', '7777'])).toEqual({ bots: 31, port: 7777 });
  });
  it('defaults bots to 0 and port to 7777', () => {
    expect(parseArgs([])).toEqual({ bots: 0, port: 7777 });
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
});
