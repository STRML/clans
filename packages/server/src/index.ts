import { createBotManager } from './bots.js';
import { parseArgs } from './cli.js';
import { startTickLoop } from './loop.js';
import { startNetServer } from './net.js';
import { loadKatabaticWorld } from './world.js';

const options = parseArgs(process.argv.slice(2));
const { world, spawns } = await loadKatabaticWorld();
// Landmarks for the waypoint graph: every real flag stand and base object already placed
// in the loaded world (loadKatabaticWorld's own createFlags/createBaseObjects calls),
// read back from the populated stores rather than the raw scene JSON -- world.ts's
// loadKatabaticWorld only returns { world, spawns }, so this reads the same placements
// it already built rather than threading the scene's flagStands/baseObjects arrays one
// call further out. See PR notes on this adaptation.
const landmarks = spawns.map((s) => ({
  position: { x: s.position[0], y: s.position[1], z: s.position[2] },
  label: 'spawn',
}));
for (let flagId = 0; flagId < world.flags.team.length; flagId += 1) {
  const base = flagId * 3;
  landmarks.push({
    position: {
      x: world.flags.standPosition[base] ?? 0,
      y: world.flags.standPosition[base + 1] ?? 0,
      z: world.flags.standPosition[base + 2] ?? 0,
    },
    label: 'flag',
  });
}
for (let id = 0; id < world.baseObjects.count; id += 1) {
  const base = id * 3;
  landmarks.push({
    position: {
      x: world.baseObjects.position[base] ?? 0,
      y: world.baseObjects.position[base + 1] ?? 0,
      z: world.baseObjects.position[base + 2] ?? 0,
    },
    label: 'baseObject',
  });
}
const botManager = createBotManager(world, spawns, landmarks, options.bots);

const net = startNetServer({ world, spawns, botManager, port: options.port });
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
