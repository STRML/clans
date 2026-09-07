import { createBotManager, TARGET_TEAM_SIZE } from './bots.js';
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

// Codex review round 1, finding (P1): this used to log the raw --bots value, not the
// actual number of bots the manager could place. rebalanceTeams only ever fills up to
// TARGET_TEAM_SIZE (16) per team, so a budget above 32 never gets fully used regardless
// of what was requested -- cli.ts's own validation still allows up to WORLD_CAPACITY (64)
// since this milestone does not change that flag's contract (Global Constraints), so the
// mismatch is real and worth surfacing to whoever is reading server startup logs.
const MAX_USABLE_BOTS = TARGET_TEAM_SIZE * 2;
if (options.bots > MAX_USABLE_BOTS) {
  console.warn(
    `[clans-server] --bots ${String(options.bots)} exceeds the usable maximum of ${String(
      MAX_USABLE_BOTS,
    )} (${String(TARGET_TEAM_SIZE)} per team); only ${String(botManager.botIds.size)} bots were placed`,
  );
}
console.log(
  `[clans-server] listening on ws://127.0.0.1:${String(options.port)} with ${String(
    botManager.botIds.size,
  )} bots`,
);
