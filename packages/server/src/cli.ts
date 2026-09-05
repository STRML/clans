export interface ServerOptions {
  bots: number;
  port: number;
}

const DEFAULT_PORT = 7777;

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
  if (!Number.isInteger(port) || port <= 0)
    throw new RangeError('--port must be a positive integer');
  return { bots, port };
}
