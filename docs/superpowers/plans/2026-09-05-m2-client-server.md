# Milestone 2: Client and Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Katabatic map runs through a local authoritative Node server. The client predicts its own player, reconciles against server snapshots, and interpolates everyone else. 31 idle bots stand in for real players. Protocol tests are green.
**Architecture:** `packages/protocol` is a dependency-free binary wire format built on `PlayerInput` and a new `PlayerSnapshotData` shape from `@clans/sim`. `packages/server` owns the authoritative `World`, runs it on a catch-up tick loop, and speaks that wire format over `ws`. `packages/client` gains a `Transport` interface, a `NetClient` that predicts and reconciles the local player, and a `RemoteBuffer` that interpolates everyone else. Milestone 1's single-player path is untouched when the client boots without a `?server=` query parameter.
**Tech Stack:** the milestone 1 stack plus `ws` (server, and a client devDependency for tests only). No new production dependency in `protocol` or `client`.
**Spec:** docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md

## Global Constraints

- Reuse `FIXED_DT` and `FIXED_TICK_MS` from `@clans/sim` everywhere a tick duration is needed. Never redefine 32 ms elsewhere.
- `packages/protocol` stays plain TypeScript with no npm runtime dependency. Its only coupling to the rest of the repo is a type-only architectural one: it imports `PlayerInput` and `PlayerSnapshotData` shapes from `@clans/sim`.
- Every multi-byte wire field is little-endian, written and read through `DataView` with the `littleEndian` flag explicit at every call.
- `packages/sim` still imports nothing from DOM, Three.js, WebSocket, or Node. All networking code lives in `protocol`, `server`, or `client`.
- The client's milestone-1 single-player path keeps working with no `?server=` query parameter: same asset load, same local `stepWorld` loop, same debug overlay.
- Server default port is 7777, the value the spec's `?server=ws://127.0.0.1:7777` example already uses. Tests that bind a real socket use a distinct fixed port so they never collide with a developer's running `pnpm dev`.
- Server world capacity is 64 slots (`createWorld(terrain, seed, 64)`), sized for 31 idle bots plus a few real clients. Later milestones raise this when CTF needs the full 32 v 32.
- Keep every new function under the existing ESLint `complexity: 10` / `max-depth: 3` budget. Split helpers the way `movement.ts` already does; do not raise the limits.
- Snapshot send rate is 1 in 2 ticks (`SNAPSHOT_EVERY_N_TICKS = 2`, about 15 Hz). Snapshot fallback to full is `SNAPSHOT_FALLBACK_MS = 1000`. Both live in `@clans/protocol` so client and server share one definition.
- Client prediction replay caps at 30 ticks (`MAX_REPLAY_TICKS = 30` in `netclient.ts`); beyond that the client hard-snaps.
- Remote player interpolation renders 100 ms behind the newest snapshot and extrapolates at most 50 ms past it, per the spec's Networking section.

## Failure matrix (from the spec)

| # | State or input | What happens | How it can fail | What the caller sees | M2 scope |
|---|---|---|---|---|---|
| 1 | Flag carried, carrier dies | flag drops, return timer starts | death position inside a wall | flag placed at nearest walkable point | N/A — flags ship in milestone 3 |
| 2 | Flag dropped, timer expires | flag returns home | picked up 1 ms before expiry | pickup cancels the timer | N/A — milestone 3 |
| 3 | Capture with own flag away | no capture | | HUD says "your flag is not home" | N/A — milestone 3 |
| 4 | Both generators dead | assets unpowered | station mid-transaction | transaction aborts, loadout kept | N/A — milestone 4 |
| 5 | Vehicle pad spawn while a vehicle exists | old vehicle destroyed | pilot inside it | pilot dismounted first, no damage | N/A — milestone 5 |
| 6 | Client input arrives out of order | | older sequence after newer | server drops it, client's replay never sees it | **Task 6** |
| 7 | Snapshot lost | | delta baseline the client never got | acks carry last received id; server never deltas against an unacked snapshot, falls back to full after 1 s | **Task 4 (mechanism), Task 6 (policy), Task 7 (acked baseline), Task 9 (client survives an undecodable delta)** |
| 8 | Client mispredicts | rewind and replay | replay would run more than 30 ticks | client hard-snaps, records a prediction error in stats | **Task 9** |
| 9 | Bot task target destroyed | bot rechooses | every task claimed | bot falls back to defend nearest asset | N/A — bot brains ship in milestone 6; M2 bots are idle stand-ins |
| 10 | Player joins mid-match | full snapshot then deltas | | player spawns after the next tick, team is the smaller one | **Task 7** |
| 11 | Server tick overruns 32 ms | | bots or collision blow the budget | server logs the overrun, skips no ticks, catches up; debug stats show it | **Task 5** |

Additional protocol/prediction tests from the spec's Testing section, mapped to the task that owns them: protocol round trip for every message → **Task 3, Task 4**; delta then apply reproduces state and hash matches → **Task 4**; scripted client at 150 ms latency / 5% loss ends a 3 s ski run within 0.5 m → **Task 9**; headless server, 32 idle bots, 5000 ticks under the 32 ms budget, reports the max → **Task 5**; Playwright entity count with `--bots 3` and `?server=` → **Task 13**.

## File structure

`packages/sim` (modify existing M1 files, add two):

- `src/types.ts`: `PlayerStore` gains `active`, `team`, `freeIds` (Task 1).
- `src/world.ts`: `addPlayer` takes a `team` parameter and reuses freed ids; new `removePlayer` (Task 1).
- `src/movement.ts`: `stepPlayers` skips inactive slots (Task 1).
- `src/world.test.ts`: extended with lifecycle tests (Task 1).
- `src/snapshot.ts`: `PlayerSnapshotData`, `serializePlayer`, `serializeActivePlayers`, `deserializePlayer` (Task 2).
- `src/snapshot.test.ts` (Task 2).
- `src/hash.ts`: `hashWorld` (Task 2).
- `src/hash.test.ts` (Task 2).
- `src/index.ts`: exports the above (Task 1, Task 2).

`packages/protocol` (all new; package.json and tsconfig.json modified once):

- `package.json`: adds `@clans/sim` as a workspace dependency (type-only use) (Task 3).
- `tsconfig.json`: adds a project reference to `../sim` (Task 3).
- `src/messages.ts`: `MessageType`, `NetInputSample`, `JoinMessage`, `WelcomeMessage`, `InputMessage`, `AckMessage` (Task 3); `SNAPSHOT_EVERY_N_TICKS`, `SNAPSHOT_FALLBACK_MS` added (Task 4).
- `src/codec.ts`: `Cursor` and the `DataView` read/write helpers (Task 3).
- `src/handshake.ts`: encode/decode for Join, Welcome, Input, Ack (Task 3).
- `src/handshake.test.ts` (Task 3).
- `src/snapshot.ts`: `SnapshotBaseline`, `DecodedSnapshot`, `encodeSnapshot`, `decodeSnapshot` (Task 4).
- `src/snapshot.test.ts` (Task 4).
- `src/index.ts` (Task 3, extended Task 4).

`packages/server` (all new; package.json modified once):

- `src/world.ts`: `SceneSpawn`, `loadKatabaticWorld`, `teamCount`, `smallerTeam`, `spawnPointFor`, `addBots` (Task 5).
- `src/world.test.ts` (Task 5).
- `src/loop.ts`: `TICK_MS`, `startTickLoop` (Task 5).
- `src/loop.test.ts` (Task 5).
- `src/cli.ts`: `parseArgs` (Task 5).
- `src/cli.test.ts` (Task 5).
- `src/bench.ts`: `runBenchmark` (Task 5).
- `src/bench.test.ts` (Task 5).
- `src/session.ts`: `Session`, `createSession`, `applyInputMessage`, `recordAck` (Task 6).
- `src/session.test.ts` (Task 6).
- `src/snapshot-policy.ts`: `needsFullSnapshot` (Task 6).
- `src/snapshot-policy.test.ts` (Task 6).
- `src/net.ts`: `startNetServer` (Task 7).
- `src/net.test.ts` (Task 7).
- `src/index.ts`: CLI entry (Task 7).
- `bin/clans-server.js` (Task 7).
- `package.json`: adds `ws`, `@types/ws`, a `bin` field (Task 7).

`packages/client` (all new files plus modifications to M1 files):

- `src/transport.ts`: `Transport`, `WebSocketTransport` (Task 8).
- `src/transport.test.ts` (Task 8).
- `package.json`: adds `ws`, `@types/ws` as devDependencies (Task 8); adds `@clans/protocol` as a dependency (Task 9).
- `src/netclient.ts`: `NetClient`, `NetClientStats` (Task 9).
- `src/netclient.test.ts` (Task 9).
- `tsconfig.json`: adds a project reference to `../protocol` (Task 9).
- `src/remote.ts`: `RemoteBuffer`, `syncRemoteMeshes` (Task 10).
- `src/remote.test.ts` (Task 10).
- `src/app.ts`: modified — `createApp` takes an optional `serverUrl`, branches prediction vs. single-player, syncs remote meshes (Task 11).
- `src/main.ts`: modified — reads `?server=` from the URL (Task 11).
- `src/stats.ts`: modified — `AppStats` and `describePlayer` gain net rows (Task 11).
- `src/stats.test.ts`: modified for the new `AppStats` shape (Task 11).

Root and e2e:

- `scripts/dev.ts`: launches server and client together (Task 12).
- `package.json`: `dev`, `dev:client`, `dev:server` scripts (Task 12).
- `e2e/server.spec.ts`: bots-only server, entity count assertion (Task 13).
- `README.md`: server run instructions, `?server=` parameter (Task 14).

## Task dependency graph

- Task 1 depends on the milestone 1 baseline only. It owns `packages/sim` player lifecycle files.
- Task 3 depends on the milestone 1 baseline only. It owns `packages/protocol` handshake files. **Task 1 and Task 3 run in parallel.**
- Task 8 depends on the milestone 1 baseline only. It owns `packages/client/src/transport.ts`. **Task 8 runs in parallel with Task 1 and Task 3.**
- Task 2 depends on Task 1. It owns `packages/sim` snapshot and hash files.
- Task 5 depends on Task 1 (the `team` parameter on `addPlayer`). It owns `packages/server` world/loop/cli/bench files. **Task 2 and Task 5 run in parallel** — different packages, no shared file.
- Task 4 depends on Task 2 and Task 3. It owns `packages/protocol/src/snapshot.ts` and extends `messages.ts`.
- Task 6 depends on Task 3 and Task 4. It owns `packages/server` session and snapshot-policy files. **Task 6 runs in parallel with the tail of Task 5** if Task 5 is still in flight — they touch no common file — but in practice finish Task 5 first since Task 7 needs both.
- Task 7 depends on Task 5 and Task 6. It owns `packages/server/src/net.ts`, `index.ts`, the bin script, and `package.json`.
- Task 9 depends on Task 1, Task 2, Task 3, Task 4, and Task 8. It owns `packages/client/src/netclient.ts`.
- Task 10 depends on Task 4. It owns `packages/client/src/remote.ts`. **Task 9 and Task 10 run in parallel** — different files, and Task 10 does not import from Task 9.
- Task 11 depends on Task 9 and Task 10. It owns `app.ts`, `main.ts`, `stats.ts`.
- Task 12 depends on Task 7 and Task 11. It owns root scripts.
- Task 13 depends on Task 7 and Task 11. It owns `e2e/server.spec.ts`. **Task 12 and Task 13 run in parallel** — different files.
- Task 14 depends on Task 12 and Task 13. It owns `README.md`.

---

### Task 1: Sim player lifecycle — teams, removal, id reuse

**Files:** Modify `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/movement.ts`, `packages/sim/src/world.test.ts`
**Interfaces:** Consumes the existing `World`, `PlayerStore`. Produces `addPlayer(world: World, spawn: Vec3, team?: number): number` (team defaults to 0, unchanged call sites still compile) and `removePlayer(world: World, id: number): void`. Changes `stepPlayers` to skip inactive slots.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sim/src/world.test.ts` (inside the existing `describe('fixed world', ...)` block, after the current two tests):

```ts
  it('assigns a default team of 0 and lets addPlayer set an explicit team', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    const b = addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    expect(world.players.team[a]).toBe(0);
    expect(world.players.team[b]).toBe(2);
  });

  it('frees a removed id and reuses it before growing the store', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 1, y: 0, z: 1 });
    const b = addPlayer(world, { x: 2, y: 0, z: 2 });
    removePlayer(world, a);
    const c = addPlayer(world, { x: 3, y: 0, z: 3 }, 1);
    expect(c).toBe(a);
    expect(world.players.active[a]).toBe(1);
    expect(world.players.position[a * 3]).toBe(3);
    expect(world.players.count).toBe(2);
    expect(b).not.toBe(c);
  });

  it('rejects removing an id that is not active', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    removePlayer(world, a);
    expect(() => removePlayer(world, a)).toThrow(RangeError);
  });

  it('skips inactive players when stepping the world', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 5, y: 0, z: 5 });
    removePlayer(world, a);
    expect(() => stepWorld(world, new Map())).not.toThrow();
    expect(world.players.position[a * 3]).toBe(5);
  });
```

Add `addPlayer` and `removePlayer` to the existing import line at the top of the file:

```ts
import { addPlayer, createWorld, nextRandom, removePlayer, stepWorld, type Heightfield } from './index.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- world.test.ts`. Expect `removePlayer` to be undefined and the team assertions to fail (no `team` field yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/sim/src/types.ts`, change the `PlayerStore` interface:

```ts
export interface PlayerStore {
  count: number;
  freeIds: number[];
  active: Uint8Array;
  team: Uint8Array;
  position: Float64Array;
  velocity: Float64Array;
  yaw: Float64Array;
  energy: Float64Array;
  onGround: Uint8Array;
  ski: Uint8Array;
  wasGrounded: Uint8Array;
  wasJumpHeld: Uint8Array;
  landingSpeed: Float64Array;
}
```

In `packages/sim/src/world.ts`, replace `createWorld` and `addPlayer`, and add `removePlayer`:

```ts
export function createWorld(terrain: Heightfield, seed: number, capacity = 32): World {
  return {
    tick: 0,
    random: { value: seed || 1 },
    terrain,
    players: {
      count: 0,
      freeIds: [],
      active: new Uint8Array(capacity),
      team: new Uint8Array(capacity),
      position: new Float64Array(capacity * 3),
      velocity: new Float64Array(capacity * 3),
      yaw: new Float64Array(capacity),
      energy: new Float64Array(capacity),
      onGround: new Uint8Array(capacity),
      ski: new Uint8Array(capacity),
      wasGrounded: new Uint8Array(capacity),
      wasJumpHeld: new Uint8Array(capacity),
      landingSpeed: new Float64Array(capacity),
    },
  };
}

export function addPlayer(world: World, spawn: Vec3, team = 0): number {
  const players = world.players;
  const id = players.freeIds.pop() ?? players.count;
  if (id >= players.energy.length) throw new RangeError('Player capacity exceeded');
  if (id === players.count) players.count += 1;
  players.active[id] = 1;
  players.team[id] = team;
  players.position.set([spawn.x, spawn.y, spawn.z], id * 3);
  players.velocity.set([0, 0, 0], id * 3);
  players.yaw[id] = 0;
  players.energy[id] = 60;
  players.onGround[id] = 0;
  players.ski[id] = 0;
  players.wasGrounded[id] = 0;
  players.wasJumpHeld[id] = 0;
  players.landingSpeed[id] = 0;
  return id;
}

export function removePlayer(world: World, id: number): void {
  const players = world.players;
  if (id < 0 || id >= players.count || !players.active[id]) {
    throw new RangeError(`Cannot remove inactive player ${String(id)}`);
  }
  players.active[id] = 0;
  players.freeIds.push(id);
}
```

In `packages/sim/src/movement.ts`, change the loop in `stepPlayers` to skip inactive slots:

```ts
export function stepPlayers(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id]) continue;
    const input = inputs.get(id) ?? { ...IDLE, yaw: world.players.yaw[id] ?? 0 };
    stepPlayer(world, id, input, LIGHT_ARMOR, dt);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`. The full sim suite (`world.test.ts`, `movement.test.ts`, `terrain.test.ts`) must stay green — `addPlayer`'s default `team = 0` keeps every M1 call site compiling unchanged.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/movement.ts packages/sim/src/world.test.ts
git commit -m "feat(sim): add player teams, removal, and id reuse" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 2: Sim player serialization and world hash

**Files:** Create `packages/sim/src/snapshot.ts`, `packages/sim/src/snapshot.test.ts`, `packages/sim/src/hash.ts`, `packages/sim/src/hash.test.ts`; Modify `packages/sim/src/index.ts`
**Interfaces:** Consumes `World`, `PlayerStore` from Task 1 (needs `active`, `team`). Produces `PlayerSnapshotData`, `serializePlayer(world, id): PlayerSnapshotData`, `serializeActivePlayers(world): PlayerSnapshotData[]`, `deserializePlayer(world, data): void`, `hashWorld(world): number`.

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addPlayer, createWorld, deserializePlayer, removePlayer, serializeActivePlayers,
  serializePlayer, type Heightfield,
} from './index.js';

const terrain: Heightfield = {
  gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('player snapshots', () => {
  it('serializes only what the protocol needs', () => {
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 }, 1);
    world.players.velocity.set([4, 5, 6], id * 3);
    world.players.yaw[id] = 0.5;
    world.players.energy[id] = 40;
    world.players.onGround[id] = 1;
    expect(serializePlayer(world, id)).toEqual({
      id, team: 1, x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6, yaw: 0.5, energy: 40, onGround: 1, ski: 0,
    });
  });

  it('serializes only active players', () => {
    const world = createWorld(terrain, 1);
    const a = addPlayer(world, { x: 0, y: 0, z: 0 });
    addPlayer(world, { x: 1, y: 0, z: 0 });
    removePlayer(world, a);
    expect(serializeActivePlayers(world).map((p) => p.id)).toEqual([1]);
  });

  it('deserializes back into an equivalent player, growing the store if needed', () => {
    const world = createWorld(terrain, 1);
    deserializePlayer(world, {
      id: 3, team: 2, x: 9, y: 0, z: 9, vx: 1, vy: 0, vz: 0, yaw: 1, energy: 30, onGround: 0, ski: 1,
    });
    expect(world.players.count).toBe(4);
    expect(world.players.active[3]).toBe(1);
    expect(serializePlayer(world, 3)).toEqual({
      id: 3, team: 2, x: 9, y: 0, z: 9, vx: 1, vy: 0, vz: 0, yaw: 1, energy: 30, onGround: 0, ski: 1,
    });
  });
});
```

Create `packages/sim/src/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addPlayer, createWorld, deserializePlayer, hashWorld, serializeActivePlayers, type Heightfield,
} from './index.js';

const terrain: Heightfield = {
  gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('hashWorld', () => {
  it('matches for two worlds with the same tick and player state', () => {
    const a = createWorld(terrain, 1);
    addPlayer(a, { x: 1, y: 2, z: 3 }, 1);
    const b = createWorld(terrain, 99); // different seed, identical players
    addPlayer(b, { x: 1, y: 2, z: 3 }, 1);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('changes when a player moves, including moves that only touch high bits', () => {
    const world = createWorld(terrain, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    const before = hashWorld(world);
    world.players.position[id * 3] = 1.5;
    expect(hashWorld(world)).not.toBe(before);
    // 100.000 m and 165.536 m differ only above the low 16 bits of the millimetre value.
    world.players.position[id * 3] = 100;
    const at100 = hashWorld(world);
    world.players.position[id * 3] = 165.536;
    expect(hashWorld(world)).not.toBe(at100);
  });

  it('reproduces the hash after a serialize and deserialize round trip', () => {
    const source = createWorld(terrain, 1);
    const id = addPlayer(source, { x: 10, y: 0, z: -5 }, 2);
    source.players.velocity.set([3, -1, 2], id * 3);
    source.players.yaw[id] = 1.2;
    source.players.energy[id] = 55;
    const target = createWorld(terrain, 1);
    target.tick = source.tick;
    for (const player of serializeActivePlayers(source)) deserializePlayer(target, player);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- snapshot.test.ts hash.test.ts`. Expect module resolution to fail for `./snapshot.js` and `./hash.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/snapshot.ts`:

```ts
import type { PlayerStore, World } from './types.js';

export interface PlayerSnapshotData {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  energy: number;
  onGround: 0 | 1;
  ski: 0 | 1;
}

export function serializePlayer(world: World, id: number): PlayerSnapshotData {
  const p = world.players;
  const base = id * 3;
  return {
    id,
    team: p.team[id] ?? 0,
    x: p.position[base] ?? 0, y: p.position[base + 1] ?? 0, z: p.position[base + 2] ?? 0,
    vx: p.velocity[base] ?? 0, vy: p.velocity[base + 1] ?? 0, vz: p.velocity[base + 2] ?? 0,
    yaw: p.yaw[id] ?? 0,
    energy: p.energy[id] ?? 0,
    onGround: (p.onGround[id] ?? 0) ? 1 : 0,
    ski: (p.ski[id] ?? 0) ? 1 : 0,
  };
}

export function serializeActivePlayers(world: World): PlayerSnapshotData[] {
  const out: PlayerSnapshotData[] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (world.players.active[id]) out.push(serializePlayer(world, id));
  }
  return out;
}

function growTo(players: PlayerStore, id: number): void {
  if (id >= players.energy.length) throw new RangeError(`Player id ${String(id)} exceeds store capacity`);
  while (players.count <= id) {
    players.active[players.count] = 0;
    players.count += 1;
  }
}

/** Writes a snapshot into its own id slot, growing the store if the id has not been seen yet. */
export function deserializePlayer(world: World, data: PlayerSnapshotData): void {
  const players = world.players;
  growTo(players, data.id);
  players.active[data.id] = 1;
  players.team[data.id] = data.team;
  players.position.set([data.x, data.y, data.z], data.id * 3);
  players.velocity.set([data.vx, data.vy, data.vz], data.id * 3);
  players.yaw[data.id] = data.yaw;
  players.energy[data.id] = data.energy;
  players.onGround[data.id] = data.onGround;
  players.ski[data.id] = data.ski;
}
```

Create `packages/sim/src/hash.ts`:

```ts
import type { World } from './types.js';

const FNV_PRIME = 0x01000193;

/**
 * Folds one number into the running hash. Positions and velocities are rounded to the
 * millimetre before mixing: the wire format quantizes them to f32, and at the map's
 * largest coordinates f32 round trip error stays under 0.001 m, so this rounding survives
 * an encode/decode cycle without changing the hash.
 */
function mix(hash: number, value: number): number {
  // All four bytes of the millimetre integer: positions reach 1024 m (20 bits).
  const bits = Math.round(value * 1000) | 0;
  let h = hash;
  for (let shift = 0; shift < 32; shift += 8) {
    h = (h ^ ((bits >>> shift) & 0xff)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

export function hashWorld(world: World): number {
  let hash = 0x811c9dc5;
  hash = mix(hash, world.tick);
  const p = world.players;
  for (let id = 0; id < p.count; id += 1) {
    if (!p.active[id]) continue;
    const base = id * 3;
    hash = mix(hash, id);
    hash = mix(hash, p.team[id] ?? 0);
    hash = mix(hash, p.position[base] ?? 0);
    hash = mix(hash, p.position[base + 1] ?? 0);
    hash = mix(hash, p.position[base + 2] ?? 0);
    hash = mix(hash, p.velocity[base] ?? 0);
    hash = mix(hash, p.velocity[base + 1] ?? 0);
    hash = mix(hash, p.velocity[base + 2] ?? 0);
    hash = mix(hash, p.yaw[id] ?? 0);
    hash = mix(hash, p.energy[id] ?? 0);
  }
  return hash >>> 0;
}
```

Add to `packages/sim/src/index.ts`:

```ts
export * from './hash.js';
export * from './snapshot.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/snapshot.ts packages/sim/src/snapshot.test.ts packages/sim/src/hash.ts packages/sim/src/hash.test.ts packages/sim/src/index.ts
git commit -m "feat(sim): serialize players and hash world state" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 3: Protocol join, welcome, input, and ack codec

**Files:** Create `packages/protocol/src/messages.ts`, `packages/protocol/src/codec.ts`, `packages/protocol/src/handshake.ts`, `packages/protocol/src/handshake.test.ts`, `packages/protocol/src/index.ts`; Modify `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
**Interfaces:** Consumes `PlayerInput` from `@clans/sim` (type only). Produces `MessageType`, `NetInputSample`, `JoinMessage`, `WelcomeMessage`, `InputMessage`, `AckMessage`, `Cursor`, `createWriter`/`createReader`, `writeU8`/`readU8`/`writeU16`/`readU16`/`writeU32`/`readU32`/`writeF32`/`readF32`, `bytesOf`, `encodeJoin`/`decodeJoin`, `encodeWelcome`/`decodeWelcome`, `encodeInput`/`decodeInput`, `encodeAck`/`decodeAck`, `INPUT_MESSAGE_BYTES`.

- [ ] **Step 1: Write the failing test**

Change `packages/protocol/package.json` scripts block to add the sim dependency:

```json
{
  "name": "@clans/protocol",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@clans/sim": "workspace:*"
  }
}
```

Change `packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "tsBuildInfoFile": "dist/.tsbuildinfo" },
  "include": ["src"],
  "references": [{ "path": "../sim" }]
}
```

Create `packages/protocol/src/handshake.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeAck, decodeInput, decodeJoin, decodeWelcome,
  encodeAck, encodeInput, encodeJoin, encodeWelcome,
} from './handshake.js';
import { MessageType, type InputMessage } from './messages.js';

describe('handshake codec', () => {
  it('round-trips a Join message', () => {
    expect(decodeJoin(encodeJoin())).toEqual({ type: MessageType.Join });
  });

  it('round-trips a Welcome message', () => {
    const bytes = encodeWelcome({ playerId: 5, team: 2, tickMs: 32 });
    expect(decodeWelcome(bytes)).toEqual({ type: MessageType.Welcome, playerId: 5, team: 2, tickMs: 32 });
  });

  it('round-trips an Input message with three distinct redundant samples', () => {
    const message: Omit<InputMessage, 'type'> = {
      sequence: 42,
      samples: [
        { moveX: 1, moveZ: -1, yaw: 0.5, jump: true, jet: false },
        { moveX: 0, moveZ: 1, yaw: 0.25, jump: false, jet: true },
        { moveX: -1, moveZ: 0, yaw: -0.5, jump: false, jet: false },
      ],
    };
    const decoded = decodeInput(encodeInput(message));
    expect(decoded.sequence).toBe(42);
    expect(decoded.samples).toEqual(message.samples);
  });

  it('round-trips an Ack message', () => {
    expect(decodeAck(encodeAck({ snapshotId: 777 }))).toEqual({ type: MessageType.Ack, snapshotId: 777 });
  });

  it('rejects decoding bytes tagged as the wrong message type', () => {
    expect(() => decodeAck(encodeJoin())).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/protocol test -- handshake.test.ts`. Expect module resolution to fail for `./handshake.js` and `./messages.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/protocol/src/messages.ts`:

```ts
import type { PlayerInput } from '@clans/sim';

export enum MessageType {
  Join = 1,
  Welcome = 2,
  Input = 3,
  Snapshot = 4,
  Ack = 5,
}

/** The wire shape of one tick's input is identical to the sim's own PlayerInput. */
export type NetInputSample = PlayerInput;

export interface JoinMessage {
  type: MessageType.Join;
}
export interface WelcomeMessage {
  type: MessageType.Welcome;
  playerId: number;
  team: number;
  tickMs: number;
}
export interface InputMessage {
  type: MessageType.Input;
  sequence: number;
  samples: [NetInputSample, NetInputSample, NetInputSample];
}
export interface AckMessage {
  type: MessageType.Ack;
  snapshotId: number;
}
```

Create `packages/protocol/src/codec.ts`:

```ts
export interface Cursor {
  view: DataView;
  offset: number;
}

export function createWriter(byteLength: number): Cursor {
  return { view: new DataView(new ArrayBuffer(byteLength)), offset: 0 };
}
export function createReader(bytes: Uint8Array): Cursor {
  return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
}

export function writeU8(cursor: Cursor, value: number): void {
  cursor.view.setUint8(cursor.offset, value);
  cursor.offset += 1;
}
export function readU8(cursor: Cursor): number {
  const value = cursor.view.getUint8(cursor.offset);
  cursor.offset += 1;
  return value;
}
export function writeU16(cursor: Cursor, value: number): void {
  cursor.view.setUint16(cursor.offset, value, true);
  cursor.offset += 2;
}
export function readU16(cursor: Cursor): number {
  const value = cursor.view.getUint16(cursor.offset, true);
  cursor.offset += 2;
  return value;
}
export function writeU32(cursor: Cursor, value: number): void {
  cursor.view.setUint32(cursor.offset, value, true);
  cursor.offset += 4;
}
export function readU32(cursor: Cursor): number {
  const value = cursor.view.getUint32(cursor.offset, true);
  cursor.offset += 4;
  return value;
}
export function writeF32(cursor: Cursor, value: number): void {
  cursor.view.setFloat32(cursor.offset, value, true);
  cursor.offset += 4;
}
export function readF32(cursor: Cursor): number {
  const value = cursor.view.getFloat32(cursor.offset, true);
  cursor.offset += 4;
  return value;
}
export function bytesOf(cursor: Cursor): Uint8Array {
  return new Uint8Array(cursor.view.buffer, cursor.view.byteOffset, cursor.offset);
}
```

Create `packages/protocol/src/handshake.ts`:

```ts
import {
  bytesOf, createReader, createWriter, readF32, readU16, readU32, readU8,
  writeF32, writeU16, writeU32, writeU8, type Cursor,
} from './codec.js';
import {
  MessageType, type AckMessage, type InputMessage, type JoinMessage, type NetInputSample, type WelcomeMessage,
} from './messages.js';

const SAMPLE_BYTES = 13; // moveX, moveZ, yaw (f32 each) plus one flags byte
export const INPUT_MESSAGE_BYTES = 1 + 4 + SAMPLE_BYTES * 3;

function expectType(cursor: Cursor, expected: MessageType): void {
  const type = readU8(cursor);
  if (type !== expected) throw new RangeError(`Expected message type ${String(expected)}, got ${String(type)}`);
}

function writeSample(cursor: Cursor, sample: NetInputSample): void {
  writeF32(cursor, sample.moveX);
  writeF32(cursor, sample.moveZ);
  writeF32(cursor, sample.yaw);
  writeU8(cursor, (sample.jump ? 1 : 0) | (sample.jet ? 2 : 0));
}
function readSample(cursor: Cursor): NetInputSample {
  const moveX = readF32(cursor);
  const moveZ = readF32(cursor);
  const yaw = readF32(cursor);
  const flags = readU8(cursor);
  return { moveX, moveZ, yaw, jump: (flags & 1) !== 0, jet: (flags & 2) !== 0 };
}

export function encodeJoin(): Uint8Array {
  const cursor = createWriter(1);
  writeU8(cursor, MessageType.Join);
  return bytesOf(cursor);
}
export function decodeJoin(bytes: Uint8Array): JoinMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Join);
  return { type: MessageType.Join };
}

export function encodeWelcome(message: Omit<WelcomeMessage, 'type'>): Uint8Array {
  const cursor = createWriter(6);
  writeU8(cursor, MessageType.Welcome);
  writeU16(cursor, message.playerId);
  writeU8(cursor, message.team);
  writeU16(cursor, message.tickMs);
  return bytesOf(cursor);
}
export function decodeWelcome(bytes: Uint8Array): WelcomeMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Welcome);
  return { type: MessageType.Welcome, playerId: readU16(cursor), team: readU8(cursor), tickMs: readU16(cursor) };
}

export function encodeInput(message: Omit<InputMessage, 'type'>): Uint8Array {
  const cursor = createWriter(INPUT_MESSAGE_BYTES);
  writeU8(cursor, MessageType.Input);
  writeU32(cursor, message.sequence);
  for (const sample of message.samples) writeSample(cursor, sample);
  return bytesOf(cursor);
}
export function decodeInput(bytes: Uint8Array): InputMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Input);
  const sequence = readU32(cursor);
  const samples: [NetInputSample, NetInputSample, NetInputSample] = [
    readSample(cursor), readSample(cursor), readSample(cursor),
  ];
  return { type: MessageType.Input, sequence, samples };
}

export function encodeAck(message: Omit<AckMessage, 'type'>): Uint8Array {
  const cursor = createWriter(5);
  writeU8(cursor, MessageType.Ack);
  writeU32(cursor, message.snapshotId);
  return bytesOf(cursor);
}
export function decodeAck(bytes: Uint8Array): AckMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Ack);
  return { type: MessageType.Ack, snapshotId: readU32(cursor) };
}
```

Create `packages/protocol/src/index.ts`:

```ts
export * from './codec.js';
export * from './handshake.js';
export * from './messages.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm install && pnpm --filter @clans/protocol test && pnpm typecheck && pnpm lint`. `pnpm install` picks up the new workspace dependency edge.

- [ ] **Step 5: Commit**

```sh
git add packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/src pnpm-lock.yaml
git commit -m "feat(protocol): binary codec for join, welcome, input, and ack" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 4: Protocol snapshot codec — full, delta, and fallback

**Files:** Create `packages/protocol/src/snapshot.ts`, `packages/protocol/src/snapshot.test.ts`; Modify `packages/protocol/src/messages.ts`, `packages/protocol/src/index.ts`
**Interfaces:** Consumes `PlayerSnapshotData` from `@clans/sim` (Task 2, type only), `Cursor` and the codec helpers (Task 3). Produces `SNAPSHOT_EVERY_N_TICKS`, `SNAPSHOT_FALLBACK_MS`, `SnapshotBaseline`, `DecodedSnapshot`, `encodeSnapshot(snapshotId, tick, lastInputSequence, players, baseline): Uint8Array`, `decodeSnapshot(bytes, baseline): DecodedSnapshot`. Covers failure matrix row 7 (mechanism half).

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addPlayer, createWorld, deserializePlayer, hashWorld, removePlayer, serializeActivePlayers,
  type Heightfield, type PlayerSnapshotData, type World,
} from '@clans/sim';
import { decodeSnapshot, encodeSnapshot } from './snapshot.js';

const terrain: Heightfield = {
  gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1,
  heights: new Uint16Array(4),
};

function applyTo(target: World, tick: number, players: PlayerSnapshotData[]): void {
  target.tick = tick;
  for (const player of players) deserializePlayer(target, player);
}

describe('snapshot codec', () => {
  it('round-trips a full snapshot and reproduces the world hash', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 1, y: 2, z: 3 }, 1);
    addPlayer(source, { x: 4, y: 5, z: 6 }, 2);
    source.tick = 10;
    const players = serializeActivePlayers(source);
    const bytes = encodeSnapshot(1, source.tick, 0, players, null);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.baselineId).toBe(0);
    const target = createWorld(terrain, 1);
    applyTo(target, decoded.tick, decoded.players);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('applies a delta against a known baseline and reproduces the state', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(source, { x: 10, y: 0, z: 0 }, 2);
    source.tick = 1;
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null);

    source.players.position[a * 3] = 5;
    const c = addPlayer(source, { x: 20, y: 0, z: 0 }, 1);
    source.tick = 2;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, source.tick, 0, nextPlayers, { snapshotId: 1, players: baselinePlayers });

    const decodedBaseline = decodeSnapshot(baselineBytes, null);
    const decoded = decodeSnapshot(deltaBytes, { snapshotId: 1, players: decodedBaseline.players });
    expect(decoded.baselineId).toBe(1);
    const target = createWorld(terrain, 1);
    applyTo(target, decoded.tick, decoded.players);
    expect(hashWorld(target)).toBe(hashWorld(source));
    expect(decoded.players.find((p) => p.id === c)?.x).toBe(20);
  });

  it('marks a removed player and drops it from the reconstructed state', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const b = addPlayer(source, { x: 1, y: 0, z: 0 }, 2);
    const baselinePlayers = serializeActivePlayers(source);
    removePlayer(source, b);
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 5, 0, nextPlayers, { snapshotId: 1, players: baselinePlayers });
    const decoded = decodeSnapshot(deltaBytes, { snapshotId: 1, players: baselinePlayers });
    expect(decoded.removedIds).toEqual([b]);
    expect(decoded.players.map((p) => p.id)).toEqual([a]);
  });

  it('throws when a delta arrives for a baseline the caller does not have', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const players = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 1, 0, players, { snapshotId: 1, players });
    expect(() => decodeSnapshot(deltaBytes, null)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/protocol test -- snapshot.test.ts`. Expect module resolution to fail for `./snapshot.js`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/protocol/src/messages.ts` (append, do not remove anything):

```ts
export const SNAPSHOT_EVERY_N_TICKS = 2;
export const SNAPSHOT_FALLBACK_MS = 1000;
```

Create `packages/protocol/src/snapshot.ts`:

```ts
import type { PlayerSnapshotData } from '@clans/sim';
import {
  bytesOf, createReader, createWriter, readF32, readU16, readU32, readU8,
  writeF32, writeU16, writeU32, writeU8, type Cursor,
} from './codec.js';
import { MessageType } from './messages.js';

export interface SnapshotBaseline {
  snapshotId: number;
  players: PlayerSnapshotData[];
}
export interface DecodedSnapshot {
  snapshotId: number;
  baselineId: number;
  tick: number;
  lastInputSequence: number;
  players: PlayerSnapshotData[];
  removedIds: number[];
}

const HEADER_BYTES = 1 + 4 + 4 + 4 + 4 + 1; // type, snapshotId, baselineId, tick, lastInputSequence, flags
const PLAYER_FULL_BYTES = 2 + 1 + 4 * 7 + 4 + 1; // id, team, 7 f32 (transform), energy f32, status byte
const DELTA_FLAG = 1;
const DIRTY_TRANSFORM = 1;
const DIRTY_ENERGY = 2;
const DIRTY_STATUS = 4;
const DIRTY_TEAM = 8;
const EPSILON = 1e-4;

interface SnapshotHeader {
  snapshotId: number;
  baselineId: number;
  tick: number;
  lastInputSequence: number;
  flags: number;
}

function writeHeader(cursor: Cursor, header: SnapshotHeader): void {
  writeU8(cursor, MessageType.Snapshot);
  writeU32(cursor, header.snapshotId);
  writeU32(cursor, header.baselineId);
  writeU32(cursor, header.tick);
  writeU32(cursor, header.lastInputSequence);
  writeU8(cursor, header.flags);
}
function readHeader(cursor: Cursor): SnapshotHeader {
  const type = readU8(cursor);
  if (type !== MessageType.Snapshot) throw new RangeError(`Expected Snapshot, got type ${String(type)}`);
  return {
    snapshotId: readU32(cursor), baselineId: readU32(cursor), tick: readU32(cursor),
    lastInputSequence: readU32(cursor), flags: readU8(cursor),
  };
}

function statusByte(data: PlayerSnapshotData): number {
  return (data.onGround ? 1 : 0) | (data.ski ? 2 : 0);
}

function writePlayerFull(cursor: Cursor, data: PlayerSnapshotData): void {
  writeU16(cursor, data.id);
  writeU8(cursor, data.team);
  writeF32(cursor, data.x); writeF32(cursor, data.y); writeF32(cursor, data.z);
  writeF32(cursor, data.vx); writeF32(cursor, data.vy); writeF32(cursor, data.vz);
  writeF32(cursor, data.yaw);
  writeF32(cursor, data.energy);
  writeU8(cursor, statusByte(data));
}
function readPlayerFull(cursor: Cursor): PlayerSnapshotData {
  const id = readU16(cursor);
  const team = readU8(cursor);
  const x = readF32(cursor), y = readF32(cursor), z = readF32(cursor);
  const vx = readF32(cursor), vy = readF32(cursor), vz = readF32(cursor);
  const yaw = readF32(cursor);
  const energy = readF32(cursor);
  const flags = readU8(cursor);
  return { id, team, x, y, z, vx, vy, vz, yaw, energy, onGround: flags & 1 ? 1 : 0, ski: flags & 2 ? 1 : 0 };
}

function encodeFullSnapshot(
  snapshotId: number, tick: number, lastInputSequence: number, players: PlayerSnapshotData[],
): Uint8Array {
  const cursor = createWriter(HEADER_BYTES + 2 + players.length * PLAYER_FULL_BYTES);
  writeHeader(cursor, { snapshotId, baselineId: 0, tick, lastInputSequence, flags: 0 });
  writeU16(cursor, players.length);
  for (const player of players) writePlayerFull(cursor, player);
  return bytesOf(cursor);
}

function transformChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return (
    Math.abs(a.x - b.x) > EPSILON ||
    Math.abs(a.y - b.y) > EPSILON ||
    Math.abs(a.z - b.z) > EPSILON ||
    Math.abs(a.vx - b.vx) > EPSILON ||
    Math.abs(a.vy - b.vy) > EPSILON ||
    Math.abs(a.vz - b.vz) > EPSILON ||
    Math.abs(a.yaw - b.yaw) > EPSILON
  );
}
function dirtyMask(current: PlayerSnapshotData, previous: PlayerSnapshotData): number {
  let mask = 0;
  if (transformChanged(current, previous)) mask |= DIRTY_TRANSFORM;
  if (Math.abs(current.energy - previous.energy) > EPSILON) mask |= DIRTY_ENERGY;
  if (current.onGround !== previous.onGround || current.ski !== previous.ski) mask |= DIRTY_STATUS;
  if (current.team !== previous.team) mask |= DIRTY_TEAM;
  return mask;
}

interface SnapshotDiff {
  added: PlayerSnapshotData[];
  changed: Array<{ data: PlayerSnapshotData; mask: number }>;
  removedIds: number[];
}
function diffPlayers(current: PlayerSnapshotData[], previous: PlayerSnapshotData[]): SnapshotDiff {
  const previousById = new Map(previous.map((player) => [player.id, player]));
  const currentIds = new Set(current.map((player) => player.id));
  const added: PlayerSnapshotData[] = [];
  const changed: Array<{ data: PlayerSnapshotData; mask: number }> = [];
  for (const player of current) {
    const before = previousById.get(player.id);
    if (!before) { added.push(player); continue; }
    const mask = dirtyMask(player, before);
    if (mask !== 0) changed.push({ data: player, mask });
  }
  const removedIds = previous.filter((player) => !currentIds.has(player.id)).map((player) => player.id);
  return { added, changed, removedIds };
}

function changedRecordBytes(mask: number): number {
  let bytes = 3; // id (2) + mask (1)
  if (mask & DIRTY_TRANSFORM) bytes += 28;
  if (mask & DIRTY_ENERGY) bytes += 4;
  if (mask & DIRTY_STATUS) bytes += 1;
  if (mask & DIRTY_TEAM) bytes += 1;
  return bytes;
}
function writeChangedPlayer(cursor: Cursor, data: PlayerSnapshotData, mask: number): void {
  writeU16(cursor, data.id);
  writeU8(cursor, mask);
  if (mask & DIRTY_TRANSFORM) {
    writeF32(cursor, data.x); writeF32(cursor, data.y); writeF32(cursor, data.z);
    writeF32(cursor, data.vx); writeF32(cursor, data.vy); writeF32(cursor, data.vz);
    writeF32(cursor, data.yaw);
  }
  if (mask & DIRTY_ENERGY) writeF32(cursor, data.energy);
  if (mask & DIRTY_STATUS) writeU8(cursor, statusByte(data));
  if (mask & DIRTY_TEAM) writeU8(cursor, data.team);
}

function encodeDeltaSnapshot(
  snapshotId: number, tick: number, lastInputSequence: number,
  baseline: SnapshotBaseline, players: PlayerSnapshotData[],
): Uint8Array {
  const diff = diffPlayers(players, baseline.players);
  const changedBytes = diff.changed.reduce((sum, entry) => sum + changedRecordBytes(entry.mask), 0);
  const bodyBytes = 2 + diff.added.length * PLAYER_FULL_BYTES + 2 + changedBytes + 2 + diff.removedIds.length * 2;
  const cursor = createWriter(HEADER_BYTES + bodyBytes);
  writeHeader(cursor, { snapshotId, baselineId: baseline.snapshotId, tick, lastInputSequence, flags: DELTA_FLAG });
  writeU16(cursor, diff.added.length);
  for (const player of diff.added) writePlayerFull(cursor, player);
  writeU16(cursor, diff.changed.length);
  for (const entry of diff.changed) writeChangedPlayer(cursor, entry.data, entry.mask);
  writeU16(cursor, diff.removedIds.length);
  for (const id of diff.removedIds) writeU16(cursor, id);
  return bytesOf(cursor);
}

export function encodeSnapshot(
  snapshotId: number, tick: number, lastInputSequence: number,
  players: PlayerSnapshotData[], baseline: SnapshotBaseline | null,
): Uint8Array {
  return baseline
    ? encodeDeltaSnapshot(snapshotId, tick, lastInputSequence, baseline, players)
    : encodeFullSnapshot(snapshotId, tick, lastInputSequence, players);
}

function decodeFull(cursor: Cursor, header: SnapshotHeader): DecodedSnapshot {
  const count = readU16(cursor);
  const players: PlayerSnapshotData[] = [];
  for (let i = 0; i < count; i += 1) players.push(readPlayerFull(cursor));
  return {
    snapshotId: header.snapshotId, baselineId: 0, tick: header.tick,
    lastInputSequence: header.lastInputSequence, players, removedIds: [],
  };
}

function applyChangedPlayer(cursor: Cursor, byId: Map<number, PlayerSnapshotData>): void {
  const id = readU16(cursor);
  const mask = readU8(cursor);
  const before = byId.get(id);
  if (!before) throw new RangeError(`Changed player ${String(id)} missing from baseline`);
  const next: PlayerSnapshotData = { ...before };
  if (mask & DIRTY_TRANSFORM) {
    next.x = readF32(cursor); next.y = readF32(cursor); next.z = readF32(cursor);
    next.vx = readF32(cursor); next.vy = readF32(cursor); next.vz = readF32(cursor);
    next.yaw = readF32(cursor);
  }
  if (mask & DIRTY_ENERGY) next.energy = readF32(cursor);
  if (mask & DIRTY_STATUS) {
    const flags = readU8(cursor);
    next.onGround = flags & 1 ? 1 : 0;
    next.ski = flags & 2 ? 1 : 0;
  }
  if (mask & DIRTY_TEAM) next.team = readU8(cursor);
  byId.set(id, next);
}

function decodeDelta(cursor: Cursor, header: SnapshotHeader, baseline: SnapshotBaseline | null): DecodedSnapshot {
  if (!baseline || baseline.snapshotId !== header.baselineId) {
    throw new RangeError(`Delta snapshot needs baseline ${String(header.baselineId)}`);
  }
  const byId = new Map(baseline.players.map((player) => [player.id, player]));
  const addedCount = readU16(cursor);
  for (let i = 0; i < addedCount; i += 1) {
    const player = readPlayerFull(cursor);
    byId.set(player.id, player);
  }
  const changedCount = readU16(cursor);
  for (let i = 0; i < changedCount; i += 1) applyChangedPlayer(cursor, byId);
  const removedCount = readU16(cursor);
  const removedIds: number[] = [];
  for (let i = 0; i < removedCount; i += 1) {
    const id = readU16(cursor);
    byId.delete(id);
    removedIds.push(id);
  }
  return {
    snapshotId: header.snapshotId, baselineId: header.baselineId, tick: header.tick,
    lastInputSequence: header.lastInputSequence, players: [...byId.values()], removedIds,
  };
}

export function decodeSnapshot(bytes: Uint8Array, baseline: SnapshotBaseline | null): DecodedSnapshot {
  const cursor = createReader(bytes);
  const header = readHeader(cursor);
  return header.flags & DELTA_FLAG ? decodeDelta(cursor, header, baseline) : decodeFull(cursor, header);
}
```

Add to `packages/protocol/src/index.ts`:

```ts
export * from './snapshot.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/protocol test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/protocol/src/messages.ts packages/protocol/src/snapshot.ts packages/protocol/src/snapshot.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): full and delta snapshot codec" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 5: Server core — world bootstrap, catch-up tick loop, CLI flags, headless benchmark

**Files:** Create `packages/server/src/world.ts`, `packages/server/src/world.test.ts`, `packages/server/src/loop.ts`, `packages/server/src/loop.test.ts`, `packages/server/src/cli.ts`, `packages/server/src/cli.test.ts`, `packages/server/src/bench.ts`, `packages/server/src/bench.test.ts`
**Interfaces:** Consumes `addPlayer`, `createWorld`, `FIXED_TICK_MS`, `stepWorld` from `@clans/sim` (Task 1). Produces `SceneSpawn`, `loadKatabaticWorld(seed?)`, `teamCount(world, team)`, `smallerTeam(world)`, `spawnPointFor(spawns, team, index)`, `addBots(world, spawns, count)`, `TICK_MS`, `startTickLoop(options)`, `TickLoop`, `parseArgs(argv)`, `ServerOptions`, `runBenchmark(world, ticks)`. Covers failure matrix row 11 (tick overrun) and the headless-bot-benchmark test.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/world.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { addBots, loadKatabaticWorld, smallerTeam, spawnPointFor, teamCount, type SceneSpawn } from './world.js';

const terrain: Heightfield = {
  gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('server world bootstrap', () => {
  it('loads the committed Katabatic terrain and scene', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    expect(world.terrain.gridSize).toBe(256);
    expect(spawns.filter((s) => s.team === 1)).toHaveLength(2);
    expect(spawns.filter((s) => s.team === 2)).toHaveLength(2);
  });

  it('picks the team with fewer active players, team 1 on a tie', () => {
    const world = createWorld(terrain, 1);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(smallerTeam(world)).toBe(2);
    addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    expect(smallerTeam(world)).toBe(1);
  });

  it('cycles spawn points within a team by index', () => {
    const spawns: SceneSpawn[] = [
      { name: null, team: 1, position: [1, 0, 1], radius: 5 },
      { name: null, team: 1, position: [2, 0, 2], radius: 5 },
    ];
    expect(spawnPointFor(spawns, 1, 0)).toEqual([1, 0, 1]);
    expect(spawnPointFor(spawns, 1, 1)).toEqual([2, 0, 2]);
    expect(spawnPointFor(spawns, 1, 2)).toEqual([1, 0, 1]);
  });

  it('adds N idle bots balanced across both teams at real spawn points', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    const ids = addBots(world, spawns, 4);
    expect(ids).toHaveLength(4);
    expect(teamCount(world, 1)).toBe(2);
    expect(teamCount(world, 2)).toBe(2);
  });
});
```

Create `packages/server/src/loop.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TICK_MS, startTickLoop } from './loop.js';

describe('startTickLoop', () => {
  it('runs one tick per scheduled interval with no overrun', () => {
    let clock = 0;
    const ticks: number[] = [];
    const overruns: unknown[] = [];
    let pending: (() => void) | null = null;
    const loop = startTickLoop({
      now: () => clock,
      schedule: (cb) => { pending = cb; },
      onTick: (tick) => ticks.push(tick),
      onOverrun: (ms, behind) => overruns.push({ ms, behind }),
    });
    clock += TICK_MS;
    pending?.();
    expect(ticks).toEqual([0]);
    expect(overruns).toHaveLength(0);
    loop.stop();
  });

  it('catches up after a 100ms stall without skipping ticks and logs the overrun', () => {
    let clock = 0;
    const ticks: number[] = [];
    const overruns: Array<{ ms: number; behind: number }> = [];
    let pending: (() => void) | null = null;
    const loop = startTickLoop({
      now: () => clock,
      schedule: (cb) => { pending = cb; },
      onTick: (tick) => ticks.push(tick),
      onOverrun: (ms, behind) => overruns.push({ ms, behind }),
    });
    clock += 100;
    pending?.();
    expect(ticks).toEqual([0, 1, 2]);
    expect(overruns).toEqual([{ ms: 68, behind: 2 }]);
    loop.stop();
  });

  it('stops calling onTick after stop()', () => {
    let clock = 0;
    const ticks: number[] = [];
    let pending: (() => void) | null = null;
    const loop = startTickLoop({
      now: () => clock,
      schedule: (cb) => { pending = cb; },
      onTick: (tick) => ticks.push(tick),
      onOverrun: () => {},
    });
    loop.stop();
    clock += TICK_MS;
    pending?.();
    expect(ticks).toEqual([]);
  });
});
```

Create `packages/server/src/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('reads --bots and --port', () => {
    expect(parseArgs(['--bots', '31', '--port', '7777'])).toEqual({ bots: 31, port: 7777 });
  });
  it('defaults bots to 0 and port to 7777', () => {
    expect(parseArgs([])).toEqual({ bots: 0, port: 7777 });
  });
  it('rejects a negative or non-numeric --bots', () => {
    expect(() => parseArgs(['--bots', '-1'])).toThrow(RangeError);
    expect(() => parseArgs(['--bots', 'x'])).toThrow(RangeError);
  });
});
```

Create `packages/server/src/bench.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBenchmark } from './bench.js';
import { addBots, loadKatabaticWorld } from './world.js';

describe('headless bot benchmark', () => {
  it('runs 5000 ticks with 32 idle bots under the 32ms tick budget', async () => {
    const { world, spawns } = await loadKatabaticWorld();
    addBots(world, spawns, 32);
    const result = runBenchmark(world, 5000);
    console.info(`[bench] avg ${result.avgMs.toFixed(3)}ms max ${result.maxMs.toFixed(3)}ms over 5000 ticks`);
    expect(result.avgMs).toBeLessThan(32);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/server test`. Expect module resolution to fail for `./world.js`, `./loop.js`, `./cli.js`, `./bench.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/world.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPlayer, createWorld, type Heightfield, type World } from '@clans/sim';

export interface SceneSpawn {
  name: string | null;
  team: number;
  position: [number, number, number];
  radius: number;
}
interface TerrainManifest {
  gridSize: number;
  squareSize: number;
  origin: { x: number; y: number; z: number };
  heightScale: number;
  heights: string;
}
interface SceneData {
  spawns: SceneSpawn[];
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const assetsRoot = resolve(packageRoot, '../../assets/out/katabatic');
// Sized for 31 idle bots plus a few real clients; later milestones raise this to 32 v 32.
const WORLD_CAPACITY = 64;

async function readHeights(manifest: TerrainManifest): Promise<Uint16Array> {
  const bytes = await readFile(resolve(assetsRoot, manifest.heights));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heights = new Uint16Array(bytes.byteLength / 2);
  for (let i = 0; i < heights.length; i += 1) heights[i] = view.getUint16(i * 2, true);
  return heights;
}

export async function loadKatabaticWorld(seed = 1): Promise<{ world: World; spawns: SceneSpawn[] }> {
  const manifest = JSON.parse(await readFile(resolve(assetsRoot, 'terrain.json'), 'utf8')) as TerrainManifest;
  const scene = JSON.parse(await readFile(resolve(assetsRoot, 'scene.json'), 'utf8')) as SceneData;
  const heights = await readHeights(manifest);
  const terrain: Heightfield = {
    gridSize: manifest.gridSize, squareSize: manifest.squareSize,
    originX: manifest.origin.x, originY: manifest.origin.y, originZ: manifest.origin.z,
    heightScale: manifest.heightScale, heights,
  };
  return { world: createWorld(terrain, seed, WORLD_CAPACITY), spawns: scene.spawns };
}

export function teamCount(world: World, team: number): number {
  let count = 0;
  for (let id = 0; id < world.players.count; id += 1) {
    if (world.players.active[id] && world.players.team[id] === team) count += 1;
  }
  return count;
}

export function smallerTeam(world: World): number {
  return teamCount(world, 1) <= teamCount(world, 2) ? 1 : 2;
}

export function spawnPointFor(spawns: SceneSpawn[], team: number, index: number): [number, number, number] {
  const teamSpawns = spawns.filter((spawn) => spawn.team === team);
  const chosen = teamSpawns[index % teamSpawns.length];
  if (!chosen) throw new Error(`No spawn point for team ${String(team)}`);
  return chosen.position;
}

export function addBots(world: World, spawns: SceneSpawn[], count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const team = smallerTeam(world);
    const [x, y, z] = spawnPointFor(spawns, team, teamCount(world, team));
    ids.push(addPlayer(world, { x, y, z }, team));
  }
  return ids;
}
```

Create `packages/server/src/loop.ts`:

```ts
import { FIXED_TICK_MS } from '@clans/sim';

export const TICK_MS = FIXED_TICK_MS;

export interface TickLoopOptions {
  onTick: (tick: number) => void;
  onOverrun: (overrunMs: number, ticksBehind: number) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => void;
}
export interface TickLoop {
  stop(): void;
}

/**
 * Runs onTick once per TICK_MS. If a call to runDueTicks finds more than one tick due, it
 * runs all of them in order — never fewer — and reports the overrun once, with how many
 * extra ticks it had to catch up on.
 */
export function startTickLoop(options: TickLoopOptions): TickLoop {
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((callback, delayMs) => { setTimeout(callback, delayMs); });
  let nextTickAt = now() + TICK_MS;
  let tick = 0;
  let stopped = false;

  function runDueTicks(): void {
    const current = now();
    const startedAt = nextTickAt;
    let ticksToRun = 0;
    while (nextTickAt <= current) {
      nextTickAt += TICK_MS;
      ticksToRun += 1;
    }
    if (ticksToRun > 1) options.onOverrun(current - startedAt, ticksToRun - 1);
    for (let i = 0; i < ticksToRun; i += 1) {
      options.onTick(tick);
      tick += 1;
    }
  }

  function frame(): void {
    if (stopped) return;
    runDueTicks();
    schedule(frame, Math.max(0, nextTickAt - now()));
  }
  schedule(frame, TICK_MS);
  return { stop: () => { stopped = true; } };
}
```

Create `packages/server/src/cli.ts`:

```ts
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
    if (argv[i] === '--bots') { bots = Number(readFlag(argv, i + 1, '--bots')); i += 1; }
    else if (argv[i] === '--port') { port = Number(readFlag(argv, i + 1, '--port')); i += 1; }
  }
  if (!Number.isInteger(bots) || bots < 0) throw new RangeError('--bots must be a non-negative integer');
  if (!Number.isInteger(port) || port <= 0) throw new RangeError('--port must be a positive integer');
  return { bots, port };
}
```

Create `packages/server/src/bench.ts`:

```ts
import { stepWorld, type PlayerInput, type World } from '@clans/sim';

export interface BenchmarkResult {
  avgMs: number;
  maxMs: number;
}

export function runBenchmark(world: World, ticks: number): BenchmarkResult {
  const inputs = new Map<number, PlayerInput>(); // empty: every bot gets the sim's idle default
  let total = 0;
  let max = 0;
  for (let i = 0; i < ticks; i += 1) {
    const start = performance.now();
    stepWorld(world, inputs);
    const elapsed = performance.now() - start;
    total += elapsed;
    if (elapsed > max) max = elapsed;
  }
  return { avgMs: total / ticks, maxMs: max };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/server test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/server/src/world.ts packages/server/src/world.test.ts packages/server/src/loop.ts packages/server/src/loop.test.ts packages/server/src/cli.ts packages/server/src/cli.test.ts packages/server/src/bench.ts packages/server/src/bench.test.ts
git commit -m "feat(server): world bootstrap, catch-up tick loop, CLI flags, headless benchmark" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 6: Server sessions and snapshot policy

**Files:** Create `packages/server/src/session.ts`, `packages/server/src/session.test.ts`, `packages/server/src/snapshot-policy.ts`, `packages/server/src/snapshot-policy.test.ts`
**Interfaces:** Consumes `NetInputSample`, `InputMessage`, `SNAPSHOT_FALLBACK_MS` from `@clans/protocol` (Task 3, Task 4). Produces `Session`, `createSession(playerId, team, now)`, `applyInputMessage(session, message): NetInputSample[]`, `recordAck(session, snapshotId, now)`, `needsFullSnapshot(lastAckedSnapshotId, lastAckedAt, now)`. Covers failure matrix row 6 (input out of order) and row 7 (fallback policy).

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MessageType, type InputMessage, type NetInputSample } from '@clans/protocol';
import { applyInputMessage, createSession, recordAck } from './session.js';

const sample = (moveZ: number): NetInputSample => ({ moveX: 0, moveZ, yaw: 0, jump: false, jet: false });
const inputMessage = (sequence: number, samples: [NetInputSample, NetInputSample, NetInputSample]): InputMessage => ({
  type: MessageType.Input, sequence, samples,
});

describe('applyInputMessage', () => {
  it('drops a message whose sequence is not newer than the last applied one', () => {
    const session = createSession(0, 1, 0);
    expect(applyInputMessage(session, inputMessage(10, [sample(1), sample(1), sample(1)]))).toEqual([sample(1)]);
    expect(applyInputMessage(session, inputMessage(7, [sample(-1), sample(-1), sample(-1)]))).toEqual([]);
    expect(session.lastAppliedSequence).toBe(10);
  });

  it('replays the redundant samples that fill a single dropped packet', () => {
    const session = createSession(0, 1, 0);
    applyInputMessage(session, inputMessage(5, [sample(5), sample(4), sample(3)]));
    const filled = applyInputMessage(session, inputMessage(7, [sample(7), sample(6), sample(5)]));
    expect(filled).toEqual([sample(6), sample(7)]);
  });
});

describe('recordAck', () => {
  it('ignores an ack older than the one already recorded', () => {
    const session = createSession(0, 1, 0);
    recordAck(session, 5, 100);
    recordAck(session, 3, 200);
    expect(session.lastAckedSnapshotId).toBe(5);
    expect(session.lastAckedAt).toBe(100);
  });
});
```

Create `packages/server/src/snapshot-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { needsFullSnapshot } from './snapshot-policy.js';

describe('needsFullSnapshot', () => {
  it('requires a full snapshot before any ack has arrived', () => {
    expect(needsFullSnapshot(0, null, 1000)).toBe(true);
  });
  it('allows a delta right after a fresh ack', () => {
    expect(needsFullSnapshot(4, 1000, 1000)).toBe(false);
  });
  it('falls back to full once the ack is more than 1 s stale', () => {
    expect(needsFullSnapshot(4, 0, 1000)).toBe(false);
    expect(needsFullSnapshot(4, 0, 1001)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/server test -- session.test.ts snapshot-policy.test.ts`. Expect module resolution to fail for `./session.js` and `./snapshot-policy.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/session.ts`:

```ts
import type { InputMessage, NetInputSample } from '@clans/protocol';

export interface Session {
  playerId: number;
  team: number;
  lastAppliedSequence: number;
  lastAckedSnapshotId: number;
  lastAckedAt: number | null;
}

export function createSession(playerId: number, team: number, now: number): Session {
  return { playerId, team, lastAppliedSequence: 0, lastAckedSnapshotId: 0, lastAckedAt: now };
}

/**
 * Returns the input samples this message adds, oldest first. A message whose sequence is
 * not newer than the last one applied is dropped entirely — a reordered or duplicate
 * packet never rewinds a session. `samples` is [newest, newest-1, newest-2]; when up to two
 * ticks were missed, the matching redundant sample fills the gap instead of being dropped.
 */
export function applyInputMessage(session: Session, message: InputMessage): NetInputSample[] {
  if (message.sequence <= session.lastAppliedSequence) return [];
  const missing = Math.min(message.sequence - session.lastAppliedSequence, message.samples.length);
  const toApply = message.samples.slice(0, missing).reverse();
  session.lastAppliedSequence = message.sequence;
  return toApply;
}

export function recordAck(session: Session, snapshotId: number, now: number): void {
  if (snapshotId < session.lastAckedSnapshotId) return;
  session.lastAckedSnapshotId = snapshotId;
  session.lastAckedAt = now;
}
```

Create `packages/server/src/snapshot-policy.ts`:

```ts
import { SNAPSHOT_FALLBACK_MS } from '@clans/protocol';

/**
 * A client never gets a delta against a snapshot it has not acknowledged. If a client's
 * ack is missing or more than SNAPSHOT_FALLBACK_MS stale, the next send is a full snapshot,
 * so a lost ack cannot stall the connection forever.
 */
export function needsFullSnapshot(lastAckedSnapshotId: number, lastAckedAt: number | null, now: number): boolean {
  if (lastAckedSnapshotId === 0 || lastAckedAt === null) return true;
  return now - lastAckedAt > SNAPSHOT_FALLBACK_MS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/server test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/server/src/session.ts packages/server/src/session.test.ts packages/server/src/snapshot-policy.ts packages/server/src/snapshot-policy.test.ts
git commit -m "feat(server): input session queue and full-snapshot fallback policy" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 7: Server networking — WebSocket server, tick integration, CLI entry

**Files:** Create `packages/server/src/net.ts`, `packages/server/src/net.test.ts`, `packages/server/src/index.ts`, `packages/server/bin/clans-server.js`; Modify `packages/server/package.json`
**Interfaces:** Consumes `startTickLoop` (Task 5), `createSession`/`applyInputMessage`/`recordAck` (Task 6), `needsFullSnapshot` (Task 6), the protocol codec (Task 3, Task 4), `addPlayer`/`removePlayer`/`serializeActivePlayers`/`stepWorld` (Task 1, Task 2). Produces `startNetServer(options): NetServer`. Covers failure matrix row 10 (mid-match join).

- [ ] **Step 1: Look up and pin the `ws` version, then write the failing test**

Run these two commands and use their exact output — do not guess a version:

```sh
npm view ws version
npm view @types/ws version
```

Change `packages/server/package.json` to add the dependencies and a `bin` entry (replace `<ws-version>` and `<types-ws-version>` with the exact strings the two commands above printed):

```json
{
  "name": "@clans/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "bin": { "clans-server": "./bin/clans-server.js" },
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "@clans/sim": "workspace:*",
    "@clans/protocol": "workspace:*",
    "@clans/bots": "workspace:*",
    "ws": "<ws-version>"
  },
  "devDependencies": {
    "@types/ws": "<types-ws-version>"
  }
}
```

Create `packages/server/src/net.test.ts`:

```ts
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type Heightfield } from '@clans/sim';
import { decodeSnapshot, decodeWelcome, encodeAck, encodeJoin, MessageType } from '@clans/protocol';
import { startNetServer, type NetServer } from './net.js';
import type { SceneSpawn } from './world.js';

const terrain: Heightfield = {
  gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1,
  heights: new Uint16Array(4),
};
const spawns: SceneSpawn[] = [
  { name: null, team: 1, position: [0, 0, 0], radius: 5 },
  { name: null, team: 2, position: [1, 0, 1], radius: 5 },
];
const TEST_PORT = 17722;

function receive(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(new Uint8Array(data as Uint8Array))));
}
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    socket.once('open', () => resolve(socket));
  });
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startNetServer', () => {
  let server: NetServer;

  beforeEach(async () => {
    server = startNetServer({ world: createWorld(terrain, 1, 8), spawns, port: TEST_PORT });
    await server.ready;
  });
  afterEach(() => server.close());

  it('welcomes a joining client with a player id and a team', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    expect(welcome.type).toBe(MessageType.Welcome);
    expect([1, 2]).toContain(welcome.team);
    client.close();
  });

  it('sends a full snapshot first, then a delta once the client has acked', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const firstPromise = receive(client);
    server.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    expect(first.baselineId).toBe(0);

    client.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(10);
    const secondPromise = receive(client);
    server.tick(4);
    const second = decodeSnapshot(await secondPromise, { snapshotId: first.snapshotId, players: first.players });
    expect(second.baselineId).toBe(first.snapshotId);
    client.close();
  });

  it('never deltas against a snapshot the client did not ack', async () => {
    const client = await connect(TEST_PORT);
    const welcomePromise = receive(client);
    client.send(encodeJoin());
    await welcomePromise;

    const firstPromise = receive(client);
    server.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    client.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(10);

    // Snapshot two is "lost": the client never acks it.
    const secondPromise = receive(client);
    server.tick(4);
    await secondPromise;

    const thirdPromise = receive(client);
    server.tick(6);
    const third = decodeSnapshot(await thirdPromise, { snapshotId: first.snapshotId, players: first.players });
    expect(third.baselineId).toBe(first.snapshotId);
    client.close();
  });

  it('gives a mid-match joiner a full snapshot and the smaller team', async () => {
    const early = await connect(TEST_PORT);
    const earlyWelcomePromise = receive(early);
    early.send(encodeJoin());
    const earlyWelcome = decodeWelcome(await earlyWelcomePromise);
    const earlyFirst = receive(early);
    server.tick(2);
    await earlyFirst;

    const late = await connect(TEST_PORT);
    const lateWelcomePromise = receive(late);
    late.send(encodeJoin());
    const lateWelcome = decodeWelcome(await lateWelcomePromise);
    expect(lateWelcome.team).not.toBe(earlyWelcome.team);

    const snapshotPromise = receive(late);
    server.tick(4);
    const snapshot = decodeSnapshot(await snapshotPromise, null);
    expect(snapshot.baselineId).toBe(0);
    expect(snapshot.players).toHaveLength(2);
    early.close();
    late.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm install && pnpm --filter @clans/server test -- net.test.ts`. Expect module resolution to fail for `./net.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/net.ts`:

```ts
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FIXED_TICK_MS, addPlayer, removePlayer, serializeActivePlayers, stepWorld, type PlayerInput, type World,
} from '@clans/sim';
import {
  MessageType, decodeAck, decodeInput, encodeSnapshot, encodeWelcome,
  SNAPSHOT_EVERY_N_TICKS, type SnapshotBaseline,
} from '@clans/protocol';
import { applyInputMessage, createSession, recordAck, type Session } from './session.js';
import { needsFullSnapshot } from './snapshot-policy.js';
import { smallerTeam, spawnPointFor, teamCount, type SceneSpawn } from './world.js';

export interface NetServerOptions {
  world: World;
  spawns: SceneSpawn[];
  port: number;
}
export interface NetServer {
  ready: Promise<void>;
  close(): void;
  tick(tickNumber: number): void;
}

// Snapshots a client may still ack. Older ones fall off; a client that far behind gets a full.
const SENT_HISTORY = 8;

interface ClientEntry {
  socket: WebSocket;
  session: Session;
  sent: SnapshotBaseline[];
}

/** The baseline for the next delta is the snapshot the client last acked, never one merely sent. */
function ackedBaseline(entry: ClientEntry): SnapshotBaseline | null {
  return entry.sent.find((sent) => sent.snapshotId === entry.session.lastAckedSnapshotId) ?? null;
}

export function startNetServer(options: NetServerOptions): NetServer {
  const wss = new WebSocketServer({ port: options.port });
  const ready = new Promise<void>((resolve) => wss.once('listening', resolve));
  const clients = new Map<WebSocket, ClientEntry>();
  const latestInputs = new Map<number, PlayerInput>();
  let nextSnapshotId = 1;

  function handleJoin(socket: WebSocket): void {
    const team = smallerTeam(options.world);
    const [x, y, z] = spawnPointFor(options.spawns, team, teamCount(options.world, team));
    const playerId = addPlayer(options.world, { x, y, z }, team);
    clients.set(socket, { socket, session: createSession(playerId, team, Date.now()), sent: [] });
    socket.send(encodeWelcome({ playerId, team, tickMs: FIXED_TICK_MS }));
  }

  function handleInput(socket: WebSocket, bytes: Uint8Array): void {
    const entry = clients.get(socket);
    if (!entry) return;
    for (const sample of applyInputMessage(entry.session, decodeInput(bytes))) {
      latestInputs.set(entry.session.playerId, sample);
    }
  }

  function handleAck(socket: WebSocket, bytes: Uint8Array): void {
    const entry = clients.get(socket);
    if (!entry) return;
    recordAck(entry.session, decodeAck(bytes).snapshotId, Date.now());
  }

  function handleMessage(socket: WebSocket, bytes: Uint8Array): void {
    const type = bytes[0];
    if (type === MessageType.Join) handleJoin(socket);
    else if (type === MessageType.Input) handleInput(socket, bytes);
    else if (type === MessageType.Ack) handleAck(socket, bytes);
  }

  wss.on('connection', (socket) => {
    socket.on('message', (data) => handleMessage(socket, new Uint8Array(data as Uint8Array)));
    socket.on('close', () => {
      const entry = clients.get(socket);
      if (!entry) return;
      removePlayer(options.world, entry.session.playerId);
      latestInputs.delete(entry.session.playerId);
      clients.delete(socket);
    });
  });

  function sendSnapshot(entry: ClientEntry, tickNumber: number, players: ReturnType<typeof serializeActivePlayers>): void {
    const useFull = needsFullSnapshot(entry.session.lastAckedSnapshotId, entry.session.lastAckedAt, Date.now());
    const baseline = useFull ? null : ackedBaseline(entry);
    const snapshotId = nextSnapshotId;
    const bytes = encodeSnapshot(snapshotId, tickNumber, entry.session.lastAppliedSequence, players, baseline);
    entry.sent.push({ snapshotId, players });
    if (entry.sent.length > SENT_HISTORY) entry.sent.shift();
    entry.socket.send(bytes);
  }

  function tick(tickNumber: number): void {
    stepWorld(options.world, latestInputs);
    if (tickNumber % SNAPSHOT_EVERY_N_TICKS !== 0) return;
    const players = serializeActivePlayers(options.world);
    nextSnapshotId += 1;
    for (const entry of clients.values()) sendSnapshot(entry, tickNumber, players);
  }

  return { ready, close: () => wss.close(), tick };
}
```

Create `packages/server/src/index.ts`:

```ts
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
      `[clans-server] tick overrun: ${overrunMs.toFixed(1)}ms, ${String(ticksBehind)} ticks behind (total: ${String(overrunCount)})`,
    );
  },
});

console.log(`[clans-server] listening on ws://127.0.0.1:${String(options.port)} with ${String(options.bots)} bots`);
```

Create `packages/server/bin/clans-server.js`:

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const result = spawnSync('npx', ['tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/server test && pnpm typecheck && pnpm lint`. Then smoke-test the CLI directly:

```sh
pnpm --filter @clans/server start -- --bots 3 --port 17799 &
sleep 2
kill %1
```

Expected: a `[clans-server] listening on ws://127.0.0.1:17799 with 3 bots` line before the kill.

- [ ] **Step 5: Commit**

```sh
git add packages/server/package.json packages/server/src/net.ts packages/server/src/net.test.ts packages/server/src/index.ts packages/server/bin/clans-server.js pnpm-lock.yaml
git commit -m "feat(server): WebSocket networking, tick integration, CLI entry" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 8: Client Transport interface and WebSocket implementation

**Files:** Create `packages/client/src/transport.ts`, `packages/client/src/transport.test.ts`; Modify `packages/client/package.json`
**Interfaces:** Produces `Transport` (interface: `send`, `onMessage`, `close`), `WebSocketTransport implements Transport`.

- [ ] **Step 1: Look up the `ws` version, then write the failing test**

Run `npm view ws version` and `npm view @types/ws version` (reuse the results from Task 7 if that task already ran in this session; otherwise look them up here). Change `packages/client/package.json` to add them as devDependencies (test-only — production code uses the browser's global `WebSocket`):

```json
{
  "name": "@clans/client",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@clans/sim": "workspace:*",
    "lil-gui": "^0.21.0",
    "three": "^0.185.1"
  },
  "devDependencies": {
    "@types/three": "^0.185.4",
    "@types/ws": "<types-ws-version>",
    "vite": "^7.3.6",
    "ws": "<ws-version>"
  }
}
```

Create `packages/client/src/transport.test.ts`:

```ts
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketTransport } from './transport.js';

describe('WebSocketTransport', () => {
  let server: WebSocketServer;
  const PORT = 17733;

  beforeEach(async () => {
    server = new WebSocketServer({ port: PORT });
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });
  afterEach(() => server.close());

  it('sends bytes the server receives', async () => {
    const received = new Promise<Uint8Array>((resolve) => {
      server.once('connection', (socket) => socket.once('message', (data) => resolve(new Uint8Array(data as Uint8Array))));
    });
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    transport.send(Uint8Array.of(1, 2, 3));
    expect([...(await received)]).toEqual([1, 2, 3]);
    transport.close();
  });

  it('queues messages that arrive before a handler is attached', async () => {
    server.on('connection', (socket) => socket.send(Uint8Array.of(9, 8, 7)));
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const received: number[][] = [];
    transport.onMessage((bytes) => received.push([...bytes]));
    expect(received).toEqual([[9, 8, 7]]);
    transport.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm install && pnpm --filter @clans/client test -- transport.test.ts`. Expect module resolution to fail for `./transport.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/transport.ts`:

```ts
export interface Transport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  close(): void;
}

export class WebSocketTransport implements Transport {
  private readonly socket: WebSocket;
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private readonly queue: Uint8Array[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', (event: MessageEvent) => {
      this.deliver(new Uint8Array(event.data as ArrayBuffer));
    });
  }

  private deliver(bytes: Uint8Array): void {
    if (this.handler) this.handler(bytes);
    else this.queue.push(bytes);
  }

  send(bytes: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(bytes);
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) handler(next);
    }
  }

  close(): void {
    this.socket.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test -- transport.test.ts && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/package.json packages/client/src/transport.ts packages/client/src/transport.test.ts pnpm-lock.yaml
git commit -m "feat(client): Transport interface and WebSocket implementation" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 9: Client NetClient — prediction, reconciliation, hard-snap

**Files:** Create `packages/client/src/netclient.ts`, `packages/client/src/netclient.test.ts`; Modify `packages/client/package.json`, `packages/client/tsconfig.json`
**Interfaces:** Consumes `Transport` (Task 8), the protocol codec (Task 3, Task 4), `createWorld`/`addPlayer`/`stepWorld`/`deserializePlayer` (Task 1, Task 2). Produces `NetClient`, `NetClientStats`, `NetClientOptions`. Covers failure matrix row 8 (hard-snap) and the 150 ms/5% loss prediction test.

- [ ] **Step 1: Write the failing tests**

Add `@clans/protocol` to `packages/client/package.json`'s `dependencies`:

```json
  "dependencies": {
    "@clans/protocol": "workspace:*",
    "@clans/sim": "workspace:*",
    "lil-gui": "^0.21.0",
    "three": "^0.185.1"
  },
```

Add a reference to `packages/client/tsconfig.json`:

```json
  "references": [{ "path": "../protocol" }, { "path": "../sim" }]
```

Create `packages/client/src/netclient.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  FIXED_DT, FIXED_TICK_MS, addPlayer, createWorld, nextRandom, serializeActivePlayers, stepWorld,
  type Heightfield, type PlayerInput, type RandomState,
} from '@clans/sim';
import {
  MessageType, SNAPSHOT_EVERY_N_TICKS, decodeInput, encodeSnapshot,
} from '@clans/protocol';
import { NetClient } from './netclient.js';
import type { Transport } from './transport.js';

const terrain: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};
const clock = { ms: 0 };
const LATENCY_MS = 150;
const LOSS_CHANCE = 0.05;

function makeLink(random: RandomState) {
  let pending: Array<{ atMs: number; bytes: Uint8Array }> = [];
  return {
    send(bytes: Uint8Array): void {
      if (nextRandom(random) < LOSS_CHANCE) return;
      pending.push({ atMs: clock.ms + LATENCY_MS, bytes });
    },
    drain(): Uint8Array[] {
      const ready = pending.filter((item) => item.atMs <= clock.ms);
      pending = pending.filter((item) => item.atMs > clock.ms);
      return ready.map((item) => item.bytes);
    },
  };
}
function makeTransport(uplink: ReturnType<typeof makeLink>): Transport & { pump: (incoming: Uint8Array[]) => void } {
  let handler: ((bytes: Uint8Array) => void) | null = null;
  return {
    send: (bytes) => uplink.send(bytes),
    onMessage: (h) => { handler = h; },
    close: () => {},
    pump: (incoming) => { for (const bytes of incoming) handler?.(bytes); },
  };
}

describe('NetClient', () => {
  it('keeps prediction within 0.5 m of the server after a 3 s ski run at 150ms latency, 5% loss', () => {
    clock.ms = 0;
    const clientToServer = makeLink({ value: 1 });
    const serverToClient = makeLink({ value: 2 });
    const transport = makeTransport(clientToServer);
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0; // this test skips the join handshake and assigns the id directly

    const server = createWorld(terrain, 1, 4);
    addPlayer(server, { x: 500, y: 0, z: 500 }, 1);
    let nextSnapshotId = 1;
    let lastInputSequence = 0;
    const skiInput: PlayerInput = { moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false };
    const totalTicks = Math.ceil(3 / FIXED_DT);

    for (let tick = 0; tick < totalTicks; tick += 1) {
      clock.ms += FIXED_TICK_MS;
      for (const bytes of clientToServer.drain()) {
        if (bytes[0] === MessageType.Input) lastInputSequence = decodeInput(bytes).sequence;
      }
      stepWorld(server, new Map([[0, skiInput]]));
      if (tick % SNAPSHOT_EVERY_N_TICKS === 0) {
        const players = serializeActivePlayers(server);
        serverToClient.send(encodeSnapshot(nextSnapshotId, server.tick, lastInputSequence, players, null));
        nextSnapshotId += 1;
      }
      transport.pump(serverToClient.drain());
      client.tick(skiInput);
    }

    const serverX = server.players.position[0] ?? 0;
    const serverZ = server.players.position[2] ?? 0;
    const clientX = client.world.players.position[0] ?? 0;
    const clientZ = client.world.players.position[2] ?? 0;
    expect(Math.hypot(clientX - serverX, clientZ - serverZ)).toBeLessThan(0.5);
  });

  it('drops a delta whose baseline it never received and keeps running', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 9 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const state = { id: 0, team: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, energy: 60, onGround: 1 as const, ski: 0 as const };
    const delta = encodeSnapshot(7, 3, 0, [state], { snapshotId: 6, players: [state] });
    expect(() => transport.pump([delta])).not.toThrow();
    expect(client.stats.packetLossEstimate).toBeGreaterThan(0);
    expect(() => client.tick({ moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false })).not.toThrow();
  });

  it('hard-snaps and records a prediction error when the replay backlog exceeds 30 ticks', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 5 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;

    const skiInput: PlayerInput = { moveX: 0, moveZ: 1, yaw: 0, jump: true, jet: false };
    for (let tick = 0; tick < 40; tick += 1) {
      clock.ms += FIXED_TICK_MS;
      client.tick(skiInput);
    }
    expect(client.stats.predictionErrorM).toBe(0);

    const serverState = {
      id: 0, team: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, energy: 60,
      onGround: 1, ski: 0,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [serverState], null)]);

    expect(client.stats.predictionErrorM).toBeGreaterThan(0);
    expect(client.world.players.position[0]).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm install && pnpm --filter @clans/client test -- netclient.test.ts`. Expect module resolution to fail for `./netclient.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/netclient.ts`:

```ts
import {
  addPlayer, createWorld, deserializePlayer, stepWorld,
  type Heightfield, type PlayerInput, type PlayerSnapshotData, type World,
} from '@clans/sim';
import { MessageType, decodeSnapshot, decodeWelcome, encodeAck, encodeInput, encodeJoin } from '@clans/protocol';
import type { SnapshotBaseline } from '@clans/protocol';
import type { Transport } from './transport.js';

const MAX_REPLAY_TICKS = 30;
const LOSS_WINDOW = 50;
const BYTES_WINDOW_MS = 1000;
const LOCAL_SLOT = 0;

interface PendingInput {
  sequence: number;
  input: PlayerInput;
}
export interface NetClientStats {
  ping: number;
  bytesPerSecond: number;
  packetLossEstimate: number;
  predictionErrorM: number;
  entityCount: number;
}
export interface NetClientOptions {
  now?: () => number;
}

export class NetClient {
  readonly world: World;
  playerId = -1;
  team = 0;
  remotePlayers = new Map<number, PlayerSnapshotData>();
  remoteTick = 0;
  stats: NetClientStats = {
    ping: 0, bytesPerSecond: 0, packetLossEstimate: 0, predictionErrorM: 0, entityCount: 1,
  };

  private readonly now: () => number;
  private sequence = 0;
  private pendingInputs: PendingInput[] = [];
  private lastSnapshot: SnapshotBaseline | null = null;
  private previousSnapshotId = 0;
  private readonly lossWindow: number[] = [];
  private readonly bytesWindow: Array<{ at: number; bytes: number }> = [];
  private readonly inputSentAt = new Map<number, number>();

  constructor(
    private readonly transport: Transport,
    terrain: Heightfield,
    options: NetClientOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.world = createWorld(terrain, 1, 1);
    addPlayer(this.world, { x: 0, y: 0, z: 0 });
    transport.onMessage((bytes) => this.handleMessage(bytes));
    transport.send(encodeJoin());
  }

  tick(input: PlayerInput): void {
    this.sequence += 1;
    this.pendingInputs.push({ sequence: this.sequence, input });
    stepWorld(this.world, new Map([[LOCAL_SLOT, input]]));
    const samples: [PlayerInput, PlayerInput, PlayerInput] = [
      input,
      this.pendingInputs.at(-2)?.input ?? input,
      this.pendingInputs.at(-3)?.input ?? input,
    ];
    this.inputSentAt.set(this.sequence, this.now());
    this.transport.send(encodeInput({ sequence: this.sequence, samples }));
  }

  private handleMessage(bytes: Uint8Array): void {
    const type = bytes[0];
    if (type === MessageType.Welcome) this.handleWelcome(bytes);
    else if (type === MessageType.Snapshot) this.handleSnapshot(bytes);
  }

  private handleWelcome(bytes: Uint8Array): void {
    const welcome = decodeWelcome(bytes);
    this.playerId = welcome.playerId;
    this.team = welcome.team;
  }

  private handleSnapshot(bytes: Uint8Array): void {
    this.recordBytes(bytes.byteLength);
    let decoded;
    try {
      decoded = decodeSnapshot(bytes, this.lastSnapshot);
    } catch {
      // A delta against a baseline we never received. Count it as loss and do not ack;
      // the server's 1 s fallback then sends a full snapshot.
      this.pushLoss(0);
      return;
    }
    this.recordLoss(decoded.snapshotId);
    this.updatePing(decoded.lastInputSequence);
    this.lastSnapshot = { snapshotId: decoded.snapshotId, players: decoded.players };
    this.transport.send(encodeAck({ snapshotId: decoded.snapshotId }));

    const self = decoded.players.find((player) => player.id === this.playerId);
    if (self) this.reconcile(self, decoded.tick, decoded.lastInputSequence);

    this.remotePlayers = new Map(
      decoded.players.filter((player) => player.id !== this.playerId).map((player) => [player.id, player]),
    );
    this.remoteTick = decoded.tick;
    this.stats.entityCount = decoded.players.length;
  }

  private reconcile(serverState: PlayerSnapshotData, serverTick: number, lastInputSequence: number): void {
    const beforeX = this.world.players.position[0] ?? 0;
    const beforeZ = this.world.players.position[2] ?? 0;
    deserializePlayer(this.world, { ...serverState, id: LOCAL_SLOT });
    this.world.tick = serverTick;
    this.pendingInputs = this.pendingInputs.filter((pending) => pending.sequence > lastInputSequence);
    if (this.pendingInputs.length > MAX_REPLAY_TICKS) {
      this.stats.predictionErrorM = Math.hypot(
        beforeX - (this.world.players.position[0] ?? 0),
        beforeZ - (this.world.players.position[2] ?? 0),
      );
      this.pendingInputs = [];
      return;
    }
    this.stats.predictionErrorM = 0;
    for (const pending of this.pendingInputs) stepWorld(this.world, new Map([[LOCAL_SLOT, pending.input]]));
  }

  private recordLoss(snapshotId: number): void {
    if (this.previousSnapshotId !== 0) {
      const gap = Math.max(0, snapshotId - this.previousSnapshotId - 1);
      for (let i = 0; i < gap; i += 1) this.pushLoss(0);
      this.pushLoss(1);
    }
    this.previousSnapshotId = snapshotId;
  }
  private pushLoss(sample: number): void {
    this.lossWindow.push(sample);
    if (this.lossWindow.length > LOSS_WINDOW) this.lossWindow.shift();
    const received = this.lossWindow.reduce((sum, value) => sum + value, 0);
    this.stats.packetLossEstimate = 1 - received / this.lossWindow.length;
  }

  private updatePing(lastInputSequence: number): void {
    const sentAt = this.inputSentAt.get(lastInputSequence);
    if (sentAt !== undefined) this.stats.ping = this.now() - sentAt;
    for (const sequence of this.inputSentAt.keys()) {
      if (sequence <= lastInputSequence) this.inputSentAt.delete(sequence);
    }
  }

  private recordBytes(byteLength: number): void {
    const now = this.now();
    this.bytesWindow.push({ at: now, bytes: byteLength });
    while (this.bytesWindow.length > 0 && now - (this.bytesWindow[0]?.at ?? now) > BYTES_WINDOW_MS) {
      this.bytesWindow.shift();
    }
    this.stats.bytesPerSecond = this.bytesWindow.reduce((sum, entry) => sum + entry.bytes, 0);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test -- netclient.test.ts && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/package.json packages/client/tsconfig.json packages/client/src/netclient.ts packages/client/src/netclient.test.ts
git commit -m "feat(client): NetClient with prediction, reconciliation, and hard-snap" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 10: Client remote player interpolation and capsule meshes

**Files:** Create `packages/client/src/remote.ts`, `packages/client/src/remote.test.ts`
**Interfaces:** Consumes `PlayerSnapshotData` from `@clans/sim` (Task 2, type only). Produces `RemoteBuffer` (`push`, `positionAt`), `INTERP_DELAY_MS`, `MAX_EXTRAPOLATE_MS`, `createCapsule()`, `syncRemoteMeshes(scene, meshes, buffers, nowMs)`.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/remote.test.ts`:

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerSnapshotData } from '@clans/sim';
import { RemoteBuffer, syncRemoteMeshes } from './remote.js';

const sample = (x: number, vx: number): PlayerSnapshotData => ({
  id: 1, team: 1, x, y: 0, z: 0, vx, vy: 0, vz: 0, yaw: 0, energy: 60, onGround: 1, ski: 0,
});

describe('RemoteBuffer', () => {
  it('linearly interpolates between two samples 100 ms behind the newest', () => {
    const buffer = new RemoteBuffer();
    buffer.push(0, sample(0, 0));
    buffer.push(100, sample(10, 0));
    expect(buffer.positionAt(150)?.x).toBeCloseTo(5);
  });

  it('extrapolates up to 50 ms past the newest sample using its velocity', () => {
    const buffer = new RemoteBuffer();
    buffer.push(0, sample(0, 20));
    expect(buffer.positionAt(200)?.x).toBeCloseTo(1);
  });

  it('returns null before any sample arrives', () => {
    expect(new RemoteBuffer().positionAt(0)).toBeNull();
  });
});

describe('syncRemoteMeshes', () => {
  it('adds a mesh per remote id and removes it once the id drops out', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    const buffers = new Map<number, RemoteBuffer>([[1, new RemoteBuffer()]]);
    buffers.get(1)?.push(0, sample(3, 0));

    syncRemoteMeshes(scene, meshes, buffers, 100);
    expect(scene.children).toHaveLength(1);
    expect(meshes.get(1)?.position.x).toBeCloseTo(3);

    buffers.delete(1);
    syncRemoteMeshes(scene, meshes, buffers, 100);
    expect(scene.children).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- remote.test.ts`. Expect module resolution to fail for `./remote.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/remote.ts`:

```ts
import * as THREE from 'three';
import type { PlayerSnapshotData } from '@clans/sim';

export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATE_MS = 50;
const HISTORY_LENGTH = 8;
const CAPSULE_RADIUS = 0.6;
const CAPSULE_HEIGHT = 1.2;

interface RemoteSample {
  atMs: number;
  data: PlayerSnapshotData;
}
interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export class RemoteBuffer {
  private samples: RemoteSample[] = [];

  push(atMs: number, data: PlayerSnapshotData): void {
    this.samples.push({ atMs, data });
    if (this.samples.length > HISTORY_LENGTH) this.samples.shift();
  }

  positionAt(nowMs: number): RemotePose | null {
    const latest = this.samples.at(-1);
    if (!latest) return null;
    const renderTime = nowMs - INTERP_DELAY_MS;
    return renderTime >= latest.atMs ? this.extrapolate(latest, renderTime) : this.interpolate(renderTime);
  }

  private interpolate(renderTime: number): RemotePose {
    let before = this.samples[0] ?? this.samples[this.samples.length - 1];
    let after = this.samples[this.samples.length - 1];
    for (let i = 0; i < this.samples.length - 1; i += 1) {
      const a = this.samples[i];
      const b = this.samples[i + 1];
      if (a && b && a.atMs <= renderTime && renderTime <= b.atMs) { before = a; after = b; break; }
    }
    if (!before || !after || before.atMs === after.atMs) {
      const only = before ?? after;
      return { x: only?.data.x ?? 0, y: only?.data.y ?? 0, z: only?.data.z ?? 0, yaw: only?.data.yaw ?? 0 };
    }
    const t = Math.max(0, Math.min(1, (renderTime - before.atMs) / (after.atMs - before.atMs)));
    return {
      x: before.data.x + (after.data.x - before.data.x) * t,
      y: before.data.y + (after.data.y - before.data.y) * t,
      z: before.data.z + (after.data.z - before.data.z) * t,
      yaw: before.data.yaw + (after.data.yaw - before.data.yaw) * t,
    };
  }

  private extrapolate(latest: RemoteSample, renderTime: number): RemotePose {
    const seconds = Math.min(renderTime - latest.atMs, MAX_EXTRAPOLATE_MS) / 1000;
    return {
      x: latest.data.x + latest.data.vx * seconds,
      y: latest.data.y + latest.data.vy * seconds,
      z: latest.data.z + latest.data.vz * seconds,
      yaw: latest.data.yaw,
    };
  }
}

export function createCapsule(): THREE.Mesh {
  const geometry = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT, 4, 8);
  const material = new THREE.MeshStandardMaterial({ color: 0x4488ff });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return mesh;
}

function pruneMissing(scene: THREE.Scene, meshes: Map<number, THREE.Mesh>, buffers: Map<number, RemoteBuffer>): void {
  for (const id of [...meshes.keys()]) {
    if (buffers.has(id)) continue;
    const mesh = meshes.get(id);
    if (mesh) scene.remove(mesh);
    meshes.delete(id);
  }
}

export function syncRemoteMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  buffers: Map<number, RemoteBuffer>,
  nowMs: number,
): void {
  pruneMissing(scene, meshes, buffers);
  for (const [id, buffer] of buffers) {
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = createCapsule();
      scene.add(mesh);
      meshes.set(id, mesh);
    }
    const pose = buffer.positionAt(nowMs);
    if (!pose) continue;
    mesh.position.set(pose.x, pose.y + CAPSULE_HEIGHT / 2 + CAPSULE_RADIUS, pose.z);
    mesh.rotation.y = pose.yaw + Math.PI;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test -- remote.test.ts && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/remote.ts packages/client/src/remote.test.ts
git commit -m "feat(client): remote player interpolation and capsule meshes" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 11: Wire networking into the client app

**Files:** Modify `packages/client/src/app.ts`, `packages/client/src/main.ts`, `packages/client/src/stats.ts`, `packages/client/src/stats.test.ts`
**Interfaces:** Consumes `WebSocketTransport` (Task 8), `NetClient` (Task 9), `RemoteBuffer`/`syncRemoteMeshes` (Task 10). Changes `createApp(container, options?: { serverUrl?: string | null })`; changes `AppStats` and `describePlayer` to add `ping`, `bytesPerSecond`, `packetLossEstimate`, `predictionErrorM`, `entityCount`.

- [ ] **Step 1: Write the failing test**

Replace the test input object in `packages/client/src/stats.test.ts` (the existing `describe('describePlayer', ...)` block) with the extended `AppStats` shape and new row assertions:

```ts
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { describe, expect, it } from 'vitest';
import { describePlayer } from './stats.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('describePlayer', () => {
  it('reports speed as the horizontal magnitude and flags as 0 or 1', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    world.players.velocity.set([3, 9, 4], id * 3);
    world.players.onGround[id] = 1;
    const stats = {
      fps: 60, frameMs: 2.5, simMs: 0.4,
      ping: 42, bytesPerSecond: 900, packetLossEstimate: 0.05, predictionErrorM: 0.1, entityCount: 4,
    };
    const rows = Object.fromEntries(describePlayer(world, id, stats).map((row) => [row.id, row]));
    expect(rows['debug-speed']?.value).toBe(5);
    expect(rows['debug-speed']?.text).toBe('5.0 m/s');
    expect(rows['debug-pos']?.text).toBe('1.0, 2.0, 3.0');
    expect(rows['debug-ground']?.value).toBe(1);
    expect(rows['debug-ski']?.value).toBe(0);
    expect(rows['debug-energy']?.value).toBe(60);
    expect(rows['debug-fps']?.text).toBe('60');
    expect(rows['debug-ping']?.text).toBe('42 ms');
    expect(rows['debug-entities']?.value).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- stats.test.ts`. Expect a type error passing the smaller stats object, and `debug-ping`/`debug-entities` to be `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/client/src/app.ts`, change the imports and add the networking pieces. Add to the import list:

```ts
import { FIXED_DT, FIXED_TICK_MS, addPlayer, createWorld, sampleTerrain, stepWorld, type Heightfield, type PlayerInput, type World } from '@clans/sim';
import { NetClient } from './netclient.js';
import { RemoteBuffer, syncRemoteMeshes } from './remote.js';
import { WebSocketTransport } from './transport.js';
```

Change `AppStats`:

```ts
export interface AppStats {
  fps: number;
  frameMs: number;
  simMs: number;
  ping: number;
  bytesPerSecond: number;
  packetLossEstimate: number;
  predictionErrorM: number;
  entityCount: number;
}
```

Add `AppOptions` and change `createApp`'s signature, `world`/`playerId` setup, and `frame`:

```ts
export interface AppOptions {
  serverUrl?: string | null;
}

export async function createApp(container: HTMLElement, options: AppOptions = {}): Promise<App> {
  const assets = await loadKatabatic();
  const terrain = toHeightfield(assets);
  const net = options.serverUrl ? new NetClient(new WebSocketTransport(options.serverUrl), terrain) : null;
  const world = net ? net.world : createWorld(terrain, 1);
  const playerId = net ? 0 : addPlayer(world, spawnPoint(assets, terrain));

  const scene = new THREE.Scene();
  addEnvironment(scene, assets);
  scene.add(await createTerrain(assets));
  const sky = scene.getObjectByName('sky');
  if (!sky) throw new Error('addEnvironment did not add the sky');

  const camera = new THREE.PerspectiveCamera(90, container.clientWidth / container.clientHeight, 0.1, 1200);
  const renderer = createRenderer(container);
  const input = new Input(renderer.domElement);
  input.attach();
  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  const acc: Accumulator = { remainder: 0 };
  const remoteMeshes = new Map<number, THREE.Mesh>();
  const remoteBuffers = new Map<number, RemoteBuffer>();
  let lastRemoteTick = -1;
  let fpsWindowStart = performance.now();
  let fpsFrames = 0;

  const app: App = {
    world, playerId, input, assets, camera, scene, renderer,
    timeScale: 1, paused: false, stepOnce: false, freeCam: false,
    freeCamPosition: new THREE.Vector3(),
    stats: { fps: 0, frameMs: 0, simMs: 0, ping: 0, bytesPerSecond: 0, packetLossEstimate: 0, predictionErrorM: 0, entityCount: 1 },
    frame(dtSeconds: number): void {
      const frameStart = performance.now();
      let steps = advance(acc, dtSeconds, app.paused ? 0 : app.timeScale, FIXED_DT);
      if (app.stepOnce) { steps = 1; app.stepOnce = false; }
      const currentInput = app.freeCam ? { ...IDLE, yaw: input.yaw } : input.snapshot();
      const simStart = performance.now();
      if (net) {
        for (let step = 0; step < steps; step += 1) net.tick(currentInput);
        updateRemotes(net, scene, remoteMeshes, remoteBuffers);
        app.stats.ping = net.stats.ping;
        app.stats.bytesPerSecond = net.stats.bytesPerSecond;
        app.stats.packetLossEstimate = net.stats.packetLossEstimate;
        app.stats.predictionErrorM = net.stats.predictionErrorM;
        app.stats.entityCount = net.stats.entityCount;
      } else {
        const inputs = new Map<number, PlayerInput>([[playerId, currentInput]]);
        for (let step = 0; step < steps; step += 1) stepWorld(world, inputs);
      }
      app.stats.simMs = performance.now() - simStart;
      if (app.freeCam) moveFreeCam(app, dtSeconds);
      placeCamera(app, sky);
      renderer.render(scene, camera);
      app.stats.frameMs = performance.now() - frameStart;
      fpsFrames += 1;
      if (frameStart - fpsWindowStart >= 500) {
        app.stats.fps = (fpsFrames * 1000) / (frameStart - fpsWindowStart);
        fpsWindowStart = frameStart;
        fpsFrames = 0;
      }
    },
  };

  function updateRemotes(
    activeNet: NetClient, targetScene: THREE.Scene,
    meshes: Map<number, THREE.Mesh>, buffers: Map<number, RemoteBuffer>,
  ): void {
    if (activeNet.remoteTick !== lastRemoteTick) {
      lastRemoteTick = activeNet.remoteTick;
      const atMs = activeNet.remoteTick * FIXED_TICK_MS;
      for (const [id, snapshot] of activeNet.remotePlayers) {
        let buffer = buffers.get(id);
        if (!buffer) { buffer = new RemoteBuffer(); buffers.set(id, buffer); }
        buffer.push(atMs, snapshot);
      }
      for (const id of [...buffers.keys()]) {
        if (!activeNet.remotePlayers.has(id)) buffers.delete(id);
      }
    }
    syncRemoteMeshes(targetScene, meshes, buffers, performance.now());
  }

  return app;
}
```

In `packages/client/src/stats.ts`, add five rows to the array `describePlayer` returns (after `debug-ski`):

```ts
    { id: 'debug-ping', label: 'ping', text: `${fixed(stats.ping, 0)} ms`, value: stats.ping },
    { id: 'debug-bps', label: 'snapshot B/s', text: fixed(stats.bytesPerSecond, 0), value: stats.bytesPerSecond },
    { id: 'debug-loss', label: 'loss', text: `${fixed(stats.packetLossEstimate * 100, 1)}%`, value: stats.packetLossEstimate },
    { id: 'debug-prediction-error', label: 'predict err', text: `${fixed(stats.predictionErrorM, 2)} m`, value: stats.predictionErrorM },
    { id: 'debug-entities', label: 'entities', text: String(stats.entityCount), value: stats.entityCount },
```

Replace `packages/client/src/main.ts`:

```ts
import { createApp } from './app.js';
import { createDebug } from './debug.js';

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

const serverUrl = new URLSearchParams(location.search).get('server');
const app = await createApp(container, { serverUrl });
const debug = createDebug(app, document.body);
let last = performance.now();
const tick = (now: number): void => {
  app.frame((now - last) / 1000);
  debug.update();
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`. Then `pnpm --filter @clans/client dev`, open `http://127.0.0.1:5173` with no query string, and confirm milestone 1 still works unchanged (terrain renders, W/Space ski, F1 overlay, no console errors about a missing server).

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/app.ts packages/client/src/main.ts packages/client/src/stats.ts packages/client/src/stats.test.ts
git commit -m "feat(client): wire NetClient and remote interpolation into the app" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 12: Root dev scripts

**Files:** Create `scripts/dev.ts`; Modify `package.json`
**Interfaces:** Produces root scripts `dev` (server with `--bots 31` plus the Vite client, together), `dev:client`, `dev:server`.

`pnpm dev` uses a small `tsx` orchestration script rather than adding `concurrently`: the repo already runs everything else through `tsx`, this needs nothing more than two `spawn` calls and a shutdown handler, and it avoids pinning a new dependency's version without being able to verify it against the registry in this session.

- [ ] **Step 1: Add the orchestrator and the root scripts**

Create `scripts/dev.ts`:

```ts
import { spawn } from 'node:child_process';

const children = [
  spawn('pnpm', ['run', 'dev:server'], { stdio: 'inherit' }),
  spawn('pnpm', ['run', 'dev:client'], { stdio: 'inherit' }),
];

function shutdown(): void {
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) shutdown();
  });
}
```

Change the `scripts` block in the root `package.json`:

```json
  "scripts": {
    "dev": "tsx scripts/dev.ts",
    "dev:client": "pnpm --filter @clans/client dev",
    "dev:server": "pnpm --filter @clans/server start -- --bots 31 --port 7777",
    "build": "pnpm -r --filter './packages/*' build",
    "typecheck": "tsc -b",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write .",
    "test": "vitest run",
    "e2e": "playwright test",
    "assets:fetch": "pnpm --filter @clans/assets fetch",
    "assets:build": "pnpm --filter @clans/assets build:assets"
  },
```

- [ ] **Step 2: Verify `dev:server` alone**

```sh
timeout 5 pnpm run dev:server || true
```

Expected: a `[clans-server] listening on ws://127.0.0.1:7777 with 31 bots` line before the timeout kills it.

- [ ] **Step 3: Verify `pnpm dev` starts both and stops cleanly**

Run `pnpm dev`, confirm both the `[clans-server] listening ...` line and Vite's `Local: http://127.0.0.1:5173/` line appear, then press Ctrl-C once and confirm both processes exit (no orphaned `tsx`/`vite` process in `ps aux | grep -E 'tsx|vite'`).

- [ ] **Step 4: Run every gate**

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. `pnpm test` already runs the Task 5 headless-bot benchmark as part of `packages/server`'s Vitest project — no `.github/workflows/ci.yml` change is needed for "CI runs the existing gates plus a headless server test".

- [ ] **Step 5: Commit**

```sh
git add scripts/dev.ts package.json
git commit -m "feat: pnpm dev runs the server and the client together" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 13: Playwright — bots-only server and entity count

**Files:** Create `e2e/server.spec.ts`
**Interfaces:** Consumes the `#debug-stats[data-ready]` and `#debug-entities[data-value]` DOM contract from Task 11, and the `?server=` query parameter from Task 11.

- [ ] **Step 1: Write the failing test**

Create `e2e/server.spec.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const PORT = 17788; // distinct from the 7777 default, so it never fights a running `pnpm dev`

let serverProcess: ChildProcess;

test.beforeAll(async () => {
  serverProcess = spawn(
    'pnpm', ['--filter', '@clans/server', 'exec', 'tsx', 'src/index.ts', '--bots', '3', '--port', String(PORT)],
    { stdio: 'pipe' },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 20_000);
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) { clearTimeout(timeout); resolve(); }
    });
    serverProcess.on('error', reject);
  });
});

test.afterAll(() => {
  serverProcess.kill();
});

test('connects to a bots-only server and shows the right entity count', async ({ page }) => {
  await page.goto(`/?server=ws://127.0.0.1:${String(PORT)}`);
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });
  await expect
    .poll(async () => Number(await page.locator('#debug-entities').getAttribute('data-value')), { timeout: 10_000 })
    .toBe(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm exec playwright test e2e/server.spec.ts`. Before Task 11 this fails because `#debug-entities` does not exist; after Task 11 it should pass on the first try, so instead verify the negative case by temporarily changing `--bots 3` to `--bots 4` and confirming the `.toBe(4)` assertion fails (5 entities, not 4), then revert.

- [ ] **Step 3: No new application code**

If the assertion is off by one, check that the join handshake for the connecting client itself is counted (`--bots 3` plus the connecting client is 4 entities total) — this is the expected count, not a bug.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm e2e`. Expected: 2 passed (the milestone 1 movement spec and this one).

- [ ] **Step 5: Commit**

```sh
git add e2e/server.spec.ts
git commit -m "test(e2e): bots-only server shows the right entity count" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 14: Docs — server run instructions and `?server=` parameter

**Files:** Modify `README.md`
**Interfaces:** Consumes the root scripts from Task 12 and the `?server=` parameter from Task 11.

- [ ] **Step 1: Update the status line and run instructions**

Change the status line near the top of `README.md`:

```md
Status: milestone 2 of 7 (client and server, prediction and interpolation, 31 idle bots). See
`docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for what each
milestone ships.
```

- [ ] **Step 2: Add a Server section**

Add after the existing `## Run it` section:

```md
## Run it with a server

```sh
pnpm dev
```

This starts the authoritative server on `ws://127.0.0.1:7777` with 31 idle bots, and the
Vite client on `http://127.0.0.1:5173`. Open `http://127.0.0.1:5173/?server=ws://127.0.0.1:7777`
to connect. Without the `?server=` parameter, `pnpm dev` alone still gives you the milestone 1
single-player path.

Run the two halves separately with `pnpm dev:server` and `pnpm dev:client`. `pnpm dev:server`
takes `--bots N` and `--port N`; the installed CLI is `clans-server --bots 31 --port 7777`.
```

- [ ] **Step 3: Update the layout section**

Change the `packages/protocol`, `packages/server`, `packages/bots` line:

```md
- `packages/protocol`: binary wire format — message schemas, snapshot delta compression.
- `packages/server`: Node, `ws`, the authoritative tick loop, idle bots.
- `packages/bots`: placeholder until milestone 6's bot brains.
```

- [ ] **Step 4: Run every gate**

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`. Expected: all green.

- [ ] **Step 5: Commit**

```sh
git add README.md
git commit -m "docs: server run instructions and the ?server= parameter" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```
