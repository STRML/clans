import { WORLD_CAPACITY } from './world.js';

export interface ServerOptions {
  bots: number;
  port: number;
}

const DEFAULT_PORT = 7777;
const MAX_PORT = 65_535;

function readFlag(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined) throw new RangeError(`Missing value for ${name}`);
  return value;
}

export function parseArgs(argv: string[]): ServerOptions {
  let bots = 0;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bots') {
      bots = Number(readFlag(argv, i + 1, '--bots'));
      i += 1;
    } else if (argv[i] === '--port') {
      port = Number(readFlag(argv, i + 1, '--port'));
      i += 1;
    }
  }
  if (!Number.isInteger(bots) || bots < 0)
    throw new RangeError('--bots must be a non-negative integer');
  // addBots throws deep inside the sim package once world capacity is exhausted; catching
  // it here instead gives a clear, actionable startup error instead of a crash whose
  // stack trace points nowhere near the actual --bots argument that caused it.
  if (bots > WORLD_CAPACITY)
    throw new RangeError(`--bots must not exceed world capacity (${String(WORLD_CAPACITY)})`);
  // net.createServer (via ws's WebSocketServer) throws ERR_SOCKET_BAD_PORT for anything
  // outside the valid TCP port range, deep inside startNetServer rather than here where
  // the actual bad --port argument is. Rejecting it at parse time gives a clear,
  // actionable startup error instead of an unrelated-looking crash.
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT)
    throw new RangeError(`--port must be an integer between 1 and ${String(MAX_PORT)}`);
  return { bots, port };
}
