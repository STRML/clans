import { FIXED_DT, TIME_LIMIT_TICKS } from '@clans/sim';
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
  /** Match length in SECONDS (`--time-limit`). Seconds, not ticks, because this is the one
   *  knob an operator reads off a stopwatch; index.ts converts it at the boundary. Defaults
   *  to the sim's own match length (flags.ts's TIME_LIMIT_TICKS, 25 minutes), derived rather
   *  than repeated so there is exactly one place a change to it has to land. */
  timeLimitSeconds: number;
  /** Seconds between the end of one match and the start of the next (`--intermission`).
   *  Zero is legal and starts the next match on the very next tick, which is what a test
   *  driving a whole cycle in a few hundred ticks wants. */
  intermissionSeconds: number;
}

const DEFAULT_PORT = 7777;
const MAX_PORT = 65_535;
// 1,500 s exactly: the sim's own default 46,875 ticks at 32 ms.
const DEFAULT_TIME_LIMIT_SECONDS = TIME_LIMIT_TICKS * FIXED_DT;
// Ours: 5 s is the stock Torque template's own end-game pause (`$Game::EndGamePause` -- see
// net.ts's DEFAULT_INTERMISSION_TICKS and sim/match.ts's header for the flow it comes from).
const DEFAULT_INTERMISSION_SECONDS = 5;

function readFlag(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined) throw new RangeError(`Missing value for ${name}`);
  return value;
}

/** One numeric flag's assignment, so `parseArgs` can look flags up by name instead of
 *  carrying a branch per flag (and so adding a flag is one line here, not another `else
 *  if`). */
type FlagSetter = (options: ServerOptions, value: number) => void;

const FLAG_SETTERS: Record<string, FlagSetter> = {
  '--bots': (options, value) => {
    options.bots = value;
  },
  '--team-size': (options, value) => {
    options.teamSize = value;
  },
  '--port': (options, value) => {
    options.port = value;
  },
  '--time-limit': (options, value) => {
    options.timeLimitSeconds = value;
  },
  '--intermission': (options, value) => {
    options.intermissionSeconds = value;
  },
};

/** Rejects a flag value that would leave the server in a state nothing can describe. Each
 *  check is per-flag because each bound has its own reason -- see the call sites. */
function validate(options: ServerOptions): void {
  // addBots throws deep inside the sim package once world capacity is exhausted; catching it
  // here instead gives a clear, actionable startup error instead of a crash whose stack trace
  // points nowhere near the actual --bots argument that caused it.
  requireInteger(options.bots, '--bots', 0, WORLD_CAPACITY);
  // The cap is a seat limit, not a budget, so its only hard bound is world capacity: no team
  // can hold more players than the world can. A cap above `bots` is legal and simply goes
  // unfilled (rebalanceTeams stops at the budget), which is why there is no
  // team-size-versus-bots cross-check here.
  requireInteger(options.teamSize, '--team-size', 1, WORLD_CAPACITY);
  // net.createServer (via ws's WebSocketServer) throws ERR_SOCKET_BAD_PORT for anything
  // outside the valid TCP port range, deep inside startNetServer rather than here where the
  // actual bad --port argument is. Rejecting it at parse time gives a clear, actionable
  // startup error instead of an unrelated-looking crash.
  requireInteger(options.port, '--port', 1, MAX_PORT);
  // Seconds, so fractional lengths are legal (`--time-limit 0.64` is 20 ticks); what is not
  // legal is a value that would make the sim's own clock meaningless -- zero or negative for
  // the match length, negative for a pause. Checked here rather than at index.ts's seconds ->
  // ticks math, so the error names the argument that caused it.
  requirePositiveSeconds(options.timeLimitSeconds, '--time-limit');
  requireNonNegativeSeconds(options.intermissionSeconds, '--intermission');
}

function requireInteger(value: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer between ${String(min)} and ${String(max)}`);
}

function requirePositiveSeconds(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive number of seconds`);
}

function requireNonNegativeSeconds(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative number of seconds`);
}

export function parseArgs(argv: string[]): ServerOptions {
  const options: ServerOptions = {
    bots: 0,
    teamSize: TARGET_TEAM_SIZE,
    port: DEFAULT_PORT,
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    intermissionSeconds: DEFAULT_INTERMISSION_SECONDS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const set = FLAG_SETTERS[argv[i] ?? ''];
    if (set === undefined) continue; // Unknown arguments are ignored, as they always were.
    set(options, Number(readFlag(argv, i + 1, argv[i] ?? '')));
    i += 1;
  }
  validate(options);
  return options;
}
