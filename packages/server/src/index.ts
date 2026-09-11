import { FIXED_DT } from '@clans/sim';
import { createBotManager } from './bots.js';
import { parseArgs } from './cli.js';
import { startTickLoop } from './loop.js';
import { startNetServer } from './net.js';
import { createOrderBoard } from './orders.js';
import { loadKatabaticWorld } from './world.js';

const options = parseArgs(process.argv.slice(2));
// Seconds -> ticks at this boundary: the CLI speaks to operators in seconds (the unit they
// read off a stopwatch), everything below it in the fixed 32 ms tick the sim requires.
const timeLimitTicks = Math.round(options.timeLimitSeconds / FIXED_DT);
const intermissionTicks = Math.round(options.intermissionSeconds / FIXED_DT);
const { world, spawns } = await loadKatabaticWorld(1, timeLimitTicks);
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
const botManager = createBotManager(world, spawns, landmarks, options.bots, options.teamSize);
const board = createOrderBoard();

const net = startNetServer({
  world,
  spawns,
  botManager,
  board,
  port: options.port,
  intermissionTicks,
});
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
// actual number of bots the manager could place. rebalanceTeams only ever fills up to the
// match's per-team cap (--team-size, 16 by default) per team, so a budget above
// teamSize * 2 never gets fully used regardless of what was requested (e.g. --bots 48
// with the default cap seats 32). cli.ts's own validation allows up to WORLD_CAPACITY (64)
// for --bots since that flag is a budget, not a match size, so the mismatch is real and
// worth surfacing to whoever is reading server startup logs -- and the fix is a second
// flag, not a smaller budget: --team-size 24 is what seats the 24-versus-24 target.
const MAX_USABLE_BOTS = options.teamSize * 2;
if (options.bots > MAX_USABLE_BOTS) {
  console.warn(
    `[clans-server] --bots ${String(options.bots)} exceeds the usable maximum of ${String(
      MAX_USABLE_BOTS,
    )} (${String(options.teamSize)} per team, raise --team-size for a larger match); only ${String(
      botManager.botIds.size,
    )} bots were placed`,
  );
}
console.log(
  `[clans-server] listening on ws://127.0.0.1:${String(options.port)} with ${String(
    botManager.botIds.size,
  )} bots (match ${String(options.timeLimitSeconds)}s, intermission ${String(
    options.intermissionSeconds,
  )}s, then the next match starts on the same map)`,
);
