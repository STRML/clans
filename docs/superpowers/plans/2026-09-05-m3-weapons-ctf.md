# Milestone 3: Weapons, Damage, CTF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All four weapons (Spinfusor, Chaingun, Mortar, Laser Rifle) plus Blaster and hand grenades fire, damage, and kick back players exactly as the spec's Weapon numbers table describes. CTF works end to end: two flags, pickup, drop, return, capture, scoring, an 8-capture game over. Death, respawn, and fall damage work. The HUD shows health, energy, ammo, flag status, a kill feed, and a respawn countdown. Every number the spec gives is used exactly; every number it does not give is picked here and marked ours.
**Architecture:** `packages/sim` gains `damage.ts` (health, fall damage, radius falloff, kickback, respawn), `weapons.ts` (per-weapon state machines, ammo, input growth), `projectiles.ts` (the projectile store, terrain/player collision, hitscan), and `flags.ts` (CTF state machine, scoring, game over). `stepWorld` grows to call all four in a fixed order but keeps its `(world, inputs, dt)` signature — the only public sim entry point stays the only public sim entry point. `packages/protocol` extends the M2 input, snapshot, and join/welcome codecs and adds two small new message types (`Event` for the kill feed and laser beam, `God` for the debug toggle). `packages/server` adds a lag-compensation position history and wires respawn, team scores, and game over into the tick loop. `packages/client` adds weapon/grenade/aim input, projectile and flag rendering, and the T2-style HUD.
**Tech Stack:** the milestone 2 stack, no new production dependency in any package.
**Spec:** docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md
**Baseline:** branch `feat/m2-client-server`, which carries everything milestones 1 and 2 built (client/server prediction and interpolation, 31 idle bots, protocol tests green).

## Global Constraints

- `stepWorld(world, inputs, dt = FIXED_DT)` stays the only public sim entry point and keeps its exact signature. Every new system (`stepWeapons`, `stepProjectiles`, `stepFlags`) is called from inside it, in this fixed order: `stepPlayers`, `stepWeapons`, `stepProjectiles`, `stepFlags`, then `world.tick += 1`. No package outside `sim` calls a step function directly.
- Cross-system communication within one tick uses transient arrays on `World`, cleared by their producer at the start of its own call: `world.pendingFireEvents` (written by `stepWeapons`, consumed by `stepProjectiles`) and `world.pendingDeaths` (written by `applyDamage`, consumed by `stepFlags` for flag-drop-on-death). Both are plain arrays so the world stays serializable for tests; neither is networked.
- `packages/sim` still imports nothing from DOM, Three.js, WebSocket, or Node. Spawn points, flag stand positions, and respawn placement are supplied by the caller (server or client), exactly like `addPlayer(world, spawn, team)` already takes a spawn `Vec3` instead of picking one itself. Sim never reads scene data.
- Every ESLint `complexity: 10` / `max-depth: 3` budget holds. Every system function here is split into named helpers the way `movement.ts`'s `classify`/`applyForces`/`integrate`/`writeState` already are.
- Only Light armor is playable this milestone. `ArmorData` gains `discAmmo`, `chaingunAmmo`, `mortarAmmo`, `grenadeCount`, `maxWeapons`, `laserRifleAllowed`, `mortarAllowed` fields (from the spec's Armor numbers table); only `LIGHT_ARMOR` is populated with real numbers. Medium and Heavy are milestone 4.
- Numbers with a spec citation are used exactly as the spec's Weapon numbers, CTF numbers, and Armor numbers tables state them. Numbers the spec does not give are picked here, marked **ours**, and collected in the final report.
- Every multi-byte wire field stays little-endian through `DataView`, per M2's Global Constraints. `packages/protocol` still has no runtime npm dependency.
- Snapshot send rate, delta-baseline policy, and the M2 prediction/reconciliation loop are unchanged. New per-player fields (`health`, `weaponSlot`) join the *existing* per-player delta scheme with two new dirty bits; projectiles, flags, and team scores are sent in full every snapshot tick (not delta-diffed) — cheap at these counts (at most a few hundred bytes), and simpler than extending the delta scheme to three more entity kinds in one milestone. This is **ours**, not spec-mandated.
- `packages/bots` stays the milestone-2 placeholder. No bot brains. The 31 idle bots keep sending no input, which now also means they never fire, never carry flags, and never take fall damage beyond gravity — `stepWeapons`/`stepFlags` treat "no input" as "no fire, no altFire, no slot change," which the existing `IDLE` fallback in `stepPlayers`-style code already produces.

## Failure matrix (from the spec)

| # | State or input | What happens | How it can fail | What the caller sees | M3 scope |
|---|---|---|---|---|---|
| 1 | Flag carried, carrier dies | flag drops at death position, return timer starts | death position is inside a wall or below terrain | flag is placed at the nearest walkable point (M3 definition: clamp Y to terrain height at that X/Z) | **Task 4** (`flags.test.ts`: "clamps the drop Y to terrain height even if the death position was below the surface") |
| 2 | Flag dropped, timer expires | flag returns home | the flag was picked up 1 ms before expiry | pickup cancels the timer; the return is a no-op if the flag is not `dropped` | **Task 4** (`flags.test.ts`: "a return-in-progress flag picked up before its timer fires never auto-returns") |
| 3 | Capture with own flag away | no capture | | carrier keeps the flag, HUD says "your flag is not home" | **Task 4** (`flags.test.ts`: "carrying the enemy flag at your own stand does not capture while your flag is stolen"), **Task 12** (HUD message) |
| 4 | Both generators dead | assets unpowered | station mid-transaction | transaction aborts, loadout kept | N/A — milestone 4 |
| 5 | Vehicle pad spawn while a vehicle exists | old vehicle destroyed | pilot inside it | pilot dismounted first, no damage | N/A — milestone 5 |
| 6 | Client input arrives out of order | | older sequence after newer | server drops it, client's replay never sees it | already covered, M2 Task 6 — unchanged this milestone |
| 7 | Snapshot lost | | delta baseline the client never got | acks carry last received id; server never deltas against an unacked snapshot | already covered, M2 Tasks 4/6/7/9 — unchanged this milestone |
| 8 | Client mispredicts | rewind and replay | replay would run more than 30 ticks | client hard-snaps, records a prediction error | already covered, M2 Task 9 — unchanged this milestone |
| 9 | Bot task target destroyed | bot rechooses | every task claimed | bot falls back to defend nearest asset | N/A — bot brains ship in milestone 6 |
| 10 | Player joins mid-match | full snapshot then deltas | | player spawns after the next tick, team is the smaller one | already covered, M2 Task 7 — unchanged this milestone |
| 11 | Server tick overruns 32 ms | | bots or collision blow the budget | server logs the overrun, skips no ticks, catches up | already covered, M2 Task 5 — unchanged this milestone |

Additional M3 tests from the spec's Testing section, mapped to owning task: weapon state machine timings → **Task 2**; disc speed and velInherit → **Task 3**; mortar arming and bounce → **Task 3**; radius falloff and kickback, two discs kill a Light → **Task 3**; sniper energy scaling and refusal below 6 → **Task 2**; scoring and game over → **Task 4**; protocol round trips for every new field → **Task 6**; headless server fires a disc at a bot, observes the health drop → **Task 7**; lag compensation (shooter at 150 ms sees a target where it was 150 ms ago and still hits) → **Task 7**; Playwright fires the Spinfusor, sees the projectile count rise then fall → **Task 14**.

## Numbers this plan picks that the spec does not give ("ours")

Cited inline at each use; collected here for one-glance review.

| Number | Value | Where |
|---|---|---|
| Blaster: speed, velInherit, damage, fire/reload, lifetime | 300 m/s, 0.5, 0.1 direct, 0.2 s / 0.3 s, 2 s, unlimited ammo | Task 2 |
| Hand grenade: radius, kickback, throw speed, arm delay, lifetime, cooldown | 10 m, 1000, 25 m/s, 0.5 s, 3 s, 1.0 s (drag/elasticity reuse Mortar's 0.1/0.15) | Task 2, Task 3 |
| Mortar shell lifetime (spec gives Spinfusor 5 s, Chaingun 3 s, not Mortar) | 5 s | Task 2 |
| Weapon activate (switch) time, all weapons | 0 s, instant | Task 2 |
| Dry-fire feedback duration | 0.2 s | Task 2 |
| Chaingun spin-up/spin-down gating (spec gives 0.5 s/1.0 s, not how they gate state) | spin-up costs the *first* shot of a new burst only; spin-down is a decorative constant, not a fire gate | Task 2 |
| Laser Rifle energy cost per shot (spec gives only the min-energy-6 refusal) | 6, reusing the refusal threshold | Task 2 |
| Player hit-sphere approximation (spec doesn't specify a hit-test shape) | sphere at capsule center height, radius = max(boundingBox X, Y)/2 | Task 1 |
| Head-hit band for the ×1.3 Laser Rifle multiplier | top 15% of player height | Task 1 |
| Respawn delay | 5 s | Task 1 |
| Flag pickup radius | 2 m | Task 4 |
| Projectile store capacity | 256 | Task 3 |
| Lag-compensation rewind: one global rewind-ms per tick, applied to every player not currently firing a hitscan/tracer weapon that tick, rather than a per-shooter-per-target rewind | see Task 7 for the reasoning | Task 7 |
| Lag-comp position history depth | 32 ticks (~1.02 s, past the spec's 200 ms cap) | Task 7 |
| NetClient incoming-event rolling history | 100 events | Task 9 |
| Protocol version byte | 2 (M1/M2 had no version field) | Task 6 |
| Fast-projectile tunneling at 425 m/s (13.6 m per 32 ms tick) is accepted, not swept-tested | known limitation, not fixed this milestone | Task 3 |
| God-mode wire mechanism: a one-shot `God` message toggles a server-side set, applied by zeroing damage after `stepWorld`, not by threading a flag through the deterministic sim | Task 7, Task 13 |

## File structure

`packages/sim` (modify existing M1/M2 files, add four):

- `src/armor.ts`: `ArmorData` gains ammo/grenade/weapon-allow fields; `LIGHT_ARMOR` populated (Task 2).
- `src/types.ts`: `PlayerInput` gains `pitch`, `fire`, `altFire`, `slot`; `PlayerStore` gains `damage`, `alive`, `respawnAt`, `score` (Task 1), then `weaponSlot`, `weaponState`, `weaponTimer`, `spunUp`, `grenadeCooldown`, `ammo`, `grenades` (Task 2); `World` gains `pendingDeaths` (Task 1), `pendingFireEvents` (Task 2), `projectiles` (Task 3), `flags`, `teamScores`, `gameOver`, `winnerTeam`, `timeLimitTicks`, `gameOverReason` (Task 4).
- `src/world.ts`: `createWorld`/`addPlayer` initialize the new fields (Task 1, Task 2, Task 3, Task 4 each add their slice, Task 4 also importing `TIME_LIMIT_TICKS`/`GameOverReason` from `flags.ts` for the defaults); `stepWorld` grows its call sequence (Task 1 adds nothing here — respawn is caller-driven; Task 2 adds `stepWeapons`; Task 3 adds `stepProjectiles`; Task 4 adds `stepFlags`).
- `src/movement.ts`: `stepPlayers` skips `!alive` players too; the landing branch calls `applyFallDamage` (Task 1). `IDLE` gains the new `PlayerInput` fields (Task 2).
- `src/movement.test.ts`: the single `idle` const gains the new fields; every test already spreads it via `inputMap` (Task 2).
- `src/snapshot.ts`: `PlayerSnapshotData` gains `health` (Task 1), then `weaponSlot` (Task 2); `serializePlayer`/`deserializePlayer` updated both times; `serializeProjectiles`/`serializeFlags` added (Task 7).
- `src/snapshot.test.ts`, `src/hash.test.ts`: literals and hash-mix updated both times.
- `src/hash.ts`: `mixPlayer` mixes `damage` (Task 1), then `weaponSlot` (Task 2); `hashWorld` itself grows to mix projectiles, flags, team scores, game-over state, and the match clock (Task 4).
- `src/damage.ts` (new, Task 1): health, fall damage, respawn, radius/kickback math.
- `src/damage.test.ts` (new, Task 1).
- `src/weapons.ts` (new, Task 2): `WeaponId`, `WeaponState`, `WEAPON_DATA`, `GRENADE_DATA`, `FireEvent`, `stepWeapons`.
- `src/weapons.test.ts` (new, Task 2).
- `src/projectiles.ts` (new, Task 3): `ProjectileStore`, `stepProjectiles`.
- `src/projectiles.test.ts` (new, Task 3).
- `src/flags.ts` (new, Task 4): `FlagStore`, `createFlags`, `stepFlags`, `GameOverReason`, `TIME_LIMIT_TICKS`, the match-clock check.
- `src/flags.test.ts` (new, Task 4).
- `src/index.ts`: exports the above, each task appending its own lines.

`packages/assets` (Task 5, parallel with Tasks 1–4 — different package, no shared file):

- `src/scene.ts`: `SceneData` gains `flags`, `flagStands`; `extractScene` calls two new builders.
- `src/scene.test.ts`: new assertions.
- `src/__fixtures__/scene.mis`: gains a `Flag` and an `ExteriorFlagStand`.

`packages/protocol` (Task 6, depends on Tasks 1–4):

- `src/messages.ts`: `PROTOCOL_VERSION`; `JoinMessage` gains `version`; `WelcomeMessage` gains `status`, keeping the M2 `spawnX`/`spawnY`/`spawnZ` fields it already has; `NetInputSample` (= `PlayerInput`) inherits the sim's new fields automatically; `MessageType` gains `Event = 6`, `God = 7`; `EventKind`, `EventMessage`, `GodMessage`.
- `src/handshake.ts`, `src/handshake.test.ts`: codec + tests for all of the above.
- `src/snapshot.ts`: `ProjectileSnapshotData`, `FlagSnapshotData`, `WorldExtras`, `emptyExtras()`; `encodeSnapshot`/`decodeSnapshot` grow a 6th parameter/field; two new player dirty bits. `WorldExtras` also carries `timeRemainingS` and `gameOverReason` for the match clock (Task 4).
- `src/snapshot.test.ts`: extended, plus the four M2 call sites gain the `extras` argument.
- `src/index.ts`: extended.

`packages/server` (Task 7, depends on Task 6 and Tasks 1–4):

- `src/lagcomp.ts` (new): `PositionHistory`, `recordHistory`, `positionAtTick`, `rewindOthers`, `restorePositions`.
- `src/lagcomp.test.ts` (new).
- `src/net.ts`: applies the grown input, sends the grown snapshot, tracks per-client ping for lag comp, handles `God` messages, respawns, freezes on game over. `buildExtras` computes `timeRemainingS` from `world.timeLimitTicks - world.tick` and passes through `world.gameOverReason`.
- `src/net.test.ts`: extended — headless disc-kill test, lag-compensation test.
- `src/world.ts`: `loadKatabaticWorld` also reads `flags`/`flagStands` from `scene.json` and calls `createFlags`.
- `src/world.test.ts`: extended.

`packages/client`:

- `src/input.ts`, Task 8 (parallel with Task 7 — different package): number keys 1–5, left mouse fire, G grenade; `pitch` was already tracked, now flows into `snapshot()`.
- `src/netclient.ts`, `src/netclient.test.ts`, Task 9 (depends on Task 6): `NetClient` exposes `projectiles`, `flags`, `teamScores`, `gameOver`, `winnerTeam`, `localHealth`, `timeRemainingS`, `gameOverReason`; the M2 `encodeSnapshot`/PlayerSnapshotData call sites in the test file gain the new fields/argument.
- `src/weapons-view.ts`, `src/weapons-view.test.ts`, Task 10 (parallel with Task 11 — different files, both depend only on Task 9's types): projectile meshes, explosions, laser beam flashes.
- `src/flag-view.ts`, `src/flag-view.test.ts`, Task 11 (parallel with Task 10): the flag box-on-a-pole.
- `src/hud.ts`, `src/hud.test.ts`, Task 12 (parallel with Task 10/Task 11 — different file): reticle, bars, ammo, flag status, kill feed, damage flash, respawn countdown, the match clock, and a game-over message that names its reason (capture limit, time limit, or a tie).
- `src/app.ts`, `src/debug.ts`, `src/stats.ts`, Task 13 (depends on Tasks 8, 10, 11, 12): wires it all into the frame loop; debug overlay gains projectile count, health, god-mode checkbox.
- `e2e/weapons.spec.ts`, Task 14 (depends on Task 13).
- `README.md`, Task 15 (depends on Task 14).

## Task dependency graph

- **Task 1** (sim: health/damage) depends on the M2 baseline only. Owns `damage.ts` and the health slice of `types.ts`/`world.ts`/`movement.ts`/`snapshot.ts`/`hash.ts`.
- **Task 2** (sim: weapons) depends on Task 1 — both touch `types.ts`/`world.ts` sequentially. Owns `weapons.ts` and the weapon slice of the same shared files, plus the repo-wide `PlayerInput` sweep (`movement.test.ts`, `app.ts`, `input.ts`, `netclient.test.ts`, `session.test.ts`, `handshake.test.ts`) needed to keep `pnpm typecheck` green everywhere.
- **Task 3** (sim: projectiles) depends on Task 1 (damage math) and Task 2 (`FireEvent`, `WEAPON_DATA`). Owns `projectiles.ts`.
- **Task 4** (sim: CTF) depends on Task 1 (`score`, `pendingDeaths`) and Task 3 only for ordering inside `stepWorld` — it does not import from `projectiles.ts`. Owns `flags.ts`. It also extends `hashWorld` in `hash.ts` (Task 1/2's file) to mix in projectiles, flags, team scores, and the match clock — a read-only pass over `world.projectiles`/`world.flags` from inside `hash.ts`, so this still adds no new import edge into `flags.ts` itself.
- **Task 5** (assets: Flag/ExteriorFlagStand extraction) depends on the M2 baseline only, touches `packages/assets`. **Runs in parallel with Tasks 1–4** — different package, no shared file.
- **Task 6** (protocol) depends on Tasks 1–4 (the full `PlayerSnapshotData`/`PlayerInput`/`FlagStore`/`ProjectileStore` shapes) and the M2 protocol baseline.
- **Task 7** (server) depends on Task 6 and Task 5 (`scene.json` gains flag data `loadKatabaticWorld` reads).
- **Task 8** (client input) depends on Task 2 (`PlayerInput` shape) only. **Runs in parallel with Task 7** — different package, no shared file.
- **Task 9** (client NetClient) depends on Task 6 and Task 8.
- **Task 10** (client projectile/explosion/beam view) depends on Task 9. **Runs in parallel with Task 11** — different files, neither imports the other.
- **Task 11** (client flag view) depends on Task 9. **Runs in parallel with Task 10.**
- **Task 12** (client HUD) depends on Task 9. **Runs in parallel with Task 10 and Task 11** — a third, disjoint file.
- **Task 13** (client app wiring) depends on Tasks 8, 10, 11, 12.
- **Task 14** (Playwright) depends on Task 13 only. This plan fixes an inconsistency here: the
  line originally read "depends on Task 7 and Task 13," anticipating an e2e spec that spawns a
  real server like `e2e/server.spec.ts` does. Task 14 instead drives single-player mode and a
  `window.__clansDebug.teleportToFlag` hook that reads live flag positions out of `world.flags`
  — no server needed, and no dependency on real Katabatic world coordinates staying where the
  spec's prose says they are.
- **Task 15** (docs) depends on Task 14.

---

### Task 1: Sim — health, fall damage, death, respawn timer, damage math

**Files:** Create `packages/sim/src/damage.ts`, `packages/sim/src/damage.test.ts`; Modify `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/movement.ts`, `packages/sim/src/snapshot.ts`, `packages/sim/src/snapshot.test.ts`, `packages/sim/src/hash.ts`, `packages/sim/src/index.ts`
**Interfaces:** Consumes `World`, `PlayerStore`, `ArmorData`, `LIGHT_ARMOR`, `sampleTerrain` (existing). Produces `PlayerHitbox`, `playerHitbox(world, id, armor): PlayerHitbox`, `raySphereDistance(origin, dir, hitbox): number | null`, `radiusFalloff(distance, radius): number`, `applyKickback(world, id, direction, magnitude, falloff, armor): void`, `applyDamage(world, id, amount, attackerId, armor): void`, `applyFallDamage(world, id, landingSpeed, armor): void`, `respawnPlayer(world, id, spawn): void`, `dueForRespawn(world): number[]`, `RESPAWN_TICKS`. Covers no failure-matrix row directly but is load-bearing for Task 3 and Task 4.

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/damage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import { addPlayer, createWorld, stepWorld, type Heightfield, type PlayerInput } from './index.js';
import {
  applyDamage,
  applyFallDamage,
  applyKickback,
  dueForRespawn,
  playerHitbox,
  radiusFalloff,
  raySphereDistance,
  respawnPlayer,
  RESPAWN_TICKS,
} from './damage.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};
const idle: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };

describe('radiusFalloff', () => {
  it('is full at the center and zero at the radius', () => {
    expect(radiusFalloff(0, 10)).toBe(1);
    expect(radiusFalloff(10, 10)).toBe(0);
    expect(radiusFalloff(5, 10)).toBeCloseTo(0.5);
    expect(radiusFalloff(20, 10)).toBe(0);
  });
});

describe('applyDamage and death', () => {
  it('kills at maxDamage and starts a 5 s respawn timer', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage - 0.01, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(1);
    applyDamage(world, id, 0.02, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
    expect(world.players.respawnAt[id]).toBe(RESPAWN_TICKS);
    expect(world.pendingDeaths).toEqual([id]);
    expect(dueForRespawn(world)).toEqual([]);
    world.tick = RESPAWN_TICKS;
    expect(dueForRespawn(world)).toEqual([id]);
  });

  it('two disc splashes at center kill a Light (0.5 + 0.5 > 0.66 maxDamage)', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    expect(world.players.alive[id]).toBe(0);
  });

  it('scores +10 for a kill, -10 for a team kill, -10 for a suicide, nothing for env damage', () => {
    const world = createWorld(flat, 1);
    const victim = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const enemy = addPlayer(world, { x: 5, y: 0, z: 5 }, 2);
    const ally = addPlayer(world, { x: 10, y: 0, z: 10 }, 1);
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    expect(world.players.score[enemy]).toBe(0);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, enemy, LIGHT_ARMOR);
    expect(world.players.score[enemy]).toBe(10);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, ally, LIGHT_ARMOR);
    expect(world.players.score[ally]).toBe(-10);
    respawnPlayer(world, victim, { x: 0, y: 0, z: 0 });
    applyDamage(world, victim, LIGHT_ARMOR.maxDamage, victim, LIGHT_ARMOR);
    expect(world.players.score[victim]).toBe(-10);
  });

  it('ignores damage against an already-dead or inactive player', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    const damageBefore = world.players.damage[id];
    applyDamage(world, id, 0.5, -1, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(damageBefore);
  });
});

describe('applyFallDamage', () => {
  it('does nothing at or below minJumpSpeed', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyFallDamage(world, id, LIGHT_ARMOR.minJumpSpeed, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBe(0);
  });
  it('scales the excess over minJumpSpeed by speedDamageScale', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyFallDamage(world, id, LIGHT_ARMOR.minJumpSpeed + 10, LIGHT_ARMOR);
    expect(world.players.damage[id]).toBeCloseTo(10 * LIGHT_ARMOR.speedDamageScale);
  });
  it('a hard landing from stepWorld applies fall damage exactly once per landing', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 60, z: 0 });
    for (let tick = 0; tick < 60; tick += 1) stepWorld(world, new Map([[id, idle]]));
    expect(world.players.damage[id]).toBeGreaterThan(0);
    const afterLanding = world.players.damage[id];
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, new Map([[id, idle]]));
    expect(world.players.damage[id]).toBe(afterLanding);
  });
});

describe('respawnPlayer and dueForRespawn', () => {
  it('resets damage, aliveness, and position', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyDamage(world, id, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    respawnPlayer(world, id, { x: 42, y: 0, z: 7 });
    expect(world.players.alive[id]).toBe(1);
    expect(world.players.damage[id]).toBe(0);
    expect(world.players.position[id * 3]).toBe(42);
    expect(world.players.respawnAt[id]).toBe(-1);
  });
});

describe('playerHitbox and raySphereDistance', () => {
  it('hits a player standing on the ray and reports the correct distance', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    const distance = raySphereDistance(
      { x: 0, y: hitbox.center.y, z: 0 },
      { x: 1, y: 0, z: 0 },
      hitbox,
    );
    expect(distance).not.toBeNull();
    expect(distance ?? 0).toBeCloseTo(10 - hitbox.radius, 1);
  });
  it('misses a ray that passes outside the hit sphere', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 10, y: 0, z: 0 });
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    expect(raySphereDistance({ x: 0, y: 100, z: 0 }, { x: 1, y: 0, z: 0 }, hitbox)).toBeNull();
  });
});

describe('applyKickback', () => {
  it('scales the velocity change by magnitude/mass and the falloff', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyKickback(world, id, { x: 0, y: 1, z: 0 }, 1750, 1, LIGHT_ARMOR);
    expect(world.players.velocity[id * 3 + 1]).toBeCloseTo(1750 / LIGHT_ARMOR.mass);
  });
  it('does nothing at zero falloff', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    applyKickback(world, id, { x: 0, y: 1, z: 0 }, 1750, 0, LIGHT_ARMOR);
    expect(world.players.velocity[id * 3 + 1]).toBe(0);
  });
});
```

Extend `packages/sim/src/snapshot.test.ts`'s two `PlayerSnapshotData` literals (the one in the `'serializes only what the protocol needs'` test's expectation and the one built manually in `'deserializes back into an equivalent player'`) with `health: LIGHT_ARMOR.maxDamage` (a fresh player has taken no damage), importing `LIGHT_ARMOR` from `./armor.js`. `hash.test.ts` needs no literal change (it round-trips through `serializeActivePlayers`, which will already include `health`).

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- damage.test.ts`. Expect module resolution to fail for `./damage.js`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/sim/src/types.ts`'s `PlayerStore` interface (after `landingSpeed`):

```ts
  damage: Float64Array;
  alive: Uint8Array;
  respawnAt: Float64Array;
  score: Int16Array;
```

Add to `World`:

```ts
  pendingDeaths: number[];
```

In `packages/sim/src/world.ts`, add the four new arrays to `createWorld`'s `players` object (`damage: new Float64Array(capacity)`, `alive: new Uint8Array(capacity)`, `respawnAt: new Float64Array(capacity)`, `score: new Int16Array(capacity)`), add `pendingDeaths: []` to the returned `World`, and in `addPlayer` initialize `players.damage[id] = 0; players.alive[id] = 1; players.respawnAt[id] = -1; players.score[id] = 0;`.

Create `packages/sim/src/damage.ts`:

```ts
import type { ArmorData } from './armor.js';
import type { Vec3, World } from './types.js';

export const RESPAWN_SECONDS = 5; // Ours: the spec asks for a pick, not a T2 number.
const FIXED_DT = 32 / 1000;
export const RESPAWN_TICKS = Math.round(RESPAWN_SECONDS / FIXED_DT);
// Ours: no true capsule-vs-ray test this milestone. A sphere at capsule center height,
// radius = the wider bounding-box axis / 2, is close enough for a demo's hit detection.
const HEAD_BAND = 0.15; // Top 15% of player height counts as a headshot for the Laser Rifle.

export interface PlayerHitbox {
  center: Vec3;
  radius: number;
  headY: number;
}

export function playerHitbox(world: World, id: number, armor: ArmorData): PlayerHitbox {
  const base = id * 3;
  const x = world.players.position[base] ?? 0;
  const y = world.players.position[base + 1] ?? 0;
  const z = world.players.position[base + 2] ?? 0;
  const [boxX, boxY, height] = armor.boundingBox;
  return {
    center: { x, y: y + height / 2, z },
    radius: Math.max(boxX, boxY) / 2,
    headY: y + height * (1 - HEAD_BAND),
  };
}

export function raySphereDistance(origin: Vec3, dir: Vec3, hitbox: PlayerHitbox): number | null {
  const ox = origin.x - hitbox.center.x;
  const oy = origin.y - hitbox.center.y;
  const oz = origin.z - hitbox.center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - hitbox.radius * hitbox.radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const t = -b - Math.sqrt(discriminant);
  return t >= 0 ? t : null;
}

export function radiusFalloff(distance: number, radius: number): number {
  if (radius <= 0) return distance <= 0 ? 1 : 0;
  return Math.max(0, 1 - distance / radius);
}

export function applyKickback(
  world: World,
  id: number,
  direction: Vec3,
  magnitude: number,
  falloff: number,
  armor: ArmorData,
): void {
  if (falloff <= 0 || magnitude <= 0) return;
  const scale = (magnitude / armor.mass) * falloff;
  const base = id * 3;
  world.players.velocity[base] = (world.players.velocity[base] ?? 0) + direction.x * scale;
  world.players.velocity[base + 1] = (world.players.velocity[base + 1] ?? 0) + direction.y * scale;
  world.players.velocity[base + 2] = (world.players.velocity[base + 2] ?? 0) + direction.z * scale;
}

function scoreForDeath(world: World, victimId: number, attackerId: number): void {
  if (attackerId < 0) return; // Fall damage or another environmental cause: no score change.
  const players = world.players;
  if (attackerId === victimId) {
    players.score[victimId] = (players.score[victimId] ?? 0) - 10;
    return;
  }
  const sameTeam = players.team[attackerId] === players.team[victimId];
  players.score[attackerId] = (players.score[attackerId] ?? 0) + (sameTeam ? -10 : 10);
}

/** `attackerId` is -1 for fall damage or any other non-player cause. */
export function applyDamage(
  world: World,
  id: number,
  amount: number,
  attackerId: number,
  armor: ArmorData,
): void {
  const players = world.players;
  if (amount <= 0 || !players.active[id] || !players.alive[id]) return;
  players.damage[id] = (players.damage[id] ?? 0) + amount;
  if ((players.damage[id] ?? 0) < armor.maxDamage) return;
  players.alive[id] = 0;
  players.respawnAt[id] = world.tick + RESPAWN_TICKS;
  world.pendingDeaths.push(id);
  scoreForDeath(world, id, attackerId);
}

export function applyFallDamage(
  world: World,
  id: number,
  landingSpeed: number,
  armor: ArmorData,
): void {
  if (landingSpeed <= armor.minJumpSpeed) return;
  applyDamage(world, id, (landingSpeed - armor.minJumpSpeed) * armor.speedDamageScale, -1, armor);
}

export function respawnPlayer(world: World, id: number, spawn: Vec3): void {
  const players = world.players;
  players.alive[id] = 1;
  players.damage[id] = 0;
  players.respawnAt[id] = -1;
  players.position.set([spawn.x, spawn.y, spawn.z], id * 3);
  players.velocity.set([0, 0, 0], id * 3);
}

export function dueForRespawn(world: World): number[] {
  const ids: number[] = [];
  const players = world.players;
  for (let id = 0; id < players.count; id += 1) {
    if (
      players.active[id] &&
      !players.alive[id] &&
      players.respawnAt[id] >= 0 &&
      world.tick >= (players.respawnAt[id] ?? 0)
    ) {
      ids.push(id);
    }
  }
  return ids;
}
```

In `packages/sim/src/movement.ts`, add the import and clear `pendingDeaths` at the top of `stepPlayers`, skip dead players, and hook fall damage into the landing branch. Add at the top:

```ts
import { applyFallDamage } from './damage.js';
```

Change `stepPlayers`:

```ts
export function stepPlayers(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt: number,
): void {
  world.pendingDeaths = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const input = inputs.get(id) ?? { ...IDLE, yaw: world.players.yaw[id] ?? 0 };
    stepPlayer(world, id, input, LIGHT_ARMOR, dt);
  }
}
```

Change `writeState` to take `world`, `ctx`, and `armor` in place of `players`, and call `applyFallDamage` exactly when a landing happened this tick — the existing `contact.landingSpeed >= 0` guard already marks that tick, and reading `players.landingSpeed[id]` on a later tick would replay a stale value, so the call must live inside this branch, not after it. `wasGrounded` keeps reading `ctx.grounded` (the pre-tick state), not `contact.grounded` (the post-tick state) — the existing comment on `applyForces` explains why the jump-edge check needs the pre-tick value, and swapping in `contact.grounded` here would silently break the ski-hop landing jump:

```ts
function writeState(
  world: World,
  id: number,
  body: Body,
  contact: Contact,
  input: PlayerInput,
  ctx: TickContext,
  armor: ArmorData,
): void {
  const players = world.players;
  writeBody(players, id, body);
  if (contact.landingSpeed >= 0) {
    players.landingSpeed[id] = contact.landingSpeed;
    applyFallDamage(world, id, contact.landingSpeed, armor);
  }
  players.onGround[id] = contact.grounded ? 1 : 0;
  players.ski[id] = ctx.skiing ? 1 : 0;
  players.wasGrounded[id] = ctx.grounded ? 1 : 0;
  players.wasJumpHeld[id] = input.jump ? 1 : 0;
}
```

Change the call site at the end of `stepPlayer`:

```ts
  writeState(world, id, body, contact, input, ctx, armor);
```

In `packages/sim/src/snapshot.ts`, add `health: number;` to `PlayerSnapshotData` (after `energy`), import `LIGHT_ARMOR` from `./armor.js`, and change `serializePlayer`/`deserializePlayer`:

```ts
    energy: num(p.energy, id),
    health: LIGHT_ARMOR.maxDamage - num(p.damage, id),
    onGround: bit(p.onGround, id),
```

```ts
  players.energy[data.id] = data.energy;
  players.damage[data.id] = LIGHT_ARMOR.maxDamage - data.health;
  players.alive[data.id] = data.health > 0 ? 1 : 0;
  players.onGround[data.id] = data.onGround;
```

In `packages/sim/src/hash.ts`'s `mixPlayer`, mix in damage after energy:

```ts
  h = mix(h, num(players.energy, id));
  h = mix(h, num(players.damage, id));
  return h;
```

Add to `packages/sim/src/index.ts`:

```ts
export * from './damage.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`. The full sim suite, including `movement.test.ts` and `world.test.ts` (both unchanged this task), must stay green.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/damage.ts packages/sim/src/damage.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/movement.ts packages/sim/src/snapshot.ts packages/sim/src/snapshot.test.ts packages/sim/src/hash.ts packages/sim/src/index.ts
git commit -m "feat(sim): health, fall damage, death, respawn timer" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 2: Sim — weapon data, state machines, ammo/energy, input growth

**Files:** Create `packages/sim/src/weapons.ts`, `packages/sim/src/weapons.test.ts`; Modify `packages/sim/src/armor.ts`, `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/movement.ts`, `packages/sim/src/movement.test.ts`, `packages/sim/src/snapshot.ts`, `packages/sim/src/snapshot.test.ts`, `packages/sim/src/hash.ts`, `packages/sim/src/index.ts`, `packages/client/src/app.ts`, `packages/client/src/input.ts`, `packages/client/src/netclient.test.ts`, `packages/server/src/session.test.ts`, `packages/protocol/src/handshake.test.ts`
**Interfaces:** Consumes `World`, `PlayerStore`, `ArmorData`, `LIGHT_ARMOR`, `applyDamage` (Task 1, unused here directly but the shape it requires is why `WeaponData` carries a `directDamage` field Task 3 will read). Produces `WeaponId`, `WeaponState`, `WeaponData`, `WEAPON_DATA`, `GRENADE_DATA`, `WEAPON_COUNT`, `ammoIndex(id, weaponId)`, `weaponIdForSlot(slot)`, `FireEvent`, `stepWeapons(world, inputs, dt): void`. Extends `PlayerInput` with `pitch`, `fire`, `altFire`, `slot`. Extends `respawnPlayer` (Task 1) to also reset the weapon loadout.

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/weapons.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import { addPlayer, createWorld, type Heightfield, type PlayerInput } from './index.js';
import { respawnPlayer } from './damage.js';
import {
  ammoIndex,
  GRENADE_DATA,
  stepWeapons,
  WEAPON_DATA,
  WeaponId,
  WeaponState,
  weaponIdForSlot,
} from './weapons.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};
const IDLE: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0,
};
const FIXED_DT = 32 / 1000;
const ticksFor = (seconds: number): number => Math.ceil(seconds / FIXED_DT);

function fireOnce(world: ReturnType<typeof createWorld>, id: number, weaponId: WeaponId): void {
  world.players.weaponSlot[id] = weaponId;
  world.players.weaponState[id] = WeaponState.Ready;
  world.players.weaponTimer[id] = 0;
  stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
}

describe('weaponIdForSlot', () => {
  it('maps keys 1..5 to Spinfusor, Chaingun, Mortar, Laser Rifle, Blaster and 0 to no change', () => {
    expect(weaponIdForSlot(1)).toBe(WeaponId.Spinfusor);
    expect(weaponIdForSlot(2)).toBe(WeaponId.Chaingun);
    expect(weaponIdForSlot(3)).toBe(WeaponId.Mortar);
    expect(weaponIdForSlot(4)).toBe(WeaponId.LaserRifle);
    expect(weaponIdForSlot(5)).toBe(WeaponId.Blaster);
    expect(weaponIdForSlot(0)).toBeNull();
    expect(weaponIdForSlot(6)).toBeNull();
  });
});

describe('stepWeapons: Spinfusor timing (fire 1.25 s, reload 0.5 s)', () => {
  it('emits one FireEvent per full 1.75 s cycle, none while Firing or Reload', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.pendingFireEvents).toHaveLength(1);
    expect(world.players.weaponState[id]).toBe(WeaponState.Firing);
    for (let tick = 0; tick < ticksFor(1.25) - 1; tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
      expect(world.pendingFireEvents).toHaveLength(0);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.Reload);
    for (let tick = 0; tick < ticksFor(0.5) - 1; tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.Ready);
    stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    expect(world.pendingFireEvents).toHaveLength(1);
  });

  it('consumes one disc per shot from the Light loadout of 15', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo);
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo - 1);
  });

  it('goes DryFire then NoAmmo when the clip empties, and never emits a FireEvent again', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)] = 0;
    fireOnce(world, id, WeaponId.Spinfusor);
    expect(world.pendingFireEvents).toHaveLength(0);
    expect(world.players.weaponState[id]).toBe(WeaponState.DryFire);
    for (let tick = 0; tick < ticksFor(0.2); tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    }
    expect(world.players.weaponState[id]).toBe(WeaponState.NoAmmo);
    stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    expect(world.pendingFireEvents).toHaveLength(0);
  });
});

describe('stepWeapons: Chaingun spin-up (0.5 s once, then 0.15 s per shot while held)', () => {
  it('the first shot of a burst costs spinUp + fireTime; a held burst then costs only fireTime', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Chaingun);
    expect(world.pendingFireEvents).toHaveLength(1);
    const spunUpCost = WEAPON_DATA[WeaponId.Chaingun].spinUpTime! + WEAPON_DATA[WeaponId.Chaingun].fireTime;
    for (let tick = 0; tick < ticksFor(spunUpCost) - 1; tick += 1) {
      stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
      expect(world.pendingFireEvents).toHaveLength(0);
    }
    stepWeapons(world, new Map([[id, { ...IDLE, fire: true }]]), FIXED_DT);
    expect(world.pendingFireEvents).toHaveLength(1); // second shot: fireTime only, no second spin-up
  });

  it('releasing fire clears the spin-up so the next burst pays it again', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Chaingun);
    stepWeapons(world, new Map([[id, { ...IDLE, fire: false }]]), FIXED_DT);
    expect(world.players.spunUp[id]).toBe(0);
  });
});

describe('stepWeapons: Mortar timing (fire 0.8 s, reload 2.0 s)', () => {
  it('consumes no ammo — Light carries none, Mortar is not Light-allowed', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.ammo[ammoIndex(id, WeaponId.Mortar)]).toBe(0);
    fireOnce(world, id, WeaponId.Mortar);
    expect(world.pendingFireEvents).toHaveLength(0);
    expect(world.players.weaponState[id]).toBe(WeaponState.DryFire);
  });
});

describe('stepWeapons: Laser Rifle energy scaling and the minEnergy 6 refusal', () => {
  it('scales energyScale by energy/maxEnergy and spends energyPerShot', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.energy[id] = LIGHT_ARMOR.maxEnergy;
    fireOnce(world, id, WeaponId.LaserRifle);
    expect(world.pendingFireEvents[0]?.energyScale).toBeCloseTo(1);
    expect(world.players.energy[id]).toBeCloseTo(LIGHT_ARMOR.maxEnergy - WEAPON_DATA[WeaponId.LaserRifle].energyPerShot!);
  });

  it('scales damage down at partial energy and refuses below minEnergy 6', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    world.players.energy[id] = 30;
    fireOnce(world, id, WeaponId.LaserRifle);
    expect(world.pendingFireEvents[0]?.energyScale).toBeCloseTo(30 / LIGHT_ARMOR.maxEnergy);
    world.players.energy[id] = 5;
    fireOnce(world, id, WeaponId.LaserRifle);
    expect(world.pendingFireEvents).toHaveLength(0);
    expect(world.players.weaponState[id]).toBe(WeaponState.DryFire);
  });
});

describe('stepWeapons: altFire grenade throw', () => {
  it('throws from the Light loadout of 5, gated by a 1.0 s cooldown, independent of the held weapon', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount);
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount - 1);
    expect(world.pendingFireEvents[0]?.isAltFire).toBe(true);
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount - 1); // cooldown still active
    for (let tick = 0; tick < ticksFor(GRENADE_DATA.throwCooldown); tick += 1) {
      stepWeapons(world, new Map([[id, IDLE]]), FIXED_DT);
    }
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount - 2);
  });
});

describe('slot switching', () => {
  it('switches instantly (0 s activate) and resets state to Ready', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Spinfusor);
    stepWeapons(world, new Map([[id, { ...IDLE, slot: 2 }]]), FIXED_DT);
    expect(world.players.weaponSlot[id]).toBe(WeaponId.Chaingun);
    expect(world.players.weaponState[id]).toBe(WeaponState.Ready);
  });
});

describe('respawnPlayer resets the loadout', () => {
  it('restores full ammo, grenades, and the starting weapon', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    fireOnce(world, id, WeaponId.Spinfusor);
    stepWeapons(world, new Map([[id, { ...IDLE, altFire: true }]]), FIXED_DT);
    respawnPlayer(world, id, { x: 0, y: 0, z: 0 });
    expect(world.players.ammo[ammoIndex(id, WeaponId.Spinfusor)]).toBe(LIGHT_ARMOR.discAmmo);
    expect(world.players.grenades[id]).toBe(LIGHT_ARMOR.grenadeCount);
    expect(world.players.weaponSlot[id]).toBe(WeaponId.Blaster);
    expect(world.players.weaponState[id]).toBe(WeaponState.Ready);
  });
});
```

Extend the single `idle` const in `packages/sim/src/movement.test.ts` (every test already spreads it via `inputMap`, so this is the only literal that needs the new fields):

```ts
const idle: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0,
};
```

Extend `packages/sim/src/snapshot.test.ts`'s two `PlayerSnapshotData` literals with `weaponSlot: WeaponId.Blaster` (a fresh player's starting weapon), importing `WeaponId` from `./weapons.js`.

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- weapons.test.ts`. Expect module resolution to fail for `./weapons.js`.

- [ ] **Step 3: Write minimal implementation**

In `packages/sim/src/armor.ts`, add to `ArmorData` (after `speedDamageScale`, the last existing field):

```ts
  discAmmo: number;
  chaingunAmmo: number;
  mortarAmmo: number;
  grenadeCount: number;
  maxWeapons: number;
  laserRifleAllowed: boolean;
  mortarAllowed: boolean;
```

Add to `LIGHT_ARMOR`'s literal:

```ts
  discAmmo: 15,
  chaingunAmmo: 100,
  mortarAmmo: 0,
  grenadeCount: 5,
  maxWeapons: 3,
  laserRifleAllowed: true,
  mortarAllowed: false,
```

In `packages/sim/src/types.ts`, change `PlayerInput`:

```ts
export interface PlayerInput {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  jet: boolean;
  fire: boolean;
  altFire: boolean;
  slot: number; // 0 = no change, 1..5 = select that weapon slot (see weaponIdForSlot)
}
```

Add to `PlayerStore` (after `score`):

```ts
  weaponSlot: Uint8Array;
  weaponState: Uint8Array;
  weaponTimer: Float64Array;
  spunUp: Uint8Array;
  grenadeCooldown: Float64Array;
  ammo: Int16Array;
  grenades: Uint8Array;
```

Add to `World`:

```ts
  pendingFireEvents: import('./weapons.js').FireEvent[];
```

Create `packages/sim/src/weapons.ts`:

```ts
import { LIGHT_ARMOR, type ArmorData } from './armor.js';
import { respawnPlayer as respawnHealth } from './damage.js';
import type { PlayerInput, Vec3, World } from './types.js';

export enum WeaponId {
  Spinfusor = 0,
  Chaingun = 1,
  Mortar = 2,
  LaserRifle = 3,
  Blaster = 4,
}
export const WEAPON_COUNT = 5;

export enum WeaponState {
  Activate = 0,
  Ready = 1,
  Firing = 2,
  Reload = 3,
  NoAmmo = 4,
  DryFire = 5,
}

export enum ProjectileType {
  Linear = 0,
  Tracer = 1,
  Grenade = 2,
}

export interface WeaponData {
  id: WeaponId;
  projectile: ProjectileType | null; // null = hitscan (Laser Rifle)
  speed: number;
  velInherit: number;
  directDamage: number;
  radiusDamage: number;
  radius: number;
  kickback: number;
  fireTime: number;
  reloadTime: number;
  lifetime: number;
  activateTime: number;
  spinUpTime?: number;
  drag?: number;
  elasticity?: number;
  armTime?: number;
  maxRange?: number;
  headMultiplier?: number;
  energyPerShot?: number;
  minEnergy?: number;
}

const DRY_FIRE_SECONDS = 0.2; // Ours: a brief empty-click before the persistent NoAmmo state.
export const MUZZLE_HEIGHT = 1.6; // Ours: roughly chest height on Light's 2.3 m capsule.

// Spec's Weapon numbers table, used exactly. Chaingun's spinDownTime (1.0 s) is kept for the
// client's future barrel-spin visual but does not gate fire logic this milestone — see the
// spin-up test for the gating we do implement.
export const WEAPON_DATA: Record<WeaponId, WeaponData> = {
  [WeaponId.Spinfusor]: {
    id: WeaponId.Spinfusor, projectile: ProjectileType.Linear, speed: 90, velInherit: 0.5,
    directDamage: 0, radiusDamage: 0.5, radius: 7.5, kickback: 1750,
    fireTime: 1.25, reloadTime: 0.5, lifetime: 5, activateTime: 0,
  },
  [WeaponId.Chaingun]: {
    id: WeaponId.Chaingun, projectile: ProjectileType.Tracer, speed: 425, velInherit: 1.0,
    directDamage: 0.0825, radiusDamage: 0, radius: 0, kickback: 0,
    fireTime: 0.15, reloadTime: 0, lifetime: 3, activateTime: 0, spinUpTime: 0.5,
  },
  [WeaponId.Mortar]: {
    id: WeaponId.Mortar, projectile: ProjectileType.Grenade, speed: 63.7, velInherit: 0.5,
    directDamage: 0, radiusDamage: 1.0, radius: 20, kickback: 2500,
    fireTime: 0.8, reloadTime: 2.0, lifetime: 5, activateTime: 0,
    drag: 0.1, elasticity: 0.15, armTime: 2.0,
  },
  [WeaponId.LaserRifle]: {
    id: WeaponId.LaserRifle, projectile: null, speed: 0, velInherit: 0,
    directDamage: 0.4, radiusDamage: 0, radius: 0, kickback: 0,
    fireTime: 0.5, reloadTime: 0.5, lifetime: 0, activateTime: 0,
    maxRange: 1000, headMultiplier: 1.3, energyPerShot: 6, minEnergy: 6,
  },
  // Blaster: the spec gives no numbers for the player-carried Blaster, only the vehicle
  // Shrike blaster (0.125 direct, 425 m/s). Every field below is ours.
  [WeaponId.Blaster]: {
    id: WeaponId.Blaster, projectile: ProjectileType.Linear, speed: 300, velInherit: 0.5,
    directDamage: 0.1, radiusDamage: 0, radius: 0, kickback: 0,
    fireTime: 0.2, reloadTime: 0.3, lifetime: 2, activateTime: 0,
  },
};

// Hand grenade: the spec's grenade.cs row gives only "0.4 radius" damage. Every other field
// (radius, kickback, throw speed, arm delay, lifetime, cooldown) is ours; drag/elasticity
// reuse Mortar's GrenadeProjectile physics numbers since the spec ties both to the same base.
export const GRENADE_DATA = {
  radiusDamage: 0.4, radius: 10, kickback: 1000, speed: 25,
  armTime: 0.5, lifetime: 3, drag: 0.1, elasticity: 0.15, throwCooldown: 1.0,
};

export interface FireEvent {
  playerId: number;
  weaponId: WeaponId;
  isAltFire: boolean;
  origin: Vec3;
  direction: Vec3;
  shooterVelocity: Vec3;
  energyScale: number; // 1 for every weapon except the Laser Rifle
}

export function ammoIndex(id: number, weaponId: WeaponId): number {
  return id * WEAPON_COUNT + weaponId;
}

export function weaponIdForSlot(slot: number): WeaponId | null {
  return slot >= 1 && slot <= 5 ? ((slot - 1) as WeaponId) : null;
}

function fireDirection(yaw: number, pitch: number): Vec3 {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
}

function shooterVelocity(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.velocity[base] ?? 0,
    y: world.players.velocity[base + 1] ?? 0,
    z: world.players.velocity[base + 2] ?? 0,
  };
}

function shooterOrigin(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: (world.players.position[base + 1] ?? 0) + MUZZLE_HEIGHT,
    z: world.players.position[base + 2] ?? 0,
  };
}

function applySlot(world: World, id: number, input: PlayerInput): void {
  const requested = weaponIdForSlot(input.slot);
  if (requested === null || requested === world.players.weaponSlot[id]) return;
  world.players.weaponSlot[id] = requested;
  world.players.weaponState[id] = WeaponState.Ready;
  world.players.weaponTimer[id] = 0;
  world.players.spunUp[id] = 0;
}

function advanceTimer(world: World, id: number, dt: number): void {
  const players = world.players;
  if ((players.weaponTimer[id] ?? 0) <= 0) return;
  players.weaponTimer[id] = Math.max(0, (players.weaponTimer[id] ?? 0) - dt);
  if ((players.weaponTimer[id] ?? 0) > 0) return;
  if (players.weaponState[id] === WeaponState.Firing) {
    const data = WEAPON_DATA[players.weaponSlot[id] as WeaponId];
    players.weaponState[id] = WeaponState.Reload;
    players.weaponTimer[id] = data.reloadTime;
  } else if (players.weaponState[id] === WeaponState.Reload) {
    players.weaponState[id] = WeaponState.Ready;
  } else if (players.weaponState[id] === WeaponState.DryFire) {
    players.weaponState[id] = WeaponState.NoAmmo;
  }
}

function fireCost(world: World, id: number, data: WeaponData): number {
  if (data.id !== WeaponId.Chaingun) return data.fireTime;
  if (world.players.spunUp[id]) return data.fireTime;
  world.players.spunUp[id] = 1;
  return (data.spinUpTime ?? 0) + data.fireTime;
}

function energyScaleFor(world: World, id: number, data: WeaponData): number | null {
  if (data.energyPerShot === undefined) return 1;
  const energy = world.players.energy[id] ?? 0;
  if (energy < (data.minEnergy ?? 0)) return null;
  const scale = Math.min(1, energy / LIGHT_ARMOR.maxEnergy);
  world.players.energy[id] = energy - data.energyPerShot;
  return scale;
}

function tryFireWeapon(world: World, id: number, input: PlayerInput): void {
  const players = world.players;
  const weaponId = players.weaponSlot[id] as WeaponId;
  const data = WEAPON_DATA[weaponId];
  const index = ammoIndex(id, weaponId);
  const ammo = players.ammo[index] ?? 0;
  const energyScale = energyScaleFor(world, id, data);
  if (ammo === 0 || energyScale === null) {
    players.weaponState[id] = WeaponState.DryFire;
    players.weaponTimer[id] = DRY_FIRE_SECONDS;
    return;
  }
  if (ammo > 0) players.ammo[index] = ammo - 1;
  players.weaponState[id] = WeaponState.Firing;
  players.weaponTimer[id] = fireCost(world, id, data);
  world.pendingFireEvents.push({
    playerId: id, weaponId, isAltFire: false,
    origin: shooterOrigin(world, id), direction: fireDirection(input.yaw, input.pitch),
    shooterVelocity: shooterVelocity(world, id), energyScale,
  });
}

function tryThrowGrenade(world: World, id: number, input: PlayerInput): void {
  const players = world.players;
  if (!input.altFire || (players.grenadeCooldown[id] ?? 0) > 0 || (players.grenades[id] ?? 0) <= 0) return;
  players.grenades[id] = (players.grenades[id] ?? 0) - 1;
  players.grenadeCooldown[id] = GRENADE_DATA.throwCooldown;
  world.pendingFireEvents.push({
    playerId: id, weaponId: WeaponId.Spinfusor, isAltFire: true,
    origin: shooterOrigin(world, id), direction: fireDirection(input.yaw, input.pitch),
    shooterVelocity: shooterVelocity(world, id), energyScale: 1,
  });
}

function stepOnePlayer(world: World, id: number, input: PlayerInput, dt: number): void {
  const players = world.players;
  if (!input.fire) players.spunUp[id] = 0;
  if ((players.grenadeCooldown[id] ?? 0) > 0) {
    players.grenadeCooldown[id] = Math.max(0, (players.grenadeCooldown[id] ?? 0) - dt);
  }
  applySlot(world, id, input);
  advanceTimer(world, id, dt);
  const state = players.weaponState[id];
  if (input.fire && (state === WeaponState.Ready || state === WeaponState.NoAmmo)) {
    tryFireWeapon(world, id, input);
  }
  tryThrowGrenade(world, id, input);
}

export function stepWeapons(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt: number): void {
  world.pendingFireEvents = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const input = inputs.get(id);
    if (input) stepOnePlayer(world, id, input, dt);
  }
}

export function resetLoadout(world: World, id: number, armor: ArmorData): void {
  const players = world.players;
  players.weaponSlot[id] = WeaponId.Blaster; // Ours: Blaster is the starting/fallback weapon.
  players.weaponState[id] = WeaponState.Ready;
  players.weaponTimer[id] = 0;
  players.spunUp[id] = 0;
  players.grenadeCooldown[id] = 0;
  players.ammo[ammoIndex(id, WeaponId.Spinfusor)] = armor.discAmmo;
  players.ammo[ammoIndex(id, WeaponId.Chaingun)] = armor.chaingunAmmo;
  players.ammo[ammoIndex(id, WeaponId.Mortar)] = armor.mortarAmmo;
  players.ammo[ammoIndex(id, WeaponId.LaserRifle)] = -1; // -1 = infinite, gated by energy only.
  players.ammo[ammoIndex(id, WeaponId.Blaster)] = -1;
  players.grenades[id] = armor.grenadeCount;
}

export function respawnPlayer(world: World, id: number, spawn: Vec3): void {
  respawnHealth(world, id, spawn);
  resetLoadout(world, id, LIGHT_ARMOR);
}
```

Note the last export shadows Task 1's `respawnPlayer` from `damage.ts` — from here on, callers import `respawnPlayer` from `weapons.ts` (re-exported through `index.ts` after `damage.ts`, so the later export wins), which resets health *and* the loadout in one call. `damage.ts`'s own `respawnPlayer` stays as the internal `respawnHealth` this file wraps.

In `packages/sim/src/world.ts`, add the seven new arrays to `createWorld`'s `players` object:

```ts
      weaponSlot: new Uint8Array(capacity),
      weaponState: new Uint8Array(capacity),
      weaponTimer: new Float64Array(capacity),
      spunUp: new Uint8Array(capacity),
      grenadeCooldown: new Float64Array(capacity),
      ammo: new Int16Array(capacity * WEAPON_COUNT),
      grenades: new Uint8Array(capacity),
```

add `pendingFireEvents: []` to the returned `World`, import `WEAPON_COUNT` and `resetLoadout` from `./weapons.js`, and call `resetLoadout(world, id, LIGHT_ARMOR)` at the end of `addPlayer` (after the existing field initialization, before `return id;`). Change `stepWorld`:

```ts
export function stepWorld(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt = FIXED_DT,
): void {
  if (dt !== FIXED_DT)
    throw new RangeError(`Simulation step requires fixed tick ${FIXED_TICK_MS} ms`);
  stepPlayers(world, inputs, dt);
  stepWeapons(world, inputs, dt);
  world.tick += 1;
}
```

In `packages/sim/src/movement.ts`, extend `IDLE`:

```ts
const IDLE: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0,
};
```

In `packages/sim/src/snapshot.ts`, add `weaponSlot: number;` to `PlayerSnapshotData` (after `health`), and in `serializePlayer`/`deserializePlayer`:

```ts
    health: LIGHT_ARMOR.maxDamage - num(p.damage, id),
    weaponSlot: num(p.weaponSlot, id),
    onGround: bit(p.onGround, id),
```

```ts
  players.alive[data.id] = data.health > 0 ? 1 : 0;
  players.weaponSlot[data.id] = data.weaponSlot;
  players.onGround[data.id] = data.onGround;
```

In `packages/sim/src/hash.ts`'s `mixPlayer`, mix in `weaponSlot` after `damage`:

```ts
  h = mix(h, num(players.damage, id));
  h = mix(h, num(players.weaponSlot, id));
  return h;
```

Add to `packages/sim/src/index.ts`:

```ts
export * from './weapons.js';
```

Because `weapons.js` is exported after `damage.js`, and both export a function named `respawnPlayer`, the wildcard re-export gives callers `weapons.ts`'s version — the one that resets the loadout too. This is intentional and is exactly why Task 1's `damage.test.ts` imports `respawnPlayer` directly from `./damage.js` (bypassing the barrel) while every later task imports it from `./index.js`.

Now sweep every other `PlayerInput`-literal site in the repo so `pnpm typecheck` stays green end to end:

In `packages/client/src/app.ts`, extend `IDLE`:

```ts
const IDLE: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0,
};
```

and change the one call site that builds free-cam input, `{ ...IDLE, yaw: input.yaw }`, to also carry pitch: `{ ...IDLE, yaw: input.yaw, pitch: input.pitch }` (Task 8 wires real fire/altFire/slot into the non-free-cam path; free cam stays inert).

In `packages/client/src/input.ts`'s `snapshot()`, add the three new fields with placeholder values Task 8 will replace (`pitch: this.pitch, fire: false, altFire: false, slot: 0`) — this task's only job is to keep the repo compiling; Task 8 owns the real key/mouse wiring.

In `packages/client/src/netclient.test.ts`, extend `skiInput` and `serverInput` (both `PlayerInput` literals) with `pitch: 0, fire: false, altFire: false, slot: 0`, the inline literal in the `'drops a delta...'` test's `client.tick({...})` call the same way, and the `state`/`serverState` object literals (both `PlayerSnapshotData`-shaped) with `health: LIGHT_ARMOR.maxDamage, weaponSlot: 4` (import `LIGHT_ARMOR` from `@clans/sim`; `4` is `WeaponId.Blaster`, the starting weapon — `@clans/sim` re-exports `WeaponId` so the test can import and use it instead of the bare literal if preferred).

In `packages/server/src/session.test.ts`, extend the `sample` helper:

```ts
const sample = (moveZ: number): NetInputSample => ({
  moveX: 0, moveZ, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0,
});
```

In `packages/protocol/src/handshake.test.ts`, extend each of the three sample objects in the `'round-trips an Input message...'` test with `pitch: 0, fire: false, altFire: false, slot: 0` (or a non-default value on one of them, to keep the round-trip meaningful — e.g. the first sample gets `pitch: 0.1, fire: true, altFire: false, slot: 2`).

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm --filter @clans/protocol test && pnpm --filter @clans/server test && pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`. Every package must be green — this is the task that proves the `PlayerInput` sweep was complete.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/weapons.ts packages/sim/src/weapons.test.ts packages/sim/src/armor.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/movement.ts packages/sim/src/movement.test.ts packages/sim/src/snapshot.ts packages/sim/src/snapshot.test.ts packages/sim/src/hash.ts packages/sim/src/index.ts packages/client/src/app.ts packages/client/src/input.ts packages/client/src/netclient.test.ts packages/server/src/session.test.ts packages/protocol/src/handshake.test.ts
git commit -m "feat(sim): weapon state machines, ammo, and fire/altFire/slot/pitch input" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 3: Sim — projectile store, terrain/player collision, hitscan

**Files:** Create `packages/sim/src/projectiles.ts`, `packages/sim/src/projectiles.test.ts`; Modify `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/index.ts`
**Interfaces:** Consumes `World`, `FireEvent`, `WeaponId`, `WEAPON_DATA`, `GRENADE_DATA`, `ProjectileType` (Task 2), `applyDamage`, `applyKickback`, `radiusFalloff`, `playerHitbox`, `raySphereDistance` (Task 1), `sampleTerrain`, `GRAVITY` (existing). Produces `ProjectileStore`, `PROJECTILE_CAPACITY`, `stepProjectiles(world, dt): void`. Covers the spec's disc-speed/velInherit, mortar-arm/bounce, and radius-falloff/kickback tests.

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/projectiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LIGHT_ARMOR } from './armor.js';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import { WeaponId, type FireEvent } from './weapons.js';
import { stepProjectiles } from './projectiles.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};
const FIXED_DT = 32 / 1000;

function fire(world: ReturnType<typeof createWorld>, event: Partial<FireEvent>): void {
  world.pendingFireEvents = [{
    playerId: 0, weaponId: WeaponId.Spinfusor, isAltFire: false,
    origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: 0, z: 1 },
    shooterVelocity: { x: 0, y: 0, z: 0 }, energyScale: 1,
    ...event,
  }];
}

function firstProjectile(world: ReturnType<typeof createWorld>) {
  const p = world.projectiles;
  for (let id = 0; id < p.count; id += 1) if (p.active[id]) return id;
  throw new Error('no active projectile');
}

describe('spawnProjectile: disc speed and velocity inheritance', () => {
  it('disc travels at 90 m/s plus 0.5x the shooter velocity', () => {
    const world = createWorld(flat, 1);
    fire(world, { shooterVelocity: { x: 0, y: 0, z: 20 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    expect(world.projectiles.velocity[id * 3 + 2]).toBeCloseTo(90 + 20 * 0.5);
  });

  it('a fresh disc despawns after its 5 s lifetime with no hit', () => {
    const world = createWorld(flat, 1);
    fire(world, { origin: { x: 0, y: 500, z: 0 }, direction: { x: 0, y: 0, z: 1 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    for (let tick = 0; tick < Math.ceil(5 / FIXED_DT) + 1; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(0);
  });
});

describe('radius damage and kickback: two discs kill a Light', () => {
  it('a disc detonating at a player\'s center does 0.5 damage and the spec\'s kickback', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, { origin: { x: 0, y: 10, z: 9 }, direction: { x: 0, y: -1, z: 0.1 } });
    for (let tick = 0; tick < 5; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeLessThan(LIGHT_ARMOR.maxDamage);
    fire(world, { origin: { x: 0, y: 10, z: 9 }, direction: { x: 0, y: -1, z: 0.1 } });
    for (let tick = 0; tick < 5; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.players.alive[target]).toBe(0);
  });
});

describe('terrain collision', () => {
  it('a disc fired into the ground detonates and despawns', () => {
    const world = createWorld(flat, 1);
    fire(world, { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(0);
  });
});

describe('direct-hit weapons: no radius, damage only the player actually hit', () => {
  it('a Chaingun bullet does 0.0825 direct damage and no splash to a bystander', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    const bystander = addPlayer(world, { x: 0, y: 0, z: 10.5 });
    fire(world, {
      weaponId: WeaponId.Chaingun,
      origin: { x: 0, y: 1.6, z: 0 }, direction: { x: 0, y: 0, z: 1 },
    });
    for (let tick = 0; tick < 3; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeCloseTo(LIGHT_ARMOR.maxDamage - 0.0825, 3);
    expect(world.players.damage[bystander]).toBe(0);
  });
});

describe('Mortar: arms after 2 s, bounces with elasticity 0.15 before then', () => {
  it('bounces off flat terrain while unarmed, reversing and shrinking the vertical velocity', () => {
    const world = createWorld(flat, 1);
    fire(world, {
      weaponId: WeaponId.Mortar,
      origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -1, z: 0 },
    });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    let bounced = false;
    for (let tick = 0; tick < 30 && world.projectiles.active[id]; tick += 1) {
      const before = world.projectiles.velocity[id * 3 + 1] ?? 0;
      stepProjectiles(world, FIXED_DT);
      const after = world.projectiles.active[id] ? (world.projectiles.velocity[id * 3 + 1] ?? 0) : 0;
      if (before < 0 && after > 0) bounced = true;
    }
    expect(bounced).toBe(true);
  });

  it('detonates on the first terrain contact once armed (after 2 s)', () => {
    const world = createWorld(flat, 1);
    fire(world, {
      weaponId: WeaponId.Mortar,
      origin: { x: 0, y: 0.05, z: 0 }, direction: { x: 1, y: 0, z: 0 },
      shooterVelocity: { x: 0, y: 0, z: 0 },
    });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    for (let tick = 0; tick < Math.ceil(2 / FIXED_DT); tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.armed[id]).toBe(1);
    stepProjectiles(world, FIXED_DT);
    // Once armed, gravity pulls it back to the ground within a tick or two and it detonates.
    for (let tick = 0; tick < 5 && world.projectiles.active[id]; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.projectiles.active[id]).toBe(0);
  });
});

describe('hitscan: Laser Rifle', () => {
  it('applies energyScale * directDamage instantly, no stored projectile', () => {
    const world = createWorld(flat, 1);
    const target = addPlayer(world, { x: 0, y: 0, z: 10 });
    fire(world, {
      weaponId: WeaponId.LaserRifle,
      origin: { x: 0, y: 1.6, z: 0 }, direction: { x: 0, y: 0, z: 1 },
      energyScale: 0.5,
    });
    stepProjectiles(world, FIXED_DT);
    expect(LIGHT_ARMOR.maxDamage - world.players.damage[target]!).toBeCloseTo(LIGHT_ARMOR.maxDamage - 0.4 * 0.5, 3);
    expect(world.projectiles.count).toBe(0);
  });
});

describe('grenade altFire', () => {
  it('spawns a Grenade-type projectile inheriting the shooter velocity, at the ours-picked 25 m/s throw speed', () => {
    const world = createWorld(flat, 1);
    fire(world, { isAltFire: true, shooterVelocity: { x: 0, y: 0, z: 10 } });
    stepProjectiles(world, FIXED_DT);
    const id = firstProjectile(world);
    expect(world.projectiles.type[id]).toBe(2); // ProjectileType.Grenade
    expect(world.projectiles.velocity[id * 3 + 2]).toBeCloseTo(25 + 10); // direction.z=1 * speed(25) + shooterVelocity.z(10) * velInherit(1)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- projectiles.test.ts`. Expect module resolution to fail for `./projectiles.js`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/sim/src/types.ts`, a new store interface plus `World.projectiles`:

```ts
export interface ProjectileStore {
  count: number;
  freeIds: number[];
  active: Uint8Array;
  type: Uint8Array;
  weaponId: Uint8Array;
  ownerId: Int16Array;
  position: Float64Array;
  velocity: Float64Array;
  expiresAtTick: Float64Array;
  armed: Uint8Array;
}
```

Add `projectiles: ProjectileStore;` to `World`.

Create `packages/sim/src/projectiles.ts`:

```ts
import { LIGHT_ARMOR } from './armor.js';
import { applyDamage, applyKickback, playerHitbox, radiusFalloff, raySphereDistance } from './damage.js';
import { GRAVITY } from './movement.js';
import { sampleTerrain } from './terrain.js';
import type { ProjectileStore, Vec3, World } from './types.js';
import { GRENADE_DATA, ProjectileType, WEAPON_DATA, type FireEvent, type WeaponData, type WeaponId } from './weapons.js';

export const PROJECTILE_CAPACITY = 256; // Ours: comfortably above what 32 players can sustain.
const FIXED_DT = 32 / 1000;

export function createProjectileStore(capacity = PROJECTILE_CAPACITY): ProjectileStore {
  return {
    count: 0,
    freeIds: [],
    active: new Uint8Array(capacity),
    type: new Uint8Array(capacity),
    weaponId: new Uint8Array(capacity),
    ownerId: new Int16Array(capacity),
    position: new Float64Array(capacity * 3),
    velocity: new Float64Array(capacity * 3),
    expiresAtTick: new Float64Array(capacity),
    armed: new Uint8Array(capacity),
  };
}

function allocate(store: ProjectileStore): number | null {
  const id = store.freeIds.pop() ?? store.count;
  if (id >= store.active.length) return null; // Capacity exceeded: drop the shot silently.
  if (id === store.count) store.count += 1;
  store.active[id] = 1;
  return id;
}

function free(store: ProjectileStore, id: number): void {
  store.active[id] = 0;
  store.freeIds.push(id);
}

function velocityFor(direction: Vec3, speed: number, shooterVel: Vec3, velInherit: number): Vec3 {
  return {
    x: direction.x * speed + shooterVel.x * velInherit,
    y: direction.y * speed + shooterVel.y * velInherit,
    z: direction.z * speed + shooterVel.z * velInherit,
  };
}

function spawnStored(
  world: World, event: FireEvent, type: ProjectileType, weaponId: WeaponId,
  speed: number, velInherit: number, lifetime: number,
): void {
  const id = allocate(world.projectiles);
  if (id === null) return;
  const store = world.projectiles;
  store.type[id] = type;
  store.weaponId[id] = weaponId;
  store.ownerId[id] = event.playerId;
  store.position.set([event.origin.x, event.origin.y, event.origin.z], id * 3);
  const velocity = velocityFor(event.direction, speed, event.shooterVelocity, velInherit);
  store.velocity.set([velocity.x, velocity.y, velocity.z], id * 3);
  store.expiresAtTick[id] = world.tick + Math.round(lifetime / FIXED_DT);
  store.armed[id] = 0;
}

function explode(world: World, point: Vec3, radiusDamage: number, radius: number, kickback: number, ownerId: number): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const hitbox = playerHitbox(world, id, LIGHT_ARMOR);
    const dx = hitbox.center.x - point.x, dy = hitbox.center.y - point.y, dz = hitbox.center.z - point.z;
    const distance = Math.hypot(dx, dy, dz);
    const falloff = radiusFalloff(distance, radius);
    if (falloff <= 0) continue;
    applyDamage(world, id, radiusDamage * falloff, ownerId, LIGHT_ARMOR);
    const length = distance || 1;
    applyKickback(world, id, { x: dx / length, y: dy / length, z: dz / length }, kickback, falloff, LIGHT_ARMOR);
  }
}

function findDirectHit(world: World, id: number, previous: Vec3, current: Vec3): number | null {
  const dx = current.x - previous.x, dy = current.y - previous.y, dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!world.players.active[playerId] || !world.players.alive[playerId] || playerId === world.projectiles.ownerId[id]) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(previous, direction, hitbox);
    if (distance !== null && distance <= length) return playerId;
  }
  return null;
}

function resolveImpact(
  world: World, id: number, data: { radiusDamage: number; radius: number; kickback: number; directDamage?: number },
  point: Vec3, hitPlayerId: number | null,
): void {
  const owner = world.projectiles.ownerId[id] ?? -1;
  if (data.radiusDamage > 0) {
    explode(world, point, data.radiusDamage, data.radius, data.kickback, owner);
  } else if (hitPlayerId !== null) {
    applyDamage(world, hitPlayerId, data.directDamage ?? 0, owner, LIGHT_ARMOR);
  }
  free(world.projectiles, id);
}

function bounce(world: World, id: number, terrainNormal: { x: number; y: number; z: number }): void {
  const store = world.projectiles;
  const base = id * 3;
  const vx = store.velocity[base] ?? 0, vy = store.velocity[base + 1] ?? 0, vz = store.velocity[base + 2] ?? 0;
  const along = vx * terrainNormal.x + vy * terrainNormal.y + vz * terrainNormal.z;
  const elasticity = GRENADE_DATA.elasticity;
  store.velocity[base] = (vx - 2 * along * terrainNormal.x) * elasticity;
  store.velocity[base + 1] = (vy - 2 * along * terrainNormal.y) * elasticity;
  store.velocity[base + 2] = (vz - 2 * along * terrainNormal.z) * elasticity;
}

function stepLinearOrTracer(world: World, id: number, dt: number): void {
  const store = world.projectiles;
  const base = id * 3;
  const previous: Vec3 = { x: store.position[base] ?? 0, y: store.position[base + 1] ?? 0, z: store.position[base + 2] ?? 0 };
  store.position[base] = previous.x + (store.velocity[base] ?? 0) * dt;
  store.position[base + 1] = previous.y + (store.velocity[base + 1] ?? 0) * dt;
  store.position[base + 2] = previous.z + (store.velocity[base + 2] ?? 0) * dt;
  const current: Vec3 = { x: store.position[base] ?? 0, y: store.position[base + 1] ?? 0, z: store.position[base + 2] ?? 0 };
  const data = WEAPON_DATA[store.weaponId[id] as WeaponId];
  const hitPlayer = findDirectHit(world, id, previous, current);
  const terrain = sampleTerrain(world.terrain, current.x, current.z);
  if (hitPlayer !== null) { resolveImpact(world, id, data, current, hitPlayer); return; }
  if (current.y <= terrain.height) { resolveImpact(world, id, data, current, null); return; }
  if (world.tick >= (store.expiresAtTick[id] ?? 0)) free(store, id);
}

function grenadeArmTicks(isMortar: boolean): number {
  return Math.round((isMortar ? (WEAPON_DATA[2].armTime ?? 0) : GRENADE_DATA.armTime) / FIXED_DT);
}
function grenadeLifetimeTicks(isMortar: boolean): number {
  return Math.round((isMortar ? WEAPON_DATA[2].lifetime : GRENADE_DATA.lifetime) / FIXED_DT);
}

function integrateGrenade(store: ProjectileStore, id: number, dt: number): Vec3 {
  const base = id * 3;
  store.velocity[base + 1] = (store.velocity[base + 1] ?? 0) - GRAVITY * dt;
  const drag = Math.max(0, 1 - GRENADE_DATA.drag * dt);
  store.velocity[base] = (store.velocity[base] ?? 0) * drag;
  store.velocity[base + 2] = (store.velocity[base + 2] ?? 0) * drag;
  store.position[base] = (store.position[base] ?? 0) + (store.velocity[base] ?? 0) * dt;
  store.position[base + 1] = (store.position[base + 1] ?? 0) + (store.velocity[base + 1] ?? 0) * dt;
  store.position[base + 2] = (store.position[base + 2] ?? 0) + (store.velocity[base + 2] ?? 0) * dt;
  return { x: store.position[base] ?? 0, y: store.position[base + 1] ?? 0, z: store.position[base + 2] ?? 0 };
}

function stepGrenade(world: World, id: number, dt: number): void {
  const store = world.projectiles;
  const current = integrateGrenade(store, id, dt);
  const isMortar = store.weaponId[id] === WEAPON_DATA[2].id; // WeaponId.Mortar
  const armAtTick = (store.expiresAtTick[id] ?? 0) - grenadeLifetimeTicks(isMortar) + grenadeArmTicks(isMortar);
  if (!store.armed[id] && world.tick >= armAtTick) store.armed[id] = 1;

  const terrain = sampleTerrain(world.terrain, current.x, current.z);
  const grounded = current.y <= terrain.height;
  const hitPlayer = store.armed[id] ? findDirectHit(world, id, current, current) : null;
  const data = isMortar ? WEAPON_DATA[2] : GRENADE_DATA;
  if (store.armed[id] && (grounded || hitPlayer !== null)) {
    resolveImpact(world, id, data, current, hitPlayer);
    return;
  }
  if (grounded) {
    store.position[id * 3 + 1] = terrain.height;
    bounce(world, id, terrain.normal);
  }
  if (world.tick >= (store.expiresAtTick[id] ?? 0)) {
    if (store.armed[id]) resolveImpact(world, id, data, current, null);
    else free(store, id);
  }
}

function resolveHitscan(world: World, event: FireEvent, data: WeaponData): void {
  let nearest: { playerId: number; distance: number } | null = null;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!world.players.active[playerId] || !world.players.alive[playerId] || playerId === event.playerId) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(event.origin, event.direction, hitbox);
    if (distance !== null && distance <= (data.maxRange ?? 0) && (!nearest || distance < nearest.distance)) {
      nearest = { playerId, distance };
    }
  }
  if (!nearest) return;
  const hitbox = playerHitbox(world, nearest.playerId, LIGHT_ARMOR);
  const hitY = event.origin.y + event.direction.y * nearest.distance;
  const multiplier = hitY >= hitbox.headY ? (data.headMultiplier ?? 1) : 1;
  applyDamage(world, nearest.playerId, data.directDamage * event.energyScale * multiplier, event.playerId, LIGHT_ARMOR);
}

function spawnFromEvent(world: World, event: FireEvent): void {
  if (event.isAltFire) {
    spawnStored(world, event, ProjectileType.Grenade, event.weaponId, GRENADE_DATA.speed, 1, GRENADE_DATA.lifetime);
    return;
  }
  const data = WEAPON_DATA[event.weaponId];
  if (data.projectile === null) { resolveHitscan(world, event, data); return; }
  spawnStored(world, event, data.projectile, event.weaponId, data.speed, data.velInherit, data.lifetime);
}

export function stepProjectiles(world: World, dt: number): void {
  for (const event of world.pendingFireEvents) spawnFromEvent(world, event);
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    if (world.projectiles.type[id] === ProjectileType.Grenade) stepGrenade(world, id, dt);
    else stepLinearOrTracer(world, id, dt);
  }
}
```

`findDirectHit` for the armed-grenade case above passes `current` for both `previous` and `current` (a point check rather than a swept segment against the just-integrated position) since the grenade's own per-tick sweep is already handled by the terrain/bounce branch; this keeps the helper's signature identical to the one `stepLinearOrTracer` uses without adding a second ray-test function.

In `packages/sim/src/world.ts`, add `projectiles: createProjectileStore()` to `createWorld`'s returned `World` (import `createProjectileStore` from `./projectiles.js`), and add `stepProjectiles(world, dt);` to `stepWorld`, after `stepWeapons`:

```ts
  stepPlayers(world, inputs, dt);
  stepWeapons(world, inputs, dt);
  stepProjectiles(world, dt);
  world.tick += 1;
```

Add to `packages/sim/src/index.ts`:

```ts
export * from './projectiles.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/projectiles.ts packages/sim/src/projectiles.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/index.ts
git commit -m "feat(sim): projectile store, terrain/player collision, hitscan" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 4: Sim — CTF flags, scoring, team score, game over, match clock

**Files:** Create `packages/sim/src/flags.ts`, `packages/sim/src/flags.test.ts`; Modify `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/hash.ts`, `packages/sim/src/hash.test.ts`, `packages/sim/src/index.ts`
**Interfaces:** Consumes `World`, `sampleTerrain`, `world.pendingDeaths` (Task 1). Produces `FlagState`, `FlagStore`, `PICKUP_RADIUS`, `RETURN_TICKS`, `CAPTURES_TO_WIN`, `TIME_LIMIT_TICKS`, `GameOverReason`, `createFlags(world, stands, timeLimitTicks?): void`, `stepFlags(world, dt): void`; extends `hashWorld` (Task 1's `hash.ts`) to mix projectiles, flags, team scores, and the match clock. Covers **failure matrix rows 1, 2, 3**.

The spec's CTF and flags section (`### Simulation (packages/sim)` → `#### CTF and flags`) gives
the match length exactly: "Match ends at 8 captures or at a configurable time limit (our
default: 25 minutes; T2's value is not verified), whichever comes first." 25 minutes is a
spec-cited number, not a plan-picked one — the spec just discloses up front that this
particular default isn't a T2 script value, the same way the 8-capture/100-point numbers are
cited from `CTFGame.cs` two paragraphs above it. `1500 s / 0.032 s = 46875` ticks exactly, no
rounding.

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/flags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import { applyDamage } from './damage.js';
import { LIGHT_ARMOR } from './armor.js';
import { createFlags, FlagState, GameOverReason, RETURN_TICKS, stepFlags } from './flags.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};
const FIXED_DT = 32 / 1000;
const stands = [
  { team: 1, position: { x: 0, y: 0, z: 0 } },
  { team: 2, position: { x: 100, y: 0, z: 0 } },
];

describe('pickup, capture, and scoring', () => {
  it('touching the enemy flag carries it and scores +20', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Carried);
    expect(world.flags.carrierId[1]).toBe(attacker);
    expect(world.players.score[attacker]).toBe(20);
  });

  it('bringing the enemy flag home while your own flag is home captures: +30 player, +100 team', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT); // pick up
    world.players.position.set([0, 0, 0], attacker * 3);
    stepFlags(world, FIXED_DT); // capture
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.players.score[attacker]).toBe(20 + 30);
    expect(world.teamScores[1]).toBe(100);
  });

  it('game over fires at 8 captures (800 team points)', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    for (let capture = 0; capture < 8; capture += 1) {
      world.players.position.set([100, 0, 0], attacker * 3);
      stepFlags(world, FIXED_DT);
      world.players.position.set([0, 0, 0], attacker * 3);
      stepFlags(world, FIXED_DT);
    }
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1);
    expect(world.teamScores[1]).toBe(800);
  });
});

describe('failure matrix row 3: capture with own flag away is refused', () => {
  it('carrying the enemy flag at your own stand does not capture while your flag is stolen', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    const thief = addPlayer(world, { x: 0, y: 0, z: 0 }, 2);
    stepFlags(world, FIXED_DT); // team 1 steals team 2's flag
    stepFlags(world, FIXED_DT); // team 2's thief steals team 1's flag from its stand
    expect(world.flags.state[0]).toBe(FlagState.Carried);
    world.players.position.set([0, 0, 0], attacker * 3);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Carried); // no capture: flags[0] (team 1's own) is not home
    expect(world.players.score[attacker]).toBe(20); // only the touch score, no +30
    void thief;
  });
});

describe('failure matrix row 1: carrier dies, flag drops at the nearest walkable point', () => {
  it('clamps the drop Y to terrain height even if the death position was below the surface', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT); // carry
    world.players.position.set([50, -20, 50], attacker * 3); // inside/under the terrain
    applyDamage(world, attacker, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Dropped);
    expect(world.flags.position[1 * 3 + 1]).toBe(0); // flat terrain height at (50, 50) is 0
    expect(world.flags.carrierId[1]).toBe(-1);
  });
});

describe('failure matrix row 2: pickup one tick before expiry cancels the return timer', () => {
  it('a return-in-progress flag picked up before its timer fires never auto-returns', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const carrier = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    world.players.position.set([50, 0, 50], carrier * 3);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT); // drop, timer starts
    expect(world.flags.state[1]).toBe(FlagState.Dropped);
    world.tick += RETURN_TICKS - 1;
    const rescuer = addPlayer(world, { x: 50, y: 0, z: 50 }, 2);
    stepFlags(world, FIXED_DT); // pick up one tick before the timer would have fired
    expect(world.flags.state[1]).toBe(FlagState.Carried);
    expect(world.flags.carrierId[1]).toBe(rescuer);
    world.tick += 1; // the tick the timer would have fired on
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Carried); // still carried: the return is a no-op
  });

  it('an untouched dropped flag returns home exactly at the timer', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const carrier = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    world.players.position.set([50, 0, 50], carrier * 3);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT);
    world.tick += RETURN_TICKS;
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.flags.position[1 * 3]).toBe(100);
  });
});

describe('touching your own dropped flag returns it instantly', () => {
  it('a teammate standing on their dropped flag returns it without waiting for the timer', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands);
    const carrier = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    stepFlags(world, FIXED_DT);
    world.players.position.set([5, 0, 5], carrier * 3);
    applyDamage(world, carrier, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepFlags(world, FIXED_DT); // drops near team 1's stand at (0,0,0)
    const defender = addPlayer(world, { x: 5, y: 0, z: 5 }, 2);
    stepFlags(world, FIXED_DT);
    expect(world.flags.state[1]).toBe(FlagState.Home);
    expect(world.flags.position[1 * 3]).toBe(100);
    void defender;
  });
});

describe('match clock: time limit game over', () => {
  const TICKS = 10; // a small time limit so the test does not need 46,875 real ticks.

  it('expires with a leader: the higher-scoring team wins', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, TICKS);
    world.teamScores[1] = 300;
    world.teamScores[2] = 100;
    world.tick = TICKS - 1;
    stepFlags(world, FIXED_DT);
    expect(world.gameOver).toBe(false);
    world.tick = TICKS;
    stepFlags(world, FIXED_DT);
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1);
    expect(world.gameOverReason).toBe(GameOverReason.TimeLimit);
  });

  it('expires tied: winnerTeam is 0, not either team', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, TICKS);
    world.teamScores[1] = 200;
    world.teamScores[2] = 200;
    world.tick = TICKS;
    stepFlags(world, FIXED_DT);
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(0);
    expect(world.gameOverReason).toBe(GameOverReason.TimeLimit);
  });

  it('a capture-limit win landing on the same tick the clock expires still wins by capture, not by the clock', () => {
    const world = createWorld(flat, 1);
    createFlags(world, stands, TICKS);
    const attacker = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    world.teamScores[1] = 700; // one capture short of the 8-capture, 800-point win
    world.teamScores[2] = 750; // leading on score, but the clock never gets a turn to say so
    world.tick = TICKS - 1;
    stepFlags(world, FIXED_DT); // picks up team 2's flag, one tick before the clock expires
    expect(world.gameOver).toBe(false);
    world.players.position.set([0, 0, 0], attacker * 3); // home, own flag untouched
    world.tick = TICKS; // the exact tick the clock would otherwise expire on
    stepFlags(world, FIXED_DT); // the capture resolves before the clock check runs
    expect(world.gameOver).toBe(true);
    expect(world.winnerTeam).toBe(1); // the capturer, not team 2 who was leading on the clock
    expect(world.gameOverReason).toBe(GameOverReason.CaptureLimit);
  });
});
```

Extend `packages/sim/src/hash.test.ts`'s import line:

```ts
import {
  addPlayer,
  createFlags,
  createWorld,
  deserializePlayer,
  FlagState,
  GameOverReason,
  hashWorld,
  serializeActivePlayers,
  type Heightfield,
} from './index.js';
```

Add six tests to the `describe('hashWorld', ...)` block, after the existing three:

```ts
  it('changes when a projectile is added', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.projectiles.active[0] = 1;
    world.projectiles.count = 1;
    world.projectiles.type[0] = 0;
    world.projectiles.position.set([1, 2, 3], 0);
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when a flag changes state', () => {
    const world = createWorld(terrain, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ]);
    const before = hashWorld(world);
    world.flags.state[0] = FlagState.Dropped;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when a team score changes', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.teamScores[1] = 100;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when the match tick advances', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.tick += 1;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('changes when the match ends', () => {
    const world = createWorld(terrain, 1);
    const before = hashWorld(world);
    world.gameOver = true;
    world.winnerTeam = 1;
    world.gameOverReason = GameOverReason.TimeLimit;
    expect(hashWorld(world)).not.toBe(before);
  });

  it('matches for two independently built worlds with identical CTF state', () => {
    const stands = [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 10, y: 0, z: 0 } },
    ];
    const a = createWorld(terrain, 1);
    createFlags(a, stands, 500);
    a.teamScores[1] = 300;
    const b = createWorld(terrain, 2); // different seed, identical CTF state
    createFlags(b, stands, 500);
    b.teamScores[1] = 300;
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
```

`timeLimitTicks` itself (the absolute-tick threshold `createFlags`'s third argument sets) is
deliberately not mixed into the hash, even though it changed here between the two worlds'
identical `500` — every other new field mixed below is exactly what a client can reconstruct
from the wire (`world.tick` from the snapshot header, `gameOver`/`winnerTeam`/`gameOverReason`/
`teamScores` from `WorldExtras` verbatim), but the wire only ever carries `timeRemainingS`
(Task 6), a value *derived from* `timeLimitTicks`, never the raw constant. Mixing it here would
make the hash unreproducible after a real network round trip for no gameplay-visible benefit —
`world.tick` already carries the "how far into the match are we" signal the hash needs.

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- flags.test.ts hash.test.ts`. Expect module resolution to fail for `./flags.js`, and the six new `hash.test.ts` cases to fail on `GameOverReason`/`createFlags` being undefined or the hash not changing.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/sim/src/types.ts`:

```ts
export interface FlagStore {
  team: Uint8Array;
  state: Uint8Array;
  position: Float64Array;
  standPosition: Float64Array;
  carrierId: Int16Array;
  returnAt: Float64Array;
}
```

Add to `World`:

```ts
  flags: FlagStore;
  teamScores: Uint16Array;
  gameOver: boolean;
  winnerTeam: number;
  timeLimitTicks: number;
  gameOverReason: import('./flags.js').GameOverReason;
```

(`gameOverReason`'s type is the inline `import('./flags.js')` form, the same trick
`pendingFireEvents` already uses in this file for `FireEvent` — `flags.ts` imports `World` from
`types.ts`, so `types.ts` cannot import a value or type from `flags.ts` at the top level without
a cycle.)

Create `packages/sim/src/flags.ts`:

```ts
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
// spec's own cited default, not a plan-picked "ours" number — it just discloses up front that
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
  const p = world.players.position, base = playerId * 3;
  const f = world.flags.position, fbase = flagId * 3;
  return Math.hypot((p[base] ?? 0) - (f[fbase] ?? 0), (p[base + 1] ?? 0) - (f[fbase + 1] ?? 0), (p[base + 2] ?? 0) - (f[fbase + 2] ?? 0));
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
  for (const deadId of world.pendingDeaths) {
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
  flags.position.set([flags.standPosition[base] ?? 0, flags.standPosition[base + 1] ?? 0, flags.standPosition[base + 2] ?? 0], base);
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

function tryCapture(world: World, playerId: number, flagId: number): void {
  const flags = world.flags;
  const team = world.players.team[playerId];
  if (flags.team[flagId] !== team || flags.state[flagId] !== FlagState.Home) return;
  if (distance(world, playerId, flagId) > PICKUP_RADIUS) return;
  if (!ownFlagHome(world, team)) return; // Failure matrix row 3: own flag away, refuse.
  for (let enemyId = 0; enemyId < FLAG_COUNT; enemyId += 1) {
    if (flags.team[enemyId] === team || flags.carrierId[enemyId] !== playerId) continue;
    returnHome(world, enemyId);
    world.players.score[playerId] = (world.players.score[playerId] ?? 0) + 30;
    world.teamScores[team] = (world.teamScores[team] ?? 0) + TEAM_POINTS_PER_CAPTURE;
    if ((world.teamScores[team] ?? 0) >= WIN_SCORE) {
      world.gameOver = true;
      world.winnerTeam = team;
      world.gameOverReason = GameOverReason.CaptureLimit;
    }
  }
}

function syncCarriedPositions(world: World): void {
  for (let flagId = 0; flagId < FLAG_COUNT; flagId += 1) {
    const carrierId = world.flags.carrierId[flagId];
    if (carrierId === undefined || carrierId < 0) continue;
    const base = carrierId * 3;
    world.flags.position.set(
      [world.players.position[base] ?? 0, world.players.position[base + 1] ?? 0, world.players.position[base + 2] ?? 0],
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
    if (world.flags.state[flagId] === FlagState.Dropped && returnAt >= 0 && world.tick >= returnAt) {
      returnHome(world, flagId);
    }
  }
}

/** The leading team wins; equal scores is a tie (winnerTeam 0). Checked last in `stepFlags` so
 * a capture-limit win landing on the very same tick (already handled above, in
 * `handleTouchesAndCaptures`) always takes priority — this only fires when `gameOver` is
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
```

In `packages/sim/src/world.ts`, import the two new defaults:

```ts
import { GameOverReason, TIME_LIMIT_TICKS } from './flags.js';
```

and add to `createWorld`'s returned `World`:

```ts
    flags: { team: new Uint8Array(0), state: new Uint8Array(0), position: new Float64Array(0), standPosition: new Float64Array(0), carrierId: new Int16Array(0), returnAt: new Float64Array(0) },
    teamScores: new Uint16Array(3),
    gameOver: false,
    winnerTeam: 0,
    timeLimitTicks: TIME_LIMIT_TICKS,
    gameOverReason: GameOverReason.CaptureLimit,
```

(An empty `FlagStore` until the caller calls `createFlags`; `stepFlags` is a no-op against zero-length arrays until then, so this is safe for every M1/M2 test that never calls `createFlags`. `createFlags`'s own `timeLimitTicks` parameter, Task 4's default or a test's override, replaces this default the moment it runs — matching the same "default here, real value once the caller sets it up" pattern the empty `FlagStore` already uses.) Add `stepFlags(world, dt);` to `stepWorld`, after `stepProjectiles`:

```ts
  stepPlayers(world, inputs, dt);
  stepWeapons(world, inputs, dt);
  stepProjectiles(world, dt);
  stepFlags(world, dt);
  world.tick += 1;
```

Rewrite `packages/sim/src/hash.ts` (full new contents) to cover projectiles, flags, team
scores, and the match-over state alongside the players it already mixed — `world.tick` itself
was already mixed unconditionally at the top, and remains the hash's signal for "how far into
the match," per the reasoning in Task 4's test file above:

```ts
import type { World } from './types.js';

const FNV_PRIME = 0x01000193;

/**
 * Folds one number into the running hash. Positions and velocities are rounded to the
 * millimetre before mixing: the wire format quantizes them to f32, and at the map's
 * largest coordinates f32 round trip error stays under 0.001 m, so this rounding survives
 * an encode/decode cycle without changing the hash. The same rounding is harmless for the
 * plain integers mixed below (ids, states, team numbers) — scaling an exact integer by 1000
 * is still an exact, deterministic function of it.
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

function num(arr: Float64Array | Uint8Array | Uint16Array | Int16Array, i: number): number {
  return arr[i] ?? 0;
}

function mixPlayer(hash: number, players: World['players'], id: number): number {
  const base = id * 3;
  let h = mix(hash, id);
  h = mix(h, num(players.team, id));
  h = mix(h, num(players.position, base));
  h = mix(h, num(players.position, base + 1));
  h = mix(h, num(players.position, base + 2));
  h = mix(h, num(players.velocity, base));
  h = mix(h, num(players.velocity, base + 1));
  h = mix(h, num(players.velocity, base + 2));
  h = mix(h, num(players.yaw, id));
  h = mix(h, num(players.energy, id));
  h = mix(h, num(players.damage, id));
  h = mix(h, num(players.weaponSlot, id));
  return h;
}

function mixProjectiles(hash: number, world: World): number {
  let h = hash;
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    const base = id * 3;
    h = mix(h, id);
    h = mix(h, num(world.projectiles.type, id));
    h = mix(h, num(world.projectiles.weaponId, id));
    h = mix(h, num(world.projectiles.position, base));
    h = mix(h, num(world.projectiles.position, base + 1));
    h = mix(h, num(world.projectiles.position, base + 2));
    h = mix(h, num(world.projectiles.velocity, base));
    h = mix(h, num(world.projectiles.velocity, base + 1));
    h = mix(h, num(world.projectiles.velocity, base + 2));
    h = mix(h, num(world.projectiles.ownerId, id));
  }
  return h;
}

function mixFlags(hash: number, world: World): number {
  let h = hash;
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const base = id * 3;
    h = mix(h, id);
    h = mix(h, num(world.flags.team, id));
    h = mix(h, num(world.flags.state, id));
    h = mix(h, num(world.flags.carrierId, id));
    h = mix(h, num(world.flags.position, base));
    h = mix(h, num(world.flags.position, base + 1));
    h = mix(h, num(world.flags.position, base + 2));
  }
  return h;
}

export function hashWorld(world: World): number {
  let hash = 0x811c9dc5;
  hash = mix(hash, world.tick);
  hash = mix(hash, world.gameOver ? 1 : 0);
  hash = mix(hash, world.winnerTeam);
  hash = mix(hash, world.gameOverReason);
  hash = mix(hash, num(world.teamScores, 1));
  hash = mix(hash, num(world.teamScores, 2));
  const p = world.players;
  for (let id = 0; id < p.count; id += 1) {
    if (!p.active[id]) continue;
    hash = mixPlayer(hash, p, id);
  }
  hash = mixProjectiles(hash, world);
  hash = mixFlags(hash, world);
  return hash >>> 0;
}
```

This is the same `mixPlayer` body Tasks 1 and 2 already built up to (`damage` then `weaponSlot`
mixed in, in that order) — Task 4 does not change `mixPlayer` itself, only adds the three new
top-level mixes and the two new per-entity loops around it.

Add to `packages/sim/src/index.ts`:

```ts
export * from './flags.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/flags.ts packages/sim/src/flags.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/hash.ts packages/sim/src/hash.test.ts packages/sim/src/index.ts
git commit -m "feat(sim): CTF flags, scoring, game over, match-length time limit, full-state hash" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 5: Assets — extract Flag and ExteriorFlagStand from the mission

**Files:** Modify `packages/assets/src/scene.ts`, `packages/assets/src/scene.test.ts`, `packages/assets/src/__fixtures__/scene.mis`
**Interfaces:** Consumes `MissionObject`, `flatten`, `teamFor`, `torquePositionToYUp`, `torqueAxisAngleToYUp` (existing). Produces `SceneData.flags`, `SceneData.flagStands`. **Runs in parallel with Tasks 1–4** — different package, no shared file.

- [ ] **Step 1: Write the failing test**

Add a `Flag` and an `ExteriorFlagStand` to `packages/assets/src/__fixtures__/scene.mis`, inside the existing `Team1` `SimGroup` (after the `SpawnSphere`):

```
new SimGroup(Team1) {
  team = "1";
  new SpawnSphere(SpawnA) {
    position = "326.888 -168.521 74.8106";
    radius = "5";
  };
  new Flag(Team1Flag) {
    position = "330 -180 75";
  };
  new ExteriorFlagStand(Team1FlagStand) {
    position = "330 -180 75";
    rotation = "0 0 1 45";
  };
};
```

Extend `packages/assets/src/scene.test.ts`'s `'extracts typed leaves and inherited team membership'` test, after the existing `scene.spawns` assertion:

```ts
    expect(scene.flags).toEqual([{ team: 1, position: [330, 75, 180] }]);
    expect(scene.flagStands).toEqual([
      { team: 1, position: [330, 75, 180], rotation: { axis: [0, 1, 0], degrees: 45 } },
    ]);
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/assets test -- scene.test.ts`. Expect `scene.flags` and `scene.flagStands` to be `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/assets/src/scene.ts`, add to `SceneData`:

```ts
  flags: Array<{ team: number; position: Vec3 }>;
  flagStands: Array<{ team: number; position: Vec3; rotation: AxisAngle }>;
```

Add two builders, next to `buildSpawns`:

```ts
function buildFlags(all: LocatedObject[]): SceneData['flags'] {
  return all
    .filter(({ object }) => object.class === 'Flag')
    .map(({ object, ancestors }) => ({
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
    }));
}

function buildFlagStands(all: LocatedObject[]): SceneData['flagStands'] {
  return all
    .filter(({ object }) => object.class === 'ExteriorFlagStand')
    .map(({ object, ancestors }) => ({
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
      rotation: torqueAxisAngleToYUp(object.props.rotation ?? '0 0 1 0'),
    }));
}
```

Change `extractScene`'s return to add:

```ts
    flags: buildFlags(all),
    flagStands: buildFlagStands(all),
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/assets test && pnpm typecheck && pnpm lint`. Then regenerate the committed output against the real mission: `pnpm assets:build`. This re-extracts `assets/out/katabatic/scene.json` with the real Katabatic `Flag`/`ExteriorFlagStand` positions from the two team bases the spec describes (team 1 near (330, −180), team 2 near (−580, 380), in Torque X/Y — see the spec's Katabatic section). Confirm `scene.json` now has a top-level `flags` array of length 2, one per team, and a `flagStands` array of length 2.

- [ ] **Step 5: Commit**

```sh
git add packages/assets/src/scene.ts packages/assets/src/scene.test.ts packages/assets/src/__fixtures__/scene.mis assets/out/katabatic/scene.json
git commit -m "feat(assets): extract Flag and ExteriorFlagStand from the mission" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 6: Protocol — input growth, version byte, snapshot extensions, Event/God messages

**Files:** Modify `packages/protocol/src/messages.ts`, `packages/protocol/src/handshake.ts`, `packages/protocol/src/handshake.test.ts`, `packages/protocol/src/snapshot.ts`, `packages/protocol/src/snapshot.test.ts`, `packages/protocol/src/index.ts`
**Interfaces:** Consumes `PlayerInput`/`PlayerSnapshotData` (Tasks 1–2, type only), `FlagState`, `ProjectileType`, `WeaponId`, `GameOverReason` (Tasks 2–4, type only, for the wire-value ranges). Produces `PROTOCOL_VERSION`, `WelcomeStatus`, extended `JoinMessage`/`WelcomeMessage`, `MessageType.Event`/`God`, `EventKind`, `EventMessage`, `GodMessage`, `encodeEvent`/`decodeEvent`, `encodeGod`/`decodeGod`, `ProjectileSnapshotData`, `FlagSnapshotData`, `WorldExtras` (now carrying `timeRemainingS`/`gameOverReason` for Task 4's match clock), `emptyExtras()`, extended `encodeSnapshot`/`decodeSnapshot`/`DecodedSnapshot`. Covers the spec's "protocol round trip for every new field" test.

- [ ] **Step 1: Write the failing tests**

Extend `packages/protocol/src/handshake.test.ts`. Change the Join/Welcome/Input tests and add two new ones:

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeAck, decodeEvent, decodeGod, decodeInput, decodeJoin, decodeWelcome,
  encodeAck, encodeEvent, encodeGod, encodeInput, encodeJoin, encodeWelcome,
} from './handshake.js';
import { EventKind, MessageType, PROTOCOL_VERSION, WelcomeStatus, type InputMessage } from './messages.js';

describe('handshake codec', () => {
  it('round-trips a Join message carrying the protocol version', () => {
    expect(decodeJoin(encodeJoin())).toEqual({ type: MessageType.Join, version: PROTOCOL_VERSION });
  });

  it('round-trips an accepted Welcome message, including the spawn point', () => {
    const bytes = encodeWelcome({
      playerId: 5, team: 2, tickMs: 32, status: WelcomeStatus.Ok,
      spawnX: 10, spawnY: 1, spawnZ: -20,
    });
    expect(decodeWelcome(bytes)).toEqual({
      type: MessageType.Welcome, playerId: 5, team: 2, tickMs: 32, status: WelcomeStatus.Ok,
      spawnX: 10, spawnY: 1, spawnZ: -20,
    });
  });

  it('round-trips a version-mismatch Welcome', () => {
    const bytes = encodeWelcome({
      playerId: 0, team: 0, tickMs: 32, status: WelcomeStatus.VersionMismatch,
      spawnX: 0, spawnY: 0, spawnZ: 0,
    });
    expect(decodeWelcome(bytes).status).toBe(WelcomeStatus.VersionMismatch);
  });

  it('round-trips an Input message with three distinct redundant samples, including the new fields', () => {
    const message: Omit<InputMessage, 'type'> = {
      sequence: 42,
      samples: [
        { moveX: 1, moveZ: -1, yaw: 0.5, pitch: 0.2, jump: true, jet: false, fire: true, altFire: false, slot: 2 },
        { moveX: 0, moveZ: 1, yaw: 0.25, pitch: -0.1, jump: false, jet: true, fire: false, altFire: true, slot: 0 },
        { moveX: -1, moveZ: 0, yaw: -0.5, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0 },
      ],
    };
    const decoded = decodeInput(encodeInput(message));
    expect(decoded.sequence).toBe(42);
    expect(decoded.samples).toEqual(message.samples);
  });

  it('round-trips an Ack message', () => {
    expect(decodeAck(encodeAck({ snapshotId: 777 }))).toEqual({
      type: MessageType.Ack, snapshotId: 777,
    });
  });

  it('round-trips an Event message', () => {
    const bytes = encodeEvent({ kind: EventKind.PlayerKilled, a: 3, b: 9 });
    expect(decodeEvent(bytes)).toEqual({ type: MessageType.Event, kind: EventKind.PlayerKilled, a: 3, b: 9 });
  });

  it('round-trips a negative "a"/"b" (miss/no-attacker sentinel) on an Event message', () => {
    const bytes = encodeEvent({ kind: EventKind.LaserFired, a: 2, b: -1 });
    expect(decodeEvent(bytes)).toEqual({ type: MessageType.Event, kind: EventKind.LaserFired, a: 2, b: -1 });
  });

  it('round-trips a God message', () => {
    expect(decodeGod(encodeGod({ enabled: true }))).toEqual({ type: MessageType.God, enabled: true });
  });

  it('rejects decoding bytes tagged as the wrong message type', () => {
    expect(() => decodeAck(encodeJoin())).toThrow(RangeError);
  });
});
```

Extend `packages/protocol/src/snapshot.test.ts`, adding `extras`/`emptyExtras()` to every existing `encodeSnapshot` call and a new describe block:

```ts
import { describe, expect, it } from 'vitest';
import {
  addPlayer, createFlags, createWorld, deserializePlayer, GameOverReason, hashWorld,
  removePlayer, serializeActivePlayers, type Heightfield, type PlayerSnapshotData, type World,
} from '@clans/sim';
import {
  decodeSnapshot, emptyExtras, encodeSnapshot,
  type DecodedSnapshot, type FlagSnapshotData, type ProjectileSnapshotData, type WorldExtras,
} from './snapshot.js';

const terrain: Heightfield = {
  gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1,
  heights: new Uint16Array(4),
};
const stands = [
  { team: 1, position: { x: 0, y: 0, z: 0 } },
  { team: 2, position: { x: 10, y: 0, z: 0 } },
];

function applyTo(target: World, tick: number, players: PlayerSnapshotData[]): void {
  target.tick = tick;
  for (const player of players) deserializePlayer(target, player);
}

/** Everything `applyTo` doesn't cover: the CTF slice of `WorldExtras`, applied onto a target
 * world that already called `createFlags` (so its `FlagStore` is sized to receive it). */
function applyExtras(target: World, decoded: DecodedSnapshot): void {
  for (const flag of decoded.flags) {
    target.flags.state[flag.id] = flag.state;
    target.flags.carrierId[flag.id] = flag.carrierId;
    target.flags.position.set([flag.x, flag.y, flag.z], flag.id * 3);
  }
  target.teamScores[1] = decoded.teamScores[0];
  target.teamScores[2] = decoded.teamScores[1];
  target.gameOver = decoded.gameOver;
  target.winnerTeam = decoded.winnerTeam;
  target.gameOverReason = decoded.gameOverReason;
}

describe('snapshot codec', () => {
  it('round-trips a full snapshot and reproduces the world hash', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 1, y: 2, z: 3 }, 1);
    addPlayer(source, { x: 4, y: 5, z: 6 }, 2);
    source.tick = 10;
    const players = serializeActivePlayers(source);
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, emptyExtras());
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.baselineId).toBe(0);
    const target = createWorld(terrain, 1);
    applyTo(target, decoded.tick, decoded.players);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('round-trips CTF state and reproduces the full-state world hash (projectiles, flags, scores, match clock)', () => {
    const source = createWorld(terrain, 1);
    createFlags(source, stands);
    source.teamScores[1] = 300;
    source.teamScores[2] = 100;
    source.gameOver = true;
    source.winnerTeam = 1;
    source.gameOverReason = GameOverReason.CaptureLimit;
    source.tick = 50;
    const players = serializeActivePlayers(source);
    const extras: WorldExtras = {
      projectiles: [],
      flags: [
        { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 },
        { id: 1, team: 2, state: 0, x: 10, y: 0, z: 0, carrierId: -1, returnInS: -1 },
      ],
      teamScores: [300, 100],
      gameOver: true,
      winnerTeam: 1,
      timeRemainingS: 0,
      gameOverReason: GameOverReason.CaptureLimit,
    };
    const bytes = encodeSnapshot(1, source.tick, 0, players, null, extras);
    const decoded = decodeSnapshot(bytes, null);

    const target = createWorld(terrain, 1);
    createFlags(target, stands); // sizes target.flags to receive applyExtras below
    applyTo(target, decoded.tick, decoded.players);
    applyExtras(target, decoded);
    expect(hashWorld(target)).toBe(hashWorld(source));
  });

  it('applies a delta against a known baseline and reproduces the state', () => {
    const source = createWorld(terrain, 1);
    const a = addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    addPlayer(source, { x: 10, y: 0, z: 0 }, 2);
    source.tick = 1;
    const baselinePlayers = serializeActivePlayers(source);
    const baselineBytes = encodeSnapshot(1, source.tick, 0, baselinePlayers, null, emptyExtras());

    source.players.position[a * 3] = 5;
    const c = addPlayer(source, { x: 20, y: 0, z: 0 }, 1);
    source.tick = 2;
    const nextPlayers = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, source.tick, 0, nextPlayers, { snapshotId: 1, players: baselinePlayers }, emptyExtras());

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
    const deltaBytes = encodeSnapshot(2, 5, 0, nextPlayers, { snapshotId: 1, players: baselinePlayers }, emptyExtras());
    const decoded = decodeSnapshot(deltaBytes, { snapshotId: 1, players: baselinePlayers });
    expect(decoded.removedIds).toEqual([b]);
    expect(decoded.players.map((p) => p.id)).toEqual([a]);
  });

  it('throws when a delta arrives for a baseline the caller does not have', () => {
    const source = createWorld(terrain, 1);
    addPlayer(source, { x: 0, y: 0, z: 0 }, 1);
    const players = serializeActivePlayers(source);
    const deltaBytes = encodeSnapshot(2, 1, 0, players, { snapshotId: 1, players }, emptyExtras());
    expect(() => decodeSnapshot(deltaBytes, null)).toThrow(RangeError);
  });

  it('round-trips projectiles, flags, team scores, and game over', () => {
    const projectiles: ProjectileSnapshotData[] = [
      { id: 3, type: 0, weaponId: 0, x: 1, y: 2, z: 3, vx: 90, vy: 0, vz: 0, ownerId: 0 },
    ];
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 },
      { id: 1, team: 2, state: 1, x: 5, y: 0, z: 5, carrierId: 2, returnInS: -1 },
    ];
    const bytes = encodeSnapshot(1, 0, 0, [], null, {
      projectiles, flags, teamScores: [100, 200], gameOver: true, winnerTeam: 1,
      timeRemainingS: 723.4, gameOverReason: 0,
    });
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.projectiles).toEqual(projectiles);
    expect(decoded.flags).toEqual(flags);
    expect(decoded.teamScores).toEqual([100, 200]);
    expect(decoded.gameOver).toBe(true);
    expect(decoded.winnerTeam).toBe(1);
    expect(decoded.timeRemainingS).toBeCloseTo(723.4, 1);
    expect(decoded.gameOverReason).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/protocol test`. Expect `version`/`status`/`kind`/`emptyExtras`/etc. to be undefined or type errors.

- [ ] **Step 3: Write minimal implementation**

Change `packages/protocol/src/messages.ts` (full new contents):

```ts
import type { PlayerInput } from '@clans/sim';

export enum MessageType {
  Join = 1,
  Welcome = 2,
  Input = 3,
  Snapshot = 4,
  Ack = 5,
  Event = 6,
  God = 7,
}

export const PROTOCOL_VERSION = 2; // M1/M2 carried no version field at all; this milestone starts at 2.

export enum WelcomeStatus {
  Ok = 0,
  VersionMismatch = 1,
}

/** The wire shape of one tick's input is identical to the sim's own PlayerInput. */
export type NetInputSample = PlayerInput;

export interface JoinMessage {
  type: MessageType.Join;
  version: number;
}
export interface WelcomeMessage {
  type: MessageType.Welcome;
  playerId: number;
  team: number;
  tickMs: number;
  status: WelcomeStatus;
  /**
   * The mission spawn point the server placed this player at. M2 added this so the
   * client's local prediction world has a real fall-back spawn instead of the map origin
   * before its first snapshot arrives. `status` is new in M3; `spawnX`/`spawnY`/`spawnZ`
   * are unchanged from M2 and must not be dropped.
   */
  spawnX: number;
  spawnY: number;
  spawnZ: number;
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

export enum EventKind {
  PlayerKilled = 0, // a = attackerId (-1 = environment), b = victimId
  FlagTouched = 1, // a = playerId, b = flagId
  FlagCaptured = 2, // a = team, b = playerId
  LaserFired = 3, // a = shooterId, b = hitPlayerId (-1 = miss)
}
export interface EventMessage {
  type: MessageType.Event;
  kind: EventKind;
  a: number;
  b: number;
}
export interface GodMessage {
  type: MessageType.God;
  enabled: boolean;
}

export const SNAPSHOT_EVERY_N_TICKS = 2;
export const SNAPSHOT_FALLBACK_MS = 1000;
```

Change `packages/protocol/src/handshake.ts` (full new contents):

```ts
import {
  bytesOf, createReader, createWriter, readF32, readI16, readU16, readU32, readU8,
  writeF32, writeI16, writeU16, writeU32, writeU8, type Cursor,
} from './codec.js';
import {
  MessageType, PROTOCOL_VERSION,
  type AckMessage, type EventMessage, type GodMessage, type InputMessage,
  type JoinMessage, type NetInputSample, type WelcomeMessage,
} from './messages.js';

const SAMPLE_BYTES = 18; // moveX, moveZ, yaw, pitch (f32 each), flags (u8), slot (u8)
export const INPUT_MESSAGE_BYTES = 1 + 4 + SAMPLE_BYTES * 3;

function expectType(cursor: Cursor, expected: MessageType): void {
  const type = readU8(cursor);
  if (type !== expected)
    throw new RangeError(`Expected message type ${String(expected)}, got ${String(type)}`);
}

function writeSample(cursor: Cursor, sample: NetInputSample): void {
  writeF32(cursor, sample.moveX);
  writeF32(cursor, sample.moveZ);
  writeF32(cursor, sample.yaw);
  writeF32(cursor, sample.pitch);
  writeU8(
    cursor,
    (sample.jump ? 1 : 0) | (sample.jet ? 2 : 0) | (sample.fire ? 4 : 0) | (sample.altFire ? 8 : 0),
  );
  writeU8(cursor, sample.slot);
}
function readSample(cursor: Cursor): NetInputSample {
  const moveX = readF32(cursor);
  const moveZ = readF32(cursor);
  const yaw = readF32(cursor);
  const pitch = readF32(cursor);
  const flags = readU8(cursor);
  const slot = readU8(cursor);
  return {
    moveX, moveZ, yaw, pitch,
    jump: (flags & 1) !== 0, jet: (flags & 2) !== 0, fire: (flags & 4) !== 0, altFire: (flags & 8) !== 0,
    slot,
  };
}

export function encodeJoin(): Uint8Array {
  const cursor = createWriter(2);
  writeU8(cursor, MessageType.Join);
  writeU8(cursor, PROTOCOL_VERSION);
  return bytesOf(cursor);
}
export function decodeJoin(bytes: Uint8Array): JoinMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Join);
  return { type: MessageType.Join, version: readU8(cursor) };
}

export function encodeWelcome(message: Omit<WelcomeMessage, 'type'>): Uint8Array {
  const cursor = createWriter(19);
  writeU8(cursor, MessageType.Welcome);
  writeU16(cursor, message.playerId);
  writeU8(cursor, message.team);
  writeU16(cursor, message.tickMs);
  writeU8(cursor, message.status);
  writeF32(cursor, message.spawnX);
  writeF32(cursor, message.spawnY);
  writeF32(cursor, message.spawnZ);
  return bytesOf(cursor);
}
export function decodeWelcome(bytes: Uint8Array): WelcomeMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Welcome);
  return {
    type: MessageType.Welcome,
    playerId: readU16(cursor),
    team: readU8(cursor),
    tickMs: readU16(cursor),
    status: readU8(cursor),
    spawnX: readF32(cursor),
    spawnY: readF32(cursor),
    spawnZ: readF32(cursor),
  };
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

export function encodeEvent(message: Omit<EventMessage, 'type'>): Uint8Array {
  const cursor = createWriter(6);
  writeU8(cursor, MessageType.Event);
  writeU8(cursor, message.kind);
  writeI16(cursor, message.a);
  writeI16(cursor, message.b);
  return bytesOf(cursor);
}
export function decodeEvent(bytes: Uint8Array): EventMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Event);
  return { type: MessageType.Event, kind: readU8(cursor), a: readI16(cursor), b: readI16(cursor) };
}

export function encodeGod(message: Omit<GodMessage, 'type'>): Uint8Array {
  const cursor = createWriter(2);
  writeU8(cursor, MessageType.God);
  writeU8(cursor, message.enabled ? 1 : 0);
  return bytesOf(cursor);
}
export function decodeGod(bytes: Uint8Array): GodMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.God);
  return { type: MessageType.God, enabled: readU8(cursor) !== 0 };
}
```

Add `writeI16`/`readI16` to `packages/protocol/src/codec.ts` (after `writeU16`/`readU16`):

```ts
export function writeI16(cursor: Cursor, value: number): void {
  cursor.view.setInt16(cursor.offset, value, true);
  cursor.offset += 2;
}
export function readI16(cursor: Cursor): number {
  const value = cursor.view.getInt16(cursor.offset, true);
  cursor.offset += 2;
  return value;
}
```

Rewrite `packages/protocol/src/snapshot.ts` (full new contents — the delta player scheme is unchanged in spirit from M2, extended with two dirty bits and a trailing "always full" extras section):

```ts
import type { PlayerSnapshotData } from '@clans/sim';
import {
  bytesOf, createReader, createWriter, readF32, readI16, readU16, readU32, readU8,
  writeF32, writeI16, writeU16, writeU32, writeU8, type Cursor,
} from './codec.js';
import { MessageType } from './messages.js';

export interface SnapshotBaseline {
  snapshotId: number;
  players: PlayerSnapshotData[];
}
export interface ProjectileSnapshotData {
  id: number;
  type: number; // ProjectileType from @clans/sim
  weaponId: number; // WeaponId from @clans/sim
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  ownerId: number;
}
export interface FlagSnapshotData {
  id: number;
  team: number;
  state: number; // FlagState from @clans/sim
  x: number; y: number; z: number;
  carrierId: number; // -1 if not carried
  returnInS: number; // -1 if not counting down
}
export interface WorldExtras {
  projectiles: ProjectileSnapshotData[];
  flags: FlagSnapshotData[];
  teamScores: [number, number]; // [team1, team2]
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number; // seconds until the match clock expires; derived, not the raw tick threshold
  gameOverReason: number; // GameOverReason from @clans/sim: 0 = capture limit, 1 = time limit
}
export function emptyExtras(): WorldExtras {
  return {
    projectiles: [], flags: [], teamScores: [0, 0], gameOver: false, winnerTeam: 0,
    timeRemainingS: 0, gameOverReason: 0,
  };
}
export interface DecodedSnapshot {
  snapshotId: number;
  baselineId: number;
  tick: number;
  lastInputSequence: number;
  players: PlayerSnapshotData[];
  removedIds: number[];
  projectiles: ProjectileSnapshotData[];
  flags: FlagSnapshotData[];
  teamScores: [number, number];
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number;
  gameOverReason: number;
}

const HEADER_BYTES = 1 + 4 + 4 + 4 + 4 + 1;
const PLAYER_FULL_BYTES = 2 + 1 + 4 * 7 + 4 + 1 + 4 + 1; // + health (f32) + weaponSlot (u8)
const PROJECTILE_BYTES = 2 + 1 + 1 + 4 * 6 + 2;
const FLAG_BYTES = 1 + 1 + 1 + 4 * 3 + 2 + 4;
const DELTA_FLAG = 1;
const DIRTY_TRANSFORM = 1;
const DIRTY_ENERGY = 2;
const DIRTY_STATUS = 4;
const DIRTY_TEAM = 8;
const DIRTY_HEALTH = 16;
const DIRTY_WEAPON = 32;
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
  writeF32(cursor, data.health);
  writeU8(cursor, data.weaponSlot);
}
function readPlayerFull(cursor: Cursor): PlayerSnapshotData {
  const id = readU16(cursor);
  const team = readU8(cursor);
  const x = readF32(cursor), y = readF32(cursor), z = readF32(cursor);
  const vx = readF32(cursor), vy = readF32(cursor), vz = readF32(cursor);
  const yaw = readF32(cursor);
  const energy = readF32(cursor);
  const flags = readU8(cursor);
  const health = readF32(cursor);
  const weaponSlot = readU8(cursor);
  return {
    id, team, x, y, z, vx, vy, vz, yaw, energy,
    onGround: flags & 1 ? 1 : 0, ski: flags & 2 ? 1 : 0, health, weaponSlot,
  };
}

function writeProjectile(cursor: Cursor, p: ProjectileSnapshotData): void {
  writeU16(cursor, p.id);
  writeU8(cursor, p.type);
  writeU8(cursor, p.weaponId);
  writeF32(cursor, p.x); writeF32(cursor, p.y); writeF32(cursor, p.z);
  writeF32(cursor, p.vx); writeF32(cursor, p.vy); writeF32(cursor, p.vz);
  writeU16(cursor, p.ownerId);
}
function readProjectile(cursor: Cursor): ProjectileSnapshotData {
  return {
    id: readU16(cursor), type: readU8(cursor), weaponId: readU8(cursor),
    x: readF32(cursor), y: readF32(cursor), z: readF32(cursor),
    vx: readF32(cursor), vy: readF32(cursor), vz: readF32(cursor),
    ownerId: readU16(cursor),
  };
}

function writeFlag(cursor: Cursor, f: FlagSnapshotData): void {
  writeU8(cursor, f.id);
  writeU8(cursor, f.team);
  writeU8(cursor, f.state);
  writeF32(cursor, f.x); writeF32(cursor, f.y); writeF32(cursor, f.z);
  writeI16(cursor, f.carrierId);
  writeF32(cursor, f.returnInS);
}
function readFlag(cursor: Cursor): FlagSnapshotData {
  return {
    id: readU8(cursor), team: readU8(cursor), state: readU8(cursor),
    x: readF32(cursor), y: readF32(cursor), z: readF32(cursor),
    carrierId: readI16(cursor), returnInS: readF32(cursor),
  };
}

function writeExtras(cursor: Cursor, extras: WorldExtras): void {
  writeU16(cursor, extras.projectiles.length);
  for (const p of extras.projectiles) writeProjectile(cursor, p);
  writeU8(cursor, extras.flags.length);
  for (const f of extras.flags) writeFlag(cursor, f);
  writeU16(cursor, extras.teamScores[0]);
  writeU16(cursor, extras.teamScores[1]);
  writeU8(cursor, extras.gameOver ? 1 : 0);
  writeU8(cursor, extras.winnerTeam);
  writeF32(cursor, extras.timeRemainingS);
  writeU8(cursor, extras.gameOverReason);
}
function readExtras(cursor: Cursor): WorldExtras {
  const projectileCount = readU16(cursor);
  const projectiles: ProjectileSnapshotData[] = [];
  for (let i = 0; i < projectileCount; i += 1) projectiles.push(readProjectile(cursor));
  const flagCount = readU8(cursor);
  const flags: FlagSnapshotData[] = [];
  for (let i = 0; i < flagCount; i += 1) flags.push(readFlag(cursor));
  const teamScores: [number, number] = [readU16(cursor), readU16(cursor)];
  const gameOver = readU8(cursor) !== 0;
  const winnerTeam = readU8(cursor);
  const timeRemainingS = readF32(cursor);
  const gameOverReason = readU8(cursor);
  return { projectiles, flags, teamScores, gameOver, winnerTeam, timeRemainingS, gameOverReason };
}
function extrasByteLength(extras: WorldExtras): number {
  return (
    2 + extras.projectiles.length * PROJECTILE_BYTES + 1 + extras.flags.length * FLAG_BYTES +
    2 + 2 + 1 + 1 + 4 + 1
  );
}

function encodeFullSnapshot(
  snapshotId: number, tick: number, lastInputSequence: number,
  players: PlayerSnapshotData[], extras: WorldExtras,
): Uint8Array {
  const cursor = createWriter(HEADER_BYTES + 2 + players.length * PLAYER_FULL_BYTES + extrasByteLength(extras));
  writeHeader(cursor, { snapshotId, baselineId: 0, tick, lastInputSequence, flags: 0 });
  writeU16(cursor, players.length);
  for (const player of players) writePlayerFull(cursor, player);
  writeExtras(cursor, extras);
  return bytesOf(cursor);
}

function transformChanged(a: PlayerSnapshotData, b: PlayerSnapshotData): boolean {
  return (
    Math.abs(a.x - b.x) > EPSILON || Math.abs(a.y - b.y) > EPSILON || Math.abs(a.z - b.z) > EPSILON ||
    Math.abs(a.vx - b.vx) > EPSILON || Math.abs(a.vy - b.vy) > EPSILON || Math.abs(a.vz - b.vz) > EPSILON ||
    Math.abs(a.yaw - b.yaw) > EPSILON
  );
}
function dirtyMask(current: PlayerSnapshotData, previous: PlayerSnapshotData): number {
  let mask = 0;
  if (transformChanged(current, previous)) mask |= DIRTY_TRANSFORM;
  if (Math.abs(current.energy - previous.energy) > EPSILON) mask |= DIRTY_ENERGY;
  if (current.onGround !== previous.onGround || current.ski !== previous.ski) mask |= DIRTY_STATUS;
  if (current.team !== previous.team) mask |= DIRTY_TEAM;
  if (Math.abs(current.health - previous.health) > EPSILON) mask |= DIRTY_HEALTH;
  if (current.weaponSlot !== previous.weaponSlot) mask |= DIRTY_WEAPON;
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
  let bytes = 3;
  if (mask & DIRTY_TRANSFORM) bytes += 28;
  if (mask & DIRTY_ENERGY) bytes += 4;
  if (mask & DIRTY_STATUS) bytes += 1;
  if (mask & DIRTY_TEAM) bytes += 1;
  if (mask & DIRTY_HEALTH) bytes += 4;
  if (mask & DIRTY_WEAPON) bytes += 1;
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
  if (mask & DIRTY_HEALTH) writeF32(cursor, data.health);
  if (mask & DIRTY_WEAPON) writeU8(cursor, data.weaponSlot);
}

function encodeDeltaSnapshot(
  snapshotId: number, tick: number, lastInputSequence: number,
  baseline: SnapshotBaseline, players: PlayerSnapshotData[], extras: WorldExtras,
): Uint8Array {
  const diff = diffPlayers(players, baseline.players);
  const changedBytes = diff.changed.reduce((sum, entry) => sum + changedRecordBytes(entry.mask), 0);
  const bodyBytes =
    2 + diff.added.length * PLAYER_FULL_BYTES + 2 + changedBytes + 2 + diff.removedIds.length * 2 + extrasByteLength(extras);
  const cursor = createWriter(HEADER_BYTES + bodyBytes);
  writeHeader(cursor, { snapshotId, baselineId: baseline.snapshotId, tick, lastInputSequence, flags: DELTA_FLAG });
  writeU16(cursor, diff.added.length);
  for (const player of diff.added) writePlayerFull(cursor, player);
  writeU16(cursor, diff.changed.length);
  for (const entry of diff.changed) writeChangedPlayer(cursor, entry.data, entry.mask);
  writeU16(cursor, diff.removedIds.length);
  for (const id of diff.removedIds) writeU16(cursor, id);
  writeExtras(cursor, extras);
  return bytesOf(cursor);
}

export function encodeSnapshot(
  snapshotId: number, tick: number, lastInputSequence: number,
  players: PlayerSnapshotData[], baseline: SnapshotBaseline | null, extras: WorldExtras,
): Uint8Array {
  return baseline
    ? encodeDeltaSnapshot(snapshotId, tick, lastInputSequence, baseline, players, extras)
    : encodeFullSnapshot(snapshotId, tick, lastInputSequence, players, extras);
}

function decodeFull(cursor: Cursor, header: SnapshotHeader): DecodedSnapshot {
  const count = readU16(cursor);
  const players: PlayerSnapshotData[] = [];
  for (let i = 0; i < count; i += 1) players.push(readPlayerFull(cursor));
  const extras = readExtras(cursor);
  return {
    snapshotId: header.snapshotId, baselineId: 0, tick: header.tick,
    lastInputSequence: header.lastInputSequence, players, removedIds: [], ...extras,
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
  if (mask & DIRTY_HEALTH) next.health = readF32(cursor);
  if (mask & DIRTY_WEAPON) next.weaponSlot = readU8(cursor);
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
  const extras = readExtras(cursor);
  return {
    snapshotId: header.snapshotId, baselineId: header.baselineId, tick: header.tick,
    lastInputSequence: header.lastInputSequence, players: [...byId.values()], removedIds, ...extras,
  };
}

export function decodeSnapshot(bytes: Uint8Array, baseline: SnapshotBaseline | null): DecodedSnapshot {
  const cursor = createReader(bytes);
  const header = readHeader(cursor);
  return header.flags & DELTA_FLAG ? decodeDelta(cursor, header, baseline) : decodeFull(cursor, header);
}
```

`packages/protocol/src/index.ts` needs no change — it already does `export * from './snapshot.js'` and `export * from './handshake.js'`, which now carry the new names.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/protocol test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/protocol/src/messages.ts packages/protocol/src/handshake.ts packages/protocol/src/handshake.test.ts packages/protocol/src/codec.ts packages/protocol/src/snapshot.ts packages/protocol/src/snapshot.test.ts
git commit -m "feat(protocol): weapon/health/projectile/flag/score wire format, version byte" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 7: Server — weapon input, projectile/event broadcast, respawn, CTF snapshots, God debug

**Small fix to Task 1 and Task 4, needed here:** `world.pendingDeaths` is currently `number[]`
(the victim id only). The kill feed's wire message (`EventKind.PlayerKilled`, Task 6) needs the
attacker id too, and nothing else in the sim can recover it after the fact — a Spinfusor or
Mortar kill lands ticks after the shot that caused it, so there is no tick-local way to look up
"who fired the fatal shot" from outside `pendingDeaths` itself. Widening the array's element to
carry both ids is the smallest fix that keeps the kill feed accurate. This changes:

- `packages/sim/src/types.ts`: `pendingDeaths: Array<{ id: number; attackerId: number }>;`
- `packages/sim/src/damage.ts`: `applyDamage` pushes `{ id, attackerId }` instead of `id`.
- `packages/sim/src/damage.test.ts`: the `'kills at maxDamage...'` test's
  `expect(world.pendingDeaths).toEqual([id])` becomes `toEqual([{ id, attackerId: -1 }])` (the
  test's own `applyDamage` calls already pass `-1` as the attacker).
- `packages/sim/src/flags.ts`: `dropCarriedFlagsOnDeath`'s `for (const deadId of world.pendingDeaths)`
  becomes `for (const { id: deadId } of world.pendingDeaths)`.

No other Task 1–6 file reads `pendingDeaths`, so this is the complete blast radius.

**Files:** Create `packages/server/src/lagcomp.ts`, `packages/server/src/lagcomp.test.ts`; Modify `packages/sim/src/types.ts`, `packages/sim/src/damage.ts`, `packages/sim/src/damage.test.ts`, `packages/sim/src/flags.ts`, `packages/server/src/net.ts`, `packages/server/src/net.test.ts`, `packages/server/src/world.ts`, `packages/server/src/world.test.ts`
**Interfaces:** Consumes `World`, `PlayerInput`, `dueForRespawn`, `respawnPlayer`, `WeaponId`, `WEAPON_DATA`, `playerHitbox`, `raySphereDistance`, `LIGHT_ARMOR`, `FlagState`, `FireEvent` (Tasks 1–4), `MessageType`, `PROTOCOL_VERSION`, `WelcomeStatus`, `EventKind`, `decodeJoin`, `decodeGod`, `encodeEvent`, `encodeSnapshot`, `type WorldExtras`, `type ProjectileSnapshotData`, `type FlagSnapshotData`, `type EventMessage` (Task 6). Produces `PositionHistory`, `createPositionHistory`, `recordHistory(history, world)`, `positionAtTick(history, playerId, tick)`, `rewindOthers(world, history, excludeIds, rewindTicks)`, `restorePositions(world, handle)`; extends `NetServerOptions` with `now?`; extends `loadKatabaticWorld` to call `createFlags`. Covers the spec's headless-disc-kill and lag-compensation tests, and **failure matrix rows 6–8, 10–11** stay covered unchanged (M2's session/ack logic is untouched).

- [ ] **Step 1: Write the failing tests**

Change `packages/sim/src/damage.test.ts`'s first assertion in the `'kills at maxDamage...'` test:

```ts
    expect(world.pendingDeaths).toEqual([{ id, attackerId: -1 }]);
```

Create `packages/server/src/lagcomp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import {
  createPositionHistory,
  positionAtTick,
  recordHistory,
  restorePositions,
  rewindOthers,
} from './lagcomp.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('recordHistory and positionAtTick', () => {
  it('keeps a bounded per-player ring buffer and finds the newest sample at or before a tick', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory(4);
    for (let step = 0; step < 6; step += 1) {
      world.players.position.set([step, 0, 0], id * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    expect(positionAtTick(history, id, 0)?.x).toBe(2); // capacity 4: ticks 0-1 fell off
    expect(positionAtTick(history, id, 3)?.x).toBe(3);
    expect(positionAtTick(history, id, 100)?.x).toBe(5); // clamps to the newest sample
  });

  it('returns null for a player with no recorded history', () => {
    const history = createPositionHistory();
    expect(positionAtTick(history, 9, 0)).toBeNull();
  });
});

describe('rewindOthers and restorePositions', () => {
  it('moves every non-excluded player back in time, then restores them exactly', () => {
    const world = createWorld(flat, 1);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 });
    const target = addPlayer(world, { x: 0, y: 0, z: 0 });
    const history = createPositionHistory();
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, step], target * 3);
      world.tick = step;
      recordHistory(history, world);
    }
    world.players.position.set([0, 0, 100], target * 3); // moved far away since
    world.tick = 10;
    const handle = rewindOthers(world, history, [shooter], 5); // rewind to tick 5
    expect(world.players.position[target * 3 + 2]).toBe(4); // newest sample at or before tick 5
    expect(world.players.position[shooter * 3 + 2]).toBe(0); // excluded: untouched
    restorePositions(world, handle);
    expect(world.players.position[target * 3 + 2]).toBe(100); // back to its true current position
  });
});
```

Extend `packages/server/src/world.test.ts`, adding one assertion inside the existing `'loads the committed Katabatic terrain and scene'` test:

```ts
    expect(world.flags.state.length).toBe(2);
```

Extend `packages/server/src/net.test.ts`. Change the top of the file to capture `world` and add `NetServer`'s `now` option, plus the imports the two new tests need:

```ts
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield, type World } from '@clans/sim';
import {
  decodeSnapshot, decodeWelcome, encodeAck, encodeInput, encodeJoin, MessageType,
  type NetInputSample,
} from '@clans/protocol';
import { startNetServer, type NetServer } from './net.js';
import type { SceneSpawn } from './world.js';
```

Change the `beforeEach`/`afterEach` block:

```ts
describe('startNetServer', () => {
  let server: NetServer;
  let world: World;

  beforeEach(async () => {
    world = createWorld(terrain, 1, 8);
    server = startNetServer({ world, spawns, port: TEST_PORT });
    await server.ready;
  });
  afterEach(() => server.close());
```

Add two `it` blocks inside the same `describe`, after the existing ones:

```ts
  it('a fired disc drops a bot target\'s health (headless disc-kill test)', async () => {
    const targetId = addPlayer(world, { x: 0, y: 0, z: 20 }, 2);
    const shooter = await connect(TEST_PORT);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    const fire: NetInputSample = {
      moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: true, altFire: false, slot: 1,
    };
    shooter.send(encodeInput({ sequence: 1, samples: [fire, fire, fire] }));
    await wait(20);
    for (let tickNumber = 2; tickNumber < 30; tickNumber += 1) server.tick(tickNumber);

    expect(world.players.damage[targetId]).toBeGreaterThan(0);
    shooter.close();
  });

  it('lag compensation: a 150ms-ping shooter still hits a target that has since moved away', async () => {
    let clock = 0;
    const lagServer = startNetServer({
      world, spawns, port: TEST_PORT + 1, now: () => clock,
    });
    await lagServer.ready;
    const targetId = addPlayer(world, { x: 0, y: 0, z: 8 }, 2);
    const shooter = await connect(TEST_PORT + 1);
    const welcomePromise = receive(shooter);
    shooter.send(encodeJoin());
    const welcome = decodeWelcome(await welcomePromise);
    world.players.position.set([0, 0, 0], welcome.playerId * 3);

    // Establish a 150ms ping: send a snapshot, ack it 150ms of server-clock time later.
    const firstPromise = receive(shooter);
    lagServer.tick(2);
    const first = decodeSnapshot(await firstPromise, null);
    clock = 150;
    shooter.send(encodeAck({ snapshotId: first.snapshotId }));
    await wait(20);

    const idle: NetInputSample = {
      moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0,
    };
    // Walk the target across the shot line for a few ticks (recorded into lag-comp history),
    // then jump it far away right before the shot — the laggy shooter's screen still shows
    // it in the old spot.
    for (let step = 0; step < 5; step += 1) {
      world.players.position.set([0, 0, 8], targetId * 3);
      lagServer.tick(3 + step);
    }
    world.players.position.set([500, 0, 500], targetId * 3);

    shooter.send(
      encodeInput({ sequence: 1, samples: [{ ...idle, slot: 2 }, { ...idle, slot: 2 }, { ...idle, slot: 2 }] }),
    );
    await wait(20);
    lagServer.tick(20); // applies the Chaingun slot switch only, still Ready, no shot yet

    const fire: NetInputSample = { ...idle, slot: 2, fire: true };
    shooter.send(encodeInput({ sequence: 2, samples: [fire, fire, fire] }));
    await wait(20);
    lagServer.tick(21); // fires with the target rewound ~150ms back onto the shot line

    expect(world.players.damage[targetId]).toBeGreaterThan(0);
    shooter.close();
    lagServer.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- damage.test.ts flags.test.ts && pnpm --filter @clans/server test`. The sim tests fail on the `pendingDeaths` shape; the server tests fail on missing `./lagcomp.js` and the missing `world.flags`/lag-comp/God wiring.

- [ ] **Step 3: Write minimal implementation**

In `packages/sim/src/types.ts`, change `World.pendingDeaths`:

```ts
  pendingDeaths: Array<{ id: number; attackerId: number }>;
```

In `packages/sim/src/damage.ts`, change the end of `applyDamage`:

```ts
  players.alive[id] = 0;
  players.respawnAt[id] = world.tick + RESPAWN_TICKS;
  world.pendingDeaths.push({ id, attackerId });
  scoreForDeath(world, id, attackerId);
```

In `packages/sim/src/flags.ts`, change `dropCarriedFlagsOnDeath`:

```ts
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
```

Create `packages/server/src/lagcomp.ts`:

```ts
import type { World } from '@clans/sim';

// Ours: 32 ticks (~1.02 s at 32 ms/tick) comfortably covers the spec's 200 ms lag-comp cap.
const HISTORY_TICKS = 32;

export interface PositionSample {
  tick: number;
  x: number;
  y: number;
  z: number;
}
export interface PositionHistory {
  capacity: number;
  samples: Map<number, PositionSample[]>;
}

export function createPositionHistory(capacity = HISTORY_TICKS): PositionHistory {
  return { capacity, samples: new Map() };
}

export function recordHistory(history: PositionHistory, world: World): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id]) {
      history.samples.delete(id);
      continue;
    }
    const base = id * 3;
    const list = history.samples.get(id) ?? [];
    list.push({
      tick: world.tick,
      x: world.players.position[base] ?? 0,
      y: world.players.position[base + 1] ?? 0,
      z: world.players.position[base + 2] ?? 0,
    });
    if (list.length > history.capacity) list.shift();
    history.samples.set(id, list);
  }
}

/** The newest recorded sample at or before `tick`, clamped to the oldest kept sample. */
export function positionAtTick(
  history: PositionHistory,
  playerId: number,
  tick: number,
): PositionSample | null {
  const list = history.samples.get(playerId);
  if (!list || list.length === 0) return null;
  let chosen = list[0]!;
  for (const sample of list) {
    if (sample.tick > tick) break;
    chosen = sample;
  }
  return chosen;
}

export interface RewindHandle {
  saved: Array<{ id: number; x: number; y: number; z: number }>;
}

/**
 * Moves every active player except `excludeIds` back to its recorded position
 * `rewindTicks` ago, for this tick's hit resolution. `restorePositions` must run right
 * after `stepWorld`, in the same tick — see the note there for what this costs.
 */
export function rewindOthers(
  world: World,
  history: PositionHistory,
  excludeIds: readonly number[],
  rewindTicks: number,
): RewindHandle {
  const targetTick = world.tick - rewindTicks;
  const saved: RewindHandle['saved'] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || excludeIds.includes(id)) continue;
    const base = id * 3;
    saved.push({
      id,
      x: world.players.position[base] ?? 0,
      y: world.players.position[base + 1] ?? 0,
      z: world.players.position[base + 2] ?? 0,
    });
    const sample = positionAtTick(history, id, targetTick);
    if (sample) world.players.position.set([sample.x, sample.y, sample.z], base);
  }
  return { saved };
}

/**
 * Restores the true position `rewindOthers` saved. A rewound player does not advance this
 * tick — the movement `stepWorld` computed for them from the borrowed position is discarded
 * along with it. This is a known one-tick freeze for whichever players a hitscan/tracer shot
 * rewound that tick; it is invisible client-side because the server position is authoritative
 * and the very next tick moves them normally again. Accepted for this milestone, same spirit
 * as Task 3's tunneling note.
 */
export function restorePositions(world: World, handle: RewindHandle): void {
  for (const entry of handle.saved) {
    world.players.position.set([entry.x, entry.y, entry.z], entry.id * 3);
  }
}
```

In `packages/server/src/world.ts`, add a flag-stand type and field to `SceneData`, and call `createFlags`:

```ts
export interface SceneFlagStand {
  team: number;
  position: [number, number, number];
}
interface SceneData {
  spawns: SceneSpawn[];
  flagStands: SceneFlagStand[];
}
```

```ts
import { addPlayer, createFlags, createWorld, type Heightfield, type World } from '@clans/sim';
```

```ts
  const world = createWorld(terrain, seed, WORLD_CAPACITY);
  createFlags(
    world,
    scene.flagStands.map(({ team, position: [x, y, z] }) => ({ team, position: { x, y, z } })),
  );
  return { world, spawns: scene.spawns };
```

(`scene.flags`, the `Flag` pickup marker Task 5 also extracts, sits at the same position as its
`ExteriorFlagStand` in the real mission data; the sim only needs the stand position, so
`flagStands` alone is enough to seed `createFlags`. `scene.flags` stays unused this milestone.)

Rewrite `packages/server/src/net.ts` (full new contents):

```ts
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FIXED_DT,
  FIXED_TICK_MS,
  FlagState,
  LIGHT_ARMOR,
  WEAPON_DATA,
  WeaponId,
  addPlayer,
  dueForRespawn,
  playerHitbox,
  raySphereDistance,
  removePlayer,
  respawnPlayer,
  serializeActivePlayers,
  stepWorld,
  type FireEvent,
  type PlayerInput,
  type World,
} from '@clans/sim';
import {
  EventKind,
  MessageType,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY_N_TICKS,
  WelcomeStatus,
  decodeAck,
  decodeGod,
  decodeInput,
  decodeJoin,
  encodeEvent,
  encodeSnapshot,
  encodeWelcome,
  type EventMessage,
  type FlagSnapshotData,
  type ProjectileSnapshotData,
  type SnapshotBaseline,
  type WorldExtras,
} from '@clans/protocol';
import { applyInputMessage, createSession, recordAck, type Session } from './session.js';
import { createPositionHistory, recordHistory, restorePositions, rewindOthers } from './lagcomp.js';
import { needsFullSnapshot } from './snapshot-policy.js';
import { smallerTeam, spawnPointFor, teamCount, type SceneSpawn } from './world.js';

export interface NetServerOptions {
  world: World;
  spawns: SceneSpawn[];
  port: number;
  now?: () => number;
}
export interface NetServer {
  ready: Promise<void>;
  close(): void;
  tick(tickNumber: number): void;
}

// Snapshots a client may still ack. Older ones fall off; a client that far behind gets a full.
const SENT_HISTORY = 8;
const REWIND_CAP_MS = 200; // Spec: lag compensation is capped at 200 ms.
const HITSCAN_WEAPONS = new Set<WeaponId>([WeaponId.Chaingun, WeaponId.LaserRifle]);

interface SentSnapshot extends SnapshotBaseline {
  sentAt: number;
}
interface ClientEntry {
  socket: WebSocket;
  session: Session;
  sent: SentSnapshot[];
  pingMs: number;
}
interface FlagSnapshotForDiff {
  state: number;
  carrierId: number;
}

/** The baseline for the next delta is the snapshot the client last acked, never one merely sent. */
function ackedBaseline(entry: ClientEntry): SnapshotBaseline | null {
  return entry.sent.find((sent) => sent.snapshotId === entry.session.lastAckedSnapshotId) ?? null;
}

function handleJoin(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  now: () => number,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const join = decodeJoin(bytes);
  if (join.version !== PROTOCOL_VERSION) {
    socket.send(
      encodeWelcome({
        playerId: 0, team: 0, tickMs: FIXED_TICK_MS, status: WelcomeStatus.VersionMismatch,
        spawnX: 0, spawnY: 0, spawnZ: 0,
      }),
    );
    return;
  }
  const team = smallerTeam(world);
  const [x, y, z] = spawnPointFor(spawns, team, teamCount(world, team));
  const playerId = addPlayer(world, { x, y, z }, team);
  clients.set(socket, { socket, session: createSession(playerId, team, now()), sent: [], pingMs: 0 });
  socket.send(
    encodeWelcome({
      playerId, team, tickMs: FIXED_TICK_MS, status: WelcomeStatus.Ok,
      spawnX: x, spawnY: y, spawnZ: z,
    }),
  );
}

function handleInput(
  clients: Map<WebSocket, ClientEntry>,
  latestInputs: Map<number, PlayerInput>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  for (const sample of applyInputMessage(entry.session, decodeInput(bytes))) {
    latestInputs.set(entry.session.playerId, sample);
  }
}

function handleAck(
  clients: Map<WebSocket, ClientEntry>,
  now: () => number,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  const decoded = decodeAck(bytes);
  recordAck(entry.session, decoded.snapshotId, now());
  const sent = entry.sent.find((candidate) => candidate.snapshotId === decoded.snapshotId);
  if (sent) entry.pingMs = now() - sent.sentAt;
}

function handleGod(
  clients: Map<WebSocket, ClientEntry>,
  godPlayers: Set<number>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  if (decodeGod(bytes).enabled) godPlayers.add(entry.session.playerId);
  else godPlayers.delete(entry.session.playerId);
}

function handleMessage(
  world: World,
  spawns: SceneSpawn[],
  clients: Map<WebSocket, ClientEntry>,
  latestInputs: Map<number, PlayerInput>,
  godPlayers: Set<number>,
  now: () => number,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const type = bytes[0];
  if (type === MessageType.Join) handleJoin(world, spawns, clients, now, socket, bytes);
  else if (type === MessageType.Input) handleInput(clients, latestInputs, socket, bytes);
  else if (type === MessageType.Ack) handleAck(clients, now, socket, bytes);
  else if (type === MessageType.God) handleGod(clients, godPlayers, socket, bytes);
}

function handleClose(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  latestInputs: Map<number, PlayerInput>,
  godPlayers: Set<number>,
  socket: WebSocket,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  removePlayer(world, entry.session.playerId);
  latestInputs.delete(entry.session.playerId);
  godPlayers.delete(entry.session.playerId);
  clients.delete(socket);
}

function sendSnapshot(
  entry: ClientEntry,
  nextSnapshotId: number,
  tickNumber: number,
  players: ReturnType<typeof serializeActivePlayers>,
  extras: WorldExtras,
  now: () => number,
): void {
  const useFull = needsFullSnapshot(entry.session.lastAckedSnapshotId, entry.session.lastAckedAt, now());
  const baseline = useFull ? null : ackedBaseline(entry);
  const bytes = encodeSnapshot(
    nextSnapshotId,
    tickNumber,
    entry.session.lastAppliedSequence,
    players,
    baseline,
    extras,
  );
  entry.sent.push({ snapshotId: nextSnapshotId, players, sentAt: now() });
  if (entry.sent.length > SENT_HISTORY) entry.sent.shift();
  entry.socket.send(bytes);
}

function buildExtras(world: World): WorldExtras {
  const projectiles: ProjectileSnapshotData[] = [];
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    const base = id * 3;
    projectiles.push({
      id,
      type: world.projectiles.type[id] ?? 0,
      weaponId: world.projectiles.weaponId[id] ?? 0,
      x: world.projectiles.position[base] ?? 0,
      y: world.projectiles.position[base + 1] ?? 0,
      z: world.projectiles.position[base + 2] ?? 0,
      vx: world.projectiles.velocity[base] ?? 0,
      vy: world.projectiles.velocity[base + 1] ?? 0,
      vz: world.projectiles.velocity[base + 2] ?? 0,
      ownerId: world.projectiles.ownerId[id] ?? -1,
    });
  }
  const flags: FlagSnapshotData[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const base = id * 3;
    const returnAt = world.flags.returnAt[id] ?? -1;
    flags.push({
      id,
      team: world.flags.team[id] ?? 0,
      state: world.flags.state[id] ?? 0,
      x: world.flags.position[base] ?? 0,
      y: world.flags.position[base + 1] ?? 0,
      z: world.flags.position[base + 2] ?? 0,
      carrierId: world.flags.carrierId[id] ?? -1,
      returnInS: returnAt < 0 ? -1 : (returnAt - world.tick) * FIXED_DT,
    });
  }
  return {
    projectiles,
    flags,
    teamScores: [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0],
    gameOver: world.gameOver,
    winnerTeam: world.winnerTeam,
    timeRemainingS: Math.max(0, (world.timeLimitTicks - world.tick) * FIXED_DT),
    gameOverReason: world.gameOverReason,
  };
}

function respawnDuePlayers(world: World, spawns: SceneSpawn[]): void {
  for (const id of dueForRespawn(world)) {
    const team = world.players.team[id] ?? 1;
    const [x, y, z] = spawnPointFor(spawns, team, teamCount(world, team));
    respawnPlayer(world, id, { x, y, z });
  }
}

/** God-mode wire mechanism (ours, see the plan's numbers table): zero damage and revive after
 * `stepWorld` runs, rather than threading a flag through the deterministic sim. */
function applyGodMode(world: World, godPlayers: Set<number>): void {
  for (const id of godPlayers) {
    if (!world.players.active[id]) continue;
    world.players.damage[id] = 0;
    if (!world.players.alive[id]) {
      world.players.alive[id] = 1;
      world.players.respawnAt[id] = -1;
    }
  }
}

function hitscanShooters(world: World, latestInputs: ReadonlyMap<number, PlayerInput>): number[] {
  const shooters: number[] = [];
  for (const [playerId, input] of latestInputs) {
    if (!input.fire || !world.players.active[playerId]) continue;
    if (HITSCAN_WEAPONS.has(world.players.weaponSlot[playerId] as WeaponId)) shooters.push(playerId);
  }
  return shooters;
}

/** One global rewind-ms for the whole tick (ours — see the plan's numbers table), not a
 * per-shooter-per-target rewind: the max ping among this tick's hitscan/tracer shooters. */
function rewindMsForShooters(clients: Map<WebSocket, ClientEntry>, shooterIds: number[]): number {
  let maxPing = 0;
  for (const entry of clients.values()) {
    if (shooterIds.includes(entry.session.playerId)) maxPing = Math.max(maxPing, entry.pingMs);
  }
  return Math.min(maxPing, REWIND_CAP_MS);
}

function killEvents(world: World): EventMessage[] {
  return world.pendingDeaths.map(({ id, attackerId }) => ({
    type: MessageType.Event as const,
    kind: EventKind.PlayerKilled,
    a: attackerId,
    b: id,
  }));
}

/** Redoes the Laser Rifle's own nearest-hit search (Task 3's `resolveHitscan`) purely to
 * report a target id on the wire; the authoritative damage already landed inside `stepWorld`. */
function findLaserHit(world: World, event: FireEvent): number {
  const data = WEAPON_DATA[WeaponId.LaserRifle];
  let nearestId = -1;
  let nearestDistance = Infinity;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!world.players.active[playerId] || !world.players.alive[playerId] || playerId === event.playerId) continue;
    const hitbox = playerHitbox(world, playerId, LIGHT_ARMOR);
    const distance = raySphereDistance(event.origin, event.direction, hitbox);
    if (distance !== null && distance <= (data.maxRange ?? 0) && distance < nearestDistance) {
      nearestId = playerId;
      nearestDistance = distance;
    }
  }
  return nearestId;
}

function laserEvents(world: World): EventMessage[] {
  return world.pendingFireEvents
    .filter((event) => event.weaponId === WeaponId.LaserRifle && !event.isAltFire)
    .map((event) => ({
      type: MessageType.Event as const,
      kind: EventKind.LaserFired,
      a: event.playerId,
      b: findLaserHit(world, event),
    }));
}

function snapshotFlags(world: World): FlagSnapshotForDiff[] {
  const out: FlagSnapshotForDiff[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) {
    out.push({ state: world.flags.state[id] ?? 0, carrierId: world.flags.carrierId[id] ?? -1 });
  }
  return out;
}

/** Diffs flag state around `stepWorld` rather than adding a pending-events array to `flags.ts`
 * (Task 4 stays untouched): a touch is carrierId -1 -> set, a capture is state Carried -> Home
 * (a timer return or an own-flag return both pass through Dropped first, never Carried). */
function flagEvents(world: World, before: FlagSnapshotForDiff[]): EventMessage[] {
  const events: EventMessage[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const previous = before[id];
    if (!previous) continue;
    const carrierId = world.flags.carrierId[id] ?? -1;
    const state = world.flags.state[id] ?? 0;
    if (previous.carrierId === -1 && carrierId !== -1) {
      events.push({ type: MessageType.Event, kind: EventKind.FlagTouched, a: carrierId, b: id });
    }
    if (previous.state === FlagState.Carried && state === FlagState.Home) {
      const capturingTeam = (world.flags.team[id] ?? 0) === 1 ? 2 : 1;
      events.push({
        type: MessageType.Event,
        kind: EventKind.FlagCaptured,
        a: capturingTeam,
        b: previous.carrierId,
      });
    }
  }
  return events;
}

function broadcastEvent(clients: Map<WebSocket, ClientEntry>, event: EventMessage): void {
  const bytes = encodeEvent(event);
  for (const entry of clients.values()) entry.socket.send(bytes);
}

export function startNetServer(options: NetServerOptions): NetServer {
  const wss = new WebSocketServer({ port: options.port });
  const ready = new Promise<void>((resolve) => wss.once('listening', resolve));
  const clients = new Map<WebSocket, ClientEntry>();
  const latestInputs = new Map<number, PlayerInput>();
  const godPlayers = new Set<number>();
  const history = createPositionHistory();
  const now = options.now ?? (() => Date.now());
  let nextSnapshotId = 1;

  wss.on('connection', (socket) => {
    socket.on('message', (data) =>
      handleMessage(
        options.world,
        options.spawns,
        clients,
        latestInputs,
        godPlayers,
        now,
        socket,
        new Uint8Array(data as Uint8Array),
      ),
    );
    socket.on('close', () => handleClose(options.world, clients, latestInputs, godPlayers, socket));
  });

  function sendAllSnapshots(tickNumber: number): void {
    const players = serializeActivePlayers(options.world);
    const extras = buildExtras(options.world);
    nextSnapshotId += 1;
    for (const entry of clients.values()) sendSnapshot(entry, nextSnapshotId, tickNumber, players, extras, now);
  }

  function runOneTick(): void {
    recordHistory(history, options.world);
    const shooters = hitscanShooters(options.world, latestInputs);
    const rewindTicks =
      shooters.length > 0 ? Math.round(rewindMsForShooters(clients, shooters) / FIXED_TICK_MS) : 0;
    const rewindHandle = rewindTicks > 0 ? rewindOthers(options.world, history, shooters, rewindTicks) : null;
    const flagsBefore = snapshotFlags(options.world);

    stepWorld(options.world, latestInputs);
    if (rewindHandle) restorePositions(options.world, rewindHandle);
    respawnDuePlayers(options.world, options.spawns);
    applyGodMode(options.world, godPlayers);

    for (const event of killEvents(options.world)) broadcastEvent(clients, event);
    for (const event of flagEvents(options.world, flagsBefore)) broadcastEvent(clients, event);
    for (const event of laserEvents(options.world)) broadcastEvent(clients, event);
  }

  // Game over freezes the sim: no more stepWorld, no more respawns or events, but snapshots
  // keep going out on the normal cadence so every client sees the frozen final state.
  function tick(tickNumber: number): void {
    if (!options.world.gameOver) runOneTick();
    if (tickNumber % SNAPSHOT_EVERY_N_TICKS !== 0) return;
    sendAllSnapshots(tickNumber);
  }

  return { ready, close: () => wss.close(), tick };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm --filter @clans/server test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/types.ts packages/sim/src/damage.ts packages/sim/src/damage.test.ts packages/sim/src/flags.ts packages/server/src/lagcomp.ts packages/server/src/lagcomp.test.ts packages/server/src/net.ts packages/server/src/net.test.ts packages/server/src/world.ts packages/server/src/world.test.ts
git commit -m "feat(server): weapon input, projectile/event broadcast, respawn, CTF snapshots, lag comp, God debug" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 8: Client — weapon fire/grenade/slot input

**Files:** Modify `packages/client/src/input.ts`, `packages/client/src/input.test.ts`
**Interfaces:** Consumes `PlayerInput` (Task 2's `pitch`/`fire`/`altFire`/`slot`). Produces `Input.fire`, extended `Input.snapshot()`, `Input.releaseAll()`. **Runs in parallel with Task 7** — different package, no shared file.

- [ ] **Step 1: Write the failing tests**

Change `packages/client/src/input.test.ts` (full new contents):

```ts
import { describe, expect, it } from 'vitest';
import { Input } from './input.js';

describe('Input.releaseAll', () => {
  it('drops the jet flag, the fire flag, and every held key', () => {
    const input = new Input({} as HTMLElement);
    input.jet = true;
    input.fire = true;
    (input as unknown as { keys: Set<string> }).keys.add('KeyW');
    expect(input.snapshot()).toMatchObject({ jet: true, fire: true, moveZ: 1 });
    input.releaseAll();
    expect(input.snapshot()).toMatchObject({ jet: false, fire: false, moveZ: 0, jump: false });
  });
});

describe('Input.snapshot: weapon slot and grenade key', () => {
  it('reads the lowest held number key 1-5 as slot, 0 when none are held', () => {
    const input = new Input({} as HTMLElement);
    expect(input.snapshot().slot).toBe(0);
    (input as unknown as { keys: Set<string> }).keys.add('Digit3');
    expect(input.snapshot().slot).toBe(3);
  });

  it('reads altFire from the G key', () => {
    const input = new Input({} as HTMLElement);
    expect(input.snapshot().altFire).toBe(false);
    (input as unknown as { keys: Set<string> }).keys.add('KeyG');
    expect(input.snapshot().altFire).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- input.test.ts`. Expect `snapshot()` to be missing `pitch`/`fire`/`altFire`/`slot`, and `Input` to have no `fire` property.

- [ ] **Step 3: Write minimal implementation**

Change `packages/client/src/input.ts` (full new contents):

```ts
import type { PlayerInput } from '@clans/sim';

const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Pointer-lock mouse look plus keyboard state. Yaw follows the sim convention: forward is
 * (sin yaw, 0, cos yaw) in world space, so yaw decreases when the mouse moves right.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  jet = false;
  fire = false;
  sensitivity = 0.002;
  private readonly keys = new Set<string>();

  constructor(private readonly target: HTMLElement) {}

  attach(): void {
    const { target } = this;
    target.addEventListener('click', () => {
      if (document.pointerLockElement !== target) target.requestPointerLock();
    });
    target.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space' || event.code.startsWith('F')) event.preventDefault();
      this.keys.add(event.code);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== target) this.releaseAll();
    });
    target.addEventListener('mousedown', (event) => {
      if (event.button === 2) this.jet = true;
      else if (event.button === 0) this.fire = true;
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 2) this.jet = false;
      else if (event.button === 0) this.fire = false;
    });
    window.addEventListener('mousemove', (event) => this.look(event));
  }

  private look(event: MouseEvent): void {
    if (document.pointerLockElement !== this.target) return;
    this.yaw -= event.movementX * this.sensitivity;
    this.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.pitch - event.movementY * this.sensitivity),
    );
  }

  /** Drop every held input. Called on blur and pointer-lock exit so nothing sticks. */
  releaseAll(): void {
    this.keys.clear();
    this.jet = false;
    this.fire = false;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** The lowest held number key 1-5, or 0 if none are held — matches `weaponIdForSlot`. */
  private slotFromKeys(): number {
    for (let n = 1; n <= 5; n += 1) {
      if (this.isDown(`Digit${String(n)}`)) return n;
    }
    return 0;
  }

  /** The sim input for this tick. Keys work without pointer lock; only the mouse needs it. */
  snapshot(): PlayerInput {
    const axis = (positive: string, negative: string): number =>
      (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
    return {
      moveX: axis('KeyD', 'KeyA'),
      moveZ: axis('KeyW', 'KeyS'),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.isDown('Space'),
      jet: this.jet,
      fire: this.fire,
      altFire: this.isDown('KeyG'),
      slot: this.slotFromKeys(),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/input.ts packages/client/src/input.test.ts
git commit -m "feat(client): weapon fire, grenade, and weapon-slot input" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 9: Client — NetClient projectiles, flags, team scores, game over, events

**Files:** Modify `packages/client/src/netclient.ts`, `packages/client/src/netclient.test.ts`
**Interfaces:** Consumes `DecodedSnapshot`'s new fields, `ProjectileSnapshotData`, `FlagSnapshotData`, `EventMessage`, `decodeEvent`, `MessageType.Event`, `LIGHT_ARMOR` (Tasks 1, 6). Produces `NetClient.projectiles`, `NetClient.flags`, `NetClient.teamScores`, `NetClient.gameOver`, `NetClient.winnerTeam`, `NetClient.timeRemainingS`, `NetClient.gameOverReason`, `NetClient.localHealth`, `NetClient.recentEvents`, `NetClient.setGodMode(enabled)`. Depends on Task 6 and Task 8.

- [ ] **Step 1: Write the failing tests**

Extend `packages/client/src/netclient.test.ts`. Change the import line to add `emptyExtras`, `type WorldExtras`, `EventKind`, `encodeEvent`, `encodeGod`, `decodeGod`:

```ts
import {
  MessageType, SNAPSHOT_EVERY_N_TICKS, decodeInput, emptyExtras, encodeSnapshot,
  EventKind, encodeEvent, encodeGod, decodeGod, type WorldExtras,
} from '@clans/protocol';
```

Change every `encodeSnapshot(...)` call site to add `emptyExtras()` as the trailing argument — the server-tick call at line 123 (`encodeSnapshot(nextSnapshotId, server.tick, lastInputSequence, players, null, emptyExtras())`), and the two manually-built ones in the other two tests (`encodeSnapshot(7, 3, 0, [state], { snapshotId: 6, players: [state] }, emptyExtras())` and `encodeSnapshot(1, 0, 0, [serverState], null, emptyExtras())`).

Add three new tests to the `describe('NetClient')` block:

```ts
  it('exposes projectiles, flags, team scores, and game over from the snapshot extras', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 11 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const extras: WorldExtras = {
      projectiles: [{ id: 0, type: 0, weaponId: 0, x: 1, y: 2, z: 3, vx: 90, vy: 0, vz: 0, ownerId: 0 }],
      flags: [{ id: 0, team: 1, state: 1, x: 5, y: 0, z: 5, carrierId: 0, returnInS: -1 }],
      teamScores: [100, 0],
      gameOver: false,
      winnerTeam: 0,
      timeRemainingS: 1200.5,
      gameOverReason: 0,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [], null, extras)]);
    expect(client.projectiles).toEqual(extras.projectiles);
    expect(client.flags).toEqual(extras.flags);
    expect(client.teamScores).toEqual([100, 0]);
    expect(client.gameOver).toBe(false);
    expect(client.timeRemainingS).toBeCloseTo(1200.5, 1);
    expect(client.gameOverReason).toBe(0);
  });

  it('reads localHealth off the reconciled snapshot for the local player', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 12 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.playerId = 0;
    const state = {
      id: 0, team: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, energy: 60,
      onGround: 1 as const, ski: 0 as const, health: 0.4, weaponSlot: 0,
    };
    transport.pump([encodeSnapshot(1, 0, 0, [state], null, emptyExtras())]);
    expect(client.localHealth).toBeCloseTo(0.4);
  });

  it('collects incoming Event messages into a bounded rolling history', () => {
    clock.ms = 0;
    const transport = makeTransport(makeLink({ value: 13 }));
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    transport.pump([encodeEvent({ kind: EventKind.PlayerKilled, a: 1, b: 2 })]);
    expect(client.recentEvents).toEqual([{ type: MessageType.Event, kind: EventKind.PlayerKilled, a: 1, b: 2 }]);
  });

  it('sends a God message when setGodMode is called', () => {
    clock.ms = 0;
    const link = makeLink({ value: 14 });
    const sent: Uint8Array[] = [];
    const rawSend = link.send.bind(link);
    link.send = (bytes) => {
      sent.push(bytes);
      rawSend(bytes);
    };
    const transport = makeTransport(link);
    const client = new NetClient(transport, terrain, { now: () => clock.ms });
    client.setGodMode(true);
    const god = sent.find((bytes) => bytes[0] === MessageType.God);
    expect(god && decodeGod(god)).toEqual({ type: MessageType.God, enabled: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- netclient.test.ts`. Expect `client.projectiles`/`flags`/`teamScores`/`gameOver`/`localHealth`/`recentEvents`/`setGodMode` to be missing, and the existing `encodeSnapshot` call sites to fail to type-check without the 6th argument.

- [ ] **Step 3: Write minimal implementation**

In `packages/client/src/netclient.ts`, change the imports:

```ts
import {
  addPlayer,
  createWorld,
  deserializePlayer,
  LIGHT_ARMOR,
  stepWorld,
  type Heightfield,
  type PlayerInput,
  type PlayerSnapshotData,
  type World,
} from '@clans/sim';
import {
  MessageType,
  decodeEvent,
  decodeSnapshot,
  decodeWelcome,
  encodeAck,
  encodeGod,
  encodeInput,
  encodeJoin,
  type EventMessage,
  type FlagSnapshotData,
  type ProjectileSnapshotData,
} from '@clans/protocol';
import type { SnapshotBaseline } from '@clans/protocol';
import type { Transport } from './transport.js';
```

Add a constant and extend the class fields (after `remoteTick = 0;`):

```ts
const EVENT_HISTORY = 100;
```

```ts
  remoteTick = 0;
  projectiles: ProjectileSnapshotData[] = [];
  flags: FlagSnapshotData[] = [];
  teamScores: [number, number] = [0, 0];
  gameOver = false;
  winnerTeam = 0;
  timeRemainingS = 0;
  gameOverReason = 0;
  localHealth = LIGHT_ARMOR.maxDamage;
  recentEvents: EventMessage[] = [];
```

Add `setGodMode` next to `tick`:

```ts
  setGodMode(enabled: boolean): void {
    this.transport.send(encodeGod({ enabled }));
  }
```

Change `handleMessage`:

```ts
  private handleMessage(bytes: Uint8Array): void {
    const type = bytes[0];
    if (type === MessageType.Welcome) this.handleWelcome(bytes);
    else if (type === MessageType.Snapshot) this.handleSnapshot(bytes);
    else if (type === MessageType.Event) this.handleEvent(bytes);
  }

  private handleEvent(bytes: Uint8Array): void {
    this.recentEvents.push(decodeEvent(bytes));
    if (this.recentEvents.length > EVENT_HISTORY) this.recentEvents.shift();
  }
```

Change `handleSnapshot`, extending the `self` branch and adding the extras assignment before `this.remoteTick = decoded.tick;`:

```ts
    const self = decoded.players.find((player) => player.id === this.playerId);
    if (self) {
      this.reconcile(self, decoded.tick, decoded.lastInputSequence);
      this.localHealth = self.health;
    }

    this.remotePlayers = new Map(
      decoded.players
        .filter((player) => player.id !== this.playerId)
        .map((player) => [player.id, player]),
    );
    this.projectiles = decoded.projectiles;
    this.flags = decoded.flags;
    this.teamScores = decoded.teamScores;
    this.gameOver = decoded.gameOver;
    this.winnerTeam = decoded.winnerTeam;
    this.timeRemainingS = decoded.timeRemainingS;
    this.gameOverReason = decoded.gameOverReason;
    this.remoteTick = decoded.tick;
    this.stats.entityCount = decoded.players.length;
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/netclient.ts packages/client/src/netclient.test.ts
git commit -m "feat(client): NetClient projectiles, flags, scores, game over, events, God" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 10: Client — projectile meshes, explosion flashes, laser beam flashes

**Files:** Create `packages/client/src/weapons-view.ts`, `packages/client/src/weapons-view.test.ts`
**Interfaces:** Consumes `ProjectileSnapshotData`, `EventMessage`, `EventKind` (Task 6), `ProjectileType`, `WeaponId`, `World` (Task 2, Task 3). Produces `createProjectileMesh`, `syncProjectileMeshes`, `projectilesFromWorld`, `type Effect`, `spawnExplosionsForExpired`, `createLaserBeam`, `spawnLaserBeams`, `updateEffects`. Depends on Task 9. **Runs in parallel with Task 11** — different files, neither imports the other.

Rendering is authoritative-only: the local player's own shot appears once the server's next
snapshot includes it, the same as anyone else's. This is a deliberate scope cut (**ours**) —
merging the client's own locally-predicted projectile (Task 2/3's `stepWorld` already spawns
one, purely as a prediction side effect, since the client runs the same sim) with the server's
copy would need a reconciliation scheme this milestone does not build. The one-RTT delay is not
noticeable at LAN latencies and does not affect hit detection, which is always server-side.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/weapons-view.test.ts`:

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventKind, type EventMessage, type ProjectileSnapshotData } from '@clans/protocol';
import {
  createLaserBeam,
  spawnExplosionsForExpired,
  spawnLaserBeams,
  syncProjectileMeshes,
  updateEffects,
  type Effect,
} from './weapons-view.js';

const disc = (id: number, x: number): ProjectileSnapshotData => ({
  id, type: 0, weaponId: 0, x, y: 1, z: 0, vx: 90, vy: 0, vz: 0, ownerId: 0,
});

describe('syncProjectileMeshes', () => {
  it('adds a mesh per projectile and removes it once the id disappears', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Mesh>();
    syncProjectileMeshes(scene, meshes, [disc(1, 5)]);
    expect(scene.children).toHaveLength(1);
    expect(meshes.get(1)?.position.x).toBe(5);
    syncProjectileMeshes(scene, meshes, []);
    expect(scene.children).toHaveLength(0);
  });
});

describe('spawnExplosionsForExpired', () => {
  it('spawns one flash per projectile id that vanished between frames', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const previous = new Map([[1, disc(1, 5)]]);
    spawnExplosionsForExpired(scene, effects, previous, []);
    expect(effects).toHaveLength(1);
    expect(scene.children).toHaveLength(1);
  });

  it('spawns nothing for a projectile that is still present', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const previous = new Map([[1, disc(1, 5)]]);
    spawnExplosionsForExpired(scene, effects, previous, [disc(1, 6)]);
    expect(effects).toHaveLength(0);
  });
});

describe('spawnLaserBeams', () => {
  it('draws a beam between the shooter and the reported hit player', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const events: EventMessage[] = [{ type: 6, kind: EventKind.LaserFired, a: 1, b: 2 }];
    const positions = new Map([
      [1, { x: 0, y: 1.6, z: 0 }],
      [2, { x: 0, y: 1.15, z: 10 }],
    ]);
    spawnLaserBeams(scene, effects, events, (id) => positions.get(id) ?? null);
    expect(effects).toHaveLength(1);
    expect(scene.children).toHaveLength(1);
  });

  it('skips a miss (b === -1): there is no target position to draw to', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const events: EventMessage[] = [{ type: 6, kind: EventKind.LaserFired, a: 1, b: -1 }];
    spawnLaserBeams(scene, effects, events, () => ({ x: 0, y: 0, z: 0 }));
    expect(effects).toHaveLength(0);
  });

  it('ignores non-LaserFired events', () => {
    const scene = new THREE.Scene();
    const effects: Effect[] = [];
    const events: EventMessage[] = [{ type: 6, kind: EventKind.PlayerKilled, a: 1, b: 2 }];
    spawnLaserBeams(scene, effects, events, () => ({ x: 0, y: 0, z: 0 }));
    expect(effects).toHaveLength(0);
  });
});

describe('updateEffects', () => {
  it('removes an effect from the scene once its ttl elapses', () => {
    const scene = new THREE.Scene();
    const mesh = createLaserBeam({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    scene.add(mesh);
    const effects: Effect[] = [{ mesh, ttl: 0.05 }];
    updateEffects(scene, effects, 0.03);
    expect(effects).toHaveLength(1);
    updateEffects(scene, effects, 0.03);
    expect(effects).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- weapons-view.test.ts`. Expect module resolution to fail for `./weapons-view.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/weapons-view.ts`:

```ts
import * as THREE from 'three';
import { ProjectileType, WeaponId, type World } from '@clans/sim';
import { EventKind, type EventMessage, type ProjectileSnapshotData } from '@clans/protocol';

const EXPLOSION_LIFETIME_S = 0.25; // Ours: a quick flash, not simulated debris.
const LASER_BEAM_LIFETIME_S = 0.08; // Ours: one or two rendered frames at 60 fps.
const EXPLOSION_RADIUS = 1.5; // Ours: a visible flash, unrelated to the weapon's damage radius.

const WEAPON_COLOR: Record<number, number> = {
  [WeaponId.Spinfusor]: 0xffa000,
  [WeaponId.Chaingun]: 0xffee55,
  [WeaponId.Mortar]: 0x888888,
  [WeaponId.LaserRifle]: 0xff2222,
  [WeaponId.Blaster]: 0x55ccff,
};
const GRENADE_COLOR = 0x55aa55;

export function createProjectileMesh(projectile: ProjectileSnapshotData): THREE.Mesh {
  const isGrenade = projectile.type === ProjectileType.Grenade;
  const radius = isGrenade ? 0.25 : 0.15;
  const geometry = new THREE.SphereGeometry(radius, 8, 6);
  const color = isGrenade ? GRENADE_COLOR : (WEAPON_COLOR[projectile.weaponId] ?? 0xffffff);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
}

function pruneProjectileMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  liveIds: Set<number>,
): void {
  for (const id of [...meshes.keys()]) {
    if (liveIds.has(id)) continue;
    const mesh = meshes.get(id);
    if (mesh) scene.remove(mesh);
    meshes.delete(id);
  }
}

export function syncProjectileMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Mesh>,
  projectiles: ProjectileSnapshotData[],
): void {
  const liveIds = new Set(projectiles.map((p) => p.id));
  pruneProjectileMeshes(scene, meshes, liveIds);
  for (const projectile of projectiles) {
    let mesh = meshes.get(projectile.id);
    if (!mesh) {
      mesh = createProjectileMesh(projectile);
      scene.add(mesh);
      meshes.set(projectile.id, mesh);
    }
    mesh.position.set(projectile.x, projectile.y, projectile.z);
  }
}

/** Single-player mode has no server snapshot; read the sim's own projectile store directly. */
export function projectilesFromWorld(world: World): ProjectileSnapshotData[] {
  const out: ProjectileSnapshotData[] = [];
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    const base = id * 3;
    out.push({
      id,
      type: world.projectiles.type[id] ?? 0,
      weaponId: world.projectiles.weaponId[id] ?? 0,
      x: world.projectiles.position[base] ?? 0,
      y: world.projectiles.position[base + 1] ?? 0,
      z: world.projectiles.position[base + 2] ?? 0,
      vx: world.projectiles.velocity[base] ?? 0,
      vy: world.projectiles.velocity[base + 1] ?? 0,
      vz: world.projectiles.velocity[base + 2] ?? 0,
      ownerId: world.projectiles.ownerId[id] ?? -1,
    });
  }
  return out;
}

export interface Effect {
  mesh: THREE.Object3D;
  ttl: number;
}

function createFlash(position: { x: number; y: number; z: number }, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(EXPLOSION_RADIUS, 8, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  mesh.position.set(position.x, position.y, position.z);
  return mesh;
}

/** Projectiles present last frame and gone this frame get a one-shot flash at their last known
 * position — there is no explicit "projectile expired" wire message, so the caller diffs. */
export function spawnExplosionsForExpired(
  scene: THREE.Scene,
  effects: Effect[],
  previous: Map<number, ProjectileSnapshotData>,
  current: ProjectileSnapshotData[],
): void {
  const currentIds = new Set(current.map((p) => p.id));
  for (const [id, last] of previous) {
    if (currentIds.has(id)) continue;
    const mesh = createFlash(last, WEAPON_COLOR[last.weaponId] ?? 0xffffff);
    scene.add(mesh);
    effects.push({ mesh, ttl: EXPLOSION_LIFETIME_S });
  }
}

export function createLaserBeam(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x, to.y, to.z),
  ]);
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: WEAPON_COLOR[WeaponId.LaserRifle] }));
}

/** Draws a one-frame beam for each new LaserFired event since the caller's last call. The
 * Laser Rifle is hitscan (Task 3: "no stored projectile"), so it never appears in the
 * projectile snapshot — this Event message is the only way another client learns it fired. */
export function spawnLaserBeams(
  scene: THREE.Scene,
  effects: Effect[],
  newEvents: EventMessage[],
  positionOf: (playerId: number) => { x: number; y: number; z: number } | null,
): void {
  for (const event of newEvents) {
    if (event.kind !== EventKind.LaserFired) continue;
    const from = positionOf(event.a);
    const to = event.b >= 0 ? positionOf(event.b) : null;
    if (!from || !to) continue;
    const beam = createLaserBeam(from, to);
    scene.add(beam);
    effects.push({ mesh: beam, ttl: LASER_BEAM_LIFETIME_S });
  }
}

export function updateEffects(scene: THREE.Scene, effects: Effect[], dtSeconds: number): void {
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const effect = effects[i];
    if (!effect) continue;
    effect.ttl -= dtSeconds;
    if (effect.ttl <= 0) {
      scene.remove(effect.mesh);
      effects.splice(i, 1);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/weapons-view.ts packages/client/src/weapons-view.test.ts
git commit -m "feat(client): projectile meshes, explosion flashes, laser beam flashes" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 11: Client — flag view (box on a pole)

**Files:** Create `packages/client/src/flag-view.ts`, `packages/client/src/flag-view.test.ts`
**Interfaces:** Consumes `FlagSnapshotData` (Task 6), `FlagState`, `World` (Task 4). Produces `syncFlagMeshes`, `flagsFromWorld`. Depends on Task 9. **Runs in parallel with Task 10.**

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/flag-view.test.ts`:

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addPlayer, createFlags, createWorld, type Heightfield } from '@clans/sim';
import type { FlagSnapshotData } from '@clans/protocol';
import { flagsFromWorld, syncFlagMeshes } from './flag-view.js';

const homeFlag = (id: number, team: number): FlagSnapshotData => ({
  id, team, state: 0, x: team * 10, y: 0, z: 0, carrierId: -1, returnInS: -1,
});

describe('syncFlagMeshes', () => {
  it('adds one group per flag, positioned at the flag, and removes it once the flag disappears', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Group>();
    syncFlagMeshes(scene, meshes, [homeFlag(0, 1), homeFlag(1, 2)]);
    expect(scene.children).toHaveLength(2);
    expect(meshes.get(0)?.position.x).toBe(10);
    syncFlagMeshes(scene, meshes, [homeFlag(1, 2)]);
    expect(scene.children).toHaveLength(1);
  });

  it('lifts a carried flag above the ground and hides its pole', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Group>();
    const carried: FlagSnapshotData = {
      id: 0, team: 1, state: 1, x: 3, y: 0, z: 3, carrierId: 5, returnInS: -1,
    };
    syncFlagMeshes(scene, meshes, [carried]);
    const group = meshes.get(0);
    expect(group?.position.y).toBeGreaterThan(0);
    expect(group?.getObjectByName('pole')?.visible).toBe(false);
  });

  it('fades a dropped flag over the spec\'s 2 s pre-return window, full opacity before it', () => {
    const scene = new THREE.Scene();
    const meshes = new Map<number, THREE.Group>();
    const farFromReturn: FlagSnapshotData = {
      id: 0, team: 1, state: 2, x: 0, y: 0, z: 0, carrierId: -1, returnInS: 10,
    };
    syncFlagMeshes(scene, meshes, [farFromReturn]);
    const cloth = meshes.get(0)?.getObjectByName('cloth') as THREE.Mesh;
    const material = cloth.material as THREE.MeshStandardMaterial;
    expect(material.opacity).toBe(1);
    const atReturn: FlagSnapshotData = { ...farFromReturn, returnInS: 0 };
    syncFlagMeshes(scene, meshes, [atReturn]);
    expect(material.opacity).toBeCloseTo(0.25, 2);
  });
});

describe('flagsFromWorld', () => {
  it('reads flag state directly from the sim store for single-player mode', () => {
    const flat: Heightfield = {
      gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
      heights: new Uint16Array(4),
    };
    const world = createWorld(flat, 1);
    createFlags(world, [
      { team: 1, position: { x: 0, y: 0, z: 0 } },
      { team: 2, position: { x: 100, y: 0, z: 0 } },
    ]);
    addPlayer(world, { x: 0, y: 0, z: 0 });
    const flags = flagsFromWorld(world);
    expect(flags).toHaveLength(2);
    expect(flags[1]).toMatchObject({ team: 2, x: 100 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- flag-view.test.ts`. Expect module resolution to fail for `./flag-view.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/flag-view.ts`:

```ts
import * as THREE from 'three';
import { FlagState, type World } from '@clans/sim';
import type { FlagSnapshotData } from '@clans/protocol';

const TEAM_COLOR: Record<number, number> = { 1: 0xdd3333, 2: 0x3366dd };
const CLOTH_SIZE = 0.6;
const POLE_HEIGHT = 1.8;
const CARRIED_LIFT = 2.0; // Ours: renders the flag over the carrier's head, no pole.
// Spec: "Flag return delay: 45 s after a drop, with a 2 s fade." The fade itself is not
// specified further, so this reads it as a warning fade on the cloth over the last 2 s
// before an unattended return, down to 25% opacity rather than fully invisible so the
// flag stays visible to a player closing in to reclaim it.
const RETURN_FADE_SECONDS = 2;
const RETURN_FADE_MIN_OPACITY = 0.25;

function createFlagMesh(team: number): THREE.Group {
  const group = new THREE.Group();
  const color = TEAM_COLOR[team] ?? 0xffffff;
  const cloth = new THREE.Mesh(
    new THREE.BoxGeometry(CLOTH_SIZE, CLOTH_SIZE, 0.05),
    new THREE.MeshStandardMaterial({ color, transparent: true }),
  );
  cloth.position.y = POLE_HEIGHT;
  cloth.name = 'cloth';
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, POLE_HEIGHT, 6),
    new THREE.MeshStandardMaterial({ color: 0x333333 }),
  );
  pole.position.y = POLE_HEIGHT / 2;
  pole.name = 'pole';
  group.add(pole, cloth);
  return group;
}

function pruneFlagMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Group>,
  liveIds: Set<number>,
): void {
  for (const id of [...meshes.keys()]) {
    if (liveIds.has(id)) continue;
    const group = meshes.get(id);
    if (group) scene.remove(group);
    meshes.delete(id);
  }
}

export function syncFlagMeshes(
  scene: THREE.Scene,
  meshes: Map<number, THREE.Group>,
  flags: FlagSnapshotData[],
): void {
  const liveIds = new Set(flags.map((f) => f.id));
  pruneFlagMeshes(scene, meshes, liveIds);
  for (const flag of flags) {
    let group = meshes.get(flag.id);
    if (!group) {
      group = createFlagMesh(flag.team);
      scene.add(group);
      meshes.set(flag.id, group);
    }
    const carried = flag.state === FlagState.Carried;
    group.position.set(flag.x, flag.y + (carried ? CARRIED_LIFT : 0), flag.z);
    const pole = group.getObjectByName('pole');
    if (pole) pole.visible = !carried;
    applyReturnFade(group, flag);
  }
}

function applyReturnFade(group: THREE.Group, flag: FlagSnapshotData): void {
  const cloth = group.getObjectByName('cloth') as THREE.Mesh | undefined;
  const material = cloth?.material as THREE.MeshStandardMaterial | undefined;
  if (!material) return;
  const fading = flag.returnInS >= 0 && flag.returnInS <= RETURN_FADE_SECONDS;
  if (!fading) {
    material.opacity = 1;
    return;
  }
  const t = flag.returnInS / RETURN_FADE_SECONDS;
  material.opacity = RETURN_FADE_MIN_OPACITY + (1 - RETURN_FADE_MIN_OPACITY) * t;
}

/** Single-player mode has no server snapshot; read the sim's own flag store directly. */
export function flagsFromWorld(world: World): FlagSnapshotData[] {
  const out: FlagSnapshotData[] = [];
  for (let id = 0; id < world.flags.state.length; id += 1) {
    const base = id * 3;
    out.push({
      id,
      team: world.flags.team[id] ?? 0,
      state: world.flags.state[id] ?? 0,
      x: world.flags.position[base] ?? 0,
      y: world.flags.position[base + 1] ?? 0,
      z: world.flags.position[base + 2] ?? 0,
      carrierId: world.flags.carrierId[id] ?? -1,
      returnInS: -1, // Single-player has no networked countdown; the sim's own tick governs it.
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/flag-view.ts packages/client/src/flag-view.test.ts
git commit -m "feat(client): flag view, box on a pole per team" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 12: Client — HUD (health, energy, ammo, weapon, scores, flag status, kill feed, respawn, match clock)

**Files:** Create `packages/client/src/hud.ts`, `packages/client/src/hud.test.ts`
**Interfaces:** Consumes `World`, `ammoIndex`, `FlagState`, `GameOverReason`, `LIGHT_ARMOR`, `WeaponId`, `FIXED_DT` (Tasks 1–4), `FlagSnapshotData`, `EventMessage`, `EventKind` (Task 6). Produces `type HudSource`, `type HudRow`, `describeHud(source): HudRow[]`, `describeKillFeed(source): string[]`, `createHud(container, initialSource)`. Depends on Task 9. **Runs in parallel with Task 10 and Task 11** — a third, disjoint file. Covers **failure matrix row 3**'s caller-visible message.

`HudSource` now also carries `timeRemainingS` and `gameOverReason` (Task 4's match clock,
relayed through Task 6's `WorldExtras` and Task 9's `NetClient`), so the HUD can show a
countdown and name why the match ended: a capture-limit win, a time-limit win for whichever
team was leading, or a tie.

The client vitest project runs with `environment: 'node'` (see `packages/client/vite.config.ts`), the
same reason `debug.ts` splits into a pure, tested `stats.ts` and an untested DOM-wiring function
exercised only by Playwright. `hud.ts` follows the same split: `describeHud`/`describeKillFeed`
are plain functions over data, unit tested here; `createHud`'s `document.createElement` calls are
exercised by Task 14's Playwright spec, not by Vitest.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/hud.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, GameOverReason, LIGHT_ARMOR, WeaponId, type Heightfield } from '@clans/sim';
import { EventKind, type EventMessage, type FlagSnapshotData } from '@clans/protocol';
import { describeHud, describeKillFeed, type HudSource } from './hud.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};

function baseSource(overrides: Partial<HudSource> = {}): HudSource {
  const world = createWorld(flat, 1);
  const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
  return {
    world, playerId, teamScores: [0, 0], flags: [], gameOver: false, winnerTeam: 0,
    timeRemainingS: 0, gameOverReason: GameOverReason.CaptureLimit, recentEvents: [],
    ...overrides,
  };
}
function rowsOf(source: HudSource): Record<string, string> {
  return Object.fromEntries(describeHud(source).map((row) => [row.id, row.text]));
}

describe('describeHud', () => {
  it('reports health and energy as percentages of the armor max', () => {
    const source = baseSource();
    source.world.players.damage[source.playerId] = LIGHT_ARMOR.maxDamage / 2;
    source.world.players.energy[source.playerId] = LIGHT_ARMOR.maxEnergy / 4;
    const rows = rowsOf(source);
    expect(rows['hud-health']).toBe('50%');
    expect(rows['hud-energy']).toBe('25%');
  });

  it('names the held weapon and reports infinite ammo as the infinity symbol', () => {
    const source = baseSource();
    source.world.players.weaponSlot[source.playerId] = WeaponId.LaserRifle;
    const rows = rowsOf(source);
    expect(rows['hud-weapon']).toBe('Laser Rifle');
    expect(rows['hud-ammo']).toBe('∞');
  });

  it('reports finite ammo as a count, e.g. a fresh Spinfusor loadout of 15', () => {
    const source = baseSource();
    source.world.players.weaponSlot[source.playerId] = WeaponId.Spinfusor;
    expect(rowsOf(source)['hud-ammo']).toBe(String(LIGHT_ARMOR.discAmmo));
  });

  it('shows the team scores line', () => {
    expect(rowsOf(baseSource({ teamScores: [300, 100] }))['hud-team-scores']).toBe(
      'Team 1: 300 — Team 2: 100',
    );
  });

  it('warns "your flag is not home" only while carrying the enemy flag with your own away (failure matrix row 3)', () => {
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 1, x: 0, y: 0, z: 0, carrierId: 99, returnInS: -1 }, // ours, stolen
      { id: 1, team: 2, state: 1, x: 0, y: 0, z: 0, carrierId: 0, returnInS: -1 }, // enemy, carried by us
    ];
    expect(rowsOf(baseSource({ flags }))['hud-flag-status']).toBe('your flag is not home');
  });

  it('shows a respawn countdown only while dead', () => {
    const source = baseSource();
    expect(rowsOf(source)['hud-respawn']).toBe('');
    source.world.players.alive[source.playerId] = 0;
    source.world.players.respawnAt[source.playerId] = 100;
    source.world.tick = 50;
    expect(rowsOf(source)['hud-respawn']).toBe('respawning in 2s');
  });

  it('names a capture-limit win plainly', () => {
    const source = baseSource({
      gameOver: true, winnerTeam: 2, gameOverReason: GameOverReason.CaptureLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Team 2 wins');
  });

  it('names a time-limit win with "on time"', () => {
    const source = baseSource({
      gameOver: true, winnerTeam: 1, gameOverReason: GameOverReason.TimeLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Team 1 wins on time');
  });

  it('names a time-limit tie as a tie, not a team win', () => {
    const source = baseSource({
      gameOver: true, winnerTeam: 0, gameOverReason: GameOverReason.TimeLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Tie game');
  });

  it('shows nothing before the game ends', () => {
    expect(rowsOf(baseSource())['hud-game-over']).toBe('');
  });

  it('formats the match clock as minutes:seconds, rounded up to the next second', () => {
    expect(rowsOf(baseSource({ timeRemainingS: 90 }))['hud-clock']).toBe('1:30');
    expect(rowsOf(baseSource({ timeRemainingS: 5.2 }))['hud-clock']).toBe('0:06');
    expect(rowsOf(baseSource({ timeRemainingS: -1 }))['hud-clock']).toBe('0:00'); // clamped
  });
});

describe('describeKillFeed', () => {
  it('formats a kill line and an environment-death line, keeping only the last 5', () => {
    const events: EventMessage[] = [
      { type: 6, kind: EventKind.PlayerKilled, a: 3, b: 9 },
      { type: 6, kind: EventKind.PlayerKilled, a: -1, b: 2 },
      { type: 6, kind: EventKind.FlagTouched, a: 1, b: 0 },
    ];
    expect(describeKillFeed(baseSource({ recentEvents: events }))).toEqual([
      'P3 eliminated P9',
      'P2 died',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- hud.test.ts`. Expect module resolution to fail for `./hud.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/hud.ts`:

```ts
import { FIXED_DT, FlagState, GameOverReason, LIGHT_ARMOR, WeaponId, ammoIndex, type World } from '@clans/sim';
import { EventKind, type EventMessage, type FlagSnapshotData } from '@clans/protocol';

export interface HudSource {
  world: World;
  playerId: number;
  teamScores: [number, number];
  flags: FlagSnapshotData[];
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number;
  gameOverReason: GameOverReason;
  recentEvents: EventMessage[];
}
export interface HudRow {
  id: string;
  text: string;
}

const WEAPON_NAME: Record<number, string> = {
  [WeaponId.Spinfusor]: 'Spinfusor',
  [WeaponId.Chaingun]: 'Chaingun',
  [WeaponId.Mortar]: 'Mortar',
  [WeaponId.LaserRifle]: 'Laser Rifle',
  [WeaponId.Blaster]: 'Blaster',
};
export const KILL_FEED_LINES = 5;

function percent(value: number, max: number): number {
  return max > 0 ? Math.round((value / max) * 100) : 0;
}

function healthRow(source: HudSource): HudRow {
  const health = LIGHT_ARMOR.maxDamage - (source.world.players.damage[source.playerId] ?? 0);
  return { id: 'hud-health', text: `${String(percent(health, LIGHT_ARMOR.maxDamage))}%` };
}

function energyRow(source: HudSource): HudRow {
  const energy = source.world.players.energy[source.playerId] ?? 0;
  return { id: 'hud-energy', text: `${String(percent(energy, LIGHT_ARMOR.maxEnergy))}%` };
}

function weaponAmmoRows(source: HudSource): HudRow[] {
  const players = source.world.players;
  const weaponSlot = (players.weaponSlot[source.playerId] ?? WeaponId.Blaster) as WeaponId;
  const ammo = players.ammo[ammoIndex(source.playerId, weaponSlot)] ?? 0;
  return [
    { id: 'hud-weapon', text: WEAPON_NAME[weaponSlot] ?? 'Unknown' },
    { id: 'hud-ammo', text: ammo < 0 ? '∞' : String(ammo) },
    { id: 'hud-grenades', text: String(players.grenades[source.playerId] ?? 0) },
  ];
}

function teamScoresRow(source: HudSource): HudRow {
  const [team1, team2] = source.teamScores;
  return { id: 'hud-team-scores', text: `Team 1: ${String(team1)} — Team 2: ${String(team2)}` };
}

/** Failure matrix row 3's caller-visible message: a carrier whose own flag is away cannot
 * capture, and the HUD is the only place this milestone surfaces why. */
function flagStatusRow(source: HudSource): HudRow {
  const team = source.world.players.team[source.playerId] ?? 0;
  const own = source.flags.find((flag) => flag.team === team);
  const enemy = source.flags.find((flag) => flag.team !== team && flag.team !== 0);
  const carryingEnemy = enemy?.carrierId === source.playerId;
  if (carryingEnemy && own && own.state !== FlagState.Home) {
    return { id: 'hud-flag-status', text: 'your flag is not home' };
  }
  if (carryingEnemy) return { id: 'hud-flag-status', text: 'carrying the enemy flag' };
  if (own && own.state !== FlagState.Home) return { id: 'hud-flag-status', text: 'your flag is away' };
  return { id: 'hud-flag-status', text: '' };
}

function respawnRow(source: HudSource): HudRow {
  const players = source.world.players;
  if (players.alive[source.playerId]) return { id: 'hud-respawn', text: '' };
  const ticksLeft = Math.max(0, (players.respawnAt[source.playerId] ?? 0) - source.world.tick);
  const secondsLeft = Math.ceil(ticksLeft * FIXED_DT);
  return { id: 'hud-respawn', text: `respawning in ${String(secondsLeft)}s` };
}

/** Names why the match ended: a capture-limit win always has a winner (only the time limit can
 * end in a tie, since a capture-limit win requires one specific team to reach `WIN_SCORE`). */
function gameOverRow(source: HudSource): HudRow {
  if (!source.gameOver) return { id: 'hud-game-over', text: '' };
  if (source.winnerTeam === 0) return { id: 'hud-game-over', text: 'Tie game' };
  const suffix = source.gameOverReason === GameOverReason.TimeLimit ? ' on time' : '';
  return { id: 'hud-game-over', text: `Team ${String(source.winnerTeam)} wins${suffix}` };
}

function clockRow(source: HudSource): HudRow {
  const totalSeconds = Math.max(0, Math.ceil(source.timeRemainingS));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return { id: 'hud-clock', text: `${String(minutes)}:${seconds.toString().padStart(2, '0')}` };
}

export function describeHud(source: HudSource): HudRow[] {
  return [
    healthRow(source),
    energyRow(source),
    ...weaponAmmoRows(source),
    teamScoresRow(source),
    flagStatusRow(source),
    respawnRow(source),
    clockRow(source),
    gameOverRow(source),
  ];
}

function killFeedLine(event: EventMessage): string | null {
  if (event.kind !== EventKind.PlayerKilled) return null;
  return event.a < 0 ? `P${String(event.b)} died` : `P${String(event.a)} eliminated P${String(event.b)}`;
}

export function describeKillFeed(source: HudSource): string[] {
  const lines: string[] = [];
  for (const event of source.recentEvents) {
    const line = killFeedLine(event);
    if (line) lines.push(line);
  }
  return lines.slice(-KILL_FEED_LINES);
}

/**
 * DOM wiring, exercised by Task 14's Playwright spec rather than Vitest (the client project
 * runs `environment: 'node'`; see `debug.ts` for the same split against `stats.ts`).
 */
export function createHud(
  container: HTMLElement,
  initialSource: HudSource,
): { update(source: HudSource): void } {
  const hud = document.createElement('div');
  hud.id = 'hud';
  container.appendChild(hud);
  const rows = new Map<string, HTMLElement>();
  for (const row of describeHud(initialSource)) {
    const el = document.createElement('div');
    el.id = row.id;
    hud.appendChild(el);
    rows.set(row.id, el);
  }
  const killFeed = document.createElement('div');
  killFeed.id = 'hud-kill-feed';
  hud.appendChild(killFeed);

  function update(source: HudSource): void {
    for (const row of describeHud(source)) {
      const el = rows.get(row.id);
      if (!el) continue;
      el.textContent = row.text;
      el.dataset['value'] = row.text;
    }
    killFeed.textContent = describeKillFeed(source).join(' | ');
    hud.dataset['ready'] = '1';
  }
  update(initialSource);
  return { update };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/hud.ts packages/client/src/hud.test.ts
git commit -m "feat(client): HUD — health, energy, ammo, scores, flag status, kill feed, respawn" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 13: Client — app wiring, F1 debug rows, lil-gui god mode, debug teleport hook

**Files:** Modify `packages/client/src/app.ts`, `packages/client/src/assets.ts`, `packages/client/src/debug.ts`, `packages/client/src/stats.ts`, `packages/client/src/stats.test.ts`, `packages/client/src/main.ts`
**Interfaces:** Consumes `createFlags` (Task 4), `NetClient.projectiles/flags/teamScores/gameOver/winnerTeam/recentEvents/setGodMode/playerId` (Task 9), `weapons-view.ts`, `flag-view.ts`, `hud.ts` exports (Tasks 10–12). Produces `App.net`, `App.godMode`, `App.debugTeleportToFlag(team)`, `activeProjectileCount`, `describeEvent`, extended `DebugRow`s, `window.__clansDebug`. Depends on Tasks 8, 10, 11, 12.

Single-player mode has no server to teleport through, so the debug teleport is a purely local
write to `world.players.position`, gated to a team's *current* flag position (read from
`world.flags`, not a hardcoded map coordinate) rather than raw x/y/z — that way it stays correct
regardless of where Katabatic's real flag stands end up after Task 5's asset extraction, and it
still works after the flag has been picked up, dropped, or returned. `window.__clansDebug` exists
purely for Task 14's Playwright spec; lil-gui stays the interactive control for `godMode`, since
driving a lil-gui panel from Playwright is exactly the kind of brittle DOM traversal a direct
hook avoids.

- [ ] **Step 1: Write the failing tests**

Change `packages/client/src/stats.test.ts` (full new contents):

```ts
import { addPlayer, createWorld, LIGHT_ARMOR, type Heightfield } from '@clans/sim';
import { describe, expect, it } from 'vitest';
import { EventKind } from '@clans/protocol';
import { activeProjectileCount, describeEvent, describePlayer } from './stats.js';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 8,
  originX: 0,
  originY: 0,
  originZ: 8,
  heightScale: 1,
  heights: new Uint16Array(4),
};

describe('describePlayer', () => {
  it('reports speed as the horizontal magnitude and flags as 0 or 1', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    world.players.velocity.set([3, 9, 4], id * 3);
    world.players.onGround[id] = 1;
    world.players.damage[id] = LIGHT_ARMOR.maxDamage / 2;
    const stats = {
      fps: 60,
      frameMs: 2.5,
      simMs: 0.4,
      ping: 42,
      bytesPerSecond: 900,
      packetLossEstimate: 0.05,
      predictionErrorM: 0.1,
      entityCount: 4,
    };
    const rows = Object.fromEntries(
      describePlayer(world, id, stats, { projectileCount: 2, lastEvent: 'none' }).map((row) => [row.id, row]),
    );
    expect(rows['debug-speed']?.value).toBe(5);
    expect(rows['debug-speed']?.text).toBe('5.0 m/s');
    expect(rows['debug-pos']?.text).toBe('1.0, 2.0, 3.0');
    expect(rows['debug-ground']?.value).toBe(1);
    expect(rows['debug-ski']?.value).toBe(0);
    expect(rows['debug-energy']?.value).toBe(60);
    expect(rows['debug-health']?.value).toBeCloseTo(LIGHT_ARMOR.maxDamage / 2);
    expect(rows['debug-fps']?.text).toBe('60');
    expect(rows['debug-ping']?.text).toBe('42 ms');
    expect(rows['debug-entities']?.value).toBe(4);
    expect(rows['debug-projectiles']?.value).toBe(2);
    expect(rows['debug-last-event']?.text).toBe('none');
  });
});

describe('activeProjectileCount', () => {
  it('counts only active projectile slots', () => {
    const world = createWorld(flat, 1);
    world.projectiles.count = 2;
    world.projectiles.active[0] = 1;
    expect(activeProjectileCount(world)).toBe(1);
  });
});

describe('describeEvent', () => {
  it('formats an event by its kind name and two ids', () => {
    expect(describeEvent({ type: 6, kind: EventKind.PlayerKilled, a: 3, b: 9 })).toBe(
      'PlayerKilled a=3 b=9',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- stats.test.ts`. Expect `describePlayer` to reject the 4th argument (or produce rows missing `debug-health`/`debug-projectiles`/`debug-last-event`), and `activeProjectileCount`/`describeEvent` to be missing.

- [ ] **Step 3: Write minimal implementation**

Change `packages/client/src/assets.ts`'s `ClientSceneData`, adding a field after `spawns`:

```ts
  spawns: Array<{
    name: string | null;
    team: number;
    position: [number, number, number];
    radius: number;
  }>;
  flagStands: Array<{ team: number; position: [number, number, number] }>;
}
```

(`packages/client/src/assets.test.ts` needs no change — it stubs `scene.json` as `{}` and never
reads `.scene.flagStands`.)

Change `packages/client/src/stats.ts` (full new contents):

```ts
import { LIGHT_ARMOR, type World } from '@clans/sim';
import { EventKind, type EventMessage } from '@clans/protocol';
import type { AppStats } from './app.js';

export interface DebugRow {
  id: string;
  label: string;
  text: string;
  value: number;
}
export interface DebugExtra {
  projectileCount: number;
  lastEvent: string;
}

const fixed = (value: number, digits = 1): string => value.toFixed(digits);

/** Reads a Vec3-shaped slice out of a flat Float64Array, defaulting missing components to 0. */
function vec3At(arr: Float64Array, base: number): [number, number, number] {
  return [arr[base] ?? 0, arr[base + 1] ?? 0, arr[base + 2] ?? 0];
}

export function activeProjectileCount(world: World): number {
  let count = 0;
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (world.projectiles.active[id]) count += 1;
  }
  return count;
}

export function describeEvent(event: EventMessage): string {
  return `${EventKind[event.kind] ?? String(event.kind)} a=${String(event.a)} b=${String(event.b)}`;
}

export function describePlayer(
  world: World,
  playerId: number,
  stats: AppStats,
  extra: DebugExtra,
): DebugRow[] {
  const base = playerId * 3;
  const p = world.players;
  const [x, y, z] = vec3At(p.position, base);
  const [vx, vy, vz] = vec3At(p.velocity, base);
  const speed = Math.hypot(vx, vz);
  const energy = p.energy[playerId] ?? 0;
  const health = LIGHT_ARMOR.maxDamage - (p.damage[playerId] ?? 0);
  const onGround = p.onGround[playerId] ?? 0;
  const ski = p.ski[playerId] ?? 0;
  return [
    { id: 'debug-fps', label: 'fps', text: fixed(stats.fps, 0), value: stats.fps },
    {
      id: 'debug-frame-ms',
      label: 'frame',
      text: `${fixed(stats.frameMs, 2)} ms`,
      value: stats.frameMs,
    },
    { id: 'debug-sim-ms', label: 'sim', text: `${fixed(stats.simMs, 2)} ms`, value: stats.simMs },
    { id: 'debug-tick', label: 'tick', text: String(world.tick), value: world.tick },
    { id: 'debug-pos', label: 'pos', text: `${fixed(x)}, ${fixed(y)}, ${fixed(z)}`, value: y },
    { id: 'debug-vel', label: 'vel', text: `${fixed(vx)}, ${fixed(vy)}, ${fixed(vz)}`, value: vy },
    { id: 'debug-speed', label: 'speed', text: `${fixed(speed)} m/s`, value: speed },
    { id: 'debug-energy', label: 'energy', text: fixed(energy), value: energy },
    { id: 'debug-health', label: 'health', text: fixed(health, 2), value: health },
    { id: 'debug-ground', label: 'ground', text: String(onGround), value: onGround },
    { id: 'debug-ski', label: 'ski', text: String(ski), value: ski },
    { id: 'debug-ping', label: 'ping', text: `${fixed(stats.ping, 0)} ms`, value: stats.ping },
    {
      id: 'debug-bps',
      label: 'snapshot B/s',
      text: fixed(stats.bytesPerSecond, 0),
      value: stats.bytesPerSecond,
    },
    {
      id: 'debug-loss',
      label: 'loss',
      text: `${fixed(stats.packetLossEstimate * 100, 1)}%`,
      value: stats.packetLossEstimate,
    },
    {
      id: 'debug-prediction-error',
      label: 'predict err',
      text: `${fixed(stats.predictionErrorM, 2)} m`,
      value: stats.predictionErrorM,
    },
    {
      id: 'debug-entities',
      label: 'entities',
      text: String(stats.entityCount),
      value: stats.entityCount,
    },
    {
      id: 'debug-projectiles',
      label: 'projectiles',
      text: String(extra.projectileCount),
      value: extra.projectileCount,
    },
    { id: 'debug-last-event', label: 'last event', text: extra.lastEvent, value: 0 },
  ];
}
```

Change `packages/client/src/debug.ts` (full new contents):

```ts
import GUI from 'lil-gui';
import type { App } from './app.js';
import { activeProjectileCount, describeEvent, describePlayer, type DebugExtra } from './stats.js';

function extraFor(app: App): DebugExtra {
  const lastEvent = app.net?.recentEvents.at(-1);
  return {
    projectileCount: app.net ? app.net.projectiles.length : activeProjectileCount(app.world),
    lastEvent: lastEvent ? describeEvent(lastEvent) : 'none',
  };
}

/**
 * F1 toggles the overlay. The stats element updates every frame even while hidden so
 * automated tests can read it through its data attributes.
 */
export function createDebug(app: App, container: HTMLElement): { update(): void } {
  const stats = document.createElement('div');
  stats.id = 'debug-stats';
  stats.hidden = true;
  container.appendChild(stats);
  const rows = new Map<string, HTMLElement>();
  for (const row of describePlayer(app.world, app.playerId, app.stats, extraFor(app))) {
    const line = document.createElement('div');
    line.id = row.id;
    line.dataset['label'] = row.label;
    stats.appendChild(line);
    rows.set(row.id, line);
  }

  const gui = new GUI({ title: 'Clans debug' });
  gui.add(app, 'timeScale', 0.1, 4, 0.1);
  gui.add(app, 'paused');
  gui.add({ step: () => (app.stepOnce = true) }, 'step').name('step once');
  gui.add(app, 'freeCam').onChange((on: boolean) => {
    if (on) app.freeCamPosition.copy(app.camera.position);
  });
  gui.add(app, 'godMode').onChange((enabled: boolean) => {
    app.net?.setGodMode(enabled);
  });
  gui.hide();

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F1') return;
    event.preventDefault();
    stats.hidden = !stats.hidden;
    if (stats.hidden) gui.hide();
    else gui.show();
  });

  return {
    update(): void {
      for (const row of describePlayer(app.world, app.playerId, app.stats, extraFor(app))) {
        const line = rows.get(row.id);
        if (!line) continue;
        line.textContent = `${row.label}: ${row.text}`;
        line.dataset['value'] = String(row.value);
      }
      stats.dataset['ready'] = '1';
    },
  };
}
```

Change `packages/client/src/app.ts`. Change the import block:

```ts
import * as THREE from 'three';
import {
  FIXED_DT,
  FIXED_TICK_MS,
  addPlayer,
  createFlags,
  createWorld,
  sampleTerrain,
  stepWorld,
  type Heightfield,
  type PlayerInput,
  type World,
} from '@clans/sim';
import type { EventMessage, ProjectileSnapshotData } from '@clans/protocol';
import { loadKatabatic, type KatabaticAssets } from './assets.js';
import { flagsFromWorld, syncFlagMeshes } from './flag-view.js';
import { createHud, type HudSource } from './hud.js';
import { Input } from './input.js';
import { advance, type Accumulator } from './loop.js';
import { NetClient } from './netclient.js';
import { RemoteBuffer, syncRemoteMeshes } from './remote.js';
import { addEnvironment, createTerrain } from './terrain.js';
import { WebSocketTransport } from './transport.js';
import {
  projectilesFromWorld,
  spawnExplosionsForExpired,
  spawnLaserBeams,
  syncProjectileMeshes,
  updateEffects,
  type Effect,
} from './weapons-view.js';
```

Change the `App` interface:

```ts
export interface App {
  world: World;
  playerId: number;
  net: NetClient | null;
  input: Input;
  assets: KatabaticAssets;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  timeScale: number;
  paused: boolean;
  stepOnce: boolean;
  freeCam: boolean;
  freeCamPosition: THREE.Vector3;
  godMode: boolean;
  stats: AppStats;
  frame(dtSeconds: number): void;
  debugTeleportToFlag(team: number): void;
}
```

Insert two new helpers right before `export async function createApp`, after `updateRemotes`'s closing brace:

```ts
function positionOfPlayer(
  world: World,
  net: NetClient | null,
  id: number,
): { x: number; y: number; z: number } | null {
  if (!net) return null;
  if (id === net.playerId) {
    return {
      x: world.players.position[0] ?? 0,
      y: world.players.position[1] ?? 0,
      z: world.players.position[2] ?? 0,
    };
  }
  const remote = net.remotePlayers.get(id);
  return remote ? { x: remote.x, y: remote.y, z: remote.z } : null;
}

function hudSourceFrom(world: World, playerId: number, net: NetClient | null): HudSource {
  return net
    ? {
        world,
        playerId,
        teamScores: net.teamScores,
        flags: net.flags,
        gameOver: net.gameOver,
        winnerTeam: net.winnerTeam,
        timeRemainingS: net.timeRemainingS,
        gameOverReason: net.gameOverReason,
        recentEvents: net.recentEvents,
      }
    : {
        world,
        playerId,
        teamScores: [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0],
        flags: flagsFromWorld(world),
        gameOver: world.gameOver,
        winnerTeam: world.winnerTeam,
        timeRemainingS: Math.max(0, (world.timeLimitTicks - world.tick) * FIXED_DT),
        gameOverReason: world.gameOverReason,
        recentEvents: [],
      };
}
```

Inside `createApp`, after the `playerId` line, seed single-player CTF from the loaded scene:

```ts
  const net = createNetClient(options.serverUrl, terrain);
  const world = net ? net.world : createWorld(terrain, 1);
  const playerId = net ? 0 : addPlayer(world, spawnPoint(assets, terrain));
  // Single-player has no server; seed CTF locally from the same scene data the server would
  // read (Task 7's loadKatabaticWorld does the equivalent for the networked path).
  if (!net) {
    createFlags(
      world,
      assets.scene.flagStands.map(({ team, position: [x, y, z] }) => ({ team, position: { x, y, z } })),
    );
  }
```

Add new tracking state and the HUD instance next to the existing ones:

```ts
  const acc: Accumulator = { remainder: 0 };
  const remoteMeshes = new Map<number, THREE.Mesh>();
  const remoteBuffers = new Map<number, RemoteBuffer>();
  const lastRemoteTick = { tick: -1 };
  const fps: FpsWindow = { windowStart: performance.now(), frames: 0 };
  const projectileMeshes = new Map<number, THREE.Mesh>();
  const previousProjectiles = new Map<number, ProjectileSnapshotData>();
  const flagMeshes = new Map<number, THREE.Group>();
  const effects: Effect[] = [];
  const seenEventCount = { count: 0 };
  const hud = createHud(document.body, hudSourceFrom(world, playerId, net));
```

Add `net`, `godMode`, and `debugTeleportToFlag` to the returned `app` object:

```ts
  const app: App = {
    world,
    playerId,
    net,
    input,
    assets,
    camera,
    scene,
    renderer,
    timeScale: 1,
    paused: false,
    stepOnce: false,
    freeCam: false,
    freeCamPosition: new THREE.Vector3(),
    godMode: false,
    stats: {
      fps: 0,
      frameMs: 0,
      simMs: 0,
      ping: 0,
      bytesPerSecond: 0,
      packetLossEstimate: 0,
      predictionErrorM: 0,
      entityCount: 1,
    },
    debugTeleportToFlag(team: number): void {
      const flagId = [...world.flags.team].findIndex((candidate) => candidate === team);
      if (flagId < 0) return;
      const base = flagId * 3;
      world.players.position.set(
        [
          world.flags.position[base] ?? 0,
          world.flags.position[base + 1] ?? 0,
          world.flags.position[base + 2] ?? 0,
        ],
        playerId * 3,
      );
    },
    frame(dtSeconds: number): void {
```

Change the body of `frame`, adding god mode and the weapons/flag/HUD sync between stepping the sim and placing the camera:

```ts
      const simStart = performance.now();
      if (net) {
        stepNetworked(
          net,
          app.stats,
          currentInput,
          steps,
          scene,
          remoteMeshes,
          remoteBuffers,
          lastRemoteTick,
        );
      } else {
        stepSinglePlayer(world, playerId, currentInput, steps);
        if (app.godMode) {
          world.players.damage[playerId] = 0;
          if (!world.players.alive[playerId]) {
            world.players.alive[playerId] = 1;
            world.players.respawnAt[playerId] = -1;
          }
        }
      }
      app.stats.simMs = performance.now() - simStart;

      const projectiles = net ? net.projectiles : projectilesFromWorld(world);
      spawnExplosionsForExpired(scene, effects, previousProjectiles, projectiles);
      syncProjectileMeshes(scene, projectileMeshes, projectiles);
      previousProjectiles.clear();
      for (const projectile of projectiles) previousProjectiles.set(projectile.id, projectile);

      syncFlagMeshes(scene, flagMeshes, net ? net.flags : flagsFromWorld(world));

      const allEvents: EventMessage[] = net ? net.recentEvents : [];
      const newEvents = allEvents.slice(seenEventCount.count);
      seenEventCount.count = allEvents.length;
      spawnLaserBeams(scene, effects, newEvents, (id) => positionOfPlayer(world, net, id));
      updateEffects(scene, effects, dtSeconds);

      hud.update(hudSourceFrom(world, playerId, net));

      if (app.freeCam) moveFreeCam(app, dtSeconds);
      placeCamera(app, sky);
      renderer.render(scene, camera);
      app.stats.frameMs = performance.now() - frameStart;
      updateFps(app, frameStart, fps);
    },
  };
  return app;
}
```

Change `packages/client/src/main.ts` (full new contents):

```ts
import { createApp } from './app.js';
import { createDebug } from './debug.js';

declare global {
  interface Window {
    __clansDebug?: { teleportToFlag(team: number): void };
  }
}

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

const serverUrl = new URLSearchParams(location.search).get('server');
const app = await createApp(container, { serverUrl });
window.__clansDebug = { teleportToFlag: (team) => app.debugTeleportToFlag(team) };
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

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`. Playwright is not run here — that is Task 14.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/app.ts packages/client/src/assets.ts packages/client/src/debug.ts packages/client/src/stats.ts packages/client/src/stats.test.ts packages/client/src/main.ts
git commit -m "feat(client): wire weapons/flags/HUD into the frame loop, F1 rows, god mode, debug teleport" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 14: Playwright — fire the Spinfusor, capture a flag with the debug teleport

**Files:** Create `e2e/weapons.spec.ts`
**Interfaces:** Consumes `#debug-stats`, `#debug-projectiles` (Task 13), `#hud`, `#hud-flag-status`, `#hud-team-scores` (Task 12), `window.__clansDebug.teleportToFlag` (Task 13). Depends on Task 13. No production code changes — this is the first spec that exercises Tasks 7–13 together as a full stack, the same role `e2e/server.spec.ts` played for M2.

- [ ] **Step 1: Write the failing test**

Create `e2e/weapons.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __clansDebug?: { teleportToFlag(team: number): void };
  }
}

test('fires a Spinfusor at terrain and sees the projectile count rise then fall', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });

  // Digit1 selects the Spinfusor; held for the whole sequence so the very first simulated
  // tick already reads slot 1, before the mouse fires.
  await page.keyboard.down('Digit1');
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.keyboard.up('Digit1');

  await expect
    .poll(
      async () => Number(await page.locator('#debug-projectiles').getAttribute('data-value')),
      { timeout: 2_000 },
    )
    .toBeGreaterThan(0);

  // The disc detonates on terrain contact, or at worst at its 5 s lifetime (Task 3) — either
  // way the count must come back down.
  await expect
    .poll(
      async () => Number(await page.locator('#debug-projectiles').getAttribute('data-value')),
      { timeout: 6_000 },
    )
    .toBe(0);
});

test('captures a flag using the debug teleport hook', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#debug-stats[data-ready="1"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator('#hud[data-ready="1"]').waitFor({ state: 'attached', timeout: 30_000 });

  const before = await page.locator('#hud-team-scores').getAttribute('data-value');

  // Single-player always spawns on team 1 (packages/client/src/app.ts's spawnPoint picks the
  // team 1 spawn); team 2 holds the enemy flag to steal.
  await page.evaluate(() => window.__clansDebug?.teleportToFlag(2));
  await expect
    .poll(async () => page.locator('#hud-flag-status').getAttribute('data-value'), {
      timeout: 2_000,
    })
    .toBe('carrying the enemy flag');

  // Home, with the enemy flag in hand and our own flag untouched: this captures.
  await page.evaluate(() => window.__clansDebug?.teleportToFlag(1));
  await expect
    .poll(async () => page.locator('#hud-team-scores').getAttribute('data-value'), {
      timeout: 2_000,
    })
    .not.toBe(before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm e2e -- weapons.spec.ts`. If Tasks 7–13 wired everything correctly this may already pass on
the first run — that is a valid outcome for an integration-only task with no new production code.
Treat a failure as a real wiring gap between two of those tasks (a missing DOM id, an
unregistered `window.__clansDebug`, a slot/fire race) and fix it in whichever file it implicates,
not in this spec.

- [ ] **Step 3: Fix any wiring gap the run exposes**

No new production file is expected here. If Step 2 fails, the fix is a small correction inside
one of Tasks 7–13's files (for example: a HUD row id typo, or `window.__clansDebug` not surviving
a page navigation). Re-run Step 2 after each fix.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm e2e -- weapons.spec.ts && pnpm e2e` (the full suite, to confirm `movement.spec.ts` and
`server.spec.ts` still pass unchanged).

- [ ] **Step 5: Commit**

```sh
git add e2e/weapons.spec.ts
git commit -m "test(e2e): fire the Spinfusor and capture a flag via the debug teleport" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 15: Docs — README and NOTICE

**Files:** Modify `README.md`, `NOTICE.md`
**Interfaces:** None — documentation only. Depends on Task 14.

- [ ] **Step 1: Write the failing check**

There is no automated test for prose. The check is manual: read `README.md` end to end as a new
contributor would, and confirm every command and keybind it documents actually exists after
Tasks 1–14.

- [ ] **Step 2: Confirm the gap**

`README.md` still says "milestone 2 of 7" and its keybind table has no fire, weapon-slot, or
grenade row. `NOTICE.md` doesn't say whether milestone 3 added new source files (it didn't, but a
reader has no way to know that without checking).

- [ ] **Step 3: Write the update**

Change `README.md`'s status line:

```md
Status: milestone 3 of 7 (weapons, damage, CTF, respawn, HUD). See
`docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for what each
milestone ships.
```

Change the keybind table:

```md
| Key | Action |
|---|---|
| W A S D | move |
| Space | jump, hold to ski |
| Right mouse | jet |
| Left mouse | fire the held weapon |
| 1 2 3 4 5 | Spinfusor, Chaingun, Mortar, Laser Rifle, Blaster |
| G | throw a hand grenade |
| F1 | debug overlay (stats, time scale, pause, step, free cam, god mode) |
```

Change the networked-play paragraph:

```md
Press F1 in a networked session for ping, snapshot bytes per second, packet loss estimate,
prediction error, entity count, the active projectile count, and the most recent kill-feed
event. The same F1 panel's lil-gui god-mode checkbox makes the local player invulnerable —
networked, it toggles server-side via a `God` message; single-player, it zeroes damage locally
every tick.
```

Change the package layout bullets:

```md
- `packages/sim`: the game simulation. Pure TypeScript, no DOM or Node imports, so it runs in the browser today and on the server. Health, fall damage, respawn, four weapons plus grenades, a projectile store, and CTF flags and scoring all live here.
- `packages/assets`: build-time pipeline that turns Tribes 2 data files into `assets/out/`.
- `packages/client`: Three.js renderer, input, projectile/explosion/laser-beam and flag rendering, the HUD, debug overlay.
- `packages/protocol`: binary wire format. Message schemas (including `Event` and `God`), full and delta snapshots with projectiles/flags/scores sent in full each tick, a world hash for tests.
- `packages/server`: Node, `ws`, 32 ms catch-up tick loop, per-client input sessions, snapshots delta-compressed against the client's last acked snapshot, lag-compensated hit detection for the Chaingun and Laser Rifle, respawn, and CTF.
- `packages/bots`: placeholder until milestone 6. The server's `--bots` are idle stand-ins.
```

Change `NOTICE.md`, adding one sentence after "Later milestones add converted `.glb` interiors and shapes.":

```md
Later milestones add converted `.glb` interiors and shapes. Milestone 3 adds no new source
files: its `Flag` and `ExteriorFlagStand` objects come from the same `Katabatic.mis` already
credited above.
```

- [ ] **Step 4: Confirm the update**

Re-read both files end to end. Confirm the milestone number, every keybind, and every package
bullet match what Tasks 1–14 actually built.

- [ ] **Step 5: Commit**

```sh
git add README.md NOTICE.md
git commit -m "docs: milestone 3 status, weapon keybinds, package layout" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

## Self-review

Checked while writing Tasks 7–15 and again after finishing them:

- **Spec coverage.** Every M3-relevant subsection of the spec (Weapons and damage, CTF and
  flags, the CTF numbers table, the relevant Networking bullets, and the M3-tagged rows of the
  Testing section) maps to a task. The CTF section's match-length sentence — "Match ends at 8
  captures or at a configurable time limit (our default: 25 minutes; T2's value is not
  verified), whichever comes first" — is now implemented, not just cited: Task 4 adds the match
  clock (`timeLimitTicks`, `GameOverReason`, `checkTimeLimit`) with tests for a time-limit win, a
  tie, and a capture-limit win landing on the same tick; Task 6 carries `timeRemainingS` and
  `gameOverReason` on the wire; Task 7 computes them server-side; Task 9 exposes them on
  `NetClient`; Task 12's HUD shows the clock and names why the match ended. The Networking
  section's relevance filtering (400 m full-rate, low-rate beyond it) is still not implemented —
  every entity is sent in full to every client this milestone, consistent with the Global
  Constraints' existing "cheap at these counts" framing but never stated as a deliberate cut
  before now. Tracked as its own issue rather than added to this plan.
- **Type consistency.** Traced every shared identifier introduced in Tasks 1–6 through its uses
  in Tasks 7–15: `WeaponId`, `WeaponData`'s optional fields, `FireEvent`, `EventKind`'s exact
  `a`/`b` semantics per kind, `PlayerSnapshotData.health`/`weaponSlot`, `ProjectileSnapshotData`
  and `FlagSnapshotData`'s field names, and `world.flags`'s empty-until-`createFlags` shape all
  match at every call site across the server, protocol test fixtures, and the five new client
  files.
- **Placeholder scan.** Grepped the finished file for `TBD`, `TODO`, `FIXME`, "similar to Task",
  and "add validation" — no hits. Every task has a complete code block for every step; no step
  defers work to "later" or to another task's file without naming exactly what changes.
- **Inconsistencies found and fixed, disclosed here per the brief:**
  1. `world.pendingDeaths` (Task 1) carried only the victim id. The kill feed's wire message
     needs the attacker id too, and there is no other way to recover it once a shot's projectile
     has traveled for several ticks before landing the kill. Task 7 widens it to
     `Array<{ id, attackerId }>`, with matching one-line fixes in `damage.ts`, `damage.test.ts`,
     and `flags.ts`'s only reader.
  2. The dependency graph's Task 14 line said "depends on Task 7 and Task 13," anticipating an
     e2e spec that spawns a real server. Task 14 instead runs single-player and reads live flag
     positions through a debug hook, so it never touches Task 7's server at all — the graph line
     now says "depends on Task 13 only," with the reasoning inline.
  3. The File structure section already said Task 13's F1 overlay gains a "health" row; my first
     draft only added the two the user's brief named (projectiles, events) and missed it. Fixed:
     `stats.ts` now exports a `debug-health` row too, with a matching `stats.test.ts` assertion.
- **`hashWorld` now covers the full state, not just players.** It previously mixed only player
  fields, so the spec's generic "hash of world state matches across encode and decode"
  Testing-section claim held only for players. Task 4 extends `hashWorld` itself (the file is
  already Task 1/2's; Task 4 becomes its third toucher, updating the File structure and
  dependency-graph bullets to say so) to mix projectiles, flags, team scores, game-over state,
  and the match clock. `world.timeLimitTicks` — the raw tick threshold — is deliberately excluded
  from the mix: the wire only ever carries the derived `timeRemainingS`, never that constant, so
  hashing it would make the hash unreproducible after a real network round trip; `world.tick`
  already carries the "how far into the match" signal the hash needs, and it is fully
  reconstructable from the snapshot header. `hash.test.ts` gets one "changes when X changes" test
  per new field, plus a same-CTF-state equality test; Task 6's snapshot round-trip test gains a
  sibling that builds a second world from a decoded snapshot's players *and* extras and asserts
  the hashes match, proving the extended hash is stable across the actual wire round trip.
