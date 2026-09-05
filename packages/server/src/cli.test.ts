import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

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
});
