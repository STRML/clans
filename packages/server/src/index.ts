import { parseArgs } from './cli.js';
import { startTickLoop } from './loop.js';
import { startNetServer } from './net.js';
import { addBots, loadKatabaticWorld } from './world.js';

const options = parseArgs(process.argv.slice(2));
const { world, spawns } = await loadKatabaticWorld();
addBots(world, spawns, options.bots);

const net = startNetServer({ world, spawns, port: options.port });
await net.ready;

let overrunCount = 0;
startTickLoop({
  onTick: (tickNumber) => net.tick(tickNumber),
  onOverrun: (overrunMs, ticksBehind) => {
    overrunCount += 1;
    console.warn(
      `[clans-server] tick overrun: ${overrunMs.toFixed(1)}ms, ${String(
        ticksBehind,
      )} ticks behind (total: ${String(overrunCount)})`,
    );
  },
});

console.log(
  `[clans-server] listening on ws://127.0.0.1:${String(options.port)} with ${String(
    options.bots,
  )} bots`,
);
