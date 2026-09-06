import { sampleTerrain } from './terrain.js';
import type { FlagStore, Vec3, World } from './types.js';

export enum FlagState {
  Home = 0,
  Carried = 1,
  Dropped = 2,
}

const FLAG_COUNT = 2;
export const PICKUP_RADIUS = 2; // Ours: not stated by the spec.
const RETURN_SECONDS = 45; // Spec's CTF numbers table.
const FIXED_DT = 32 / 1000;
export const RETURN_TICKS = Math.round(RETURN_SECONDS / FIXED_DT);
export const CAPTURES_TO_WIN = 8; // Spec's CTF_scoreLimit.
const TEAM_POINTS_PER_CAPTURE = 100; // Spec.
export const WIN_SCORE = CAPTURES_TO_WIN * TEAM_POINTS_PER_CAPTURE;

export enum GameOverReason {
  CaptureLimit = 0,
  TimeLimit = 1,
}
// Spec's CTF and flags section: "Match ends at 8 captures or at a configurable time limit
// (our default: 25 minutes; T2's value is not verified), whichever comes first." This is the
// spec's own cited default, not a plan-picked "ours" number -- it just discloses up front that
// this particular value isn't a T2 script constant, unlike the capture/point numbers above it.
const TIME_LIMIT_SECONDS = 25 * 60;
export const TIME_LIMIT_TICKS = Math.round(TIME_LIMIT_SECONDS / FIXED_DT); // 46,875 ticks exactly.

export function createFlags(
  world: World,
  stands: Array<{ team: number; position: Vec3 }>,
  timeLimitTicks = TIME_LIMIT_TICKS,
): void {
  const store: FlagStore = {
    team: new Uint8Array(FLAG_COUNT),
    state: new Uint8Array(FLAG_COUNT),
    position: new Float64Array(FLAG_COUNT * 3),
    standPosition: new Float64Array(FLAG_COUNT * 3),
    carrierId: new Int16Array(FLAG_COUNT).fill(-1),
    returnAt: new Float64Array(FLAG_COUNT).fill(-1),
  };
  stands.slice(0, FLAG_COUNT).forEach((stand, id) => {
    store.team[id] = stand.team;
    store.position.set([stand.position.x, stand.position.y, stand.position.z], id * 3);
    store.standPosition.set([stand.position.x, stand.position.y, stand.position.z], id * 3);
  });
  world.flags = store;
  world.timeLimitTicks = timeLimitTicks;
}

function distance(world: World, playerId: number, flagId: number): number {
  const p = world.players.position,
    base = playerId * 3;
  const f = world.flags.position,
    fbase = flagId * 3;
  return Math.hypot(
    (p[base] ?? 0) - (f[fbase] ?? 0),
    (p[base + 1] ?? 0) - (f[fbase + 1] ?? 0),
    (p[base + 2] ?? 0) - (f[fbase + 2] ?? 0),
  );
}

function clampToWalkable(world: World, x: number, z: number): Vec3 {
  return { x, y: sampleTerrain(world.terrain, x, z).height, z };
}

function dropFlag(world: World, flagId: number, at: Vec3): void {
  const flags = world.flags;
  const walkable = clampToWalkable(world, at.x, at.z);
  flags.state[flagId] = FlagState.Dropped;
  flags.position.set([walkable.x, walkable.y, walkable.z], flagId * 3);
  flags.carrierId[flagId] = -1;
  flags.returnAt[flagId] = world.tick + RETURN_TICKS;
}

function dropCarriedFlagsOnDeath(world: World): void {
  for (const { id: deadId } of world.pendingDeaths) {
    for (let flagId = 0; flagId < FLAG_COUNT; flagId += 1) {
      if (world.flags.carrierId[flagId] !== deadId) continue;
      const base = deadId * 3;
      dropFlag(world, flagId, {
        x: world.players.position[base] ?? 0,
        y: world.players.position[base + 1] ?? 0,
        z: world.players.position[base + 2] ?? 0,
      });
    }
  }
}

function returnHome(world: World, flagId: number): void {
  const flags = world.flags;
  const base = flagId * 3;
  flags.state[flagId] = FlagState.Home;
  flags.position.set(
    [
      flags.standPosition[base] ?? 0,
      flags.standPosition[base + 1] ?? 0,
      flags.standPosition[base + 2] ?? 0,
    ],
    base,
  );
  flags.carrierId[flagId] = -1;
  flags.returnAt[flagId] = -1;
}

function tryPickupOrReturn(world: World, playerId: number, flagId: number): void {
  const flags = world.flags;
  if (distance(world, playerId, flagId) > PICKUP_RADIUS) return;
  const isOwnFlag = flags.team[flagId] === world.players.team[playerId];
  if (!isOwnFlag && flags.state[flagId] !== FlagState.Carried) {
    flags.state[flagId] = FlagState.Carried;
    flags.carrierId[flagId] = playerId;
    flags.returnAt[flagId] = -1; // Cancels any in-flight return timer (failure matrix row 2).
    world.players.score[playerId] = (world.players.score[playerId] ?? 0) + 20;
  } else if (isOwnFlag && flags.state[flagId] === FlagState.Dropped) {
    returnHome(world, flagId);
  }
}

function ownFlagHome(world: World, team: number): boolean {
  for (let flagId = 0; flagId < FLAG_COUNT; flagId += 1) {
    if (world.flags.team[flagId] === team) return world.flags.state[flagId] === FlagState.Home;
  }
  return false;
}

function checkCaptureWin(world: World, team: number): void {
  if ((world.teamScores[team] ?? 0) < WIN_SCORE) return;
  world.gameOver = true;
  world.winnerTeam = team;
  world.gameOverReason = GameOverReason.CaptureLimit;
}

function completeCapture(world: World, playerId: number, team: number, enemyFlagId: number): void {
  returnHome(world, enemyFlagId);
  world.players.score[playerId] = (world.players.score[playerId] ?? 0) + 30;
  world.teamScores[team] = (world.teamScores[team] ?? 0) + TEAM_POINTS_PER_CAPTURE;
  checkCaptureWin(world, team);
}

/** Captures every enemy flag `playerId` is carrying (in practice at most one, since a
 *  player can only carry one flag, but this stays a loop rather than an early-return
 *  single lookup to keep the "which flag" search and the "what capturing it does" logic
 *  cleanly separated). */
function captureCarriedEnemyFlags(world: World, playerId: number, team: number): void {
  for (let enemyFlagId = 0; enemyFlagId < FLAG_COUNT; enemyFlagId += 1) {
    const flags = world.flags;
    if (flags.team[enemyFlagId] === team || flags.carrierId[enemyFlagId] !== playerId) continue;
    completeCapture(world, playerId, team, enemyFlagId);
  }
}

function tryCapture(world: World, playerId: number, flagId: number): void {
  const flags = world.flags;
  const team = world.players.team[playerId] ?? 0;
  if (flags.team[flagId] !== team || flags.state[flagId] !== FlagState.Home) return;
  if (distance(world, playerId, flagId) > PICKUP_RADIUS) return;
  if (!ownFlagHome(world, team)) return; // Failure matrix row 3: own flag away, refuse.
  captureCarriedEnemyFlags(world, playerId, team);
}

function syncCarriedPositions(world: World): void {
  for (let flagId = 0; flagId < FLAG_COUNT; flagId += 1) {
    const carrierId = world.flags.carrierId[flagId];
    if (carrierId === undefined || carrierId < 0) continue;
    const base = carrierId * 3;
    world.flags.position.set(
      [
        world.players.position[base] ?? 0,
        world.players.position[base + 1] ?? 0,
        world.players.position[base + 2] ?? 0,
      ],
      flagId * 3,
    );
  }
}

function handleTouchesAndCaptures(world: World): void {
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!world.players.active[playerId] || !world.players.alive[playerId]) continue;
    for (let flagId = 0; flagId < FLAG_COUNT; flagId += 1) {
      tryPickupOrReturn(world, playerId, flagId);
      tryCapture(world, playerId, flagId);
    }
  }
  syncCarriedPositions(world);
}

function handleReturnTimers(world: World): void {
  for (let flagId = 0; flagId < FLAG_COUNT; flagId += 1) {
    const returnAt = world.flags.returnAt[flagId] ?? -1;
    if (
      world.flags.state[flagId] === FlagState.Dropped &&
      returnAt >= 0 &&
      world.tick >= returnAt
    ) {
      returnHome(world, flagId);
    }
  }
}

/** The leading team wins; equal scores is a tie (winnerTeam 0). Checked last in `stepFlags` so
 * a capture-limit win landing on the very same tick (already handled above, in
 * `handleTouchesAndCaptures`) always takes priority -- this only fires when `gameOver` is
 * still false after everything else this tick has run. */
function checkTimeLimit(world: World): void {
  if (world.gameOver || world.tick < world.timeLimitTicks) return;
  const team1 = world.teamScores[1] ?? 0;
  const team2 = world.teamScores[2] ?? 0;
  world.gameOver = true;
  world.gameOverReason = GameOverReason.TimeLimit;
  world.winnerTeam = team1 === team2 ? 0 : team1 > team2 ? 1 : 2;
}

export function stepFlags(world: World, _dt: number): void {
  if (world.gameOver) return;
  dropCarriedFlagsOnDeath(world);
  handleTouchesAndCaptures(world);
  handleReturnTimers(world);
  checkTimeLimit(world);
}
