import { TARGET_TEAM_SIZE } from './bots.js';
import { WORLD_CAPACITY } from './world.js';

export interface ServerOptions {
  bots: number;
  /** Per-team seat cap handed to createBotManager (bots.ts's `teamSize`), so one flag can
   *  seat a match larger than the spec's default 16 versus 16: `--bots 48 --team-size 24`
   *  is the 24-versus-24 target match. Defaults to TARGET_TEAM_SIZE, so omitting it keeps
   *  every existing invocation's seating byte-identical. */
  teamSize: number;
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
  let teamSize = TARGET_TEAM_SIZE;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bots') {
      bots = Number(readFlag(argv, i + 1, '--bots'));
      i += 1;
    } else if (argv[i] === '--team-size') {
      teamSize = Number(readFlag(argv, i + 1, '--team-size'));
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
  // The cap is a seat limit, not a budget, so its only hard bound is world capacity: no
  // team can hold more players than the world can. A cap above `bots` is legal and simply
  // goes unfilled (rebalanceTeams stops at the budget), which is why there is no
  // team-size-versus-bots cross-check here.
  if (!Number.isInteger(teamSize) || teamSize <= 0)
    throw new RangeError('--team-size must be a positive integer');
  if (teamSize > WORLD_CAPACITY)
    throw new RangeError(`--team-size must not exceed world capacity (${String(WORLD_CAPACITY)})`);
  // net.createServer (via ws's WebSocketServer) throws ERR_SOCKET_BAD_PORT for anything
  // outside the valid TCP port range, deep inside startNetServer rather than here where
  // the actual bad --port argument is. Rejecting it at parse time gives a clear,
  // actionable startup error instead of an unrelated-looking crash.
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT)
    throw new RangeError(`--port must be an integer between 1 and ${String(MAX_PORT)}`);
  return { bots, teamSize, port };
}
