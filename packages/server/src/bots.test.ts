import { describe, expect, it } from 'vitest';
import { addPlayer, createFlags, createWorld, FlagState, type Heightfield } from '@clans/sim';
import { BotRole } from '@clans/bots';
import { createBotManager, joinableTeam, rebalanceTeams, TARGET_TEAM_SIZE } from './bots.js';
import { teamCount, type SceneSpawn } from './world.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 2000,
  originX: -1000,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

const spawns: SceneSpawn[] = [
  { name: null, team: 1, position: [-100, 0, 0], radius: 5 },
  { name: null, team: 1, position: [-90, 0, 0], radius: 5 },
  { name: null, team: 2, position: [100, 0, 0], radius: 5 },
  { name: null, team: 2, position: [90, 0, 0], radius: 5 },
];

describe('createBotManager', () => {
  it('fills both teams to TARGET_TEAM_SIZE at construction with a full budget', () => {
    const world = createWorld(flat, 1, 64);
    const manager = createBotManager(world, spawns, [], TARGET_TEAM_SIZE * 2);
    expect(teamCount(world, 1)).toBe(TARGET_TEAM_SIZE);
    expect(teamCount(world, 2)).toBe(TARGET_TEAM_SIZE);
    expect(manager.botIds.size).toBe(TARGET_TEAM_SIZE * 2);
  });

  it('constructs without throwing at maxBots = 1 and assigns that single bot the Attacker role (failure matrix row 14)', () => {
    const world = createWorld(flat, 1, 64);
    expect(() => createBotManager(world, spawns, [], 1)).not.toThrow();
    const manager = createBotManager(createWorld(flat, 1, 64), spawns, [], 1);
    expect(manager.botIds.size).toBe(1);
    const [onlyBotId] = manager.botIds;
    const runtime = manager.runtimes.get(onlyBotId as number);
    expect(runtime?.role).toBe(BotRole.Attacker);
  });
});

describe('rebalanceTeams', () => {
  it('removes exactly one lowest-score bot when a human joins a team already at TARGET_TEAM_SIZE (failure matrix row 12)', () => {
    const world = createWorld(flat, 1, 64);
    const manager = createBotManager(world, spawns, [], TARGET_TEAM_SIZE * 2);
    // Give every bot on team 1 a distinct score so "lowest" is unambiguous.
    const team1BotIds = [...manager.botIds]
      .filter((id) => world.players.team[id] === 1)
      .sort((a, b) => a - b);
    team1BotIds.forEach((id, index) => {
      world.players.score[id] = index + 1;
    });
    const lowestScoreBotId = team1BotIds[0];
    addPlayer(world, { x: -95, y: 0, z: 0 }, 1); // the joining human, team 1 already at 16
    rebalanceTeams(manager, world, spawns);
    expect(teamCount(world, 1)).toBe(TARGET_TEAM_SIZE);
    expect(manager.botIds.has(lowestScoreBotId as number)).toBe(false);
  });

  it('drops a carried flag before removing a bot during rebalancing, the same as a real disconnect', () => {
    const world = createWorld(flat, 1, 64);
    createFlags(world, [
      { team: 1, position: { x: -100, y: 0, z: 0 } },
      { team: 2, position: { x: 100, y: 0, z: 0 } },
    ]);
    const manager = createBotManager(world, spawns, [], TARGET_TEAM_SIZE * 2);
    const team1BotIds = [...manager.botIds]
      .filter((id) => world.players.team[id] === 1)
      .sort((a, b) => a - b);
    // Every bot starts at score 0 (a tie), so pickBotToRemove's own tie-break -- highest
    // player id -- decides; team1BotIds is sorted ascending, so its last entry is the one
    // rebalanceTeams will actually remove here.
    const carrierId = team1BotIds[team1BotIds.length - 1] as number;
    // Team-1's own flag (id 0) carried by that bot.
    world.flags.carrierId[0] = carrierId;
    world.flags.state[0] = FlagState.Carried;
    addPlayer(world, { x: -95, y: 0, z: 0 }, 1); // the joining human, team 1 already at 16
    rebalanceTeams(manager, world, spawns);
    expect(manager.botIds.has(carrierId)).toBe(false);
    expect(world.flags.carrierId[0]).toBe(-1);
    expect(world.flags.state[0]).toBe(FlagState.Dropped);
  });

  it('backfills one bot when a human leaves and budget remains (failure matrix row 13)', () => {
    const world = createWorld(flat, 1, 64);
    const human = addPlayer(world, { x: -95, y: 0, z: 0 }, 1);
    const manager = createBotManager(world, spawns, [], TARGET_TEAM_SIZE * 2);
    expect(teamCount(world, 1)).toBe(TARGET_TEAM_SIZE);
    world.players.active[human] = 0; // simulate removePlayer's own effect already applied
    rebalanceTeams(manager, world, spawns);
    expect(teamCount(world, 1)).toBe(TARGET_TEAM_SIZE);
  });

  it('never adds another bot once the manager already carries maxBots, even under TARGET_TEAM_SIZE', () => {
    const world = createWorld(flat, 1, 64);
    const manager = createBotManager(world, spawns, [], 2);
    expect(manager.botIds.size).toBe(2);
    rebalanceTeams(manager, world, spawns);
    expect(manager.botIds.size).toBe(2);
    expect(teamCount(world, 1)).toBeLessThan(TARGET_TEAM_SIZE);
  });

  it('splits a small bot budget across both teams instead of saturating team 1 first (Codex review round 1, P2)', () => {
    const world = createWorld(flat, 1, 64);
    createBotManager(world, spawns, [], 2);
    expect(teamCount(world, 1)).toBe(1);
    expect(teamCount(world, 2)).toBe(1);
  });
});

describe('joinableTeam', () => {
  it('returns null when both teams are full of humans and no bot exists to shed (--bots 0, issue #31)', () => {
    // The #31 repro: with no bot on either team, rebalanceTeams had nothing to remove,
    // yet handleJoin accepted the join unconditionally -- team 1 went to 17 humans.
    const world = createWorld(flat, 1, 64);
    const manager = createBotManager(world, spawns, [], 0);
    for (let i = 0; i < TARGET_TEAM_SIZE; i += 1) {
      addPlayer(world, { x: -95, y: 0, z: 0 }, 1);
      addPlayer(world, { x: 95, y: 0, z: 0 }, 2);
    }
    expect(joinableTeam(world, manager)).toBeNull();
  });

  it('keeps sending a joiner to the smaller under-cap team while either team has a slot', () => {
    const world = createWorld(flat, 1, 64);
    const manager = createBotManager(world, spawns, [], 0);
    addPlayer(world, { x: -95, y: 0, z: 0 }, 1);
    // Same pick smallerTeam makes for this world (team 2 is the smaller), so the cap
    // gate changes nothing for ordinary joins.
    expect(joinableTeam(world, manager)).toBe(2);
  });

  it('offers the alternate team, and its bot, when the preferred team is at cap with no bot', () => {
    // Team 1: 16 humans, botless -- smallerTeam's pick (tie goes to team 1) has nothing
    // to shed. Team 2: 15 humans plus the manager's single backfilled bot, so exactly-at
    // -cap team 2 can still take the joiner by giving that bot up (row 12's mechanic)
    // instead of refusing the join outright.
    const world = createWorld(flat, 1, 64);
    for (let i = 0; i < TARGET_TEAM_SIZE; i += 1) addPlayer(world, { x: -95, y: 0, z: 0 }, 1);
    for (let i = 0; i < TARGET_TEAM_SIZE - 1; i += 1) addPlayer(world, { x: 95, y: 0, z: 0 }, 2);
    const manager = createBotManager(world, spawns, [], 1);
    expect(manager.botIds.size).toBe(1);
    expect(joinableTeam(world, manager)).toBe(2);
    // The offer is real: the join lands on team 2, rebalanceTeams sheds exactly the bot,
    // and both teams sit back at the cap.
    addPlayer(world, { x: 95, y: 0, z: 0 }, 2);
    rebalanceTeams(manager, world, spawns);
    expect(teamCount(world, 1)).toBe(TARGET_TEAM_SIZE);
    expect(teamCount(world, 2)).toBe(TARGET_TEAM_SIZE);
    expect(manager.botIds.size).toBe(0);
  });
});
