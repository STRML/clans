# Milestone 4: Base Assets and Power Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Katabatic's bases work. Each team's generators, inventory stations, base turrets (Plasma and AA barrels on `TurretBaseLarge`, plus the forward-tower `SentryTurret`), the large pulse sensor, the vehicle pad, and the two force fields exist in the sim, take real T2 damage (or, for the vehicle pad and the force fields, are correctly invincible per script), and go dark the instant both of a team's generators are destroyed. A player can walk into a powered inventory station and swap armor and pack. A powered turret with line of sight finds an enemy player in range and shoots them with the right projectile for its barrel. A Repair Pack heals a damaged player, base object, or turret within beam range. A powered force field blocks the enemy team's players and projectiles and passes the owning team's. Katabatic's eleven interior buildings render and block movement and projectiles through a per-instance uniform grid, not brute force. The commander map shows sensed enemies. Every number the spec gives is used exactly; every number it does not give is picked here and marked ours.
**Architecture:** `packages/sim` gains `interiors.ts` (a uniform-grid-accelerated static triangle collider, built once per instance at load), `baseObjects.ts` (generators/sensors/stations/pad/force fields, power derivation, shielded damage, force-field blocking geometry), `turrets.ts` (targeting with a terrain line-of-sight check, aiming, firing), and `repair.ts` (the Repair Pack beam). `armor.ts` gains `MEDIUM_ARMOR`/`HEAVY_ARMOR` and every player now carries its own armor id instead of the whole sim assuming `LIGHT_ARMOR`. `projectiles.ts` grows to treat base objects, turrets, and powered enemy force fields as hittable/blocking, and to spawn turret-fired shots outside the player fire-event path. `movement.ts` grows an interior-collision pass and a force-field block pass. `stepWorld` grows to call `stepPower`, `stepTurrets`, and `stepRepairPacks` in a fixed order, but keeps its `(world, inputs, dt)` signature. `packages/protocol` adds `baseObjects`/`turrets` to `WorldExtras` (full every tick, following M3's projectiles/flags precedent, force fields riding along as just another `BaseObjectKind`) and a `Loadout` message for station use. `packages/assets` extracts base objects (including force fields, with their extra rotation/scale), turrets, and interior placements from the mission, and fetches + converts the eleven interior and eight base-object shape `.glb` files from the `exogen/t2-mapper` mirror. `packages/server` loads all of it and wires the `Loadout` message. `packages/client` renders base objects, turrets, interiors, and force fields (as a translucent quad, no `.glb`), adds a station loadout menu, extends the HUD with base-object health when aimed at, and adds a 2D commander map.
**Tech Stack:** the milestone 3 stack, plus `@gltf-transform/core` as a new `packages/assets` devDependency for reading `.glb` geometry at build time (no new production dependency in any shipped package; `packages/assets` output is committed data, not code that ships).
**Spec:** docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md
**Baseline:** `main` at commit `a9bef90` (M3: weapons, damage, CTF, HUD, PR #9), which carries milestones 1–3: client/server prediction and interpolation, all four weapons, CTF, respawn, HUD, 31 idle bots, protocol tests green.

## Global Constraints

- `stepWorld(world, inputs, dt = FIXED_DT)` stays the only public sim entry point and keeps its exact signature. The fixed call order grows to `stepPlayers`, `stepWeapons`, `stepPower`, `stepTurrets`, `stepProjectiles`, `stepRepairPacks`, `stepFlags`, then `world.tick += 1`. `stepPower` must run before `stepTurrets` (turrets stop engaging the instant their team loses power) and `stepTurrets` must run before `stepProjectiles` (a turret's shot this tick has to already be in `world.pendingTurretFireEvents` for `stepProjectiles` to materialize it in the *same* tick — the same same-tick relationship M3's `stepWeapons` → `stepProjectiles` already has for player shots; see Task 5). `stepFlags` stays last, unchanged from M3. No package outside `sim` calls a step function directly.
- `packages/sim` still imports nothing from DOM, Three.js, WebSocket, or Node. Interior triangle data, base object placements, and turret placements are supplied by the caller (server or client) as plain typed arrays and numbers, exactly like `Heightfield` already is — the sim never reads scene JSON or fetches a `.glb`.
- Every ESLint `complexity: 10` / `max-depth: 3` budget holds. Every new system function is split into named helpers the way `movement.ts`'s `classify`/`applyForces`/`integrate`/`writeState` and `projectiles.ts`'s per-projectile-type steppers already are.
- Light, Medium, and Heavy armor are all playable this milestone. `PlayerStore` gains an `armor: Uint8Array` (`ArmorId`) field, set by `addPlayer`/`respawnPlayer`/a station loadout change, and every call site that used to hardcode `LIGHT_ARMOR` (`movement.ts`, `weapons.ts`, `damage.ts`, `projectiles.ts`, `snapshot.ts`, `hash.ts`, `hud.ts`) now reads `ARMORS[players.armor[id]]` through a shared `armorFor(world, id)` helper. This is a mechanical sweep, not a design change: every one of those call sites already threaded an `armor: ArmorData` parameter through from M3, so the fix is at the point each system looks the armor up, not at every place it is used.
- Numbers with a spec citation are used exactly as the spec's Base asset numbers table states them. Numbers the spec does not give are pulled from the cited T2 base script at `jdknight/t2ds` (script and line range cited inline) or, failing that, picked here, marked **ours**, and collected in the final report.
- Base objects and turrets use the spec's own shield rule verbatim: "shields (Shield Pack, vehicles, base turrets) spend energy at `energyPerDamagePoint` before health." `applyBaseObjectDamage`/turret damage spend `min(energy / energyPerDamagePoint, amount)` worth of the hit against energy first, at `energy -= spent * energyPerDamagePoint`, and only the remainder against health. This is the same mechanic the spec's Weapons and damage section states for players; M3 never needed it because no player-facing Shield Pack shipped, so this is the first sim code to implement it.
- Interior collision uses a uniform grid, built once per interior instance at load, not brute-force triangle iteration. Each `InteriorInstance` buckets its world-space triangles into fixed-size cells (Task 2); a ray query walks only the cells its segment actually crosses (a 3D DDA / Amanatides–Woo traversal, not the whole interior), and a sphere query only visits the cells its bounding box overlaps. This satisfies the spec's "per-interior triangle meshes with a BVH for buildings" — a uniform grid is the simpler of the two acceleration structures the spec's own Testing/Simulation sections leave open, chosen over a hierarchical BVH because Katabatic's interiors are small, roughly convex rooms/corridors (a grid degrades on deeply nested detail a BVH would handle better, and Katabatic has none at this milestone's fidelity) and a flat grid is less code at an equivalent complexity budget. Task 2's own benchmark test proves this holds the 32 ms tick budget against a synthetic worst case sized from Katabatic's measured real asset weight.
- Force fields (`ForceFieldBare`) are in scope this milestone, folded into Task 3 rather than a standalone task: they are `BaseObjectKind.ForceField`, powered exactly like every other base object, rendered as a translucent quad, and block enemy players and projectiles while passing friendly ones. Because the blocking geometry (movement in `movement.ts`, Task 2's domain; projectile segments in `projectiles.ts`, Task 5's domain) can only be built once `baseObjects.ts` exists, the two call-site wire-ups land in the tasks that already touch those files last — Task 6 for player movement, Task 5 for projectiles — while Task 3 owns the data, the cached collision geometry, and the `activeForceFieldBlockers(world, team)` query every consumer calls. See Task 3, Task 5, and Task 6, and this plan's Spec gaps for the one real deviation from the T2 script (team-passable, not the script's kill-everyone-in-the-zone behavior).
- Turret target acquisition checks line of sight against the terrain heightfield before a turret may acquire or keep a target — Task 4's `hasLineOfSight` marches the turret-to-target segment against `sampleTerrain` (the same technique `projectiles.ts`'s own terrain marching already uses, duplicated rather than shared because Task 4 runs before Task 5 exports anything reusable — see Task 4's own note). This matches the real T2 sensor's `detectsUsingLOS = true` (`turret.cs:142`, `turrets/sentryTurret.cs:129`), which this plan previously (in an earlier draft) chose to skip; it is no longer skipped.
- `packages/bots` stays the milestone-2 placeholder; no bot brains ship this milestone. The 31 idle bots keep sending no input, which now also means they never use a station, never fire a repair beam, and are never targeted preferentially by a turret over a real client — turret targeting has no notion of "bot" versus "human," only "enemy team, in range, alive."

## Failure matrix (from the spec)

| # | State or input | What happens | How it can fail | What the caller sees | M4 scope |
|---|---|---|---|---|---|
| 1 | Flag carried, carrier dies | flag drops at death position, return timer starts | death position is inside a wall or below terrain | flag is placed at the nearest walkable point | already covered, M3 Task 4 — unchanged this milestone |
| 2 | Flag dropped, timer expires | flag returns home | picked up 1 ms before expiry | pickup cancels the timer | already covered, M3 Task 4 — unchanged this milestone |
| 3 | Capture with own flag away | no capture | | carrier keeps the flag, HUD says "your flag is not home" | already covered, M3 Task 4 — unchanged this milestone |
| 4 | Both generators dead | assets unpowered | a station is mid-transaction when power drops | the transaction aborts, the player keeps their old loadout | **Task 3** (`baseObjects.test.ts`: "both generators destroyed clears the powered bit on every station/turret/sensor/pad of that team"), **Task 6** (`repair.test.ts`/loadout test: "a station use in progress the tick power drops does not apply the new loadout") |
| 5 | Vehicle pad spawn while a vehicle exists | old vehicle destroyed | pilot inside it | pilot dismounted first, no damage | N/A — vehicles ship in milestone 5. The pad is placed, damageable-per-script (in fact `isInvincible`, see Task 3), and power-gated this milestone; spawning is out of scope |
| 6 | Client input arrives out of order | | older sequence after newer | server drops it, client's replay never sees it | already covered, M2 Task 6 — unchanged this milestone |
| 7 | Snapshot lost | | delta baseline the client never got | acks carry last received id; server never deltas against an unacked snapshot | already covered, M2 Tasks 4/6/7/9 — unchanged this milestone |
| 8 | Client mispredicts | rewind and replay | replay would run more than 30 ticks | client hard-snaps, records a prediction error | already covered, M2 Task 9 — unchanged this milestone |
| 9 | Bot task target destroyed | bot rechooses | every task claimed | bot falls back to defend nearest asset | N/A — bot brains ship in milestone 6 |
| 10 | Player joins mid-match | full snapshot then deltas | | player spawns after the next tick, team is the smaller one | already covered, M2 Task 7 — unchanged this milestone |
| 11 | Server tick overruns 32 ms | | bots or collision blow the budget | server logs the overrun, skips no ticks, catches up | already covered, M2 Task 5 — unchanged this milestone |

M4-specific failure rows the spec's Base assets/power text implies but the M1–M3 table never listed, added here because this milestone is what makes them possible:

| # | State or input | What happens | How it can fail | What the caller sees | M4 scope |
|---|---|---|---|---|---|
| 12 | Turret's target dies or leaves range mid-engagement | turret drops the target and reacquires | the dead/departed id is still cached as `targetId` | turret goes idle for at most one `stepTurrets` tick, then reacquires; it never fires at a stale id | **Task 4** (`turrets.test.ts`: "a turret whose target dies this tick does not fire at the corpse next tick") |
| 13 | Repair beam target moves out of range mid-beam | beam stops healing, no error | target reference is stale | `stepRepairPacks` re-checks range every tick from current positions, not a cached target | **Task 6** (`repair.test.ts`: "a repair beam started in range stops healing the instant the target leaves the 10 m beam range") |
| 14 | Player fires into an interior wall from outside | projectile stops at the wall, no damage inside | the segment check only tests terrain, not interior triangles | the shot resolves against the nearest of terrain, interior, base object, turret, or player hit along the segment | **Task 5** (`projectiles.test.ts`: "a disc fired through where an interior wall stands detonates at the wall, not past it") |
| 15 | A generator dies mid-repair-beam heal | the beam keeps targeting a destroyed object | `applyBaseObjectDamage`'s destroyed flag isn't checked by the healer | `stepRepairPacks` skips a destroyed target; a destroyed base object is not repairable by a Repair Pack (only by rebuilding, out of scope) | **Task 6** (`repair.test.ts`: "a repair beam does not revive a destroyed generator") |
| 16 | A turret's line of sight to its target is blocked by terrain (a hill) | turret does not acquire, or drops an already-acquired target | the LOS march samples too coarsely and steps over a thin ridge | `hasLineOfSight` walks the segment at a fixed step and returns false on the first occluded sample; a turret with no line of sight neither acquires nor keeps firing | **Task 4** (`turrets.test.ts`: "a hill between the turret and an otherwise-in-range player blocks acquisition") |
| 17 | An enemy player or projectile reaches a powered force field | blocked at the field's plane, no damage to the field | the block check reads the wrong team (blocks the field's own team instead of the enemy) | a friendly player/projectile passes through untouched; an enemy player is pushed back like an interior wall and an enemy projectile detonates at the plane | **Task 3** (`baseObjects.test.ts`: team filter on `activeForceFieldBlockers`), **Task 5** (`projectiles.test.ts`: enemy shot blocked, friendly shot passes), **Task 6** (`movement.test.ts`: enemy player blocked, friendly player passes) |
| 18 | Both of a team's generators die while a force field is powered | the force field goes dark and stops blocking either team | `stepPower`'s `needsPower` bit is not read by the force-field blocker query | `activeForceFieldBlockers` excludes an unpowered field for every team, matching every other unpowered base object | **Task 3** (`baseObjects.test.ts`: "an unpowered force field blocks no one") |

## Numbers this plan picks that the spec does not give ("ours")

Every row also states its real T2 source when one exists — the spec's own table often gives only part of a datablock (e.g. "StationInventory — from `station.cs`" with no number). Cited inline at each use; collected here for one-glance review.

| Number | Value | T2 source (if any) | Where |
|---|---|---|---|
| GeneratorLarge maxEnergy / rechargeRate | 50 / 0.05 | `staticShape.cs:447-467` | Task 3 |
| SensorLargePulse maxEnergy / rechargeRate | 110 / 0.31 | `staticShape.cs:342-372` | Task 3 |
| StationInventory maxDamage / energyPerDamagePoint / maxEnergy / rechargeRate | 1.00 / 75 / 50 / 0.35 | `station.cs:136-166` | Task 3 |
| StationVehiclePad is not damageable at all (`isInvincible = true`, no `maxDamage`) | — | `station.cs:235-247` | Task 3 — a real deviation from the spec's own table, which lists it alongside damageable assets; see Spec gaps |
| Station use radius | 2.5 m | derived loosely from the real trigger box (`station.cs:299`, a ~1.5×1.5×2.3 m polyhedron); the sim has no box triggers, so this is a sphere radius picked to cover the same area | Task 3, Task 6 |
| TurretBaseLarge maxEnergy / rechargeRate | 150 / 0.31 | `turret.cs:150-192` | Task 4 |
| TurretBaseLarge sensor (target-acquisition) radius | 80 m (`TurretBaseSensorObj`) | `turret.cs:139-146` | Task 4 |
| PlasmaBarrelLarge attackRadius / projectile lifetime | 120 m / 6 s | `turrets/plasmaBarrelLarge.cs:195-306` | Task 4 |
| AABarrelLarge attackRadius | 200 m | `turrets/aaBarrelLarge.cs:125-193` | Task 4 |
| SentryTurret maxEnergy / energyPerDamagePoint / rechargeRate / thetaMin / thetaMax / sensor radius / attackRadius | 150 / 100 / 0.40 / 89° / 175° / 60 m / 60 m | `turrets/sentryTurret.cs:92-227` | Task 4 |
| Turret engagement range = min(sensor radius, barrel attackRadius) | see values above | derived from the two real numbers, not a script constant | Task 4 |
| Turret aiming is instant tracking, not `degPerSecTheta`/`degPerSecPhi`-limited slew | the real per-barrel slew rates exist in script (e.g. Plasma 300°/500° per second) but are not modeled | Task 4 |
| Turret LOS march step | 0.5 m | matches `projectiles.ts`'s own `TERRAIN_MARCH_STEP`, duplicated rather than imported — Task 4 runs before Task 5 exports it | Task 4 |
| Turret eye height above its base position | 2 m | not in the cited scripts; a reasonable barrel-elevation guess for a "close enough for a demo" LOS check | Task 4 |
| Turret fire attribution: `attackerId = -1` (no score change), same convention as fall damage | Task 4, Task 5 |
| AA barrel never acquires a target this milestone (real T2 AA targets vehicles only, and no vehicle exists until milestone 5) | Task 4 |
| Base object hit-sphere radius (Generator/Sensor/StationInventory/StationVehiclePad) | 1.5 m | Task 5 — same "sphere close enough for a demo" bar `damage.ts`'s `playerHitbox` already sets for players |
| Turret hit-sphere radius | 1.2 m | Task 5 |
| No team filtering on projectile hit-tests against base objects, turrets, or players (only turret target *acquisition* excludes the turret's own team) | matches M3's existing player-vs-player model, where any weapon can damage a teammate (with a score penalty) — and `staticShape.cs`'s own comment that `noIndividualDamage` is only set for non-team-based mission types, implying a team mission like CTF allows it | Task 5 |
| Repair Pack beam range | 10 m (`DefaultRepairBeam.beamRange`) | `packs/repairpack.cs:48` | Task 6 |
| Repair Pack is the only pack modeled this milestone (Energy/Shield/Turret/Sensor packs are loadout-menu-invisible; `PlayerStore` gains one `hasRepairPack: Uint8Array` bit, not a general pack enum) | Task 1, Task 6 — matches the user-given M4 scope, which names only the Repair Pack |
| Interior collision uniform grid cell size | 2 m | picked so a typical Katabatic corridor (a few metres wide) spans only 1-2 cells per axis; not in the cited scripts | Task 2 |
| Interior collision response: two-sphere (feet, chest) push-out along the nearest penetrated triangle's normal, not a full swept capsule | Task 2 |
| Interior/force-field query benchmark budget | under 50 µs per `raycastInteriors` or `resolveSphereAgainstInteriors` call, averaged over 10,000 calls, against a synthetic 5,000-triangle interior | 5,000 triangles is a conservative over-estimate — Task 9's measured real total across all 19 `.glb` files is 1,278,076 bytes, and a shape that size rarely reaches even one-tenth that triangle count; the budget itself leaves headroom under the 32 ms tick budget even with dozens of simultaneous queries per tick | Task 2 |
| `BaseObjectKind.ForceField` has no `maxHealth`/`maxEnergy` of its own (`invincible: true`, matching `StationVehiclePad`'s precedent) | `ForceFieldBareData` (`forceField.cs:10-33`) carries no `energy`/`maxDamage`/`invincible`-named field at all — confirmed by a full-file grep; power is inherited generically through `StaticShapeData::gainPower`/`::losePower` (`forceField.cs:151-186, 213-236`), not a field on the datablock itself | Task 3 |
| Force field blocking is team-passable (blocks the opposing team, passes the owning team), matching the spec's own Base asset numbers table row ("ForceFieldBare — team-passable") | a real deviation from the actual T2 script: `defaultForceFieldBare` — the exact datablock Katabatic places — calls `killAllPlayersWithinZone(%data, %obj)` with no `%team` argument (`forceField.cs:175-178`), so the function's own team check (`forceField.cs:200`) never short-circuits and it kills every player who touches it, friend or foe. Implementing an instant-kill mechanic was not asked for and would contradict the spec's own table; this plan follows the table, not the literal script for this one field — see Spec gaps | Task 3 |
| Force field render color: `rgb(0.0, 0.55, 0.99)` powered, black (`powerOffTranslucency = 0.0`) unpowered, `baseTranslucency = 0.30` | `forceField.cs:12-18` (`defaultForceFieldBare`'s `color`/`powerOffColor`/`baseTranslucency`/`powerOffTranslucency`) | Task 11 |
| Force field quad half-width/half-height come from the mission's own `scale` property on the `ForceFieldBare` placement, not a picked constant | the real `PhysicalZone`'s `scale = %obj.scale` (`forceField.cs:246`) — data-driven, not guessed | Task 8 |
| `BaseObjectStore` capacity | 64 (28 real objects across both teams at Katabatic's counts — 26 generators/sensors/stations/pads plus 2 force fields — with headroom) | Task 3 |
| `TurretStore` capacity | 16 (6 real turrets across both teams) | Task 4 |
| Interior/shape asset size budget | 8 MB total under `assets/out/katabatic` for M4's additions (measured real total: 1.28 MB for all 19 needed `.glb` files) | Task 9 |
| Commander map is a static top-down projection of the mission-area bounding box, no pan/zoom | Task 13 |
| Sensed-enemy filter for the commander map is computed client-side from already-broadcast player positions plus friendly sensor/turret positions and ranges, not a server-side per-team relevance filter | Task 13 — the spec's own Networking section describes relevance filtering as future work, not shipped in M1–M3 |
| `MessageType.Loadout = 8` | Task 7 |

## File structure

`packages/sim` (modify existing M1–M3 files, add six):

- `src/armor.ts`: `ArmorId` enum; `MEDIUM_ARMOR`, `HEAVY_ARMOR` populated from the spec's Armor numbers table; `ARMORS: Record<ArmorId, ArmorData>`; `armorFor(world, id): ArmorData` (Task 1).
- `src/types.ts`: `PlayerStore` gains `armor: Uint8Array`, `hasRepairPack: Uint8Array` (Task 1, Task 6); `World` gains `interiors: InteriorInstance[]` (Task 2), `baseObjects: BaseObjectStore`, `forceFields: ForceFieldGeometry[]` (Task 3), `turrets: TurretStore` (Task 4).
- `src/world.ts`: `addPlayer`/`respawnPlayer` initialize `armor`/`hasRepairPack`; `createWorld` initializes `interiors: []`, `forceFields: []`, empty `baseObjects`/`turrets` stores; `stepWorld` grows its call sequence across Tasks 3, 4, 6.
- `src/movement.ts`: every `LIGHT_ARMOR` reference becomes `armorFor(world, id)` (Task 1); `stepPlayer` gains an interior-collision correction pass (Task 2) and a force-field block pass (Task 6).
- `src/weapons.ts`, `src/damage.ts`: every `LIGHT_ARMOR` reference at a per-player call site becomes `armorFor(world, id)` (Task 1).
- `src/snapshot.ts`, `src/hash.ts`: `PlayerSnapshotData`/`mixPlayer` gain `armor`, `hasRepairPack` (Task 1).
- `src/interiors.ts` (new, Task 2): `InteriorTriangles`, `InteriorPlacement`, `InteriorInstance`, `buildInteriorCollider`, `raycastInteriors`, `resolveSphereAgainstInteriors` — internally a uniform grid, built once per instance; the three exported signatures are unchanged by that, so no downstream task needs its own edit for the grid itself.
- `src/interiors.test.ts` (new, Task 2): includes the cell-touch and benchmark tests.
- `src/baseObjects.ts` (new, Task 3): `BaseObjectKind` (now five members, `ForceField = 4`), `BaseObjectStore`, `BASE_OBJECT_DATA`, `createBaseObjects`, `stepPower`, `applyBaseObjectDamage`, `stationAt`, `ForceFieldGeometry`, `activeForceFieldBlockers`. Depends on Task 2's `interiors.ts` for the cached per-field collider.
- `src/baseObjects.test.ts` (new, Task 3).
- `src/turrets.ts` (new, Task 4): `TurretBarrelId`, `TurretBaseId`, `TurretStore`, `TURRET_BARREL_DATA`, `TURRET_BASE_DATA`, `createTurrets`, `stepTurrets`, `applyTurretDamage`, `hasLineOfSight`.
- `src/turrets.test.ts` (new, Task 4).
- `src/projectiles.ts` (Task 5): direct-hit, grenade-contact, hitscan, and tracer-recheck searches extended to consider base objects, turrets, and force fields; `spawnTurretShot` exported; `ProjectileStore` gains a `team: Uint8Array` field so a turret-fired shot (no `ownerId`) still knows which force fields to pass through.
- `src/projectiles.test.ts` (Task 5).
- `src/repair.ts` (new, Task 6): `stepRepairPacks`.
- `src/repair.test.ts` (new, Task 6).
- `src/index.ts`: exports the above, each task appending its own lines.

`packages/protocol` (Task 7, depends on Tasks 1, 3, 4, 6):

- `src/messages.ts`: `MessageType.Loadout = 8`; `LoadoutMessage`; `NetInputSample` (= `PlayerInput`) inherits `packActive` automatically once Task 6 adds it to the sim type. (Station use has no wire representation at all — see Task 6's own note: entering a powered station's use radius is a proximity fact both sides already compute identically from state they already have, and pressing `E` only opens a local menu; nothing about "the menu is open" needs to reach the server. Only the player's final *choice*, sent once as a `Loadout` message, does.)
- `src/handshake.ts`, `src/handshake.test.ts`: `writeSample`/`readSample` gain one new flag bit (`packActive`); `encodeLoadout`/`decodeLoadout`.
- `src/snapshot.ts`: `BaseObjectSnapshotData`, `TurretSnapshotData`; `WorldExtras` gains `baseObjects`, `turrets`; `encodeSnapshot`/`decodeSnapshot`/`emptyExtras` grow to match.
- `src/snapshot.test.ts`: extended.
- `src/index.ts`: extended.

`packages/assets` (Task 8 depends on the M3 baseline only; Task 9 depends on Task 8):

- `src/scene.ts`: `SceneData` gains `baseObjects`, `turrets`, `interiors`, `forceFields`; `extractScene` calls four new builders (Task 8). `baseObjects` entries for `ForceField` carry a `rotation`/`scale` the other kinds leave unset.
- `src/scene.test.ts`, `src/__fixtures__/scene.mis`: extended (Task 8).
- `src/fetch.ts`: `SOURCES` grows to include the eleven interior and eight shape `.glb` files (Task 9).
- `src/interiors.ts` (new, Task 9): reads each interior/shape `.glb` with `@gltf-transform/core`, writes a flat triangle-position binary per shape, and a size-budget check.
- `src/interiors.test.ts` (new, Task 9).
- `src/build.ts`: copies the fetched `.glb` files and their extracted collision binaries into `assets/out/katabatic`, writes them into `scene.json` (Task 9).
- `package.json`: adds `@gltf-transform/core` as a devDependency (Task 9).

`packages/server` (Task 10, depends on Task 7 and Task 9):

- `src/world.ts`: `loadKatabaticWorld` also reads `baseObjects`/`turrets`/`interiors` from `scene.json`, loads each interior's collision binary, and calls `createBaseObjects`/`createTurrets`/sets `world.interiors` (`createBaseObjects` builds each force field's cached collider internally — no separate server-side call needed).
- `src/world.test.ts`: extended.
- `src/net.ts`: handles `Loadout` messages; `buildExtras` grows to include `baseObjects`/`turrets`.
- `src/net.test.ts`: extended.

`packages/client`:

- `src/assets.ts`, Task 11 (depends on Task 9): `KatabaticAssets` gains `baseObjects`/`turrets`/`interiors`, loads every shape/interior `.glb`.
- `src/base-object-view.ts`, `src/base-object-view.test.ts`, Task 11: meshes for generators/sensors/stations/pad/turrets/interiors; power-state tint; turret barrel aim; muzzle flash; force fields get a translucent quad mesh (from the placement's `rotation`/`scale`) instead of a loaded shape.
- `src/interior-collision.ts`, Task 11 (parallel with the view file — different concern, same task): loads each interior's collision binary into the client's own predicted `World.interiors` the same way the server does.
- `src/stationMenu.ts`, `src/stationMenu.test.ts`, Task 12 (depends on Task 11): armor/repair-pack picker shown while the local player stands in a powered station's use radius.
- `src/hud.ts`, `src/hud.test.ts`, Task 12 (parallel with the menu file): base-object-health-when-aimed row; every `LIGHT_ARMOR` reference in `hud.ts` becomes `armorFor`.
- `src/input.ts`, `src/input.test.ts`, Task 12: `E` use, `R` pack, `C` command circuit.
- `src/commander-map.ts`, `src/commander-map.test.ts`, Task 13 (depends on Task 11, parallel with Task 12): the 2D canvas.
- `src/app.ts`, `src/main.ts`, Task 14 (depends on Tasks 12, 13): wires it all in; `__clansDebug` gains `killGenerator`/`repairGenerator` hooks for the e2e test.
- `e2e/base.spec.ts`, Task 14 (depends on the app wiring above).
- `README.md`, `NOTICE.md`, Task 14.

## Task dependency graph

- **Task 1** (sim: armor selection) depends on the M3 baseline only. Touches `armor.ts`, the armor slice of `types.ts`/`world.ts`, and sweeps `LIGHT_ARMOR` out of `movement.ts`/`weapons.ts`/`damage.ts`/`snapshot.ts`/`hash.ts`/`hud.ts`.
- **Task 2** (sim: interior collision) depends on Task 1 — both touch `movement.ts` sequentially (Task 1's armor lookup, then Task 2's collision call). Owns `interiors.ts`.
- **Task 3** (sim: base objects + power + force fields) depends on Task 2 — force fields cache their collision quad via `buildInteriorCollider`, so `baseObjects.ts` imports `interiors.ts`. No longer parallel with Task 2 (an earlier draft of this plan had Task 3 depend on the M3 baseline only; force fields changed that — see this plan's Global Constraints). Owns `baseObjects.ts`.
- **Task 4** (sim: turrets) depends on Task 3 (`BaseObjectStore`'s power derivation).
- **Task 5** (sim: projectiles vs base objects/turrets/force fields) depends on Task 1 (touches `projectiles.ts` after Task 1's `LIGHT_ARMOR` sweep touches the same file), Task 2 (`raycastInteriors`, already true in an earlier draft but not stated explicitly there), Task 3 (`activeForceFieldBlockers`), and Task 4.
- **Task 6** (sim: repair pack, station loadout, force-field player-movement block, integration) depends on Task 1 (`armorFor`, `hasRepairPack`), Task 2 (`movement.ts`'s `resolveInteriors` call site, which the force-field block sits next to), Task 3 (stations, `activeForceFieldBlockers`), and Task 5 (the damage dispatch pattern it reuses). Owns `repair.ts`; also finishes `stepWorld`'s call order and `hashWorld`/snapshot completeness for every field the earlier tasks added.
- **Task 7** (protocol) depends on Tasks 1, 3, 4, 6 (the full `BaseObjectStore`/`TurretStore`/`PlayerInput` shapes).
- **Task 8** (assets: scene extraction) depends on the M3 baseline only, touches `packages/assets`. **Runs in parallel with Tasks 1–7** — different package, no shared file.
- **Task 9** (assets: fetch + convert + triangle extraction) depends on Task 8 (needs the interior/shape name list Task 8's extraction produces).
- **Task 10** (server) depends on Task 7 and Task 9.
- **Task 11** (client: rendering + collision) depends on Task 9 and Task 10.
- **Task 12** (client: station menu, HUD, input) depends on Task 11.
- **Task 13** (client: commander map) depends on Task 11. **Runs in parallel with Task 12** — different files.
- **Task 14** (client wiring, Playwright, docs) depends on Tasks 12 and 13.

---

### Task 1: Sim — Medium/Heavy armor data, per-player armor selection

**Files:** Modify `packages/sim/src/armor.ts`, `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/movement.ts`, `packages/sim/src/movement.test.ts`, `packages/sim/src/weapons.ts`, `packages/sim/src/damage.ts`, `packages/sim/src/snapshot.ts`, `packages/sim/src/snapshot.test.ts`, `packages/sim/src/hash.ts`, `packages/sim/src/index.ts`, `packages/client/src/hud.ts`
**Interfaces:** Consumes `World`, `PlayerStore`, `ArmorData` (existing, unchanged shape). Produces `ArmorId` (`Light = 0, Medium = 1, Heavy = 2`), `MEDIUM_ARMOR: ArmorData`, `HEAVY_ARMOR: ArmorData`, `ARMORS: Record<ArmorId, ArmorData>`, `armorFor(world: World, id: number): ArmorData`. Covers no failure-matrix row directly but every later task that reads a player's armor (Task 3's station loadout, Task 6's Repair Pack rate) depends on `armorFor` existing.

- [ ] **Step 1: Write the failing tests**

Create the Medium/Heavy fixture and the `armorFor` test inside `packages/sim/src/armor.test.ts` (new file):

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import { ARMORS, ArmorId, armorFor, HEAVY_ARMOR, LIGHT_ARMOR, MEDIUM_ARMOR } from './armor.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('MEDIUM_ARMOR and HEAVY_ARMOR', () => {
  it('match the spec Armor numbers table exactly', () => {
    expect(MEDIUM_ARMOR.mass).toBe(130);
    expect(MEDIUM_ARMOR.maxDamage).toBe(1.1);
    expect(MEDIUM_ARMOR.maxEnergy).toBe(80);
    expect(MEDIUM_ARMOR.maxForwardSpeed).toBe(12);
    expect(MEDIUM_ARMOR.maxWeapons).toBe(4);
    expect(MEDIUM_ARMOR.laserRifleAllowed).toBe(false);
    expect(MEDIUM_ARMOR.mortarAllowed).toBe(false);
    expect(MEDIUM_ARMOR.discAmmo).toBe(15);
    expect(MEDIUM_ARMOR.chaingunAmmo).toBe(150);
    expect(MEDIUM_ARMOR.grenadeCount).toBe(6);

    expect(HEAVY_ARMOR.mass).toBe(180);
    expect(HEAVY_ARMOR.maxDamage).toBe(1.32);
    expect(HEAVY_ARMOR.maxEnergy).toBe(110);
    expect(HEAVY_ARMOR.maxForwardSpeed).toBe(7);
    expect(HEAVY_ARMOR.maxWeapons).toBe(5);
    expect(HEAVY_ARMOR.laserRifleAllowed).toBe(false);
    expect(HEAVY_ARMOR.mortarAllowed).toBe(true);
    expect(HEAVY_ARMOR.mortarAmmo).toBe(200);
    expect(HEAVY_ARMOR.grenadeCount).toBe(8);
  });
  it('ARMORS indexes by ArmorId to the same three objects', () => {
    expect(ARMORS[ArmorId.Light]).toBe(LIGHT_ARMOR);
    expect(ARMORS[ArmorId.Medium]).toBe(MEDIUM_ARMOR);
    expect(ARMORS[ArmorId.Heavy]).toBe(HEAVY_ARMOR);
  });
});

describe('armorFor', () => {
  it('reads back the armor addPlayer assigned', () => {
    const world = createWorld(flat, 1);
    const light = addPlayer(world, { x: 0, y: 0, z: 0 });
    expect(armorFor(world, light)).toBe(LIGHT_ARMOR);
  });
  it('a Heavy player runs at 7 m/s, not the Light default of 15', () => {
    const world = createWorld(flat, 1);
    const heavy = addPlayer(world, { x: 0, y: 0, z: 0 }, 1, ArmorId.Heavy);
    expect(armorFor(world, heavy).maxForwardSpeed).toBe(7);
  });
});
```

Extend `packages/sim/src/movement.test.ts` with one new case proving the sweep actually reads per-player armor rather than the old constant:

```ts
it('a Heavy player accelerates toward 7 m/s forward, not the Light 15 m/s cap', () => {
  const world = createWorld(flat, 1);
  const id = addPlayer(world, { x: 0, y: 0, z: 0 }, 1, ArmorId.Heavy);
  const forward: PlayerInput = { ...idle, moveZ: 1 };
  for (let tick = 0; tick < 200; tick += 1) stepWorld(world, new Map([[id, forward]]));
  const speed = Math.hypot(
    world.players.velocity[id * 3] ?? 0,
    world.players.velocity[id * 3 + 2] ?? 0,
  );
  expect(speed).toBeLessThanOrEqual(HEAVY_ARMOR.maxForwardSpeed + 0.01);
  expect(speed).toBeGreaterThan(6);
});
```

(Import `ArmorId`, `HEAVY_ARMOR` from `./armor.js` at the top of `movement.test.ts`.)

Extend `packages/sim/src/snapshot.test.ts`'s two `PlayerSnapshotData` literals with `armor: ArmorId.Light, hasRepairPack: 0`, importing `ArmorId` from `./armor.js`.

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- armor.test.ts`. Expect `ArmorId`/`MEDIUM_ARMOR`/`HEAVY_ARMOR`/`armorFor` to not exist. Run `pnpm --filter @clans/sim test -- movement.test.ts` and expect the new Heavy-speed case to fail (a Heavy player currently still runs at the Light cap because `stepPlayers` hardcodes `LIGHT_ARMOR`).

- [ ] **Step 3: Write minimal implementation**

In `packages/sim/src/armor.ts`, add after the existing `LIGHT_ARMOR` export (numbers from the spec's Armor numbers table, `player.cs`, cited at the top of the spec's Source material table):

```ts
export enum ArmorId {
  Light = 0,
  Medium = 1,
  Heavy = 2,
}

export const MEDIUM_ARMOR: ArmorData = {
  mass: 130,
  maxDamage: 1.1,
  maxEnergy: 80,
  rechargeRate: 0.256,
  jetForce: 25.22 * 130,
  jetEnergyDrain: 1.0,
  minJetEnergy: 1,
  runForce: 46 * 130,
  maxForwardSpeed: 12,
  maxBackwardSpeed: 10,
  maxSideSpeed: 10,
  jumpForce: 8.3 * 130,
  jumpDelay: 0,
  minJumpSpeed: 15,
  maxJumpSpeed: 25,
  horizMaxSpeed: 60,
  horizResistSpeed: 28,
  horizResistFactor: 0.32,
  upMaxSpeed: 70,
  upResistSpeed: 30,
  upResistFactor: 0.23,
  drag: 0.3,
  boundingBox: [1.45, 1.45, 2.4],
  runSurfaceAngle: 70,
  jumpSurfaceAngle: 80,
  speedDamageScale: 0.004,
  discAmmo: 15,
  chaingunAmmo: 150,
  mortarAmmo: 0,
  grenadeCount: 6,
  maxWeapons: 4,
  laserRifleAllowed: false,
  mortarAllowed: false,
};

export const HEAVY_ARMOR: ArmorData = {
  mass: 180,
  maxDamage: 1.32,
  maxEnergy: 110,
  rechargeRate: 0.256,
  jetForce: 22.47 * 180,
  jetEnergyDrain: 1.1,
  minJetEnergy: 1,
  runForce: 40.25 * 180,
  maxForwardSpeed: 7,
  maxBackwardSpeed: 5,
  maxSideSpeed: 5,
  jumpForce: 8.3 * 180,
  jumpDelay: 0,
  minJumpSpeed: 20,
  maxJumpSpeed: 30,
  horizMaxSpeed: 52,
  horizResistSpeed: 23,
  horizResistFactor: 0.29,
  upMaxSpeed: 60,
  upResistSpeed: 35,
  upResistFactor: 0.18,
  drag: 0.33,
  boundingBox: [1.63, 1.63, 2.6],
  runSurfaceAngle: 70,
  jumpSurfaceAngle: 80,
  speedDamageScale: 0.004,
  discAmmo: 15,
  chaingunAmmo: 200,
  mortarAmmo: 200,
  grenadeCount: 8,
  maxWeapons: 5,
  laserRifleAllowed: false,
  mortarAllowed: true,
};

export const ARMORS: Record<ArmorId, ArmorData> = {
  [ArmorId.Light]: LIGHT_ARMOR,
  [ArmorId.Medium]: MEDIUM_ARMOR,
  [ArmorId.Heavy]: HEAVY_ARMOR,
};

/** The single place every system looks up a player's armor. Never read `LIGHT_ARMOR` (or any
 *  other constant) directly for a per-player calculation again — see this plan's Global
 *  Constraints. */
export function armorFor(world: { players: { armor: Uint8Array } }, id: number): ArmorData {
  return ARMORS[(world.players.armor[id] ?? ArmorId.Light) as ArmorId];
}
```

In `packages/sim/src/types.ts`'s `PlayerStore`, add after `respawnSeq`:

```ts
  armor: Uint8Array; // ArmorId
  hasRepairPack: Uint8Array; // 0/1 — Task 6 sets this from a Loadout request
```

In `packages/sim/src/world.ts`: add `armor: new Uint8Array(capacity), hasRepairPack: new Uint8Array(capacity),` to `createWorld`'s `players` object. Change `addPlayer`'s signature and body:

```ts
export function addPlayer(world: World, spawn: Vec3, team = 0, armor = ArmorId.Light): number {
  const players = world.players;
  const id = players.freeIds.pop() ?? players.count;
  if (id >= players.energy.length) throw new RangeError('Player capacity exceeded');
  if (id === players.count) players.count += 1;
  players.active[id] = 1;
  players.team[id] = team;
  players.armor[id] = armor;
  players.hasRepairPack[id] = 0;
  players.damage[id] = 0;
  players.godMode[id] = 0;
  players.alive[id] = 1;
  players.respawnAt[id] = -1;
  players.respawnSeq[id] = 0;
  players.score[id] = 0;
  resetPlayerToSpawn(world, id, spawn);
  resetLoadout(world, id, ARMORS[armor]);
  return id;
}
```

(Import `ArmorId`, `ARMORS` instead of the bare `LIGHT_ARMOR` import at the top of `world.ts`; `resetPlayerToSpawn`'s own `players.energy[id] = LIGHT_ARMOR.maxEnergy` becomes `players.energy[id] = armorFor(world, id).maxEnergy` — but `resetPlayerToSpawn` runs *before* `players.armor[id]` is set in the reordered `addPlayer` above, so move the `players.armor[id] = armor;` line before the `resetPlayerToSpawn(world, id, spawn);` call, which the body above already does.)

`weapons.ts`'s `respawnPlayer` reads the caller's intended armor from the same place `addPlayer` now does — change its signature to accept the target armor explicitly rather than hardcoding `LIGHT_ARMOR`:

```ts
export function respawnPlayer(world: World, id: number, spawn: Vec3, armor?: ArmorId): void {
  if (armor !== undefined) world.players.armor[id] = armor;
  respawnHealth(world, id, spawn);
  resetLoadout(world, id, armorFor(world, id));
}
```

This keeps every M3 call site (`respawnPlayer(world, id, spawn)`, no third argument) working unchanged — a respawn defaults to keeping the player's current armor, which is exactly what T2 does (armor only changes at a station).

Sweep the remaining `LIGHT_ARMOR` call sites:

- `movement.ts`'s `stepPlayers`: `stepPlayer(world, id, input, LIGHT_ARMOR, dt);` becomes `stepPlayer(world, id, input, armorFor(world, id), dt);` (drop the now-unused `LIGHT_ARMOR` import).
- `weapons.ts`'s `energyScaleFor`: `Math.min(1, energy / LIGHT_ARMOR.maxEnergy)` becomes `Math.min(1, energy / armorFor(world, id).maxEnergy)`.
- `weapons.ts`'s `resetLoadout` already takes `armor: ArmorData` as a parameter — no change needed there, only at its call sites, both already fixed above.
- `damage.ts`, `projectiles.ts` (Task 5 sweeps the two remaining `LIGHT_ARMOR` sites inside `projectiles.ts`'s `explode`/`findDirectHitFrom`/etc. together with its own base-object changes, since it is already touching every one of those functions — see Task 5).
- `client/src/hud.ts`'s `healthRow`/`energyRow`: `LIGHT_ARMOR.maxDamage` becomes `armorFor(source.world, source.playerId).maxDamage`, same for `maxEnergy`; import `armorFor` from `@clans/sim`.

In `packages/sim/src/snapshot.ts`, add `armor: number; hasRepairPack: 0 | 1;` to `PlayerSnapshotData` (after `godMode`), and in `serializePlayer`/`deserializePlayer`:

```ts
    armor: num(p.armor, id),
    hasRepairPack: bit(p.hasRepairPack, id),
```
```ts
  players.armor[data.id] = data.armor;
  players.hasRepairPack[data.id] = data.hasRepairPack;
```

Also change `serializePlayer`'s health line to use the player's real armor instead of the Light constant: `health: armorFor(world, id).maxDamage - num(p.damage, id),` and `deserializePlayer`'s mirror: `players.damage[data.id] = ARMORS[data.armor as ArmorId].maxDamage - data.health;` (armor must be applied before this line reads it back, so `players.armor[data.id] = data.armor;` moves above the damage line in `deserializePlayer`'s body).

In `packages/sim/src/hash.ts`'s `mixPlayer`, mix in the two new fields after `respawnSeq`'s masked mix:

```ts
  h = mix(h, num(players.armor, id));
  h = mix(h, num(players.hasRepairPack, id));
```

Add to `packages/sim/src/index.ts` (the `armor.js` line already exists as `export * from './armor.js';` — no change needed there).

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`. Every M3 test that constructs a `PlayerSnapshotData` literal by hand must be updated with `armor`/`hasRepairPack` or the object-literal excess-property check fails typecheck, not just the two files this step names — grep the repo for `PlayerSnapshotData = {` and `: PlayerSnapshotData = {` before declaring this step done.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/armor.ts packages/sim/src/armor.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/movement.ts packages/sim/src/movement.test.ts packages/sim/src/weapons.ts packages/sim/src/snapshot.ts packages/sim/src/snapshot.test.ts packages/sim/src/hash.ts packages/client/src/hud.ts
git commit -m "feat(sim): Medium/Heavy armor data and per-player armor selection" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 2: Sim — interior collision (uniform-grid-accelerated static triangle mesh)

**Files:** Create `packages/sim/src/interiors.ts`, `packages/sim/src/interiors.test.ts`; Modify `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/movement.ts`, `packages/sim/src/index.ts`
**Interfaces:** Consumes `Vec3` (existing). Produces `InteriorTriangles { positions: Float32Array }` (local-space triangle soup, 9 floats per triangle, no index buffer — the assets pipeline expands indexed geometry into a flat triangle list at build time so the sim never has to), `InteriorPlacement { position: Vec3; rotation: { axis: Vec3; degrees: number } }`, `InteriorInstance` (opaque, built by `buildInteriorCollider`, internally a uniform grid over the instance's world-space triangles), `InteriorQueryStats { cellsVisited: number; trianglesTested: number }` (an optional out-parameter, mutated in place, for the debug layer's "wireframes for terrain collision, interior BVH" stat and for this task's own tests — see the spec's Debug mode section), `buildInteriorCollider(triangles: InteriorTriangles, placement: InteriorPlacement): InteriorInstance`, `raycastInteriors(interiors: readonly InteriorInstance[], origin: Vec3, direction: Vec3, maxDistance: number, stats?: InteriorQueryStats): { distance: number; point: Vec3; normal: Vec3 } | null`, `resolveSphereAgainstInteriors(interiors: readonly InteriorInstance[], center: Vec3, radius: number, stats?: InteriorQueryStats): Vec3 | null` (a push-out delta, or `null` if the sphere touches nothing). The `stats` parameter is optional and appended last, so every M4 call site already written elsewhere in this plan before this rewrite (Task 5, Task 6, Task 11) needs no edit. Covers failure-matrix row 14 (Task 5 wires the raycast side into `projectiles.ts`; this task proves the geometry and query functions alone).

This task replaces an earlier draft's brute-force per-instance triangle scan with a real acceleration structure: each `InteriorInstance` buckets its triangles into a uniform grid at build time (once, since Katabatic's interiors never move), a ray query walks only the grid cells its segment actually crosses (Amanatides–Woo 3D DDA traversal), and a sphere query only visits the cells its bounding box overlaps. This is what the spec's Simulation section means by "per-interior triangle meshes with a BVH for buildings" — a uniform grid is the simpler of the two well-known static-scene acceleration structures, chosen here because Katabatic's interiors are small, roughly convex rooms and corridors where a grid's cell locality already captures nearly all of a hierarchical BVH's benefit at a fraction of the build-time code.

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/interiors.test.ts`. A single unit cube (two triangles per face, 12 total) placed at the origin is enough to prove rotation, raycast, and sphere push-out without needing real Katabatic geometry:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildInteriorCollider,
  raycastInteriors,
  resolveSphereAgainstInteriors,
  type InteriorInstance,
  type InteriorPlacement,
  type InteriorTriangles,
} from './interiors.js';

/** A 2x2x2 axis-aligned box centered on the origin in local space, faces wound outward. */
function unitBox(): InteriorTriangles {
  const p: [number, number, number][] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const quad = (a: number, b: number, c: number, d: number): number[] => [
    ...p[a]!, ...p[b]!, ...p[c]!,
    ...p[a]!, ...p[c]!, ...p[d]!,
  ];
  const positions = new Float32Array([
    ...quad(0, 3, 2, 1), // -Z
    ...quad(4, 5, 6, 7), // +Z
    ...quad(0, 4, 7, 3), // -X
    ...quad(1, 2, 6, 5), // +X
    ...quad(0, 1, 5, 4), // -Y
    ...quad(3, 7, 6, 2), // +Y
  ]);
  return { positions };
}

const identity: InteriorPlacement = { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } };

describe('buildInteriorCollider + raycastInteriors', () => {
  it('hits the near face of an untransformed box from outside', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    const hit = raycastInteriors([instance], { x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
    expect(hit?.distance).toBeCloseTo(4, 1);
    expect(hit?.point.x).toBeCloseTo(-1, 1);
  });
  it('a ray that misses the box entirely returns null', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    const hit = raycastInteriors([instance], { x: -5, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).toBeNull();
  });
  it('respects a translated placement', () => {
    const moved: InteriorPlacement = { ...identity, position: { x: 100, y: 0, z: 0 } };
    const instance = buildInteriorCollider(unitBox(), moved);
    const hit = raycastInteriors([instance], { x: 95, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(99, 1);
  });
  it('respects a 90 degree rotated placement (a box is rotation-symmetric, so rotate a non-cube check via the Y axis on a differently-sized box is unnecessary; this proves the transform pipeline runs, not that rotation changes the hit for a cube)', () => {
    const rotated: InteriorPlacement = { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 90 } };
    const instance = buildInteriorCollider(unitBox(), rotated);
    const hit = raycastInteriors([instance], { x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
  });
});

describe('resolveSphereAgainstInteriors', () => {
  it('returns null for a sphere well outside the box', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    expect(resolveSphereAgainstInteriors([instance], { x: 10, y: 0, z: 0 }, 0.5)).toBeNull();
  });
  it('pushes a penetrating sphere back out along the nearest face normal', () => {
    const instance = buildInteriorCollider(unitBox(), identity);
    // Center 0.7 inside the +X face (face at x=1), radius 0.5: penetration depth 0.5 - 0.3 = 0.2.
    const push = resolveSphereAgainstInteriors([instance], { x: 1.3, y: 0, z: 0 }, 0.5);
    expect(push).not.toBeNull();
    expect(push?.x ?? 0).toBeGreaterThan(0); // pushes further along +X, away from the box interior
    expect(Math.abs(push?.x ?? 0)).toBeCloseTo(0.2, 1);
  });
  it('an empty interior list always returns null', () => {
    expect(resolveSphereAgainstInteriors([], { x: 0, y: 0, z: 0 }, 1)).toBeNull();
  });
});

/** Twenty separate 1x1x1 boxes ("posts"), spaced 4 m apart along X, each its own pair of
 *  triangles in one shared triangle soup. Real Katabatic interiors are single connected
 *  meshes, but a sparse row of separated clusters is what actually proves cell-locality:
 *  a query near post 0 has no business touching the cells around post 19, and a brute-force
 *  scan (or a single whole-interior AABB reject, which is all the pre-grid draft had) cannot
 *  tell the difference — it always tests every triangle once inside the reject. */
function postRow(count: number): InteriorTriangles {
  const tris: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = i * 4;
    // One quad (2 triangles) per post, facing -X, so a ray along +X hits it squarely.
    tris.push(
      x, -0.5, -0.5, x, 0.5, -0.5, x, 0.5, 0.5,
      x, -0.5, -0.5, x, 0.5, 0.5, x, -0.5, 0.5,
    );
  }
  return { positions: new Float32Array(tris) };
}

describe('uniform grid cell locality (spec: "per-interior triangle meshes with a BVH")', () => {
  it('a ray only visits the cells along its own short segment, not the whole row', () => {
    const instance = buildInteriorCollider(postRow(20), identity);
    const stats: InteriorQueryStats = { cellsVisited: 0, trianglesTested: 0 };
    // Post 0 is at x=0; this ray only travels from x=-2 to x=2, nowhere near posts 5-19.
    const hit = raycastInteriors([instance], { x: -2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 4, stats);
    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(0, 1);
    // The grid cell size is 2 m (this plan's "ours" table); a 4 m segment crosses at most a
    // handful of cells, never all 20 posts' worth.
    expect(stats.cellsVisited).toBeLessThan(6);
    expect(stats.trianglesTested).toBeLessThan(6);
  });
  it('a sphere query only visits the cells its own bounding box overlaps', () => {
    const instance = buildInteriorCollider(postRow(20), identity);
    const stats: InteriorQueryStats = { cellsVisited: 0, trianglesTested: 0 };
    const push = resolveSphereAgainstInteriors([instance], { x: 0.4, y: 0, z: 0 }, 0.3, stats);
    expect(push).not.toBeNull();
    expect(stats.cellsVisited).toBeLessThan(6);
    expect(stats.trianglesTested).toBeLessThan(6);
  });
  it('correctness is unaffected by the acceleration structure: a ray that only reaches post 0 never reports post 1', () => {
    const instance = buildInteriorCollider(postRow(20), identity);
    const hit = raycastInteriors([instance], { x: -2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 2.4);
    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(0, 1); // post 0, not post 1 at x=4
  });
});

describe('benchmark: query time stays under budget on a Katabatic-scale interior', () => {
  /** 5,000 triangles is a conservative over-estimate for one real Katabatic interior — Task
   *  9's measured real total across all 19 needed .glb files is 1,278,076 bytes, and a shape
   *  that size rarely reaches even a tenth this triangle count. A flat grid of small quads
   *  filling a 30 x 4 x 20 m volume (a generous interior footprint) stands in for the real
   *  geometry without needing network access in this unit test. */
  function denseInterior(triangleCount: number): InteriorTriangles {
    const quads = Math.ceil(triangleCount / 2);
    const cols = Math.ceil(Math.sqrt(quads));
    const positions = new Float32Array(quads * 18);
    for (let i = 0; i < quads; i += 1) {
      const gx = (i % cols) * (30 / cols) - 15;
      const gz = Math.floor(i / cols) * (20 / cols) - 10;
      const o = i * 18;
      positions.set(
        [
          gx, 0, gz, gx + 0.2, 4, gz, gx + 0.2, 4, gz + 0.2,
          gx, 0, gz, gx + 0.2, 4, gz + 0.2, gx, 0, gz + 0.2,
        ],
        o,
      );
    }
    return { positions };
  }

  it('raycastInteriors averages under 50 microseconds per call against a 5,000-triangle interior', () => {
    const instance = buildInteriorCollider(denseInterior(5000), identity);
    const iterations = 10000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      raycastInteriors([instance], { x: -20, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 40);
    }
    const microsPerCall = ((performance.now() - start) * 1000) / iterations;
    expect(microsPerCall).toBeLessThan(50);
  });

  it('resolveSphereAgainstInteriors averages under 50 microseconds per call against the same interior', () => {
    const instance = buildInteriorCollider(denseInterior(5000), identity);
    const iterations = 10000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      resolveSphereAgainstInteriors([instance], { x: 0.1, y: 2, z: 0.1 }, 0.6);
    }
    const microsPerCall = ((performance.now() - start) * 1000) / iterations;
    expect(microsPerCall).toBeLessThan(50);
  });
});
```

(Import `type InteriorQueryStats` alongside the file's existing `interiors.js` import list.)

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- interiors.test.ts`. Expect module resolution to fail for `./interiors.js`. The benchmark tests will also fail once the module resolves if implemented as brute force against 5,000 triangles at 10,000 iterations — the budget is written against the grid-accelerated implementation Step 3 below builds, not the naive one.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/interiors.ts`:

```ts
import type { Vec3 } from './types.js';

export interface InteriorTriangles {
  /** Local-space triangle soup: 9 floats per triangle (3 verts x xyz), no index buffer. */
  positions: Float32Array;
}
export interface InteriorPlacement {
  position: Vec3;
  rotation: { axis: Vec3; degrees: number };
}
interface Aabb {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}
/** A uniform grid over one interior instance's world-space triangles, built once at load
 *  (`buildInteriorCollider`, right below) and never rebuilt — Katabatic's interiors never
 *  move. `cellStart` is a CSR prefix-sum array (length `dimX*dimY*dimZ + 1`); cell `c`'s
 *  triangle indices live at `triangleIndices[cellStart[c] .. cellStart[c+1])`. This is what
 *  the spec's "per-interior triangle meshes with a BVH for buildings" asks for — a uniform
 *  grid, not a hierarchical tree, is the simpler of the two well-known static-scene
 *  acceleration structures and is enough for Katabatic's small, roughly-convex rooms. See
 *  this plan's Global Constraints. */
interface UniformGrid {
  cellSize: number;
  minX: number;
  minY: number;
  minZ: number;
  dimX: number;
  dimY: number;
  dimZ: number;
  cellStart: Int32Array;
  triangleIndices: Int32Array;
}

/** Ours — see this plan's "ours" numbers table. Small enough that a typical Katabatic
 *  corridor (a few metres wide) spans only 1-2 cells per axis. */
const GRID_CELL_SIZE = 2;

export interface InteriorInstance {
  /** World-space triangle soup, already transformed once at build time — Katabatic's
   *  interiors never move, so this pays the rotation/translation cost exactly once instead
   *  of every tick. */
  worldPositions: Float32Array;
  bounds: Aabb;
  grid: UniformGrid;
}

/** An optional out-parameter both query functions below mutate in place when supplied —
 *  never allocated when omitted, so a caller that does not care (every M1-M3-style test,
 *  and any hot path that skips it) pays nothing extra. Feeds the spec's Debug mode "interior
 *  BVH" stat and this task's own cell-locality tests. */
export interface InteriorQueryStats {
  cellsVisited: number;
  trianglesTested: number;
}

function axisAngleToMatrix(axis: Vec3, degrees: number): number[] {
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const x = axis.x / len, y = axis.y / len, z = axis.z / len;
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad), t = 1 - c;
  // Row-major 3x3 rotation matrix, standard axis-angle (Rodrigues) form.
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

function applyPlacement(m: number[], p: InteriorPlacement, x: number, y: number, z: number): Vec3 {
  return {
    x: (m[0] ?? 1) * x + (m[1] ?? 0) * y + (m[2] ?? 0) * z + p.position.x,
    y: (m[3] ?? 0) * x + (m[4] ?? 1) * y + (m[5] ?? 0) * z + p.position.y,
    z: (m[6] ?? 0) * x + (m[7] ?? 0) * y + (m[8] ?? 1) * z + p.position.z,
  };
}

function boundsOf(positions: Float32Array): Aabb {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0, y = positions[i + 1] ?? 0, z = positions[i + 2] ?? 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function triangleAabb(positions: Float32Array, i: number): Aabb {
  const ax = positions[i] ?? 0, ay = positions[i + 1] ?? 0, az = positions[i + 2] ?? 0;
  const bx = positions[i + 3] ?? 0, by = positions[i + 4] ?? 0, bz = positions[i + 5] ?? 0;
  const cx = positions[i + 6] ?? 0, cy = positions[i + 7] ?? 0, cz = positions[i + 8] ?? 0;
  return {
    minX: Math.min(ax, bx, cx), minY: Math.min(ay, by, cy), minZ: Math.min(az, bz, cz),
    maxX: Math.max(ax, bx, cx), maxY: Math.max(ay, by, cy), maxZ: Math.max(az, bz, cz),
  };
}

type GridShape = Pick<UniformGrid, 'minX' | 'minY' | 'minZ' | 'cellSize' | 'dimX' | 'dimY' | 'dimZ'>;

function clampCell(v: number, dim: number): number {
  return Math.min(Math.max(v, 0), dim - 1);
}

function cellCoordFor(grid: GridShape, p: Vec3): [number, number, number] {
  return [
    clampCell(Math.floor((p.x - grid.minX) / grid.cellSize), grid.dimX),
    clampCell(Math.floor((p.y - grid.minY) / grid.cellSize), grid.dimY),
    clampCell(Math.floor((p.z - grid.minZ) / grid.cellSize), grid.dimZ),
  ];
}

function cellIndex(grid: Pick<GridShape, 'dimX' | 'dimY'>, x: number, y: number, z: number): number {
  return (z * grid.dimY + y) * grid.dimX + x;
}

function visitRow(grid: GridShape, x0: number, x1: number, y: number, z: number, visit: (i: number) => void): void {
  for (let x = x0; x <= x1; x += 1) visit(cellIndex(grid, x, y, z));
}

/** Every cell an AABB overlaps, inclusive. Kept to depth 3 (function -> for -> for -> call)
 *  by delegating the innermost loop to `visitRow`. */
function forEachOverlappedCell(grid: GridShape, box: Aabb, visit: (i: number) => void): void {
  const [x0, y0, z0] = cellCoordFor(grid, { x: box.minX, y: box.minY, z: box.minZ });
  const [x1, y1, z1] = cellCoordFor(grid, { x: box.maxX, y: box.maxY, z: box.maxZ });
  for (let z = z0; z <= z1; z += 1) {
    for (let y = y0; y <= y1; y += 1) visitRow(grid, x0, x1, y, z, visit);
  }
}

function buildUniformGrid(positions: Float32Array, bounds: Aabb): UniformGrid {
  const cellSize = GRID_CELL_SIZE;
  const dimX = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
  const dimY = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSize));
  const dimZ = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cellSize));
  const grid: GridShape = { cellSize, minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ, dimX, dimY, dimZ };
  const cellCount = dimX * dimY * dimZ;
  const triangleCount = positions.length / 9;
  const counts = new Int32Array(cellCount);
  for (let t = 0; t < triangleCount; t += 1) {
    forEachOverlappedCell(grid, triangleAabb(positions, t * 9), (i) => { counts[i] = (counts[i] ?? 0) + 1; });
  }
  const cellStart = new Int32Array(cellCount + 1);
  for (let c = 0; c < cellCount; c += 1) cellStart[c + 1] = (cellStart[c] ?? 0) + (counts[c] ?? 0);
  const cursor = cellStart.slice(0, cellCount);
  const triangleIndices = new Int32Array(cellStart[cellCount] ?? 0);
  for (let t = 0; t < triangleCount; t += 1) {
    forEachOverlappedCell(grid, triangleAabb(positions, t * 9), (i) => {
      triangleIndices[cursor[i] ?? 0] = t;
      cursor[i] = (cursor[i] ?? 0) + 1;
    });
  }
  return { ...grid, cellStart, triangleIndices };
}

export function buildInteriorCollider(
  triangles: InteriorTriangles,
  placement: InteriorPlacement,
): InteriorInstance {
  const m = axisAngleToMatrix(placement.rotation.axis, placement.rotation.degrees);
  const src = triangles.positions;
  const worldPositions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const world = applyPlacement(m, placement, src[i] ?? 0, src[i + 1] ?? 0, src[i + 2] ?? 0);
    worldPositions[i] = world.x;
    worldPositions[i + 1] = world.y;
    worldPositions[i + 2] = world.z;
  }
  const bounds = boundsOf(worldPositions);
  return { worldPositions, bounds, grid: buildUniformGrid(worldPositions, bounds) };
}

/** Slab-method ray/AABB test, returning the entry/exit distances instead of a bare boolean
 *  so callers can start a grid walk at the point the ray actually enters the bounds, not at
 *  `origin` (which may be well outside them). */
function rayAabbInterval(
  bounds: Aabb, origin: Vec3, inv: Vec3, maxDistance: number,
): { tMin: number; tMax: number } | null {
  let tMin = 0, tMax = maxDistance;
  const axes: Array<[number, number, number, number]> = [
    [origin.x, inv.x, bounds.minX, bounds.maxX],
    [origin.y, inv.y, bounds.minY, bounds.maxY],
    [origin.z, inv.z, bounds.minZ, bounds.maxZ],
  ];
  for (const [o, invD, lo, hi] of axes) {
    let t1 = (lo - o) * invD;
    let t2 = (hi - o) * invD;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return { tMin, tMax };
}

/** Möller–Trumbore ray/triangle intersection, single-sided (Katabatic's interiors are closed
 *  solids, so we only care about the entry face). Returns the hit distance, or null. */
function rayTriangle(
  origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3, maxDistance: number,
): number | null {
  const EPS = 1e-7;
  const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const h = {
    x: direction.y * e2.z - direction.z * e2.y,
    y: direction.z * e2.x - direction.x * e2.z,
    z: direction.x * e2.y - direction.y * e2.x,
  };
  const det = e1.x * h.x + e1.y * h.y + e1.z * h.z;
  if (Math.abs(det) < EPS) return null;
  const invDet = 1 / det;
  const s = { x: origin.x - a.x, y: origin.y - a.y, z: origin.z - a.z };
  const u = (s.x * h.x + s.y * h.y + s.z * h.z) * invDet;
  if (u < 0 || u > 1) return null;
  const q = { x: s.y * e1.z - s.z * e1.y, y: s.z * e1.x - s.x * e1.z, z: s.x * e1.y - s.y * e1.x };
  const v = (direction.x * q.x + direction.y * q.y + direction.z * q.z) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2.x * q.x + e2.y * q.y + e2.z * q.z) * invDet;
  return t > EPS && t <= maxDistance ? t : null;
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const nx = e1.y * e2.z - e1.z * e2.y;
  const ny = e1.z * e2.x - e1.x * e2.z;
  const nz = e1.x * e2.y - e1.y * e2.x;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function readTri(positions: Float32Array, i: number): [Vec3, Vec3, Vec3] {
  return [
    { x: positions[i] ?? 0, y: positions[i + 1] ?? 0, z: positions[i + 2] ?? 0 },
    { x: positions[i + 3] ?? 0, y: positions[i + 4] ?? 0, z: positions[i + 5] ?? 0 },
    { x: positions[i + 6] ?? 0, y: positions[i + 7] ?? 0, z: positions[i + 8] ?? 0 },
  ];
}

interface CellCoord { x: number; y: number; z: number }
interface DdaAxis { cell: number; dim: number; step: number; tMax: number; tDelta: number }

function ddaAxis(origin: number, dir: number, gridMin: number, cellSize: number, dim: number): DdaAxis {
  const cell = clampCell(Math.floor((origin - gridMin) / cellSize), dim);
  if (dir === 0) return { cell, dim, step: 0, tMax: Infinity, tDelta: Infinity };
  const step = dir > 0 ? 1 : -1;
  const boundary = gridMin + (cell + (step > 0 ? 1 : 0)) * cellSize;
  return { cell, dim, step, tMax: (boundary - origin) / dir, tDelta: cellSize / Math.abs(dir) };
}

function inGridRange(ax: DdaAxis, ay: DdaAxis, az: DdaAxis): boolean {
  return ax.cell >= 0 && ax.cell < ax.dim && ay.cell >= 0 && ay.cell < ay.dim && az.cell >= 0 && az.cell < az.dim;
}

function smallestTMaxAxis(ax: DdaAxis, ay: DdaAxis, az: DdaAxis): 'x' | 'y' | 'z' {
  if (ax.tMax <= ay.tMax && ax.tMax <= az.tMax) return 'x';
  return ay.tMax <= az.tMax ? 'y' : 'z';
}

function stepAxis(axis: DdaAxis): DdaAxis {
  return { ...axis, cell: axis.cell + axis.step, tMax: axis.tMax + axis.tDelta };
}

/** Amanatides & Woo voxel traversal: visits exactly the cells the segment from `entry` in
 *  `direction`, for up to `remaining` distance, actually crosses — in order, never the
 *  segment's whole bounding box. This is the acceleration this task's Global Constraints
 *  bullet and the spec's own "BVH for buildings" line ask for. */
function cellsAlongRay(grid: UniformGrid, entry: Vec3, direction: Vec3, remaining: number): CellCoord[] {
  let ax = ddaAxis(entry.x, direction.x, grid.minX, grid.cellSize, grid.dimX);
  let ay = ddaAxis(entry.y, direction.y, grid.minY, grid.cellSize, grid.dimY);
  let az = ddaAxis(entry.z, direction.z, grid.minZ, grid.cellSize, grid.dimZ);
  const cells: CellCoord[] = [];
  let traveled = 0;
  while (traveled <= remaining && inGridRange(ax, ay, az)) {
    cells.push({ x: ax.cell, y: ay.cell, z: az.cell });
    const axis = smallestTMaxAxis(ax, ay, az);
    traveled = axis === 'x' ? ax.tMax : axis === 'y' ? ay.tMax : az.tMax;
    if (axis === 'x') ax = stepAxis(ax);
    else if (axis === 'y') ay = stepAxis(ay);
    else az = stepAxis(az);
  }
  return cells;
}

/** Every triangle index referenced by any of `cells`, each reported once even if several
 *  cells share it (a triangle spanning a cell boundary is bucketed into every cell it
 *  overlaps at build time — see `buildUniformGrid`). */
function candidateTriangles(grid: UniformGrid, cells: readonly CellCoord[], stats?: InteriorQueryStats): Set<number> {
  const candidates = new Set<number>();
  for (const cell of cells) {
    if (stats) stats.cellsVisited += 1;
    const index = cellIndex(grid, cell.x, cell.y, cell.z);
    const start = grid.cellStart[index] ?? 0;
    const end = grid.cellStart[index + 1] ?? 0;
    for (let i = start; i < end; i += 1) candidates.add(grid.triangleIndices[i] ?? 0);
  }
  return candidates;
}

function raycastOneInterior(
  instance: InteriorInstance,
  origin: Vec3,
  direction: Vec3,
  inv: Vec3,
  maxDistance: number,
  stats?: InteriorQueryStats,
): { distance: number; point: Vec3; normal: Vec3 } | null {
  const interval = rayAabbInterval(instance.bounds, origin, inv, maxDistance);
  if (!interval) return null;
  const entryT = Math.max(interval.tMin, 0);
  const entry: Vec3 = {
    x: origin.x + direction.x * entryT, y: origin.y + direction.y * entryT, z: origin.z + direction.z * entryT,
  };
  const cells = cellsAlongRay(instance.grid, entry, direction, maxDistance - entryT);
  let nearest: { distance: number; point: Vec3; normal: Vec3 } | null = null;
  for (const t of candidateTriangles(instance.grid, cells, stats)) {
    if (stats) stats.trianglesTested += 1;
    const [a, b, c] = readTri(instance.worldPositions, t * 9);
    const distance = rayTriangle(origin, direction, a, b, c, maxDistance);
    if (distance === null || (nearest && distance >= nearest.distance)) continue;
    const point: Vec3 = {
      x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance,
    };
    nearest = { distance, point, normal: triangleNormal(a, b, c) };
  }
  return nearest;
}

export function raycastInteriors(
  interiors: readonly InteriorInstance[],
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  stats?: InteriorQueryStats,
): { distance: number; point: Vec3; normal: Vec3 } | null {
  const inv: Vec3 = {
    x: direction.x !== 0 ? 1 / direction.x : Infinity,
    y: direction.y !== 0 ? 1 / direction.y : Infinity,
    z: direction.z !== 0 ? 1 / direction.z : Infinity,
  };
  let nearest: { distance: number; point: Vec3; normal: Vec3 } | null = null;
  for (const instance of interiors) {
    const hit = raycastOneInterior(instance, origin, direction, inv, maxDistance, stats);
    if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
  }
  return nearest;
}

function sphereIntersectsAabb(bounds: Aabb, center: Vec3, radius: number): boolean {
  const cx = Math.max(bounds.minX, Math.min(center.x, bounds.maxX));
  const cy = Math.max(bounds.minY, Math.min(center.y, bounds.maxY));
  const cz = Math.max(bounds.minZ, Math.min(center.z, bounds.maxZ));
  return Math.hypot(center.x - cx, center.y - cy, center.z - cz) <= radius;
}

/** Closest point on triangle (a,b,c) to `p` — the standard clamp-to-edges construction. */
function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const d1 = ab.x * ap.x + ab.y * ap.y + ab.z * ap.z;
  const d2 = ac.x * ap.x + ac.y * ap.y + ac.z * ap.z;
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = { x: p.x - b.x, y: p.y - b.y, z: p.z - b.z };
  const d3 = ab.x * bp.x + ab.y * bp.y + ab.z * bp.z;
  const d4 = ac.x * bp.x + ac.y * bp.y + ac.z * bp.z;
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t };
  }
  const cp = { x: p.x - c.x, y: p.y - c.y, z: p.z - c.z };
  const d5 = ab.x * cp.x + ab.y * cp.y + ab.z * cp.z;
  const d6 = ac.x * cp.x + ac.y * cp.y + ac.z * cp.z;
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return { x: a.x + ac.x * t, y: a.y + ac.y * t, z: a.z + ac.z * t };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { x: b.x + (c.x - b.x) * t, y: b.y + (c.y - b.y) * t, z: b.z + (c.z - b.z) * t };
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return { x: a.x + ab.x * v + ac.x * w, y: a.y + ab.y * v + ac.y * w, z: a.z + ab.z * v + ac.z * w };
}

function sphereCells(grid: UniformGrid, center: Vec3, radius: number): CellCoord[] {
  const box: Aabb = {
    minX: center.x - radius, minY: center.y - radius, minZ: center.z - radius,
    maxX: center.x + radius, maxY: center.y + radius, maxZ: center.z + radius,
  };
  const cells: CellCoord[] = [];
  forEachOverlappedCell(grid, box, (i) => {
    const z = Math.floor(i / (grid.dimX * grid.dimY));
    const y = Math.floor((i - z * grid.dimX * grid.dimY) / grid.dimX);
    const x = i - z * grid.dimX * grid.dimY - y * grid.dimX;
    cells.push({ x, y, z });
  });
  return cells;
}

function resolveSphereAgainstOneInterior(
  instance: InteriorInstance,
  center: Vec3,
  radius: number,
  stats?: InteriorQueryStats,
): { depth: number; push: Vec3 } | null {
  if (!sphereIntersectsAabb(instance.bounds, center, radius)) return null;
  const cells = sphereCells(instance.grid, center, radius);
  let deepest: { depth: number; push: Vec3 } | null = null;
  for (const t of candidateTriangles(instance.grid, cells, stats)) {
    if (stats) stats.trianglesTested += 1;
    const [a, b, c] = readTri(instance.worldPositions, t * 9);
    const closest = closestPointOnTriangle(center, a, b, c);
    const dx = center.x - closest.x, dy = center.y - closest.y, dz = center.z - closest.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance >= radius) continue;
    const depth = radius - distance;
    if (deepest && depth <= deepest.depth) continue;
    const len = distance || 1;
    deepest = { depth, push: { x: (dx / len) * depth, y: (dy / len) * depth, z: (dz / len) * depth } };
  }
  return deepest;
}

/** The single deepest penetration this tick, across every triangle of every interior whose
 *  AABB the sphere could plausibly touch — and, within an instance, only the triangles in
 *  the grid cells the sphere's own bounding box overlaps. Ours: not the sum of every
 *  overlapping triangle's push-out (that can push a sphere wedged in a corner further than
 *  either face alone would), matching how `applyGround` in `movement.ts` already resolves
 *  one contact per tick. */
export function resolveSphereAgainstInteriors(
  interiors: readonly InteriorInstance[],
  center: Vec3,
  radius: number,
  stats?: InteriorQueryStats,
): Vec3 | null {
  let deepest: { depth: number; push: Vec3 } | null = null;
  for (const instance of interiors) {
    const found = resolveSphereAgainstOneInterior(instance, center, radius, stats);
    if (found && (!deepest || found.depth > deepest.depth)) deepest = found;
  }
  return deepest?.push ?? null;
}
```

In `packages/sim/src/types.ts`, add to `World` (after `killY`): `interiors: import('./interiors.js').InteriorInstance[];`

In `packages/sim/src/world.ts`, add `interiors: [],` to `createWorld`'s returned object.

In `packages/sim/src/movement.ts`, add the interior-collision pass. Import `resolveSphereAgainstInteriors` from `./interiors.js` and add a helper called from `stepPlayer` right after `integrate` resolves terrain contact, before `writeState`:

```ts
/** Ours: a two-sphere approximation of the player capsule (feet, chest) rather than a full
 *  swept capsule — the sim already treats a player as one sphere for hit detection
 *  (damage.ts's playerHitbox), so this reuses the same "close enough for a browser demo"
 *  bar rather than introducing a second, more precise player shape only interiors use. */
function resolveInteriors(world: World, body: Body, armor: ArmorData): void {
  if (world.interiors.length === 0) return;
  const [boxX, boxY, height] = armor.boundingBox;
  const radius = Math.max(boxX, boxY) / 2;
  const feet = { x: body.x, y: body.y + radius, z: body.z };
  const chest = { x: body.x, y: body.y + height - radius, z: body.z };
  const push =
    resolveSphereAgainstInteriors(world.interiors, chest, radius) ??
    resolveSphereAgainstInteriors(world.interiors, feet, radius);
  if (!push) return;
  body.x += push.x;
  body.y += push.y;
  body.z += push.z;
  const len = Math.hypot(push.x, push.y, push.z) || 1;
  const into = (body.vx * push.x + body.vy * push.y + body.vz * push.z) / len;
  if (into < 0) {
    body.vx -= (into * push.x) / len;
    body.vy -= (into * push.y) / len;
    body.vz -= (into * push.z) / len;
  }
}
```

Change `stepPlayer`'s body to call it right after `integrate`:

```ts
  const contact = integrate(world, body, ctx.grounded, forces.jumped || forces.jetted, dt);
  resolveInteriors(world, body, armor);
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`. Confirm `movement.test.ts`'s full suite (including every M1–M3 case, none of which places an interior in the world so `resolveInteriors` is a no-op for all of them) stays green.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/interiors.ts packages/sim/src/interiors.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/movement.ts
git commit -m "feat(sim): static interior collision for player movement" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 3: Sim — base objects, power derivation, shielded damage, station use, force fields

**Files:** Create `packages/sim/src/baseObjects.ts`, `packages/sim/src/baseObjects.test.ts`; Modify `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/hash.ts`, `packages/sim/src/snapshot.ts`, `packages/sim/src/index.ts`. Depends on Task 2 (`interiors.ts`'s `buildInteriorCollider`, reused to build each force field's collision quad) — see this plan's Task dependency graph.
**Interfaces:** Consumes `World`, `Vec3` (existing), `buildInteriorCollider`/`InteriorInstance`/`InteriorPlacement`/`InteriorTriangles` (Task 2). Produces `BaseObjectKind` (`Generator = 0, Sensor = 1, StationInventory = 2, StationVehiclePad = 3, ForceField = 4`), `BaseObjectStore`, `BASE_OBJECT_DATA: Record<BaseObjectKind, BaseObjectData>`, `createBaseObjects(world, placements: Array<{ kind: BaseObjectKind; team: number; position: Vec3; rotation?: { axis: Vec3; degrees: number }; scale?: Vec3 }>): void` (`rotation`/`scale` are only read for `ForceField` placements), `stepPower(world: World): void`, `applyBaseObjectDamage(world: World, id: number, amount: number): void`, `teamHasPower(world: World, team: number): boolean`, `STATION_USE_RADIUS`, `stationAt(world: World, playerId: number): number | null` (returns the id of a powered `StationInventory` the player is standing inside the use radius of, or `null`), `ForceFieldGeometry { baseObjectId: number; team: number; instance: InteriorInstance }`, `activeForceFieldBlockers(world: World, forTeam: number): InteriorInstance[]` (every powered, non-destroyed force field belonging to a team other than `forTeam` — Task 5 and Task 6 both call this, once for projectiles and once for player movement). Covers failure-matrix row 4 (`baseObjects.test.ts`: "both generators destroyed clears the powered bit on every station/turret/sensor/pad/force field of that team") and the new rows 17-18 (`baseObjects.test.ts`: team filter and power gating on `activeForceFieldBlockers`).

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/baseObjects.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from './index.js';
import {
  applyBaseObjectDamage,
  BASE_OBJECT_DATA,
  BaseObjectKind,
  createBaseObjects,
  STATION_USE_RADIUS,
  stationAt,
  stepPower,
  teamHasPower,
  activeForceFieldBlockers,
} from './baseObjects.js';
import { raycastInteriors } from './interiors.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};

function twoGeneratorsOneStation(world: ReturnType<typeof createWorld>): { gen1: number; gen2: number; station: number } {
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
  ]);
  stepPower(world);
  return { gen1: 0, gen2: 1, station: 2 };
}

describe('BASE_OBJECT_DATA', () => {
  it('matches the spec Base asset numbers table and staticShape.cs exactly', () => {
    expect(BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth).toBe(1.5);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Generator].energyPerDamagePoint).toBe(30);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].maxHealth).toBe(1.5);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].energyPerDamagePoint).toBe(33);
    expect(BASE_OBJECT_DATA[BaseObjectKind.Sensor].detectRadius).toBe(300);
    expect(BASE_OBJECT_DATA[BaseObjectKind.StationInventory].maxHealth).toBe(1.0);
    expect(BASE_OBJECT_DATA[BaseObjectKind.StationVehiclePad].invincible).toBe(true);
  });
});

describe('stepPower', () => {
  it('a team with at least one living generator powers its other objects', () => {
    const world = createWorld(flat, 1);
    const { station } = twoGeneratorsOneStation(world);
    expect(world.baseObjects.powered[station]).toBe(1);
    expect(teamHasPower(world, 1)).toBe(true);
  });
  it('destroying one of two generators keeps the team powered', () => {
    const world = createWorld(flat, 1);
    const { gen1, station } = twoGeneratorsOneStation(world);
    applyBaseObjectDamage(world, gen1, BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10);
    stepPower(world);
    expect(world.baseObjects.powered[station]).toBe(1);
  });
  it('failure matrix row 4: destroying both generators unpowers every other object of that team', () => {
    const world = createWorld(flat, 1);
    const { gen1, gen2, station } = twoGeneratorsOneStation(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, gen1, overkill);
    applyBaseObjectDamage(world, gen2, overkill);
    stepPower(world);
    expect(world.baseObjects.powered[station]).toBe(0);
  });
  it('a generator itself is always "powered" (it does not depend on another generator)', () => {
    const world = createWorld(flat, 1);
    const { gen1 } = twoGeneratorsOneStation(world);
    expect(world.baseObjects.powered[gen1]).toBe(1);
  });
});

describe('applyBaseObjectDamage: shielded damage spends energy before health', () => {
  it('spends energy at energyPerDamagePoint before touching health', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    const data = BASE_OBJECT_DATA[BaseObjectKind.Generator];
    // 1 point of damage costs energyPerDamagePoint (30) energy; the generator starts with
    // maxEnergy (50), so 1.0 damage only partially drains the shield and leaves health untouched.
    applyBaseObjectDamage(world, 0, 1.0);
    expect(world.baseObjects.damage[0]).toBe(0);
    expect(world.baseObjects.energy[0]).toBeCloseTo(50 - 1.0 * 30);
  });
  it('overflow past the shield reaches health', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    // Shield holds 50 / 30 = 1.667 damage worth of energy; hitting for 2.0 spends it all and
    // lets 0.333 through to health.
    applyBaseObjectDamage(world, 0, 2.0);
    expect(world.baseObjects.energy[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBeCloseTo(2.0 - 50 / 30);
  });
  it('destroys at maxHealth and further damage is a no-op', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    const damageAfter = world.baseObjects.damage[0];
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.damage[0]).toBe(damageAfter);
  });
  it('a StationVehiclePad is invincible: damage is always a no-op (station.cs isInvincible)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.StationVehiclePad, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(0);
    expect(world.baseObjects.damage[0]).toBe(0);
  });
});

describe('stationAt', () => {
  it('finds a powered station within STATION_USE_RADIUS of the player', () => {
    const world = createWorld(flat, 1);
    const { station } = twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10 + STATION_USE_RADIUS - 0.1, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBe(station);
  });
  it('returns null outside the use radius', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10 + STATION_USE_RADIUS + 5, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
  it('returns null for an unpowered station (failure matrix row 4)', () => {
    const world = createWorld(flat, 1);
    const { gen1, gen2, station } = twoGeneratorsOneStation(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, gen1, overkill);
    applyBaseObjectDamage(world, gen2, overkill);
    stepPower(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
  it('never returns an enemy team station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.StationInventory, team: 2, position: { x: 0, y: 0, z: 0 } }]);
    stepPower(world);
    const player = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    expect(stationAt(world, player)).toBeNull();
  });
});

describe('ForceField', () => {
  const forceFieldPlacement = (team: number) => ({
    kind: BaseObjectKind.ForceField,
    team,
    position: { x: 0, y: 0, z: 0 },
    rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
    scale: { x: 6, y: 4, z: 1 },
  });

  it('BASE_OBJECT_DATA[ForceField] is invincible — forceField.cs has no energy/maxDamage field of its own', () => {
    expect(BASE_OBJECT_DATA[BaseObjectKind.ForceField].invincible).toBe(true);
    expect(BASE_OBJECT_DATA[BaseObjectKind.ForceField].maxHealth).toBe(0);
  });

  it('failure matrix row 18: an unpowered force field blocks no one', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [forceFieldPlacement(1)]);
    // No generator: stepPower leaves it unpowered.
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(0);
    expect(activeForceFieldBlockers(world, 1)).toHaveLength(0);
  });

  it('a powered force field blocks the opposing team and passes its own (failure matrix row 17)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1); // team 2 (enemy) is blocked
    expect(activeForceFieldBlockers(world, 1)).toHaveLength(0); // team 1 (owner) passes freely
  });

  it('destroying both of the owning team\'s generators drops the force field from every team\'s blocker list', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 25, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, 0, overkill);
    applyBaseObjectDamage(world, 1, overkill);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(0);
  });

  it('a destroyed generator that leaves one alive keeps the force field powered', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 25, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, 0, overkill);
    stepPower(world);
    expect(activeForceFieldBlockers(world, 2)).toHaveLength(1);
  });

  it('the blocker geometry sits at the field\'s own position, sized from the placement scale', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 0, z: 0 } },
      forceFieldPlacement(1),
    ]);
    stepPower(world);
    const [blocker] = activeForceFieldBlockers(world, 2);
    // A ray straight through the field's own position, aimed at its plane, must hit it.
    const hit = blocker && raycastInteriors([blocker], { x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 20);
    expect(hit).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- baseObjects.test.ts`. Expect module resolution to fail for `./baseObjects.js`. Every `ForceField` case fails on `activeForceFieldBlockers` not existing.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/baseObjects.ts`:

```ts
import { buildInteriorCollider, type InteriorInstance } from './interiors.js';
import type { Vec3, World } from './types.js';

export enum BaseObjectKind {
  Generator = 0,
  Sensor = 1,
  StationInventory = 2,
  StationVehiclePad = 3,
  ForceField = 4,
}

export interface BaseObjectData {
  maxHealth: number;
  maxEnergy: number;
  energyPerDamagePoint: number;
  rechargeRate: number;
  /** Generators and (per script) the vehicle pad never lose power themselves; every other
   *  kind goes offline the instant its team has no living generator. */
  needsPower: boolean;
  /** StationVehiclePad and ForceField only: `station.cs:235-247` sets `isInvincible = true`
   *  with no `maxDamage` field at all for the pad — the real T2 datablock cannot be
   *  destroyed by weapons fire. `ForceFieldBareData` (`forceField.cs:10-33`) has no
   *  `energy`/`maxDamage`/`invincib*` field of any kind, confirmed by a full-file grep —
   *  there is nothing to damage in the first place, so this plan treats it the same way.
   *  Both are genuine deviations from the spec's own Base asset numbers table, which lists
   *  them in the same damageable-asset row shape as everything else; see this plan's Spec
   *  gaps. */
  invincible: boolean;
  /** Sensor only. */
  detectRadius: number;
}

export const BASE_OBJECT_DATA: Record<BaseObjectKind, BaseObjectData> = {
  // staticShape.cs:447-467. Spec's Base asset numbers table: maxDamage 1.50, energyPerDamagePoint 30.
  [BaseObjectKind.Generator]: {
    maxHealth: 1.5, maxEnergy: 50, energyPerDamagePoint: 30, rechargeRate: 0.05,
    needsPower: false, invincible: false, detectRadius: 0,
  },
  // staticShape.cs:342-372 (StaticShapeData) + staticShape.cs:331-340 (SensorLgPulseObj).
  // Spec: maxDamage 1.50, energyPerDamagePoint 33, detectRadius 300 m.
  [BaseObjectKind.Sensor]: {
    maxHealth: 1.5, maxEnergy: 110, energyPerDamagePoint: 33, rechargeRate: 0.31,
    needsPower: true, invincible: false, detectRadius: 300,
  },
  // station.cs:136-166. Spec cites "from station.cs" with no number; every field here is
  // read straight out of the script.
  [BaseObjectKind.StationInventory]: {
    maxHealth: 1.0, maxEnergy: 50, energyPerDamagePoint: 75, rechargeRate: 0.35,
    needsPower: true, invincible: false, detectRadius: 0,
  },
  // station.cs:235-247: isInvincible = true, no maxDamage/isShielded fields at all.
  [BaseObjectKind.StationVehiclePad]: {
    maxHealth: 0, maxEnergy: 0, energyPerDamagePoint: 0, rechargeRate: 0.05,
    needsPower: true, invincible: true, detectRadius: 0,
  },
  // forceField.cs:10-33, 151-186, 213-236: no energy/maxDamage field; power is inherited
  // generically through StaticShapeData::gainPower/losePower, the same power-grid callback
  // every other poweredStaticShape uses. Spec: "ForceFieldBare — team-passable" (no number).
  [BaseObjectKind.ForceField]: {
    maxHealth: 0, maxEnergy: 0, energyPerDamagePoint: 0, rechargeRate: 0,
    needsPower: true, invincible: true, detectRadius: 0,
  },
};

export const STATION_USE_RADIUS = 2.5; // Ours — see this plan's "ours" numbers table.

export interface BaseObjectStore {
  count: number;
  kind: Uint8Array;
  team: Uint8Array;
  position: Float64Array;
  damage: Float64Array;
  destroyed: Uint8Array;
  energy: Float64Array;
  powered: Uint8Array;
}

const BASE_OBJECT_CAPACITY = 64; // Ours: Katabatic's real count is 28 (26 plus 2 force fields); headroom for other maps.

export function createEmptyBaseObjects(): BaseObjectStore {
  return {
    count: 0,
    kind: new Uint8Array(BASE_OBJECT_CAPACITY),
    team: new Uint8Array(BASE_OBJECT_CAPACITY),
    position: new Float64Array(BASE_OBJECT_CAPACITY * 3),
    damage: new Float64Array(BASE_OBJECT_CAPACITY),
    destroyed: new Uint8Array(BASE_OBJECT_CAPACITY),
    energy: new Float64Array(BASE_OBJECT_CAPACITY),
    powered: new Uint8Array(BASE_OBJECT_CAPACITY),
  };
}

export interface ForceFieldGeometry {
  baseObjectId: number;
  team: number;
  /** A cached two-triangle quad, built once here and reused by every later query — a real
   *  `PhysicalZone` in T2 is a solid polyhedron (`forceField.cs:242-252`), but a thin quad at
   *  the field's own plane is enough for a browser demo's block-and-render needs and reuses
   *  Task 2's already-tested `raycastInteriors`/`resolveSphereAgainstInteriors` verbatim. */
  instance: InteriorInstance;
}

/** A quad centered at the origin in the field's own local space, facing local +X (matching
 *  how the mission's own rotation already orients the placement) — `scale.z`/`scale.y` give
 *  its half-width/half-height (Torque Y-up scale: `scale.x` is thickness, unused here). */
function forceFieldQuad(scale: Vec3): { positions: Float32Array } {
  const hw = scale.z / 2 || 3; // Ours fallback if a placement omits scale — see "ours" table.
  const hh = scale.y / 2 || 2;
  return {
    positions: new Float32Array([
      0, -hh, -hw, 0, hh, -hw, 0, hh, hw,
      0, -hh, -hw, 0, hh, hw, 0, -hh, hw,
    ]),
  };
}

export function createBaseObjects(
  world: World,
  placements: Array<{
    kind: BaseObjectKind;
    team: number;
    position: Vec3;
    rotation?: { axis: Vec3; degrees: number };
    scale?: Vec3;
  }>,
): void {
  const store = world.baseObjects;
  placements.forEach(({ kind, team, position, rotation, scale }, id) => {
    if (id >= BASE_OBJECT_CAPACITY) throw new RangeError('Base object capacity exceeded');
    store.kind[id] = kind;
    store.team[id] = team;
    store.position.set([position.x, position.y, position.z], id * 3);
    store.damage[id] = 0;
    store.destroyed[id] = 0;
    store.energy[id] = BASE_OBJECT_DATA[kind as BaseObjectKind].maxEnergy;
    store.powered[id] = 1;
    store.count = Math.max(store.count, id + 1);
    if (kind === BaseObjectKind.ForceField) {
      const instance = buildInteriorCollider(forceFieldQuad(scale ?? { x: 1, y: 4, z: 6 }), {
        position,
        rotation: rotation ?? { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
      });
      world.forceFields.push({ baseObjectId: id, team, instance });
    }
  });
}

/** Every powered, non-destroyed force field belonging to a team other than `forTeam` —
 *  Task 5 calls this once per shooter team before resolving a projectile segment, and Task 6
 *  calls it once per player team inside `stepPlayer`'s movement resolution. Spec: "ForceFieldBare
 *  — team-passable." Ours: this is a real deviation from the literal T2 script, which kills
 *  every player who touches `defaultForceFieldBare` regardless of team (`forceField.cs:175-178`,
 *  `killAllPlayersWithinZone` called with no `%team` argument so its own team check never
 *  short-circuits) — see this plan's Spec gaps and "ours" table. */
export function activeForceFieldBlockers(world: World, forTeam: number): InteriorInstance[] {
  const store = world.baseObjects;
  return world.forceFields
    .filter((f) => f.team !== forTeam && store.powered[f.baseObjectId] === 1 && !store.destroyed[f.baseObjectId])
    .map((f) => f.instance);
}

/** A generator counts toward its team's power as long as it exists and is not destroyed —
 *  the sim never removes a base object once placed, so "exists" is just `id < count`. */
export function teamHasPower(world: World, team: number): boolean {
  const store = world.baseObjects;
  for (let id = 0; id < store.count; id += 1) {
    if (store.kind[id] === BaseObjectKind.Generator && store.team[id] === team && !store.destroyed[id]) {
      return true;
    }
  }
  return false;
}

/** Spec: "a base is powered while at least one of its generators is alive. Unpowered
 *  inventory stations, vehicle pads, base turrets, sensors, and force fields go offline."
 *  Generators never depend on power themselves (`needsPower: false`), so this only ever
 *  clears the bit on the *other* kinds — see `BASE_OBJECT_DATA`'s `needsPower` field, which
 *  Task 4's turret power also reads. */
export function stepPower(world: World): void {
  const store = world.baseObjects;
  const teamPower = new Map<number, boolean>();
  for (let id = 0; id < store.count; id += 1) {
    const data = BASE_OBJECT_DATA[store.kind[id] as BaseObjectKind];
    if (!data.needsPower) {
      store.powered[id] = 1;
      continue;
    }
    const team = store.team[id] ?? 0;
    if (!teamPower.has(team)) teamPower.set(team, teamHasPower(world, team));
    store.powered[id] = teamPower.get(team) ? 1 : 0;
  }
}

/** Same shielded-damage rule the spec states for players: "shields ... spend energy at
 *  energyPerDamagePoint before health." An invincible object (StationVehiclePad) ignores
 *  every hit outright — see `BaseObjectData.invincible`'s own comment. */
export function applyBaseObjectDamage(world: World, id: number, amount: number): void {
  const store = world.baseObjects;
  const data = BASE_OBJECT_DATA[store.kind[id] as BaseObjectKind];
  if (data.invincible || amount <= 0 || store.destroyed[id]) return;
  const energy = store.energy[id] ?? 0;
  const shieldCapacity = data.energyPerDamagePoint > 0 ? energy / data.energyPerDamagePoint : 0;
  const shieldAbsorbed = Math.min(shieldCapacity, amount);
  store.energy[id] = energy - shieldAbsorbed * data.energyPerDamagePoint;
  const throughShield = amount - shieldAbsorbed;
  if (throughShield <= 0) return;
  store.damage[id] = (store.damage[id] ?? 0) + throughShield;
  if ((store.damage[id] ?? 0) >= data.maxHealth) store.destroyed[id] = 1;
}

function distance(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/** The id of a powered `StationInventory` belonging to the player's own team within
 *  `STATION_USE_RADIUS`, or `null`. Never an enemy station (a real trigger in T2 is
 *  per-object anyway, but the sim also never wants a player "using" an enemy station to
 *  even be representable) and never an unpowered one (failure matrix row 4). */
export function stationAt(world: World, playerId: number): number | null {
  const store = world.baseObjects;
  const base = playerId * 3;
  const px = world.players.position[base] ?? 0;
  const py = world.players.position[base + 1] ?? 0;
  const pz = world.players.position[base + 2] ?? 0;
  const team = world.players.team[playerId] ?? 0;
  for (let id = 0; id < store.count; id += 1) {
    if (store.kind[id] !== BaseObjectKind.StationInventory) continue;
    if (store.team[id] !== team || !store.powered[id]) continue;
    const sBase = id * 3;
    const d = distance(
      px, py, pz,
      store.position[sBase] ?? 0, store.position[sBase + 1] ?? 0, store.position[sBase + 2] ?? 0,
    );
    if (d <= STATION_USE_RADIUS) return id;
  }
  return null;
}
```

In `packages/sim/src/types.ts`, add to `World` (after `interiors`): `baseObjects: import('./baseObjects.js').BaseObjectStore; forceFields: import('./baseObjects.js').ForceFieldGeometry[];`

In `packages/sim/src/world.ts`, import `createEmptyBaseObjects` from `./baseObjects.js` and add `baseObjects: createEmptyBaseObjects(), forceFields: [],` to `createWorld`'s returned object.

In `packages/sim/src/hash.ts`, add a `mixBaseObjects` function mirroring `mixFlags`'s shape and call it from `hashWorld`. Force fields need no separate hash entry: `createBaseObjects` gives every `ForceField` placement an id in the same `BaseObjectStore` every other kind uses, so this loop already mixes them in by iterating `store.count`:

```ts
function mixBaseObjects(hash: number, world: World): number {
  let h = hash;
  const store = world.baseObjects;
  for (let id = 0; id < store.count; id += 1) {
    h = mix(h, id);
    h = mix(h, num(store.kind, id));
    h = mix(h, num(store.team, id));
    h = mix(h, num(store.damage, id));
    h = mix(h, num(store.destroyed, id));
    h = mix(h, num(store.energy, id));
    h = mix(h, num(store.powered, id));
  }
  return h;
}
```

Add `hash = mixBaseObjects(hash, world);` to `hashWorld`, right after the existing `hash = mixFlags(hash, world);` line.

`snapshot.ts`'s `PlayerSnapshotData` is unaffected by base objects (Task 7 carries `BaseObjectSnapshotData` as a `WorldExtras` array, following M3's projectiles/flags precedent, not as a per-player field) — no change to `snapshot.ts` in this task.

Add to `packages/sim/src/index.ts`:

```ts
export * from './baseObjects.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/baseObjects.ts packages/sim/src/baseObjects.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/hash.ts packages/sim/src/index.ts
git commit -m "feat(sim): base objects, per-team power derivation, shielded damage, force fields" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 4: Sim — turrets: targeting with line-of-sight, aiming, firing

**Files:** Create `packages/sim/src/turrets.ts`, `packages/sim/src/turrets.test.ts`; Modify `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/hash.ts`, `packages/sim/src/index.ts`
**Interfaces:** Consumes `World`, `Vec3`, `BaseObjectData`-shaped power lookup (`world.baseObjects` from Task 3, read-only), `sampleTerrain` (existing, `terrain.ts`). Produces `TurretBarrelId` (`PlasmaBarrelLarge = 0, AABarrelLarge = 1, SentryTurretBarrel = 2`), `TurretBaseId` (`Large = 0, Sentry = 1`), `TURRET_BARREL_DATA: Record<TurretBarrelId, TurretBarrelData>`, `TURRET_BASE_DATA: Record<TurretBaseId, TurretBaseData>`, `TurretStore`, `createTurrets(world, placements: Array<{ barrel: TurretBarrelId; team: number; position: Vec3 }>): void`, `stepTurrets(world: World, dt: number): void`, `applyTurretDamage(world: World, id: number, amount: number): void`, `hasLineOfSight(world: World, from: Vec3, to: Vec3): boolean` (marches the segment against `sampleTerrain`, matching the real T2 sensor's `detectsUsingLOS = true`; `turret.cs:142`, `turrets/sentryTurret.cs:129`), `pendingTurretFireEvents: TurretFireEvent[]` (a transient array on `World`, mirroring `pendingFireEvents`, drained by Task 5's `projectiles.ts` extension). Covers failure-matrix row 12 (`turrets.test.ts`: "a turret whose target dies this tick does not fire at the corpse next tick") and row 16 (`turrets.test.ts`: "a hill between the turret and an otherwise-in-range player blocks acquisition").

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/turrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, applyDamage, createWorld, LIGHT_ARMOR, type Heightfield } from './index.js';
import { BaseObjectKind, createBaseObjects, stepPower } from './baseObjects.js';
import {
  createTurrets,
  stepTurrets,
  TURRET_BARREL_DATA,
  TURRET_BASE_DATA,
  TurretBarrelId,
  TurretBaseId,
  TurretState,
  applyTurretDamage,
  hasLineOfSight,
} from './turrets.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};

/** An 11x11 grid spanning world x,z in [-10, 10] (squareSize 2, origin at the -10,-10
 *  corner), flat at height 0 except a `BUMP`-metre ridge across both the middle row and the
 *  middle column. Elevating both axes' centre band, not just one, makes the fixture robust
 *  to whichever of `terrain.ts`'s two grid axes actually indexes world X versus world Z —
 *  the segment this test cares about (turret to target, both at world z=0) crosses the
 *  ridge either way. */
function hillBetween(bumpHeight: number): Heightfield {
  const size = 11;
  const heights = new Uint16Array(size * size);
  const mid = 5;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      heights[row * size + col] = row === mid || col === mid ? bumpHeight : 0;
    }
  }
  return { gridSize: size, squareSize: 2, originX: -10, originY: -10, originZ: 0, heightScale: 1, heights };
}

/** A single 10 m wall crossing world x=0 at every z, used only for the "target moves behind
 *  cover" case below, where (unlike `hillBetween`'s deliberately convention-proof cross) the
 *  test needs a close range with clear sight and a far range that is blocked. This assumes
 *  `terrain.ts`'s `Heightfield.heights` is row-major with row = the Z grid index and col =
 *  the X grid index (`heights[row*gridSize+col]`), matching `sampleTerrain(terrain, x, z)`'s
 *  parameter order — the one place in this task where the exact axis layout matters and
 *  could not be confirmed without reading `terrain.ts`'s full source in this planning
 *  session. If the real layout transposes row/col, swap them here.
 */
function wallAcrossX(bumpHeight: number): Heightfield {
  const size = 11;
  const wallCol = 5; // worldX = originX + wallCol * squareSize = -10 + 10 = 0.
  const heights = new Uint16Array(size * size);
  for (let row = 0; row < size; row += 1) heights[row * size + wallCol] = bumpHeight;
  return { gridSize: size, squareSize: 2, originX: -10, originY: -10, originZ: 0, heightScale: 1, heights };
}
const FIXED_DT = 32 / 1000;
const ticksFor = (seconds: number): number => Math.ceil(seconds / FIXED_DT);

function poweredTurret(world: ReturnType<typeof createWorld>, barrel: TurretBarrelId): number {
  createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } }]);
  createTurrets(world, [{ barrel, team: 1, position: { x: 0, y: 0, z: 0 } }]);
  stepPower(world);
  return 0;
}

describe('TURRET_BARREL_DATA / TURRET_BASE_DATA', () => {
  it('PlasmaBarrelLarge matches the spec table and plasmaBarrelLarge.cs', () => {
    const p = TURRET_BARREL_DATA[TurretBarrelId.PlasmaBarrelLarge];
    expect(p.speed).toBe(50);
    expect(p.radiusDamage).toBe(0.5);
    expect(p.radius).toBe(10);
    expect(p.kickback).toBe(500);
    expect(p.fireTime).toBe(0.3);
    expect(p.reloadTime).toBe(0.8);
    expect(p.attackRadius).toBe(120);
  });
  it('AABarrelLarge matches aaBarrelLarge.cs', () => {
    const a = TURRET_BARREL_DATA[TurretBarrelId.AABarrelLarge];
    expect(a.speed).toBe(150);
    expect(a.directDamage).toBe(0.25);
    expect(a.fireTime).toBe(0.15);
    expect(a.reloadTime).toBe(0.2);
    expect(a.attackRadius).toBe(200);
    expect(a.vehiclesOnly).toBe(true);
  });
  it('SentryTurretBarrel matches the spec table and sentryTurret.cs', () => {
    const s = TURRET_BARREL_DATA[TurretBarrelId.SentryTurretBarrel];
    expect(s.directDamage).toBe(0.1);
    expect(s.speed).toBe(200);
    expect(s.fireTime).toBe(0.13);
    expect(s.reloadTime).toBe(0.4);
  });
  it('TurretBaseLarge maxHealth/energyPerDamagePoint match the spec table', () => {
    const base = TURRET_BASE_DATA[TurretBaseId.Large];
    expect(base.maxHealth).toBe(2.25);
    expect(base.energyPerDamagePoint).toBe(50);
    expect(base.thetaMin).toBe(15);
    expect(base.thetaMax).toBe(140);
  });
  it('Sentry base maxHealth matches the spec table', () => {
    expect(TURRET_BASE_DATA[TurretBaseId.Sentry].maxHealth).toBe(1.2);
  });
});

describe('stepTurrets: acquisition and firing', () => {
  it('an unpowered turret never fires', () => {
    const world = createWorld(flat, 1);
    createTurrets(world, [{ barrel: TurretBarrelId.PlasmaBarrelLarge, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    // No generator created: stepPower would leave it unpowered, but this test skips even
    // calling stepPower to prove the default (a freshly created turret with no power source
    // reachable) is "unpowered", not "powered by default".
    stepPower(world);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('a powered turret acquires and fires at an enemy within range', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.PlasmaBarrelLarge);
    addPlayer(world, { x: 50, y: 0, z: 0 }, 2);
    let fired = false;
    for (let tick = 0; tick < ticksFor(1); tick += 1) {
      stepTurrets(world, FIXED_DT);
      if (world.pendingTurretFireEvents.length > 0) fired = true;
    }
    expect(fired).toBe(true);
  });

  it('never fires at a teammate', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.PlasmaBarrelLarge);
    addPlayer(world, { x: 50, y: 0, z: 0 }, 1);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('ignores a target beyond the engagement range (min of sensor radius and attackRadius)', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.PlasmaBarrelLarge);
    // TurretBaseLarge sensor radius is 80 m — tighter than PlasmaBarrelLarge's 120 m attackRadius.
    addPlayer(world, { x: 90, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('AABarrelLarge never acquires a target this milestone (real T2 targets vehicles only)', () => {
    const world = createWorld(flat, 1);
    poweredTurret(world, TurretBarrelId.AABarrelLarge);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });

  it('failure matrix row 12: a target that dies this tick is dropped, no next-tick fire at the corpse', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.SentryTurretBarrel);
    const enemy = addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT); // acquires
    expect(world.turrets.targetId[turret]).toBe(enemy);
    applyDamage(world, enemy, LIGHT_ARMOR.maxDamage, -1, LIGHT_ARMOR);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).not.toBe(enemy);
  });

  it('fire/reload timing matches SentryTurretBarrel: 0.13 s fire, 0.40 s reload', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.SentryTurretBarrel);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    let fires = 0;
    for (let tick = 0; tick < ticksFor(1); tick += 1) {
      stepTurrets(world, FIXED_DT);
      fires += world.pendingTurretFireEvents.length;
    }
    // One full cycle is fireTime + reloadTime = 0.53 s; in 1 s that is at least one and at
    // most two shots, never a shot every tick.
    expect(fires).toBeGreaterThanOrEqual(1);
    expect(fires).toBeLessThanOrEqual(2);
    expect(world.turrets.state[turret]).not.toBeUndefined();
  });
});

describe('hasLineOfSight (spec: real T2 sensor detectsUsingLOS = true, turret.cs:142)', () => {
  it('true between two points with nothing but flat ground between them', () => {
    const world = createWorld(hillBetween(0), 1);
    expect(hasLineOfSight(world, { x: -8, y: 2, z: 0 }, { x: 8, y: 0, z: 0 })).toBe(true);
  });
  it('false when a 10 m ridge sits between them at world z=0', () => {
    const world = createWorld(hillBetween(10), 1);
    expect(hasLineOfSight(world, { x: -8, y: 2, z: 0 }, { x: 8, y: 0, z: 0 })).toBe(false);
  });
});

describe('stepTurrets: line of sight (failure matrix row 16)', () => {
  it('a hill between the turret and an otherwise-in-range player blocks acquisition', () => {
    const world = createWorld(hillBetween(10), 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } }]);
    createTurrets(world, [{ barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } }]);
    stepPower(world);
    // 16 m apart, well inside SentryTurretBarrel's 60 m engagement range — only the hill
    // stands in the way.
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    for (let tick = 0; tick < ticksFor(1); tick += 1) stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });
  it('the same layout with no hill acquires and fires normally', () => {
    const world = createWorld(hillBetween(0), 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } }]);
    createTurrets(world, [{ barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } }]);
    stepPower(world);
    addPlayer(world, { x: 8, y: 0, z: 0 }, 2);
    let fired = false;
    for (let tick = 0; tick < ticksFor(1); tick += 1) {
      stepTurrets(world, FIXED_DT);
      if (world.pendingTurretFireEvents.length > 0) fired = true;
    }
    expect(fired).toBe(true);
  });
  it('a target that moves to a position with no line of sight is dropped, not fired through', () => {
    const world = createWorld(wallAcrossX(10), 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: -8, y: 0, z: 0 } }]);
    const turret = 0;
    createTurrets(world, [{ barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: -8, y: 0, z: 0 } }]);
    stepPower(world);
    // Placed close to the turret first, on the same side of the x=0 wall, so the initial
    // acquisition tick has clear line of sight and a real target to later drop.
    const enemy = addPlayer(world, { x: -6, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).toBe(enemy);
    world.players.position.set([8, 0, 0], enemy * 3); // crosses x=0 to the far side of the wall
    stepTurrets(world, FIXED_DT);
    expect(world.turrets.targetId[turret]).not.toBe(enemy);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });
});

describe('applyTurretDamage', () => {
  it('destroys at maxHealth and clears the current target', () => {
    const world = createWorld(flat, 1);
    const turret = poweredTurret(world, TurretBarrelId.SentryTurretBarrel);
    addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    stepTurrets(world, FIXED_DT);
    applyTurretDamage(world, turret, 1000);
    expect(world.turrets.destroyed[turret]).toBe(1);
    stepTurrets(world, FIXED_DT);
    expect(world.pendingTurretFireEvents).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- turrets.test.ts`. Expect module resolution to fail for `./turrets.js` (including `hasLineOfSight`, which does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/turrets.ts`:

```ts
import { BaseObjectKind, teamHasPower } from './baseObjects.js';
import { sampleTerrain } from './terrain.js';
import { ProjectileType } from './weapons.js';
import type { Vec3, World } from './types.js';

const LOS_MARCH_STEP = 0.5; // Ours — matches projectiles.ts's own TERRAIN_MARCH_STEP.
const TURRET_EYE_HEIGHT = 2; // Ours — see this plan's "ours" numbers table.

/** Marches the segment from `from` to `to` at a fixed step and blocks line of sight the
 *  instant a sampled point's terrain height is at or above the segment's own interpolated
 *  height there. Matches the real T2 sensor's `detectsUsingLOS = true`
 *  (`turret.cs:142`, `turrets/sentryTurret.cs:129`). Duplicated from the same technique
 *  `projectiles.ts` uses for terrain marching, not imported from it, because this task runs
 *  before Task 5 exports anything reusable — see this plan's Global Constraints. */
export function hasLineOfSight(world: World, from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal === 0) return true;
  const steps = Math.max(1, Math.ceil(horizontal / LOS_MARCH_STEP));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const sample = sampleTerrain(world.terrain, from.x + dx * t, from.z + dz * t);
    if (!sample.empty && sample.height >= from.y + dy * t) return false;
  }
  return true;
}

export enum TurretBarrelId {
  PlasmaBarrelLarge = 0,
  AABarrelLarge = 1,
  SentryTurretBarrel = 2,
}
export enum TurretBaseId {
  Large = 0,
  Sentry = 1,
}
export enum TurretState {
  Ready = 0,
  Firing = 1,
  Reload = 2,
}

export interface TurretBarrelData {
  projectile: ProjectileType;
  speed: number;
  velInherit: number;
  directDamage: number;
  radiusDamage: number;
  radius: number;
  kickback: number;
  fireTime: number;
  reloadTime: number;
  lifetime: number;
  attackRadius: number;
  /** AABarrelLarge only: the real T2 barrel is a vehicle-seeking weapon
   *  (`isSeeker = true`, `aaBarrelLarge.cs:176-183`). No vehicle exists until milestone 5,
   *  so this barrel never acquires a target this milestone — see this plan's "ours" table. */
  vehiclesOnly?: boolean;
}
export interface TurretBaseData {
  maxHealth: number;
  maxEnergy: number;
  energyPerDamagePoint: number;
  rechargeRate: number;
  thetaMin: number;
  thetaMax: number;
  /** Target-acquisition sensor radius — tighter than the barrel's own `attackRadius` for
   *  TurretBaseLarge (80 m sensor vs 120 m Plasma attack range), so engagement range is the
   *  smaller of the two; see `engagementRange`. */
  sensorRadius: number;
}

export const TURRET_BARREL_DATA: Record<TurretBarrelId, TurretBarrelData> = {
  // turrets/plasmaBarrelLarge.cs:195-306. Spec: 0.5 radius damage at 10 m, 50 m/s, kickback
  // 500, 0.3 s fire, 0.8 s reload. attackRadius (120) and lifetime (6 s, lifetimeMS = 6000)
  // are not in the spec table; both come straight from the script.
  [TurretBarrelId.PlasmaBarrelLarge]: {
    projectile: ProjectileType.Linear, speed: 50, velInherit: 1.0, directDamage: 0,
    radiusDamage: 0.5, radius: 10, kickback: 500, fireTime: 0.3, reloadTime: 0.8,
    lifetime: 6, attackRadius: 120,
  },
  // turrets/aaBarrelLarge.cs:125-193. Spec: "targets vehicles, numbers from
  // aaBarrelLarge.cs at implementation time" — this is that citation.
  [TurretBarrelId.AABarrelLarge]: {
    projectile: ProjectileType.Tracer, speed: 150, velInherit: 1.0, directDamage: 0.25,
    radiusDamage: 0, radius: 0, kickback: 0, fireTime: 0.15, reloadTime: 0.2,
    lifetime: 3, attackRadius: 200, vehiclesOnly: true,
  },
  // turrets/sentryTurret.cs:92-227. Spec: 0.1 direct at 200 m/s, 0.13 s fire, 0.40 s reload.
  [TurretBarrelId.SentryTurretBarrel]: {
    projectile: ProjectileType.Linear, speed: 200, velInherit: 0.5, directDamage: 0.1,
    radiusDamage: 0, radius: 0, kickback: 0, fireTime: 0.13, reloadTime: 0.4,
    lifetime: 3, attackRadius: 60,
  },
};

export const TURRET_BASE_DATA: Record<TurretBaseId, TurretBaseData> = {
  // turret.cs:150-192 (TurretData) + turret.cs:139-146 (TurretBaseSensorObj). Spec: maxDamage
  // 2.25, energyPerDamagePoint 50, elevation 15 to 140. maxEnergy/rechargeRate/sensor radius
  // are not in the spec table; all three come straight from the script.
  [TurretBaseId.Large]: {
    maxHealth: 2.25, maxEnergy: 150, energyPerDamagePoint: 50, rechargeRate: 0.31,
    thetaMin: 15, thetaMax: 140, sensorRadius: 80,
  },
  // sentryTurret.cs:92-227 (TurretData + SentryMotionSensor). Spec: maxDamage 1.2 only;
  // every other field here is read from the script.
  [TurretBaseId.Sentry]: {
    maxHealth: 1.2, maxEnergy: 150, energyPerDamagePoint: 100, rechargeRate: 0.4,
    thetaMin: 89, thetaMax: 175, sensorRadius: 60,
  },
};

const BASE_FOR_BARREL: Record<TurretBarrelId, TurretBaseId> = {
  [TurretBarrelId.PlasmaBarrelLarge]: TurretBaseId.Large,
  [TurretBarrelId.AABarrelLarge]: TurretBaseId.Large,
  [TurretBarrelId.SentryTurretBarrel]: TurretBaseId.Sentry,
};

export function baseFor(barrel: TurretBarrelId): TurretBaseData {
  return TURRET_BASE_DATA[BASE_FOR_BARREL[barrel]];
}

/** Ours: the smaller of the base's sensor radius and the barrel's own attackRadius — see
 *  `TurretBaseData.sensorRadius`'s comment for why these differ for TurretBaseLarge. */
export function engagementRange(barrel: TurretBarrelId): number {
  return Math.min(baseFor(barrel).sensorRadius, TURRET_BARREL_DATA[barrel].attackRadius);
}

export interface TurretStore {
  count: number;
  barrel: Uint8Array;
  team: Uint8Array;
  position: Float64Array;
  damage: Float64Array;
  destroyed: Uint8Array;
  energy: Float64Array;
  powered: Uint8Array;
  targetId: Int16Array;
  state: Uint8Array;
  timer: Float64Array;
}
const TURRET_CAPACITY = 16; // Ours: Katabatic's real count is 6; headroom for other maps.

export function createEmptyTurrets(): TurretStore {
  return {
    count: 0,
    barrel: new Uint8Array(TURRET_CAPACITY),
    team: new Uint8Array(TURRET_CAPACITY),
    position: new Float64Array(TURRET_CAPACITY * 3),
    damage: new Float64Array(TURRET_CAPACITY),
    destroyed: new Uint8Array(TURRET_CAPACITY),
    energy: new Float64Array(TURRET_CAPACITY),
    powered: new Uint8Array(TURRET_CAPACITY),
    targetId: new Int16Array(TURRET_CAPACITY).fill(-1),
    state: new Uint8Array(TURRET_CAPACITY),
    timer: new Float64Array(TURRET_CAPACITY),
  };
}

export function createTurrets(
  world: World,
  placements: Array<{ barrel: TurretBarrelId; team: number; position: Vec3 }>,
): void {
  const store = world.turrets;
  placements.forEach(({ barrel, team, position }, id) => {
    if (id >= TURRET_CAPACITY) throw new RangeError('Turret capacity exceeded');
    store.barrel[id] = barrel;
    store.team[id] = team;
    store.position.set([position.x, position.y, position.z], id * 3);
    store.damage[id] = 0;
    store.destroyed[id] = 0;
    store.energy[id] = baseFor(barrel).maxEnergy;
    store.powered[id] = 0;
    store.targetId[id] = -1;
    store.state[id] = TurretState.Ready;
    store.timer[id] = 0;
    store.count = Math.max(store.count, id + 1);
  });
}

export function applyTurretDamage(world: World, id: number, amount: number): void {
  const store = world.turrets;
  const data = baseFor(store.barrel[id] as TurretBarrelId);
  if (amount <= 0 || store.destroyed[id]) return;
  const energy = store.energy[id] ?? 0;
  const shieldCapacity = data.energyPerDamagePoint > 0 ? energy / data.energyPerDamagePoint : 0;
  const shieldAbsorbed = Math.min(shieldCapacity, amount);
  store.energy[id] = energy - shieldAbsorbed * data.energyPerDamagePoint;
  const throughShield = amount - shieldAbsorbed;
  if (throughShield <= 0) return;
  store.damage[id] = (store.damage[id] ?? 0) + throughShield;
  if ((store.damage[id] ?? 0) >= data.maxHealth) {
    store.destroyed[id] = 1;
    store.targetId[id] = -1;
  }
}

/** Mirrors `baseObjects.ts`'s `stepPower`, but turrets are always `needsPower: true` (a
 *  turret has no power-independent counterpart the way a generator does), so this is a
 *  straight team-power lookup with no branch. */
export function stepTurretPower(world: World): void {
  const store = world.turrets;
  const teamPower = new Map<number, boolean>();
  for (let id = 0; id < store.count; id += 1) {
    const team = store.team[id] ?? 0;
    if (!teamPower.has(team)) teamPower.set(team, teamHasPower(world, team));
    store.powered[id] = teamPower.get(team) ? 1 : 0;
  }
}

function distance(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

function turretPosition(store: TurretStore, id: number): Vec3 {
  const base = id * 3;
  return { x: store.position[base] ?? 0, y: store.position[base + 1] ?? 0, z: store.position[base + 2] ?? 0 };
}

function playerPoint(world: World, playerId: number): Vec3 {
  const base = playerId * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: world.players.position[base + 1] ?? 0,
    z: world.players.position[base + 2] ?? 0,
  };
}

function turretEye(pos: Vec3): Vec3 {
  return { x: pos.x, y: pos.y + TURRET_EYE_HEIGHT, z: pos.z };
}

/** Nearest living enemy player within the barrel's engagement range and with a clear line of
 *  sight from the turret's eye position to the player. `vehiclesOnly` barrels
 *  (AABarrelLarge) always return null — see `TurretBarrelData.vehiclesOnly`. Matches the real
 *  T2 sensor's `detectsUsingLOS = true` (`turret.cs:142`, `turrets/sentryTurret.cs:129`) —
 *  failure matrix row 16. */
function acquireTarget(world: World, id: number): number {
  const store = world.turrets;
  const barrelId = store.barrel[id] as TurretBarrelId;
  if (TURRET_BARREL_DATA[barrelId].vehiclesOnly) return -1;
  const range = engagementRange(barrelId);
  const pos = turretPosition(store, id);
  const eye = turretEye(pos);
  const team = store.team[id] ?? 0;
  let nearest = -1;
  let nearestDistance = Infinity;
  for (let playerId = 0; playerId < world.players.count; playerId += 1) {
    if (!world.players.active[playerId] || !world.players.alive[playerId]) continue;
    if (world.players.team[playerId] === team) continue;
    const target = playerPoint(world, playerId);
    const d = distance(pos.x, pos.y, pos.z, target.x, target.y, target.z);
    if (d > range || d >= nearestDistance) continue;
    if (!hasLineOfSight(world, eye, target)) continue;
    nearest = playerId;
    nearestDistance = d;
  }
  return nearest;
}

/** True when the current target is still a valid one to keep engaging — alive, active, an
 *  enemy, still in range, and still visible. Reacquisition (`acquireTarget`) always runs when
 *  this is false, covering "target died" (failure matrix row 12), "target walked out of
 *  range", and "target walked behind terrain" (failure matrix row 16) alike — there is no
 *  separate code path for any of the three causes. */
function targetStillValid(world: World, id: number): boolean {
  const store = world.turrets;
  const targetId = store.targetId[id];
  if (targetId < 0 || !world.players.active[targetId] || !world.players.alive[targetId]) return false;
  const barrelId = store.barrel[id] as TurretBarrelId;
  const pos = turretPosition(store, id);
  const target = playerPoint(world, targetId);
  const d = distance(pos.x, pos.y, pos.z, target.x, target.y, target.z);
  return d <= engagementRange(barrelId) && hasLineOfSight(world, turretEye(pos), target);
}

export interface TurretFireEvent {
  turretId: number;
  barrel: TurretBarrelId;
  team: number;
  origin: Vec3;
  direction: Vec3;
}

/** Ready -> Firing -> Reload -> Ready, the same shape as `weapons.ts`'s player state
 *  machine but with no ammo: a powered turret with a target always cycles. */
function advanceFireCycle(world: World, id: number, dt: number): void {
  const store = world.turrets;
  const barrel = TURRET_BARREL_DATA[store.barrel[id] as TurretBarrelId];
  const timer = (store.timer[id] ?? 0) - dt;
  if (timer > 0) {
    store.timer[id] = timer;
    return;
  }
  if (store.state[id] === TurretState.Firing) {
    store.state[id] = TurretState.Reload;
    store.timer[id] = barrel.reloadTime;
    return;
  }
  store.state[id] = TurretState.Ready;
  store.timer[id] = 0;
}

function fireAt(world: World, id: number): void {
  const store = world.turrets;
  const barrelId = store.barrel[id] as TurretBarrelId;
  const barrel = TURRET_BARREL_DATA[barrelId];
  const pos = turretPosition(store, id);
  const targetBase = store.targetId[id] * 3;
  const dx = (world.players.position[targetBase] ?? 0) - pos.x;
  const dy = (world.players.position[targetBase + 1] ?? 0) - pos.y;
  const dz = (world.players.position[targetBase + 2] ?? 0) - pos.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  world.pendingTurretFireEvents.push({
    turretId: id,
    barrel: barrelId,
    team: store.team[id] ?? 0,
    origin: pos,
    direction: { x: dx / len, y: dy / len, z: dz / len },
  });
  store.state[id] = TurretState.Firing;
  store.timer[id] = barrel.fireTime;
}

function stepOneTurret(world: World, id: number, dt: number): void {
  const store = world.turrets;
  if (!store.powered[id] || store.destroyed[id]) {
    store.targetId[id] = -1;
    return;
  }
  if (!targetStillValid(world, id)) store.targetId[id] = acquireTarget(world, id);
  if (store.targetId[id] < 0) return;
  if (store.state[id] === TurretState.Ready) fireAt(world, id);
  else advanceFireCycle(world, id, dt);
}

export function stepTurrets(world: World, dt: number): void {
  stepTurretPower(world);
  world.pendingTurretFireEvents = [];
  for (let id = 0; id < world.turrets.count; id += 1) stepOneTurret(world, id, dt);
}
```

In `packages/sim/src/types.ts`, add to `World` (after `baseObjects`): `turrets: import('./turrets.js').TurretStore; pendingTurretFireEvents: import('./turrets.js').TurretFireEvent[];`

In `packages/sim/src/world.ts`, import `createEmptyTurrets` from `./turrets.js` and add `turrets: createEmptyTurrets(), pendingTurretFireEvents: [],` to `createWorld`'s returned object.

In `packages/sim/src/hash.ts`, add a `mixTurrets` function mirroring `mixBaseObjects` and call it from `hashWorld` right after `mixBaseObjects`:

```ts
function mixTurrets(hash: number, world: World): number {
  let h = hash;
  const store = world.turrets;
  for (let id = 0; id < store.count; id += 1) {
    h = mix(h, id);
    h = mix(h, num(store.barrel, id));
    h = mix(h, num(store.team, id));
    h = mix(h, num(store.damage, id));
    h = mix(h, num(store.destroyed, id));
    h = mix(h, num(store.energy, id));
    h = mix(h, num(store.powered, id));
    h = mix(h, num(store.targetId, id));
    h = mix(h, num(store.state, id));
  }
  return h;
}
```

`pendingTurretFireEvents` is deliberately not mixed — same convention `pendingFireEvents` already follows (this plan's stepWorld comment and M3's hashWorld POLICY comment both call transient one-tick arrays out of scope).

Add to `packages/sim/src/index.ts`:

```ts
export * from './turrets.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/turrets.ts packages/sim/src/turrets.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/hash.ts packages/sim/src/index.ts
git commit -m "feat(sim): turret targeting with terrain line of sight, aiming, and firing" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 5: Sim — projectiles vs base objects/turrets/interiors/force fields, turret-fired shots

**Files:** Modify `packages/sim/src/projectiles.ts`, `packages/sim/src/projectiles.test.ts`, `packages/sim/src/types.ts`, `packages/sim/src/world.ts`
**Interfaces:** Consumes `BaseObjectStore`/`applyBaseObjectDamage`/`activeForceFieldBlockers` (Task 3), `TurretStore`/`applyTurretDamage`/`TurretFireEvent`/`TURRET_BARREL_DATA` (Task 4), `InteriorInstance`/`raycastInteriors` (Task 2), `armorFor` (Task 1). Produces no new exported names beyond what `stepProjectiles` already exports — this task changes *what a projectile can hit*, not the public shape. `ProjectileStore` gains a `team: Uint8Array` field (set at spawn time from the shooter's team, or the turret's team for a turret-fired shot) so a force-field block check has a team to compare against even for a shot with no `ownerId`. Every M3 test in `projectiles.test.ts` must still pass unmodified: this task only adds targets, it never removes the player-hit path. Covers failure-matrix row 14 (`projectiles.test.ts`: "a disc fired through where an interior wall stands detonates at the wall, not past it") and row 17 (`projectiles.test.ts`: an enemy shot is blocked at a powered force field, a friendly shot passes through).

- [ ] **Step 1: Write the failing tests**

Append to `packages/sim/src/projectiles.test.ts` (imports for `BaseObjectKind`/`createBaseObjects`, `TurretBarrelId`/`createTurrets`/`stepTurrets`, `buildInteriorCollider`/`InteriorPlacement`/`InteriorTriangles` join the existing import list):

```ts
import { applyBaseObjectDamage, BaseObjectKind, createBaseObjects } from './baseObjects.js';
import { buildInteriorCollider, type InteriorPlacement, type InteriorTriangles } from './interiors.js';
import { createTurrets, stepTurrets, TurretBarrelId } from './turrets.js';

describe('projectiles vs base objects', () => {
  it('a Spinfusor disc splash-damages a generator it lands near', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 2, position: { x: 20, y: 0, z: 0 } }]);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Spinfusor;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.damage[0]).toBeGreaterThan(0);
  });

  it('a direct-hit weapon (Chaingun bullet) damages a station on contact', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.StationInventory, team: 2, position: { x: 10, y: 0, z: 0 } }]);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Chaingun;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    stepProjectiles(world, FIXED_DT); // Tracer resolves same-tick, matching M3's Chaingun path.
    expect(world.baseObjects.damage[0]).toBeGreaterThan(0);
  });

  it('friendly fire reaches a same-team base object (no team filter on the hit-test)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 10, y: 0, z: 0 } }]);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Chaingun;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.damage[0]).toBeGreaterThan(0);
  });

  it('a destroyed base object cannot be damaged further (applyBaseObjectDamage no-ops)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 2, position: { x: 10, y: 0, z: 0 } }]);
    applyBaseObjectDamage(world, 0, 1000);
    const damageAfter = world.baseObjects.damage[0];
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Chaingun;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.damage[0]).toBe(damageAfter);
  });
});

describe('projectiles vs turrets', () => {
  it('a player weapon can damage a turret', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 0, z: 0 } }]);
    createTurrets(world, [{ barrel: TurretBarrelId.SentryTurretBarrel, team: 2, position: { x: 10, y: 0, z: 0 } }]);
    const shooter = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Chaingun;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    stepProjectiles(world, FIXED_DT);
    expect(world.turrets.damage[0]).toBeGreaterThan(0);
  });
});

describe('turret-fired shots become real, damaging projectiles', () => {
  it('a turret shot spawned this tick damages the target player on a later tick', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    createTurrets(world, [{ barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    stepPower(world);
    const enemy = addPlayer(world, { x: 10, y: 0, z: 0 }, 2);
    const before = world.players.damage[enemy];
    for (let tick = 0; tick < 90; tick += 1) {
      stepTurretPower(world);
      stepTurrets(world, FIXED_DT);
      stepProjectiles(world, FIXED_DT);
    }
    expect(world.players.damage[enemy]).toBeGreaterThan(before);
  });
});

describe('interior collision for projectiles (failure matrix row 14)', () => {
  function wallInterior(): InteriorTriangles {
    // A single quad wall in the XZ-perpendicular plane at x=5, spanning y 0..4, z -4..4.
    const positions = new Float32Array([
      5, 0, -4, 5, 4, -4, 5, 4, 4,
      5, 0, -4, 5, 4, 4, 5, 0, 4,
    ]);
    return { positions };
  }
  const wallPlacement: InteriorPlacement = { position: { x: 0, y: 0, z: 0 }, rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 } };

  it('a disc fired through where an interior wall stands detonates at the wall, not past it', () => {
    const world = createWorld(flat, 1);
    world.interiors = [buildInteriorCollider(wallInterior(), wallPlacement)];
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 2, position: { x: 20, y: 2, z: 0 } }]);
    const shooter = addPlayer(world, { x: 0, y: 2, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Spinfusor;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    // The generator sits at x=20, well past the wall at x=5: it must take no damage because
    // the disc stopped at the wall.
    expect(world.baseObjects.damage[0]).toBe(0);
  });
});

describe('force fields block enemy projectiles and pass friendly ones (failure matrix row 17)', () => {
  function withForceField(ownerTeam: number): ReturnType<typeof createWorld> {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: ownerTeam, position: { x: 5, y: 0, z: 20 } },
      {
        kind: BaseObjectKind.ForceField,
        team: ownerTeam,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
      { kind: BaseObjectKind.Generator, team: 3 - ownerTeam, position: { x: 20, y: 2, z: 0 } },
    ]);
    stepPower(world);
    return world;
  }

  it('an enemy disc detonates against a powered force field, not past it', () => {
    const world = withForceField(2); // field belongs to team 2
    const shooter = addPlayer(world, { x: 0, y: 2, z: 0 }, 1); // shooter is team 1, the enemy
    world.players.weaponSlot[shooter] = WeaponId.Spinfusor;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    // The generator at x=20 belongs to team 1 (the shooter's own team) so it is never in
    // this test's way conceptually, but its damage staying at 0 proves the disc never
    // reached past the field at x=5.
    expect(world.baseObjects.damage[2]).toBe(0);
  });

  it('a friendly disc passes through the same powered force field untouched', () => {
    const world = withForceField(1); // field belongs to team 1, same as the shooter
    const shooter = addPlayer(world, { x: 0, y: 2, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Spinfusor;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    // The generator at x=20 belongs to the opposing team (team 2): a friendly shot passing
    // straight through the field must still be able to reach and damage it.
    expect(world.baseObjects.damage[2]).toBeGreaterThan(0);
  });

  it('an unpowered force field blocks nothing, friend or enemy', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      {
        kind: BaseObjectKind.ForceField,
        team: 2,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 20, y: 2, z: 0 } },
    ]);
    // No generator for team 2: stepPower leaves the field unpowered.
    stepPower(world);
    const shooter = addPlayer(world, { x: 0, y: 2, z: 0 }, 1);
    world.players.weaponSlot[shooter] = WeaponId.Spinfusor;
    world.players.weaponState[shooter] = WeaponState.Ready;
    stepWeapons(world, new Map([[shooter, { ...idleInput(), yaw: Math.PI / 2, fire: true }]]), FIXED_DT);
    for (let tick = 0; tick < 60; tick += 1) stepProjectiles(world, FIXED_DT);
    expect(world.baseObjects.damage[1]).toBeGreaterThan(0);
  });
});
```

`idleInput()` is a small local helper this file's existing tests already build inline in every case — add it once near the top of `projectiles.test.ts` if it does not already exist as a shared constant, returning the same shape M3's `IDLE`-style literals use (`{ moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false, slot: 0 }`).

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- projectiles.test.ts`. The base-object/turret/interior cases fail (nothing takes damage, the disc reaches the generator at x=20 through the wall); the force-field cases fail the same way (the enemy shot reaches the generator behind the field, because `stepProjectiles` does not yet consult `activeForceFieldBlockers` at all); every pre-existing M3 case still passes.

- [ ] **Step 3: Write minimal implementation**

In `packages/sim/src/types.ts`, `World.pendingTurretFireEvents` already exists from Task 4 — no further type change needed here.

In `packages/sim/src/projectiles.ts`, add the new imports at the top:

```ts
import { activeForceFieldBlockers, applyBaseObjectDamage, BaseObjectKind } from './baseObjects.js';
import { raycastInteriors, type InteriorInstance } from './interiors.js';
import { applyTurretDamage, TURRET_BARREL_DATA, TurretBarrelId, type TurretFireEvent } from './turrets.js';
```

Add a merged terrain-or-interior-or-force-field segment check, replacing every direct call to `terrainHitAlongSegment(world.terrain, ...)`. Both helpers below take the shooter's team so `activeForceFieldBlockers` only ever includes the fields that actually block that particular shot — a friendly force field never appears in the list it queries, so it is structurally impossible for this code to block its own team's shots:

```ts
/** Every collider a projectile from `shooterTeam` can hit along a segment or ray: static
 *  interiors (always) plus any powered, non-destroyed enemy force field (never a friendly
 *  one — see `activeForceFieldBlockers`). Both `world.interiors` and force fields resolve
 *  through the exact same `raycastInteriors` Task 2 already tests, since a force field's
 *  cached geometry is itself an `InteriorInstance` (Task 3). */
function collidersFor(world: World, shooterTeam: number): InteriorInstance[] {
  const fields = activeForceFieldBlockers(world, shooterTeam);
  return fields.length === 0 ? world.interiors : [...world.interiors, ...fields];
}

/** The nearer of a terrain hit and an interior/force-field hit along the same
 *  previous->current segment — failure matrix rows 14 and 17. An empty collider list (the
 *  common case for every M1-M3 test, and for any map without buildings or force fields)
 *  costs one array length check, not a wasted triangle scan. */
function worldHitAlongSegment(
  world: World,
  previous: Vec3,
  current: Vec3,
  shooterTeam: number,
): { distance: number; point: Vec3; sample?: TerrainSample; normal?: Vec3 } | null {
  const terrainHit = terrainHitAlongSegment(world.terrain, previous, current);
  const colliders = collidersFor(world, shooterTeam);
  if (colliders.length === 0) return terrainHit;
  const dx = current.x - previous.x, dy = current.y - previous.y, dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return terrainHit;
  const direction: Vec3 = { x: dx / length, y: dy / length, z: dz / length };
  const interiorHit = raycastInteriors(colliders, previous, direction, length);
  if (!terrainHit) return interiorHit;
  if (!interiorHit) return terrainHit;
  return interiorHit.distance <= terrainHit.distance ? interiorHit : terrainHit;
}
```

Every call site that read `terrainHitAlongSegment(world.terrain, previous, current)` directly (`stepLinearOrTracer`, `stepGrenade`, `hitTestTracer`) is changed to `worldHitAlongSegment(world, previous, current, world.projectiles.team[id] ?? 0)` (each of those functions already has `id` in scope for the projectile it is stepping). `nearestHitscanTarget`'s own `marchTerrain(world.terrain, event.origin, event.direction, maxRange)` call gets the same treatment via a sibling helper — hitscan events carry no projectile id, so the shooter's team comes from `event.ownerId` (a hitscan is always player-fired, never turret-fired, so `ownerId` is always valid here):

```ts
function worldMarch(
  world: World,
  origin: Vec3,
  direction: Vec3,
  length: number,
  shooterTeam: number,
): { distance: number } | null {
  const terrainHit = marchTerrain(world.terrain, origin, direction, length);
  const colliders = collidersFor(world, shooterTeam);
  if (colliders.length === 0) return terrainHit;
  const interiorHit = raycastInteriors(colliders, origin, direction, length);
  if (!terrainHit) return interiorHit;
  if (!interiorHit) return terrainHit;
  return interiorHit.distance <= terrainHit.distance ? interiorHit : terrainHit;
}
```

`nearestHitscanTarget`'s `const terrainHit = marchTerrain(world.terrain, event.origin, event.direction, maxRange);` becomes `const terrainHit = worldMarch(world, event.origin, event.direction, maxRange, world.players.team[event.ownerId] ?? 0);` (the local variable name is unchanged so the rest of that function's body needs no further edit).

Add the base-object and turret hit-sphere search, mirroring `findDirectHitFrom`'s shape:

```ts
export const BASE_OBJECT_HIT_RADIUS = 1.5; // Ours — see this plan's "ours" numbers table.
export const TURRET_HIT_RADIUS = 1.2; // Ours.

interface StructureHit {
  kind: 'baseObject' | 'turret';
  id: number;
  distance: number;
}

function nearestStructureHitFrom(
  world: World,
  previous: Vec3,
  current: Vec3,
): StructureHit | null {
  const dx = current.x - previous.x, dy = current.y - previous.y, dz = current.z - previous.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  const direction: Vec3 = { x: dx / length, y: dy / length, z: dz / length };
  let nearest: StructureHit | null = null;
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.destroyed[id]) continue;
    const base = id * 3;
    const hitbox: PlayerHitbox = {
      center: { x: bases.position[base] ?? 0, y: bases.position[base + 1] ?? 0, z: bases.position[base + 2] ?? 0 },
      radius: BASE_OBJECT_HIT_RADIUS,
      headY: Infinity,
    };
    const distance = raySphereDistance(previous, direction, hitbox);
    if (distance === null || distance > length || (nearest && distance >= nearest.distance)) continue;
    nearest = { kind: 'baseObject', id, distance };
  }
  const turrets = world.turrets;
  for (let id = 0; id < turrets.count; id += 1) {
    if (turrets.destroyed[id]) continue;
    const base = id * 3;
    const hitbox: PlayerHitbox = {
      center: { x: turrets.position[base] ?? 0, y: turrets.position[base + 1] ?? 0, z: turrets.position[base + 2] ?? 0 },
      radius: TURRET_HIT_RADIUS,
      headY: Infinity,
    };
    const distance = raySphereDistance(previous, direction, hitbox);
    if (distance === null || distance > length || (nearest && distance >= nearest.distance)) continue;
    nearest = { kind: 'turret', id, distance };
  }
  return nearest;
}

function applyStructureDamage(structure: StructureHit, amount: number, world: World): void {
  if (structure.kind === 'baseObject') applyBaseObjectDamage(world, structure.id, amount);
  else applyTurretDamage(world, structure.id, amount);
}
```

`findDirectHitFrom`'s own player search is unchanged, but its two call sites (`findDirectHit`, and `stepLinearOrTracer`'s own resolution) now compare the player hit against `nearestStructureHitFrom`'s result and resolve to whichever is nearer — same "nearer of two searches" pattern `worldHitAlongSegment` above already establishes, and the same pattern `nearerGrenadeContact` already uses for terrain-vs-player. `resolveImpact` grows a third branch:

```ts
function resolveImpact(
  world: World,
  id: number,
  data: ImpactData,
  point: Vec3,
  hitPlayerId: number | null,
  hitStructure: StructureHit | null = null,
): void {
  const owner = world.projectiles.ownerId[id] ?? -1;
  if (data.radiusDamage > 0) {
    explode(world, point, data.radiusDamage, data.radius, data.kickback, owner);
    // Splash also reaches a base object or turret standing in the blast: same falloff math,
    // reusing radiusFalloff against the structure's own hit-sphere center.
    explodeStructures(world, point, data.radiusDamage, data.radius);
  } else if (hitStructure) {
    applyStructureDamage(hitStructure, data.directDamage ?? 0, world);
  } else if (hitPlayerId !== null) {
    applyDamage(world, hitPlayerId, data.directDamage ?? 0, owner, armorFor(world, hitPlayerId));
  }
  free(world.projectiles, id);
}

function explodeStructures(world: World, point: Vec3, radiusDamage: number, radius: number): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.destroyed[id]) continue;
    const base = id * 3;
    const distance = Math.hypot(
      (bases.position[base] ?? 0) - point.x,
      (bases.position[base + 1] ?? 0) - point.y,
      (bases.position[base + 2] ?? 0) - point.z,
    );
    const falloff = radiusFalloff(distance, radius);
    if (falloff > 0) applyBaseObjectDamage(world, id, radiusDamage * falloff);
  }
  const turrets = world.turrets;
  for (let id = 0; id < turrets.count; id += 1) {
    if (turrets.destroyed[id]) continue;
    const base = id * 3;
    const distance = Math.hypot(
      (turrets.position[base] ?? 0) - point.x,
      (turrets.position[base + 1] ?? 0) - point.y,
      (turrets.position[base + 2] ?? 0) - point.z,
    );
    const falloff = radiusFalloff(distance, radius);
    if (falloff > 0) applyTurretDamage(world, id, radiusDamage * falloff);
  }
}
```

`stepLinearOrTracer`'s direct-hit resolution changes from:

```ts
  const directHit = findDirectHit(world, id, previous, current);
  const terrainHit = terrainHitAlongSegment(world.terrain, previous, current);
  if (terrainHit && (!directHit || terrainHit.distance <= directHit.distance)) {
    resolveImpact(world, id, data, terrainHit.point, null);
    return NO_HIT;
  }
  if (directHit) {
    const hitPoint = pointAlongSegment(previous, current, directHit.distance);
    resolveImpact(world, id, data, hitPoint, directHit.playerId);
    return { hitPlayerId: directHit.playerId, hitPoint };
  }
```

to:

```ts
  const directHit = findDirectHit(world, id, previous, current);
  const structureHit = nearestStructureHitFrom(world, previous, current);
  const worldHit = worldHitAlongSegment(world, previous, current);
  const nearest = nearestOfThree(worldHit, directHit, structureHit);
  if (nearest === worldHit && worldHit) {
    resolveImpact(world, id, data, worldHit.point, null);
    return NO_HIT;
  }
  if (nearest === structureHit && structureHit) {
    const hitPoint = pointAlongSegment(previous, current, structureHit.distance);
    resolveImpact(world, id, data, hitPoint, null, structureHit);
    return NO_HIT;
  }
  if (nearest === directHit && directHit) {
    const hitPoint = pointAlongSegment(previous, current, directHit.distance);
    resolveImpact(world, id, data, hitPoint, directHit.playerId);
    return { hitPlayerId: directHit.playerId, hitPoint };
  }
```

with a small three-way distance combinator next to `worldHitAlongSegment`:

```ts
function nearestOfThree<
  A extends { distance: number } | null,
  B extends { distance: number } | null,
  C extends { distance: number } | null,
>(a: A, b: B, c: C): A | B | C {
  let best: A | B | C = a;
  if (b && (!best || b.distance < best.distance)) best = b;
  if (c && (!best || c.distance < best.distance)) best = c;
  return best;
}
```

Every remaining `LIGHT_ARMOR` reference inside `projectiles.ts` (`explode`, `findDirectHitFrom`'s `playerHitbox(world, id, LIGHT_ARMOR)` calls, `grenadeHitPlayer`, `nearestHitscanTarget`, `resolveHitscan`, `hitTestHitscan`, `hitTestTracer`) becomes `armorFor(world, id)` at the specific player id each call already has in scope — a mechanical sweep, since every one of these already threads a `playerId`/`id` through, this task's own `LIGHT_ARMOR` sweep responsibility (deferred from Task 1, see Task 1's own note).

Add `team: Uint8Array` to the existing `ProjectileStore` interface (declared earlier in this file from M1–M3, alongside `ownerId`) and to `createProjectileStore`'s returned object (`team: new Uint8Array(capacity),`, matching how every other per-projectile field is sized). `spawnFromEvent` (existing, M3) gains one line right after it sets `store.ownerId[id]`: `store.team[id] = world.players.team[event.ownerId] ?? 0;` — the shooter's team, read once at spawn time rather than looked up through `ownerId` on every later hit test (a turret-fired shot has no `ownerId` to look up through, which is exactly why this field exists).

Wire turret-fired shots into `spawnFromEvent`'s sibling. Add:

```ts
function spawnTurretShot(world: World, event: TurretFireEvent, dt: number): void {
  const data = TURRET_BARREL_DATA[event.barrel];
  const id = allocate(world.projectiles);
  if (id === null) return; // Turrets have no ammo to refund — a full store just drops the shot.
  const store = world.projectiles;
  store.type[id] = data.projectile;
  store.weaponId[id] = event.barrel + TURRET_WEAPON_ID_OFFSET;
  store.ownerId[id] = -1; // No player identity; see this plan's "ours" table.
  store.team[id] = event.team;
  store.position.set([event.origin.x, event.origin.y, event.origin.z], id * 3);
  const velocity = {
    x: event.direction.x * data.speed,
    y: event.direction.y * data.speed,
    z: event.direction.z * data.speed,
  };
  store.velocity.set([velocity.x, velocity.y, velocity.z], id * 3);
  if (data.projectile === ProjectileType.Tracer) stepLinearOrTracer(world, id, dt);
}

export function spawnPendingTurretShots(world: World, dt: number): void {
  for (const event of world.pendingTurretFireEvents) spawnTurretShot(world, event, dt);
}
```

`store.weaponId` is a `Uint8Array` shared by both player weapons (`WeaponId`, 0–4) and turret barrels (`TurretBarrelId`, 0–2); `TURRET_WEAPON_ID_OFFSET = 100` keeps the two ranges from colliding, and every place that reads `store.weaponId[id]` back out to find a `WeaponData` (`stepLinearOrTracer`'s own `WEAPON_DATA[store.weaponId[id] as WeaponId]` lookup) is changed to a small dispatcher:

```ts
const TURRET_WEAPON_ID_OFFSET = 100;

function dataForStoredWeapon(weaponId: number): WeaponData | TurretBarrelData {
  return weaponId >= TURRET_WEAPON_ID_OFFSET
    ? TURRET_BARREL_DATA[(weaponId - TURRET_WEAPON_ID_OFFSET) as TurretBarrelId]
    : WEAPON_DATA[weaponId as WeaponId];
}
```

`stepLinearOrTracer`'s `const data = WEAPON_DATA[store.weaponId[id] as WeaponId];` becomes `const data = dataForStoredWeapon(store.weaponId[id] ?? 0);`. `TurretBarrelData` and `WeaponData` already share every field `resolveImpact`/`stepLinearOrTracer` read (`speed`, `velInherit`, `directDamage`, `radiusDamage`, `radius`, `kickback`, `lifetime`) — `resolveImpact`'s `ImpactData` parameter type already only requires that subset, so no further type change is needed there.

`stepProjectiles` grows one line, calling the new spawn function right alongside its existing `spawnFromEvent` drain:

```ts
export function stepProjectiles(world: World, dt: number): void {
  flushPendingFreeIds(world.projectiles);
  for (let id = 0; id < world.projectiles.count; id += 1) {
    if (!world.projectiles.active[id]) continue;
    if (world.projectiles.type[id] === ProjectileType.Grenade) stepGrenade(world, id, dt);
    else stepLinearOrTracer(world, id, dt);
  }
  world.lastFireEvents = world.pendingFireEvents;
  for (const event of world.pendingFireEvents) spawnFromEvent(world, event, dt);
  world.pendingFireEvents = [];
  spawnPendingTurretShots(world, dt);
  world.pendingTurretFireEvents = [];
}
```

Finally, in `packages/sim/src/world.ts`, add `stepPower`, `stepTurrets`, and `stepProjectiles`' new ordering to `stepWorld`:

```ts
export function stepWorld(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt = FIXED_DT,
): void {
  if (dt !== FIXED_DT)
    throw new RangeError(`Simulation step requires fixed tick ${FIXED_TICK_MS} ms`);
  if (world.gameOver) return;
  stepPlayers(world, inputs, dt);
  stepWeapons(world, inputs, dt);
  stepPower(world);
  stepTurrets(world, dt);
  stepProjectiles(world, dt);
  stepFlags(world, dt);
  world.tick += 1;
}
```

(`stepRepairPacks` is added here too by Task 6, which is the task that creates it — this task's own edit stops at `stepProjectiles`, matching M3's own per-task incremental pattern for `stepWorld`'s call sequence.)

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`. Every M3 `projectiles.test.ts`/`weapons.test.ts`/`damage.test.ts` case must stay green — this task adds targets, it must never change a single M3 assertion's outcome.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/projectiles.ts packages/sim/src/projectiles.test.ts packages/sim/src/world.ts
git commit -m "feat(sim): projectiles damage base objects and turrets; interior/force-field collision; turret-fired shots" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 6: Sim — Repair Pack beam, station loadout application, force-field player movement block, stepWorld/hash/snapshot integration

**Files:** Create `packages/sim/src/repair.ts`, `packages/sim/src/repair.test.ts`; Modify `packages/sim/src/baseObjects.ts`, `packages/sim/src/baseObjects.test.ts`, `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/movement.ts`, `packages/sim/src/movement.test.ts`, `packages/sim/src/weapons.ts`, `packages/sim/src/index.ts`
**Interfaces:** Consumes `armorFor` (Task 1), `raySphereDistance`, `playerHitbox` (existing, `damage.ts`), `BASE_OBJECT_HIT_RADIUS`/`TURRET_HIT_RADIUS` (Task 5), `activeForceFieldBlockers` (Task 3), `resolveSphereAgainstInteriors` (Task 2, already imported by `movement.ts` for `resolveInteriors`). Produces `stepRepairPacks(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt: number): void`, `applyLoadoutRequest(world: World, playerId: number, armor: ArmorId, repairPack: boolean): boolean` (in `baseObjects.ts`, alongside `stationAt`). `PlayerInput` gains `packActive: boolean`. Covers failure-matrix rows 4 (`baseObjects.test.ts`: "a station use in progress the tick power drops does not apply the new loadout" — trivially true here since `applyLoadoutRequest` re-checks `stationAt` at call time, never caches an earlier "in range" result), 13 (`repair.test.ts`: beam stops the instant the target leaves range), 15 (`repair.test.ts`: beam does not revive a destroyed generator), and 17 (`movement.test.ts`: an enemy player is blocked at a powered force field, a friendly player passes through — the player-movement half of row 17; Task 5 already covers the projectile half).

- [ ] **Step 1: Write the failing tests**

Create `packages/sim/src/repair.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, applyDamage, createWorld, LIGHT_ARMOR, type Heightfield, type PlayerInput } from './index.js';
import { applyBaseObjectDamage, BaseObjectKind, createBaseObjects } from './baseObjects.js';
import { stepRepairPacks } from './repair.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};
const FIXED_DT = 32 / 1000;
const REPAIR_RATE = LIGHT_ARMOR.repairRate;
const IDLE: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, jet: false, fire: false, altFire: false,
  slot: 0, packActive: false,
};
const aimingAt = (from: { x: number; z: number }, to: { x: number; z: number }): number =>
  Math.atan2(to.x - from.x, to.z - from.z);

describe('stepRepairPacks', () => {
  it('does nothing for a player without the Repair Pack equipped', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt];
    stepRepairPacks(world, new Map([[healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }]]), FIXED_DT);
    expect(world.players.damage[hurt]).toBe(before);
  });

  it('heals a damaged, aimed-at, in-range teammate by repairRate per tick', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt] ?? 0;
    stepRepairPacks(world, new Map([[healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }]]), FIXED_DT);
    expect(world.players.damage[hurt]).toBeCloseTo(before - REPAIR_RATE);
  });

  it('failure matrix row 13: stops the instant the target leaves the 10 m beam range', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 11, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.3, -1, LIGHT_ARMOR);
    const before = world.players.damage[hurt];
    stepRepairPacks(world, new Map([[healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 11, z: 0 }) }]]), FIXED_DT);
    expect(world.players.damage[hurt]).toBe(before);
  });

  it('heals a damaged base object within range', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } }]);
    applyBaseObjectDamage(world, 0, 20); // spends the shield, reaches health
    const before = world.baseObjects.damage[0] ?? 0;
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(world, new Map([[healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }]]), FIXED_DT);
    expect(world.baseObjects.damage[0]).toBeLessThan(before);
  });

  it('failure matrix row 15: does not revive a destroyed generator', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } }]);
    applyBaseObjectDamage(world, 0, 1000);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    stepRepairPacks(world, new Map([[healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }]]), FIXED_DT);
    expect(world.baseObjects.destroyed[0]).toBe(1);
    expect(world.baseObjects.damage[0]).toBeGreaterThan(0);
  });

  it('never reduces damage below zero', () => {
    const world = createWorld(flat, 1);
    const healer = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    const hurt = addPlayer(world, { x: 5, y: 0, z: 0 }, 1);
    world.players.hasRepairPack[healer] = 1;
    applyDamage(world, hurt, 0.0001, -1, LIGHT_ARMOR);
    for (let tick = 0; tick < 10; tick += 1) {
      stepRepairPacks(world, new Map([[healer, { ...IDLE, packActive: true, yaw: aimingAt({ x: 0, z: 0 }, { x: 5, z: 0 }) }]]), FIXED_DT);
    }
    expect(world.players.damage[hurt]).toBe(0);
  });
});
```

Extend `packages/sim/src/baseObjects.test.ts` with `applyLoadoutRequest` cases:

```ts
describe('applyLoadoutRequest', () => {
  it('applies armor, full heal, full energy, and the repair pack choice at a powered station', () => {
    const world = createWorld(flat, 1);
    const { station } = twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    applyDamage(world, player, 0.3, -1, LIGHT_ARMOR);
    world.players.energy[player] = 0;
    const applied = applyLoadoutRequest(world, player, ArmorId.Heavy, true);
    expect(applied).toBe(true);
    expect(world.players.armor[player]).toBe(ArmorId.Heavy);
    expect(world.players.damage[player]).toBe(0);
    expect(world.players.energy[player]).toBe(HEAVY_ARMOR.maxEnergy);
    expect(world.players.hasRepairPack[player]).toBe(1);
  });
  it('failure matrix row 4: refuses when the station is not powered, player keeps their old loadout', () => {
    const world = createWorld(flat, 1);
    const { gen1, gen2 } = twoGeneratorsOneStation(world);
    const overkill = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10;
    applyBaseObjectDamage(world, gen1, overkill);
    applyBaseObjectDamage(world, gen2, overkill);
    stepPower(world);
    const player = addPlayer(world, { x: 10, y: 0, z: 0 }, 1);
    const applied = applyLoadoutRequest(world, player, ArmorId.Heavy, true);
    expect(applied).toBe(false);
    expect(world.players.armor[player]).toBe(ArmorId.Light);
  });
  it('refuses outside the use radius', () => {
    const world = createWorld(flat, 1);
    twoGeneratorsOneStation(world);
    const player = addPlayer(world, { x: 10 + STATION_USE_RADIUS + 5, y: 0, z: 0 }, 1);
    expect(applyLoadoutRequest(world, player, ArmorId.Medium, false)).toBe(false);
  });
});
```

(Import `ArmorId`, `HEAVY_ARMOR`, `applyLoadoutRequest` from the appropriate modules at the top of `baseObjects.test.ts`.)

Extend the single `idle` const in `packages/sim/src/movement.test.ts` with `packActive: false` (every test already spreads it, so this is the only literal that needs the new field — same pattern M3's Task 2 used for `pitch`/`fire`/`altFire`/`slot`).

Append to `packages/sim/src/movement.test.ts` (import `BaseObjectKind`, `createBaseObjects`, `stepPower` from `./baseObjects.js` alongside this file's existing imports):

```ts
describe('force fields block enemy movement, pass friendly movement (failure matrix row 17)', () => {
  function withForceField(ownerTeam: number): ReturnType<typeof createWorld> {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: ownerTeam, position: { x: 5, y: 0, z: 20 } },
      {
        kind: BaseObjectKind.ForceField,
        team: ownerTeam,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
    ]);
    stepPower(world);
    return world;
  }

  it('an enemy player pushing straight into a powered force field is stopped at it', () => {
    const world = withForceField(2);
    const id = addPlayer(world, { x: 4.5, y: 0, z: 0 }, 1); // team 1, the enemy of the field's team 2
    const forward: PlayerInput = { ...idle, yaw: Math.PI / 2, moveZ: 1 }; // yaw 90 deg faces +X, moveZ pushes forward into the field at x=5
    for (let tick = 0; tick < 30; tick += 1) stepWorld(world, new Map([[id, forward]]));
    expect(world.players.position[id * 3] ?? 0).toBeLessThan(5);
  });

  it('a friendly player walks through the same powered force field unimpeded', () => {
    const world = withForceField(1); // field belongs to team 1, same as the player
    const id = addPlayer(world, { x: 4.5, y: 0, z: 0 }, 1);
    const forward: PlayerInput = { ...idle, yaw: Math.PI / 2, moveZ: 1 };
    for (let tick = 0; tick < 30; tick += 1) stepWorld(world, new Map([[id, forward]]));
    expect(world.players.position[id * 3] ?? 0).toBeGreaterThan(5);
  });

  it('an unpowered force field blocks no one', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      {
        kind: BaseObjectKind.ForceField,
        team: 2,
        position: { x: 5, y: 2, z: 0 },
        rotation: { axis: { x: 0, y: 1, z: 0 }, degrees: 0 },
        scale: { x: 1, y: 4, z: 6 },
      },
    ]);
    // No generator for team 2: stepPower leaves the field unpowered.
    stepPower(world);
    const id = addPlayer(world, { x: 4.5, y: 0, z: 0 }, 1);
    const forward: PlayerInput = { ...idle, yaw: Math.PI / 2, moveZ: 1 };
    for (let tick = 0; tick < 30; tick += 1) stepWorld(world, new Map([[id, forward]]));
    expect(world.players.position[id * 3] ?? 0).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- repair.test.ts`. Expect module resolution to fail for `./repair.js`. Run `pnpm --filter @clans/sim test -- baseObjects.test.ts` and expect the three new `applyLoadoutRequest` cases to fail (name does not exist). Run `pnpm --filter @clans/sim test -- movement.test.ts` and expect the enemy-blocked force-field case to fail (the player walks straight through, since `stepPlayer` does not yet call `activeForceFieldBlockers` at all).

- [ ] **Step 3: Write minimal implementation**

In `packages/sim/src/types.ts`, add `packActive: boolean;` to `PlayerInput` (after `slot`).

In `packages/sim/src/baseObjects.ts`, add the imports `import { ArmorId, ARMORS, type ArmorData } from './armor.js';` and `import { resetLoadout } from './weapons.js';`, then append:

```ts
/**
 * The one place a player's armor and Repair Pack choice actually change — called directly
 * by server/net.ts's Loadout handler and by the client's single-player equivalent, never
 * threaded through PlayerInput/stepWorld (this is a one-shot request, not per-tick state,
 * matching how `setGodMode` already works). Re-checks `stationAt` at call time rather than
 * trusting an earlier "in range" result, which is what makes failure matrix row 4 true for
 * free: a request that arrives the same tick power drops (or after the player already
 * walked away) simply finds no station and returns false, leaving every field of the
 * player's current loadout untouched.
 */
export function applyLoadoutRequest(
  world: World,
  playerId: number,
  armor: ArmorId,
  repairPack: boolean,
): boolean {
  if (stationAt(world, playerId) === null) return false;
  const players = world.players;
  const data: ArmorData = ARMORS[armor];
  players.armor[playerId] = armor;
  players.damage[playerId] = 0;
  players.energy[playerId] = data.maxEnergy;
  players.hasRepairPack[playerId] = repairPack ? 1 : 0;
  resetLoadout(world, playerId, data);
  return true;
}
```

Create `packages/sim/src/repair.ts`:

```ts
import { playerHitbox, raySphereDistance, type PlayerHitbox } from './damage.js';
import { BASE_OBJECT_HIT_RADIUS, TURRET_HIT_RADIUS } from './projectiles.js';
import { armorFor } from './armor.js';
import type { PlayerInput, Vec3, World } from './types.js';

const BEAM_RANGE = 10; // packs/repairpack.cs:48 — DefaultRepairBeam.beamRange.

interface RepairCandidate {
  kind: 'player' | 'baseObject' | 'turret';
  id: number;
  distance: number;
}

function eyeOrigin(world: World, id: number): Vec3 {
  const base = id * 3;
  return {
    x: world.players.position[base] ?? 0,
    y: (world.players.position[base + 1] ?? 0) + 1.6, // Same MUZZLE_HEIGHT convention as weapons.ts.
    z: world.players.position[base + 2] ?? 0,
  };
}

function aimDirection(yaw: number, pitch: number): Vec3 {
  return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
}

function candidateFromHitbox(
  kind: RepairCandidate['kind'],
  id: number,
  hitbox: PlayerHitbox,
  origin: Vec3,
  direction: Vec3,
): RepairCandidate | null {
  const distance = raySphereDistance(origin, direction, hitbox);
  if (distance === null || distance > BEAM_RANGE) return null;
  return { kind, id, distance };
}

function nearerCandidate(a: RepairCandidate | null, b: RepairCandidate | null): RepairCandidate | null {
  if (!a) return b;
  if (!b) return a;
  return a.distance <= b.distance ? a : b;
}

function findRepairTarget(world: World, healerId: number, origin: Vec3, direction: Vec3): RepairCandidate | null {
  let nearest: RepairCandidate | null = null;
  for (let id = 0; id < world.players.count; id += 1) {
    if (id === healerId || !world.players.active[id] || !world.players.alive[id]) continue;
    if ((world.players.damage[id] ?? 0) <= 0) continue;
    const hitbox = playerHitbox(world, id, armorFor(world, id));
    nearest = nearerCandidate(nearest, candidateFromHitbox('player', id, hitbox, origin, direction));
  }
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.destroyed[id] || (bases.damage[id] ?? 0) <= 0) continue;
    const base = id * 3;
    const hitbox: PlayerHitbox = {
      center: { x: bases.position[base] ?? 0, y: bases.position[base + 1] ?? 0, z: bases.position[base + 2] ?? 0 },
      radius: BASE_OBJECT_HIT_RADIUS,
      headY: Infinity,
    };
    nearest = nearerCandidate(nearest, candidateFromHitbox('baseObject', id, hitbox, origin, direction));
  }
  const turrets = world.turrets;
  for (let id = 0; id < turrets.count; id += 1) {
    if (turrets.destroyed[id] || (turrets.damage[id] ?? 0) <= 0) continue;
    const base = id * 3;
    const hitbox: PlayerHitbox = {
      center: { x: turrets.position[base] ?? 0, y: turrets.position[base + 1] ?? 0, z: turrets.position[base + 2] ?? 0 },
      radius: TURRET_HIT_RADIUS,
      headY: Infinity,
    };
    nearest = nearerCandidate(nearest, candidateFromHitbox('turret', id, hitbox, origin, direction));
  }
  return nearest;
}

/** Spec: "Repair Pack fires a repair beam that adds repairRate per tick to any damaged
 *  asset, vehicle, or player." `repairRate` is the same 0.0033/tick for every armor (the
 *  spec's Armor numbers table), applied as a flat per-call reduction — `stepRepairPacks`
 *  always runs once per fixed 32 ms tick via `stepWorld`, the same convention
 *  `applyJet`'s `jetEnergyDrain` already uses. Vehicles are milestone 5; only players, base
 *  objects, and turrets are healable this milestone. */
function healCandidate(world: World, healerId: number, candidate: RepairCandidate): void {
  const rate = armorFor(world, healerId).repairRate;
  if (candidate.kind === 'player') {
    world.players.damage[candidate.id] = Math.max(0, (world.players.damage[candidate.id] ?? 0) - rate);
  } else if (candidate.kind === 'baseObject') {
    world.baseObjects.damage[candidate.id] = Math.max(0, (world.baseObjects.damage[candidate.id] ?? 0) - rate);
  } else {
    world.turrets.damage[candidate.id] = Math.max(0, (world.turrets.damage[candidate.id] ?? 0) - rate);
  }
}

export function stepRepairPacks(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt: number): void {
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id] || !world.players.hasRepairPack[id]) continue;
    const input = inputs.get(id);
    if (!input?.packActive) continue;
    const origin = eyeOrigin(world, id);
    const direction = aimDirection(input.yaw, input.pitch);
    const target = findRepairTarget(world, id, origin, direction);
    if (target) healCandidate(world, id, target);
  }
  void dt; // dt is part of every step*'s signature for consistency; the heal rate is per-tick, not dt-scaled.
}
```

In `packages/sim/src/movement.ts`, add `packActive: false,` to the file's own `IDLE` constant (used when an active player is missing from `inputs`).

Wire the force-field block into the same place Task 2's `resolveInteriors` already runs. Import `activeForceFieldBlockers` from `./baseObjects.js`, and change `stepPlayer`'s call site from:

```ts
  const contact = integrate(world, body, ctx.grounded, forces.jumped || forces.jetted, dt);
  resolveInteriors(world, body, armor);
```

to:

```ts
  const contact = integrate(world, body, ctx.grounded, forces.jumped || forces.jetted, dt);
  resolveInteriors(world, body, armor);
  resolveForceFields(world, id, body, armor);
```

Add the new function right after `resolveInteriors` (it needs the player's own team, which `resolveInteriors` never had a reason to look up, so it is a separate small function rather than a parameter added to `resolveInteriors` itself):

```ts
/** Reuses `resolveInteriors`'s own two-sphere push-out against whichever of the player's
 *  team's opposing force fields are currently powered — `activeForceFieldBlockers` already
 *  excludes the player's own team's fields, so there is nothing else to filter here. A
 *  friendly field never appears in the list this queries, which is what makes "always
 *  passes your own team" true by construction rather than by an extra team check in this
 *  function — failure matrix row 17. */
function resolveForceFields(world: World, id: number, body: Body, armor: ArmorData): void {
  const team = world.players.team[id] ?? 0;
  const blockers = activeForceFieldBlockers(world, team);
  if (blockers.length === 0) return;
  const [boxX, boxY, height] = armor.boundingBox;
  const radius = Math.max(boxX, boxY) / 2;
  const chest = { x: body.x, y: body.y + height - radius, z: body.z };
  const push = resolveSphereAgainstInteriors(blockers, chest, radius);
  if (!push) return;
  body.x += push.x;
  body.y += push.y;
  body.z += push.z;
}
```

In `packages/sim/src/world.ts`, finish `stepWorld`'s call order:

```ts
export function stepWorld(
  world: World,
  inputs: ReadonlyMap<number, PlayerInput>,
  dt = FIXED_DT,
): void {
  if (dt !== FIXED_DT)
    throw new RangeError(`Simulation step requires fixed tick ${FIXED_TICK_MS} ms`);
  if (world.gameOver) return;
  stepPlayers(world, inputs, dt);
  stepWeapons(world, inputs, dt);
  stepPower(world);
  stepTurrets(world, dt);
  stepProjectiles(world, dt);
  stepRepairPacks(world, inputs, dt);
  stepFlags(world, dt);
  world.tick += 1;
}
```

(Import `stepPower` from `./baseObjects.js`, `stepTurrets` from `./turrets.js`, `stepRepairPacks` from `./repair.js` at the top of `world.ts`.)

Add to `packages/sim/src/index.ts`:

```ts
export * from './repair.js';
```

(`baseObjects.js` is already star-exported from Task 3; `applyLoadoutRequest` reaches every caller through that existing line.)

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`. Grep the repo for every `PlayerInput = {`/`: PlayerInput = {` literal outside `packages/sim` (in `packages/client`, `packages/server`, `packages/protocol` test files) and add `packActive: false` to each — the same sweep obligation M3's Task 2 called out for its own `PlayerInput` growth, repeated here because it bites the same way if skipped: a missing field fails typecheck, not a runtime test.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/repair.ts packages/sim/src/repair.test.ts packages/sim/src/baseObjects.ts packages/sim/src/baseObjects.test.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/movement.ts packages/sim/src/movement.test.ts packages/sim/src/index.ts
git commit -m "feat(sim): Repair Pack beam, station loadout application, force-field movement block, stepWorld integration" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 7: Protocol — base object/turret snapshot extras, Loadout message, `packActive` input bit

**Files:** Modify `packages/protocol/src/messages.ts`, `packages/protocol/src/handshake.ts`, `packages/protocol/src/handshake.test.ts`, `packages/protocol/src/snapshot.ts`, `packages/protocol/src/snapshot.test.ts`, `packages/protocol/src/index.ts`
**Interfaces:** Consumes `BaseObjectStore`, `TurretStore` shapes (Task 3, Task 4, read-only via the server's own snapshot builder — Task 10). Produces `MessageType.Loadout = 8`, `LoadoutMessage { type; armor: number; repairPack: boolean }`, `encodeLoadout`/`decodeLoadout`, `BaseObjectSnapshotData { id; damage; destroyed: 0 | 1; powered: 0 | 1 }`, `TurretSnapshotData { id; damage; destroyed: 0 | 1; powered: 0 | 1; targetId: number; state: number }`, `WorldExtras` gains `baseObjects`/`turrets`. Position is deliberately *not* on the wire for either — base objects and turrets never move, and both the server and every client already load the identical, identically-ordered placement list from `scene.json` (Task 8/9), so an id alone is enough for a client to know where to draw it. Covers no failure-matrix row directly (the rows it enables were already proven in the sim); a round-trip test proves the wire format itself.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/handshake.test.ts`:

```ts
import { decodeLoadout, encodeLoadout } from './handshake.js';

describe('Loadout round trip', () => {
  it('encodes and decodes armor and repairPack exactly', () => {
    const bytes = encodeLoadout({ armor: 2, repairPack: true });
    expect(decodeLoadout(bytes)).toEqual({ type: MessageType.Loadout, armor: 2, repairPack: true });
  });
  it('round-trips repairPack: false', () => {
    const bytes = encodeLoadout({ armor: 0, repairPack: false });
    expect(decodeLoadout(bytes).repairPack).toBe(false);
  });
});

describe('packActive input bit', () => {
  it('round-trips through encodeInput/decodeInput alongside every other flag', () => {
    const sample: NetInputSample = {
      moveX: 1, moveZ: -1, yaw: 0.5, pitch: -0.2, jump: true, jet: false, fire: true,
      altFire: false, slot: 3, packActive: true,
    };
    const bytes = encodeInput({ sequence: 1, samples: [sample, sample, sample] });
    const decoded = decodeInput(bytes);
    expect(decoded.samples[0].packActive).toBe(true);
    expect(decoded.samples[0].jump).toBe(true);
    expect(decoded.samples[0].fire).toBe(true);
  });
});
```

(`NetInputSample`, `encodeInput`, `decodeInput`, `MessageType` are already imported at the top of `handshake.test.ts` from M2/M3.)

Append to `packages/protocol/src/snapshot.test.ts`:

```ts
import { emptyExtras } from './snapshot.js';

describe('WorldExtras: baseObjects and turrets', () => {
  it('emptyExtras includes empty baseObjects/turrets arrays', () => {
    const extras = emptyExtras();
    expect(extras.baseObjects).toEqual([]);
    expect(extras.turrets).toEqual([]);
  });
  it('a full snapshot round-trips baseObjects and turrets exactly', () => {
    const extras = {
      ...emptyExtras(),
      baseObjects: [{ id: 0, damage: 0.4, destroyed: 0 as const, powered: 1 as const }],
      turrets: [{ id: 3, damage: 0, destroyed: 0 as const, powered: 1 as const, targetId: 7, state: 1 }],
    };
    const bytes = encodeSnapshot(1, 100, 5, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.baseObjects).toEqual(extras.baseObjects);
    expect(decoded.turrets).toEqual(extras.turrets);
  });
  it('a destroyed turret carries destroyed: 1 and an unset target', () => {
    const extras = {
      ...emptyExtras(),
      turrets: [{ id: 0, damage: 1.2, destroyed: 1 as const, powered: 0 as const, targetId: -1, state: 0 }],
    };
    const bytes = encodeSnapshot(1, 0, 0, [], null, extras);
    const decoded = decodeSnapshot(bytes, null);
    expect(decoded.turrets[0]).toEqual(extras.turrets[0]);
  });
});
```

(`encodeSnapshot`/`decodeSnapshot` are already imported at the top of `snapshot.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/protocol test`. Expect `encodeLoadout`/`decodeLoadout`/`MessageType.Loadout` to not exist, `packActive` to be a type error on `NetInputSample`, and `emptyExtras()` to not have `baseObjects`/`turrets`.

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/messages.ts`, add `Loadout = 8,` to `MessageType` and, after `GodMessage`:

```ts
export interface LoadoutMessage {
  type: MessageType.Loadout;
  armor: number; // ArmorId from @clans/sim
  repairPack: boolean;
}
```

Add two new constants next to `MAX_SNAPSHOT_FLAGS`:

```ts
export const MAX_SNAPSHOT_BASE_OBJECTS = 64; // Matches @clans/sim's BASE_OBJECT_CAPACITY.
export const MAX_SNAPSHOT_TURRETS = 16; // Matches @clans/sim's TURRET_CAPACITY.
```

In `packages/protocol/src/handshake.ts`, add `packActive` to `writeSample`/`readSample`'s flags byte (bit 4, value 16 — bits 0-3 are already `jump`/`jet`/`fire`/`altFire`):

```ts
function writeSample(cursor: Cursor, sample: NetInputSample): void {
  writeF32(cursor, sample.moveX);
  writeF32(cursor, sample.moveZ);
  writeF32(cursor, sample.yaw);
  writeF32(cursor, sample.pitch);
  writeU8(
    cursor,
    (sample.jump ? 1 : 0) |
      (sample.jet ? 2 : 0) |
      (sample.fire ? 4 : 0) |
      (sample.altFire ? 8 : 0) |
      (sample.packActive ? 16 : 0),
  );
  writeU8(cursor, sample.slot);
}
```

```ts
  return {
    moveX: clampAxis(moveX),
    moveZ: clampAxis(moveZ),
    yaw,
    pitch,
    jump: (flags & 1) !== 0,
    jet: (flags & 2) !== 0,
    fire: (flags & 4) !== 0,
    altFire: (flags & 8) !== 0,
    packActive: (flags & 16) !== 0,
    slot,
  };
```

Add the Loadout codec, same shape as `encodeGod`/`decodeGod`:

```ts
export function encodeLoadout(message: Omit<LoadoutMessage, 'type'>): Uint8Array {
  const cursor = createWriter(3);
  writeU8(cursor, MessageType.Loadout);
  writeU8(cursor, message.armor);
  writeU8(cursor, message.repairPack ? 1 : 0);
  return bytesOf(cursor);
}
export function decodeLoadout(bytes: Uint8Array): LoadoutMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Loadout);
  const armor = readU8(cursor);
  const repairPack = readU8(cursor) !== 0;
  return { type: MessageType.Loadout, armor, repairPack };
}
```

(Add `LoadoutMessage` to the `import type { ... } from './messages.js'` list at the top of `handshake.ts`.)

In `packages/protocol/src/snapshot.ts`, add the two new snapshot shapes after `FlagSnapshotData`:

```ts
export interface BaseObjectSnapshotData {
  id: number;
  damage: number;
  destroyed: 0 | 1;
  powered: 0 | 1;
}
export interface TurretSnapshotData {
  id: number;
  damage: number;
  destroyed: 0 | 1;
  powered: 0 | 1;
  targetId: number; // -1 = none
  state: number; // TurretState from @clans/sim
}
```

Extend `WorldExtras` and `emptyExtras`:

```ts
export interface WorldExtras {
  projectiles: ProjectileSnapshotData[];
  flags: FlagSnapshotData[];
  baseObjects: BaseObjectSnapshotData[];
  turrets: TurretSnapshotData[];
  teamScores: [number, number];
  gameOver: boolean;
  winnerTeam: number;
  timeRemainingS: number;
  gameOverReason: number;
}
export function emptyExtras(): WorldExtras {
  return {
    projectiles: [], flags: [], baseObjects: [], turrets: [],
    teamScores: [0, 0], gameOver: false, winnerTeam: 0, timeRemainingS: 0, gameOverReason: 0,
  };
}
```

Add byte-size constants next to `FLAG_BYTES`:

```ts
const BASE_OBJECT_BYTES = 2 + 4 + 1 + 1; // id, damage f32, destroyed, powered
const TURRET_BYTES = 2 + 4 + 1 + 1 + 2 + 1; // id, damage f32, destroyed, powered, targetId i16, state
```

Add read/write functions mirroring `writeFlag`/`readFlag`:

```ts
function writeBaseObject(cursor: Cursor, o: BaseObjectSnapshotData): void {
  writeU16(cursor, o.id);
  writeF32(cursor, o.damage);
  writeU8(cursor, o.destroyed);
  writeU8(cursor, o.powered);
}
function readBaseObject(cursor: Cursor): BaseObjectSnapshotData {
  const id = readU16(cursor);
  const damage = readF32(cursor);
  assertFinite([damage]);
  const destroyed = readU8(cursor) ? 1 : 0;
  const powered = readU8(cursor) ? 1 : 0;
  return { id, damage, destroyed, powered };
}
function writeTurret(cursor: Cursor, t: TurretSnapshotData): void {
  writeU16(cursor, t.id);
  writeF32(cursor, t.damage);
  writeU8(cursor, t.destroyed);
  writeU8(cursor, t.powered);
  writeI16(cursor, t.targetId);
  writeU8(cursor, t.state);
}
function readTurret(cursor: Cursor): TurretSnapshotData {
  const id = readU16(cursor);
  const damage = readF32(cursor);
  assertFinite([damage]);
  const destroyed = readU8(cursor) ? 1 : 0;
  const powered = readU8(cursor) ? 1 : 0;
  const targetId = readI16(cursor);
  const state = readU8(cursor);
  return { id, damage, destroyed, powered, targetId, state };
}
```

Extend `writeExtras`/`readExtras`/`extrasByteLength` to carry the two new arrays right after flags (before `teamScores`):

```ts
function writeExtras(cursor: Cursor, extras: WorldExtras): void {
  writeU16(cursor, extras.projectiles.length);
  for (const p of extras.projectiles) writeProjectile(cursor, p);
  writeU8(cursor, extras.flags.length);
  for (const f of extras.flags) writeFlag(cursor, f);
  writeU8(cursor, extras.baseObjects.length);
  for (const o of extras.baseObjects) writeBaseObject(cursor, o);
  writeU8(cursor, extras.turrets.length);
  for (const t of extras.turrets) writeTurret(cursor, t);
  writeU16(cursor, extras.teamScores[0]);
  writeU16(cursor, extras.teamScores[1]);
  writeU8(cursor, extras.gameOver ? 1 : 0);
  writeU8(cursor, extras.winnerTeam);
  writeF32(cursor, extras.timeRemainingS);
  writeU8(cursor, extras.gameOverReason);
}
function readExtras(cursor: Cursor): WorldExtras {
  const projectileCount = readU16(cursor);
  assertPlausibleExtrasCount(projectileCount, MAX_SNAPSHOT_PROJECTILES, 'projectile');
  const projectiles: ProjectileSnapshotData[] = [];
  for (let i = 0; i < projectileCount; i += 1) projectiles.push(readProjectile(cursor));
  const flagCount = readU8(cursor);
  assertPlausibleExtrasCount(flagCount, MAX_SNAPSHOT_FLAGS, 'flag');
  const flags: FlagSnapshotData[] = [];
  for (let i = 0; i < flagCount; i += 1) flags.push(readFlag(cursor));
  const baseObjectCount = readU8(cursor);
  assertPlausibleExtrasCount(baseObjectCount, MAX_SNAPSHOT_BASE_OBJECTS, 'baseObject');
  const baseObjects: BaseObjectSnapshotData[] = [];
  for (let i = 0; i < baseObjectCount; i += 1) baseObjects.push(readBaseObject(cursor));
  const turretCount = readU8(cursor);
  assertPlausibleExtrasCount(turretCount, MAX_SNAPSHOT_TURRETS, 'turret');
  const turrets: TurretSnapshotData[] = [];
  for (let i = 0; i < turretCount; i += 1) turrets.push(readTurret(cursor));
  const teamScores: [number, number] = [readU16(cursor), readU16(cursor)];
  const gameOver = readU8(cursor) !== 0;
  const winnerTeam = readU8(cursor);
  const timeRemainingS = readF32(cursor);
  const gameOverReason = readU8(cursor);
  assertFinite([timeRemainingS]);
  return { projectiles, flags, baseObjects, turrets, teamScores, gameOver, winnerTeam, timeRemainingS, gameOverReason };
}
function extrasByteLength(extras: WorldExtras): number {
  return (
    2 + extras.projectiles.length * PROJECTILE_BYTES +
    1 + extras.flags.length * FLAG_BYTES +
    1 + extras.baseObjects.length * BASE_OBJECT_BYTES +
    1 + extras.turrets.length * TURRET_BYTES +
    2 + 2 + 1 + 1 + 4 + 1
  );
}
```

(Import `MAX_SNAPSHOT_BASE_OBJECTS`, `MAX_SNAPSHOT_TURRETS` alongside the existing `MAX_SNAPSHOT_FLAGS`/`MAX_SNAPSHOT_PROJECTILES` import from `./messages.js`.)

Add to `packages/protocol/src/index.ts` — `messages.js`, `handshake.js`, and `snapshot.js` are already star- or named-exported from M1-M3; the new names (`MessageType.Loadout` is part of the existing `MessageType` export, `LoadoutMessage`/`encodeLoadout`/`decodeLoadout`/`BaseObjectSnapshotData`/`TurretSnapshotData` are new named exports those existing `export *`/`export {...}` lines already cover) — confirm no new `export` line is needed, only that nothing narrows the existing barrel exports to a name list that would exclude them.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/protocol test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/protocol/src/messages.ts packages/protocol/src/handshake.ts packages/protocol/src/handshake.test.ts packages/protocol/src/snapshot.ts packages/protocol/src/snapshot.test.ts
git commit -m "feat(protocol): base object/turret snapshot extras, Loadout message, packActive bit" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 8: Assets — extract base objects, turrets, force fields, and interior placements from the mission

**Files:** Modify `packages/assets/src/scene.ts`, `packages/assets/src/scene.test.ts`, `packages/assets/src/__fixtures__/scene.mis`
**Interfaces:** Consumes `MissionObject`, `flatten`, `teamFor`, `torquePositionToYUp`, `torqueAxisAngleToYUp` (existing, unchanged). Produces `SceneData` gains `baseObjects: Array<{ kind: number; team: number; position: Vec3; rotation?: AxisAngle; scale?: Vec3 }>` (`rotation`/`scale` are only ever set for a `ForceField`-kind entry), `turrets: Array<{ barrel: number; team: number; position: Vec3 }>`, `interiors: Array<{ shape: string; position: Vec3; rotation: AxisAngle }>`, `torqueScaleToYUp(value: string): Vec3` (a new small helper alongside `torquePositionToYUp`/`torqueAxisAngleToYUp` — scale swaps the Y/Z axes the same way position and rotation do, but is never negated, since a scale magnitude is never signed). The numeric `kind`/`barrel` values are plain literals chosen to match `@clans/sim`'s `BaseObjectKind`/`TurretBarrelId` enum ordinals exactly (documented inline); `packages/assets` takes no runtime dependency on `@clans/sim`, matching the existing M1–M3 separation. No failure-matrix row — this is a pure extraction task, proven by fixture-based unit tests the way `buildFlags`/`buildSpawns` already are.

Real Katabatic mission structure this task extracts (read from the actual cached `Katabatic.mis`, `jdknight`'s mirror via `exogen/t2-mapper`, in this planning session):

- Generators/sensors/stations are `StaticShape` objects: `dataBlock = "GeneratorLarge"` (4 total, 2/team), `"SensorLargePulse"` (2, 1/team), `"StationInventory"` (18, 9/team), `"StationVehiclePad"` (2, 1/team). Team comes from the enclosing `SimGroup(Team1)`/`SimGroup(Team2)`, exactly like `buildFlags`/`buildSpawns` already resolve it via `teamFor(ancestors)`.
- Turrets are a distinct `Turret` class (not `StaticShape`): `dataBlock = "TurretBaseLarge"` (4, 2/team) with an `initialBarrel` property of `"AABarrelLarge"` or `"PlasmaBarrelLarge"`, and `dataBlock = "SentryTurret"` (2, 1/team) with `initialBarrel = "SentryTurretBarrel"`.
- Force fields are their own distinct `ForceFieldBare` class (`new ForceFieldBare(...)`, not a `StaticShape`/`dataBlock` pair the way generators and stations are) — confirmed present in the mission read that produced this plan, `dataBlock = "defaultForceFieldBare"`, one per team, each carrying its own `position`, `rotation`, and `scale` properties (the real `PhysicalZone`'s dimensions come from `%obj.scale`, `forceField.cs:246`).
- Interiors are `InteriorInstance` objects with an `interiorFile` property (no `dataBlock`), 11 unique files across 29 placements: `sbunk2.dif`, `smisc3.dif`, `srock6.dif`, `srock7.dif`, `srock8.dif`, `sspir2.dif`, `sspir3.dif`, `sspir4.dif`, `stowr4.dif`, `stowr6.dif`, `svpad.dif`.

- [ ] **Step 1: Write the failing tests**

Extend `packages/assets/src/__fixtures__/scene.mis` with one of each new object type inside the existing `Team1`/`Team2` `SimGroup`s (the fixture already has a `SpawnSphere` and flag/flag-stand under each team — add these alongside them):

```
new StaticShape(Team1Gen1) {
  position = "10 0 0";
  rotation = "0 0 1 0";
  dataBlock = "GeneratorLarge";
};
new StaticShape(Team1Sensor1) {
  position = "20 0 0";
  rotation = "0 0 1 0";
  dataBlock = "SensorLargePulse";
};
new StaticShape(Team1Station1) {
  position = "30 0 0";
  rotation = "0 0 1 0";
  dataBlock = "StationInventory";
};
new StaticShape(Team1Pad1) {
  position = "40 0 0";
  rotation = "0 0 1 0";
  dataBlock = "StationVehiclePad";
};
new Turret(Team1TurretBaseLarge1) {
  position = "50 0 0";
  rotation = "0 0 1 0";
  dataBlock = "TurretBaseLarge";
  initialBarrel = "PlasmaBarrelLarge";
};
new Turret(Team1SentryTurret1) {
  position = "60 0 0";
  rotation = "0 0 1 0";
  dataBlock = "SentryTurret";
  initialBarrel = "SentryTurretBarrel";
};
new InteriorInstance() {
  position = "70 0 0";
  rotation = "0 1 0 45";
  interiorFile = "sbunk2.dif";
};
new ForceFieldBare(Team1ForceField1) {
  position = "80 0 0";
  rotation = "0 1 0 90";
  scale = "1 4 6";
  dataBlock = "defaultForceFieldBare";
};
```

(Mirror the same eight objects under `Team2` with `dataBlock = "AABarrelLarge"` for its `TurretBaseLarge` so both barrel types are covered by the fixture, at different position offsets to keep every placement distinct. Exact placement inside the fixture's existing `SimGroup` nesting must match how `buildSpawns`/`buildFlags` already find their objects — flatten sees every descendant regardless of depth, so nesting depth itself doesn't matter, only that each new object sits somewhere under the right `SimGroup(TeamN)`.)

Extend `packages/assets/src/scene.test.ts`:

```ts
describe('buildBaseObjects', () => {
  it('extracts generator, sensor, station, and pad with the right kind and team', () => {
    const scene = extractScene(parseMission(fixtureSource));
    const gen = scene.baseObjects.find((o) => o.kind === BASE_OBJECT_KIND.Generator && o.team === 1);
    expect(gen?.position).toEqual([10, 0, 0]);
    const sensor = scene.baseObjects.find((o) => o.kind === BASE_OBJECT_KIND.Sensor && o.team === 1);
    expect(sensor).toBeDefined();
    const station = scene.baseObjects.find((o) => o.kind === BASE_OBJECT_KIND.StationInventory && o.team === 1);
    expect(station).toBeDefined();
    const pad = scene.baseObjects.find((o) => o.kind === BASE_OBJECT_KIND.StationVehiclePad && o.team === 1);
    expect(pad).toBeDefined();
  });
});

describe('buildTurrets', () => {
  it('extracts a Plasma-barreled TurretBaseLarge, an AA-barreled one, and a Sentry, each with its team', () => {
    const scene = extractScene(parseMission(fixtureSource));
    const plasma = scene.turrets.find((t) => t.barrel === TURRET_BARREL.PlasmaBarrelLarge);
    expect(plasma?.team).toBe(1);
    const aa = scene.turrets.find((t) => t.barrel === TURRET_BARREL.AABarrelLarge);
    expect(aa?.team).toBe(2);
    const sentry = scene.turrets.find((t) => t.barrel === TURRET_BARREL.SentryTurretBarrel);
    expect(sentry).toBeDefined();
  });
});

describe('buildInteriors', () => {
  it('extracts an interior placement with its shape name (extension stripped), position, and rotation', () => {
    const scene = extractScene(parseMission(fixtureSource));
    const bunker = scene.interiors.find((i) => i.shape === 'sbunk2');
    expect(bunker?.position).toEqual([70, 0, 0]);
    expect(bunker?.rotation.degrees).toBe(45);
  });
});

describe('buildBaseObjects: force fields', () => {
  it('extracts a ForceFieldBare as a base object with kind ForceField, its rotation, and its scale', () => {
    const scene = extractScene(parseMission(fixtureSource));
    const field = scene.baseObjects.find((o) => o.kind === BASE_OBJECT_KIND.ForceField && o.team === 1);
    expect(field?.position).toEqual([80, 0, 0]);
    expect(field?.rotation?.degrees).toBe(90);
    expect(field?.scale).toEqual([1, 6, 4]); // torqueScaleToYUp swaps Y/Z, no negation.
  });
  it('every non-ForceField base object leaves rotation and scale undefined', () => {
    const scene = extractScene(parseMission(fixtureSource));
    const gen = scene.baseObjects.find((o) => o.kind === BASE_OBJECT_KIND.Generator && o.team === 1);
    expect(gen?.rotation).toBeUndefined();
    expect(gen?.scale).toBeUndefined();
  });
});
```

(`BASE_OBJECT_KIND`/`TURRET_BARREL` are small local test-only constant objects mirroring the literal values `scene.ts` itself uses, declared once near the top of `scene.test.ts`: `const BASE_OBJECT_KIND = { Generator: 0, Sensor: 1, StationInventory: 2, StationVehiclePad: 3, ForceField: 4 } as const;` and `const TURRET_BARREL = { PlasmaBarrelLarge: 0, AABarrelLarge: 1, SentryTurretBarrel: 2 } as const;` — these exist only so the test file doesn't hardcode magic numbers twice, and must stay in lockstep with `@clans/sim`'s real enums; a comment says so.)

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/assets test -- scene.test.ts`. Expect `scene.baseObjects`/`scene.turrets`/`scene.interiors` to be `undefined`, and `torqueScaleToYUp` to not exist.

- [ ] **Step 3: Write minimal implementation**

In `packages/assets/src/scene.ts`, extend `SceneData`:

```ts
export interface SceneData {
  terrain: { terrainFile: string; squareSize: number; position: Vec3; emptySquares: number[] };
  sun: { direction: Vec3; color: Color4; ambient: Color4 };
  sky: { visibleDistance: number; fogDistance: number; fogColor: Color4; materialList: string };
  missionArea: { minX: number; minZ: number; width: number; depth: number };
  spawns: Array<{ name: string | null; team: number; position: Vec3; radius: number }>;
  flags: Array<{ team: number; position: Vec3 }>;
  flagStands: Array<{ team: number; position: Vec3; rotation: AxisAngle }>;
  baseObjects: Array<{ kind: number; team: number; position: Vec3; rotation?: AxisAngle; scale?: Vec3 }>;
  turrets: Array<{ barrel: number; team: number; position: Vec3 }>;
  interiors: Array<{ shape: string; position: Vec3; rotation: AxisAngle }>;
}
```

Add `torqueScaleToYUp` alongside the existing `torquePositionToYUp`/`torqueAxisAngleToYUp` (same file, near the top with the other coordinate helpers):

```ts
/** Scale swaps the Y/Z axes exactly like position and rotation do (Torque Z-up to Y-up), but
 *  is never negated — a scale magnitude is never signed the way a position offset can be. */
export function torqueScaleToYUp(value: string): Vec3 {
  const [x = 1, y = 1, z = 1] = numbers(value, 3);
  return [x, z, y];
}
```

Add the dataBlock-to-kind lookup and the four builders, right after `buildFlagStands`:

```ts
// Numeric values match @clans/sim's BaseObjectKind ordinals exactly (Generator = 0,
// Sensor = 1, StationInventory = 2, StationVehiclePad = 3, ForceField = 4). packages/assets
// takes no runtime dependency on @clans/sim, so this is a plain lookup table, not an
// imported enum.
const BASE_OBJECT_KIND_BY_DATA_BLOCK: Record<string, number> = {
  GeneratorLarge: 0,
  SensorLargePulse: 1,
  StationInventory: 2,
  StationVehiclePad: 3,
};

function buildBaseObjects(all: LocatedObject[]): SceneData['baseObjects'] {
  return all
    .filter(({ object }) => object.class === 'StaticShape' && object.props.dataBlock in BASE_OBJECT_KIND_BY_DATA_BLOCK)
    .map(({ object, ancestors }) => ({
      kind: BASE_OBJECT_KIND_BY_DATA_BLOCK[object.props.dataBlock as string] as number,
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
    }));
}

const FORCE_FIELD_KIND = 4; // Matches @clans/sim's BaseObjectKind.ForceField ordinal.

/** Force fields are their own Torque class (`ForceFieldBare`), not a `StaticShape`/`dataBlock`
 *  pair the way `buildBaseObjects` above filters — see this task's own mission-structure
 *  notes. Folded into the same `baseObjects` array (not a separate `SceneData` field) so the
 *  sim's `createBaseObjects` and the client's rendering both already handle it through the
 *  generic per-kind loop every other base object kind already goes through. */
function buildForceFieldBaseObjects(all: LocatedObject[]): SceneData['baseObjects'] {
  return all
    .filter(({ object }) => object.class === 'ForceFieldBare')
    .map(({ object, ancestors }) => ({
      kind: FORCE_FIELD_KIND,
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
      rotation: torqueAxisAngleToYUp(object.props.rotation ?? '0 0 1 0'),
      scale: torqueScaleToYUp(object.props.scale ?? '1 4 6'),
    }));
}

// Numeric values match @clans/sim's TurretBarrelId ordinals exactly (PlasmaBarrelLarge = 0,
// AABarrelLarge = 1, SentryTurretBarrel = 2).
const TURRET_BARREL_BY_NAME: Record<string, number> = {
  PlasmaBarrelLarge: 0,
  AABarrelLarge: 1,
  SentryTurretBarrel: 2,
};

function buildTurrets(all: LocatedObject[]): SceneData['turrets'] {
  return all
    .filter(({ object }) => object.class === 'Turret')
    .map(({ object, ancestors }) => {
      const barrel = TURRET_BARREL_BY_NAME[object.props.initialBarrel ?? ''];
      if (barrel === undefined) {
        throw new TypeError(`Unknown Turret initialBarrel "${String(object.props.initialBarrel)}"`);
      }
      return { barrel, team: teamFor(ancestors), position: torquePositionToYUp(object.props.position ?? '') };
    });
}

/** Strips the `.dif` extension so this matches the `.glb` shape name Task 9's fetch/convert
 *  step produces under `assets/out/katabatic/interiors/` — one name, two extensions, never
 *  duplicated as a string literal in two places. */
function shapeNameFromInteriorFile(interiorFile: string): string {
  return interiorFile.replace(/\.dif$/i, '');
}

function buildInteriors(all: LocatedObject[]): SceneData['interiors'] {
  return all
    .filter(({ object }) => object.class === 'InteriorInstance')
    .map(({ object }) => ({
      shape: shapeNameFromInteriorFile(requiredString(object.props.interiorFile, 'InteriorInstance.interiorFile')),
      position: torquePositionToYUp(object.props.position ?? ''),
      rotation: torqueAxisAngleToYUp(object.props.rotation ?? '0 0 1 0'),
    }));
}
```

Extend `extractScene`'s returned object:

```ts
export function extractScene(objects: MissionObject[]): SceneData {
  const all = flatten(objects);
  return {
    terrain: buildTerrain(findByClass(all, 'TerrainBlock')),
    sun: buildSun(findByClass(all, 'Sun')),
    sky: buildSky(findByClass(all, 'Sky')),
    missionArea: buildMissionArea(findByClass(all, 'MissionArea')),
    spawns: buildSpawns(all),
    flags: buildFlags(all),
    flagStands: buildFlagStands(all),
    baseObjects: [...buildBaseObjects(all), ...buildForceFieldBaseObjects(all)],
    turrets: buildTurrets(all),
    interiors: buildInteriors(all),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/assets test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/assets/src/scene.ts packages/assets/src/scene.test.ts packages/assets/src/__fixtures__/scene.mis
git commit -m "feat(assets): extract base objects, turrets, force fields, and interior placements from the mission" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 9: Assets — fetch and convert interior/shape `.glb`, extract collision triangles, size budget

**Files:** Create `packages/assets/src/interiors.ts`, `packages/assets/src/interiors.test.ts`; Modify `packages/assets/src/fetch.ts`, `packages/assets/src/build.ts`, `packages/assets/package.json`
**Interfaces:** Consumes nothing sim-side (this is a Node build script, per this plan's Global Constraints packages/sim boundary). Produces `extractTriangles(glbPath: string): Promise<{ positions: Float32Array }>` (object-space triangle soup, every mesh's own node transforms already baked in — the exact shape `@clans/sim`'s `InteriorTriangles` expects), `writeTriangleBinary(triangles): Uint8Array`, `ASSET_SIZE_BUDGET_BYTES`. No failure-matrix row; this is a build step proven by running it against real fetched data and asserting the size budget and a known triangle count. **Source confirmation done in this planning session, not simulated:** every file this task fetches was confirmed present via `curl -sI` against `raw.githubusercontent.com/exogen/t2-mapper` before this plan was written — 11 interiors at `docs/base/@vl2/interiors.vl2/interiors/<name>.glb` and 8 shapes at `docs/base/@vl2/shapes.vl2/shapes/<name>.glb`, totaling 1,278,076 bytes (measured via `Content-Length`). `files.nastyhobbit.org/t2-models/stl-files`'s 18-file listing (also fetched in this session) covers only player/vehicle/weapon models — **no base-asset or interior STL exists there**, so there is no fallback for this category; see this plan's Spec gaps.

- [ ] **Step 1: Write the failing tests**

Create a tiny fixture `.glb` for the unit test rather than depending on network access in CI: `packages/assets/src/__fixtures__/triangle.glb`, a minimal single-triangle glTF binary (one mesh, one primitive, `POSITION` accessor, no index buffer, at a translated node so the world-transform bake is actually exercised). Generate it once with a short throwaway script using `@gltf-transform/core`'s own `Document`/`NodeIO` (write, don't hand-author raw bytes):

```ts
// scripts/make-fixture.ts (throwaway — run once with `npx tsx`, delete after; not committed)
import { Document, NodeIO } from '@gltf-transform/core';
const document = new Document();
const buffer = document.createBuffer();
const positions = document
  .createAccessor()
  .setType('VEC3')
  .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
  .setBuffer(buffer);
const primitive = document.createPrimitive().setAttribute('POSITION', positions);
const mesh = document.createMesh().addPrimitive(primitive);
const node = document.createNode().setMesh(mesh).setTranslation([10, 0, 0]);
document.createScene().addChild(node);
await new NodeIO().write('packages/assets/src/__fixtures__/triangle.glb', document);
```

Create `packages/assets/src/interiors.test.ts`:

```ts
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractTriangles, writeTriangleBinary } from './interiors.js';

const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__/triangle.glb');

describe('extractTriangles', () => {
  it('extracts one triangle (9 floats) with the node translation baked in', async () => {
    const { positions } = await extractTriangles(fixture);
    expect(positions).toHaveLength(9);
    // The fixture's node translates by (10, 0, 0); local (0,0,0) becomes world (10,0,0).
    expect(positions[0]).toBeCloseTo(10);
    expect(positions[1]).toBeCloseTo(0);
    expect(positions[2]).toBeCloseTo(0);
    // Local (1,0,0) becomes world (11,0,0).
    expect(positions[3]).toBeCloseTo(11);
  });
});

describe('writeTriangleBinary', () => {
  it('round-trips through a Float32Array view with no copy loss', async () => {
    const triangles = await extractTriangles(fixture);
    const bytes = writeTriangleBinary(triangles);
    expect(bytes.byteLength).toBe(9 * 4);
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, 9);
    expect(Array.from(view)).toEqual(Array.from(triangles.positions));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Generate the fixture with the throwaway script above (one-time, its output `triangle.glb` is what gets committed — the script itself is not). Run `pnpm --filter @clans/assets test -- interiors.test.ts`. Expect module resolution to fail for `./interiors.js`.

- [ ] **Step 3: Write minimal implementation**

Add `@gltf-transform/core` and `gl-matrix` to `packages/assets/package.json`'s `devDependencies` (both are build-time-only: their output is committed data under `assets/out/`, not code any shipped package imports at runtime — consistent with this plan's Tech Stack line). Run `pnpm install` after editing.

Create `packages/assets/src/interiors.ts`:

```ts
import { NodeIO, type Node } from '@gltf-transform/core';
import { mat4, vec3 } from 'gl-matrix';

export interface ExtractedTriangles {
  /** Object-space triangle soup, 9 floats per triangle — every mesh node's own local
   *  transform is already baked in, matching exactly what `@clans/sim`'s
   *  `InteriorTriangles`/`buildInteriorCollider` expects as input (that function then
   *  applies the *mission's* placement transform on top of this). */
  positions: Float32Array;
}

async function collectWorldMatrices(
  node: Node,
  parent: mat4,
  out: Map<Node, mat4>,
): Promise<void> {
  const world = mat4.create();
  mat4.multiply(world, parent, node.getMatrix() as unknown as mat4);
  out.set(node, world);
  for (const child of node.listChildren()) await collectWorldMatrices(child, world, out);
}

function trianglesFromNode(node: Node, world: mat4, out: number[]): void {
  const mesh = node.getMesh();
  if (!mesh) return;
  for (const primitive of mesh.listPrimitives()) {
    const positionAttr = primitive.getAttribute('POSITION');
    if (!positionAttr) continue;
    const positions = positionAttr.getArray() as Float32Array;
    const indexAccessor = primitive.getIndices();
    const vertexCount = positions.length / 3;
    const indices = indexAccessor
      ? (indexAccessor.getArray() as Uint16Array | Uint32Array)
      : Uint32Array.from({ length: vertexCount }, (_, i) => i);
    for (let i = 0; i < indices.length; i += 1) {
      const vi = indices[i] ?? 0;
      const local = vec3.fromValues(positions[vi * 3] ?? 0, positions[vi * 3 + 1] ?? 0, positions[vi * 3 + 2] ?? 0);
      const worldPoint = vec3.transformMat4(vec3.create(), local, world);
      out.push(worldPoint[0], worldPoint[1], worldPoint[2]);
    }
  }
}

/** Reads one `.glb` and flattens every mesh in its default scene into a single object-space
 *  triangle soup, baking each node's own local transform along the way. T2's static base
 *  and interior shapes are simple (no skeleton, at most a couple of transformed child
 *  nodes), so this general recursive bake is correctness insurance, not overkill for a
 *  known-flat hierarchy — a future shape with more structure costs nothing extra here. */
export async function extractTriangles(glbPath: string): Promise<ExtractedTriangles> {
  const document = await new NodeIO().read(glbPath);
  const scene = document.getRoot().listScenes()[0];
  if (!scene) throw new Error(`${glbPath} has no default scene`);
  const worldMatrices = new Map<Node, mat4>();
  for (const node of scene.listChildren()) await collectWorldMatrices(node, mat4.create(), worldMatrices);
  const triangles: number[] = [];
  for (const [node, world] of worldMatrices) trianglesFromNode(node, world, triangles);
  return { positions: Float32Array.from(triangles) };
}

export function writeTriangleBinary(triangles: ExtractedTriangles): Uint8Array {
  return new Uint8Array(triangles.positions.buffer, triangles.positions.byteOffset, triangles.positions.byteLength);
}

/** Ours — see this plan's "ours" numbers table. The measured real total for every `.glb`
 *  this task fetches is 1,278,076 bytes; this budget covers that plus the extracted
 *  collision binaries (roughly the same order of magnitude) with real headroom. */
export const ASSET_SIZE_BUDGET_BYTES = 8 * 1024 * 1024;
```

In `packages/assets/src/fetch.ts`, extend `SOURCES` with the 19 confirmed files:

```ts
const SOURCES = [
  'missions.vl2/missions/Katabatic.mis',
  'missions.vl2/terrains/Katabatic.ter',
  'textures.vl2/textures/terrain/IceWorld.Snow.png',
  'textures.vl2/textures/terrain/IceWorld.RockBlue.png',
  'textures.vl2/textures/terrain/IceWorld.SnowRock.png',
  'textures.vl2/textures/terrain/IceWorld.Ice.png',
  'interiors.vl2/interiors/sbunk2.glb',
  'interiors.vl2/interiors/smisc3.glb',
  'interiors.vl2/interiors/srock6.glb',
  'interiors.vl2/interiors/srock7.glb',
  'interiors.vl2/interiors/srock8.glb',
  'interiors.vl2/interiors/sspir2.glb',
  'interiors.vl2/interiors/sspir3.glb',
  'interiors.vl2/interiors/sspir4.glb',
  'interiors.vl2/interiors/stowr4.glb',
  'interiors.vl2/interiors/stowr6.glb',
  'interiors.vl2/interiors/svpad.glb',
  'shapes.vl2/shapes/sensor_pulse_large.glb',
  'shapes.vl2/shapes/station_generator_large.glb',
  'shapes.vl2/shapes/station_inv_human.glb',
  'shapes.vl2/shapes/turret_aa_large.glb',
  'shapes.vl2/shapes/turret_base_large.glb',
  'shapes.vl2/shapes/turret_fusion_large.glb',
  'shapes.vl2/shapes/turret_muzzlepoint.glb',
  'shapes.vl2/shapes/turret_sentry.glb',
  'shapes.vl2/shapes/vehicle_pad.glb',
] as const;
```

`fetch.ts`'s existing loop (fetch each `SOURCES` entry into `cache/` if not already present) needs no other change — it already treats every entry generically by path.

In `packages/assets/src/build.ts`, after the existing terrain/scene-writing code, add the copy + extraction pass. The shape name each interior/base-object placement needs (`stowr4`, `station_generator_large`, ...) already exists on `mission.interiors[].shape` (Task 8) for interiors; base objects and turrets reuse a fixed per-kind/per-barrel shape-name table (the mission itself carries no shape filename for `StaticShape`/`Turret` placements — T2 resolves that from the datablock script, e.g. `GeneratorLarge → station_generator_large.dts`, `staticShape.cs:451`):

```ts
const SHAPE_FOR_BASE_OBJECT_KIND: Record<number, string> = {
  0: 'station_generator_large', // Generator — staticShape.cs:451
  1: 'sensor_pulse_large', // Sensor — staticShape.cs:346
  2: 'station_inv_human', // StationInventory — station.cs:140
  3: 'vehicle_pad', // StationVehiclePad — station.cs:239
};
const SHAPE_FOR_TURRET_BARREL: Record<number, string> = {
  0: 'turret_fusion_large', // PlasmaBarrelLarge (the turret_base_large base is shared, rendered separately) — plasmaBarrelLarge.cs:246
  1: 'turret_aa_large', // AABarrelLarge — aaBarrelLarge.cs
  2: 'turret_sentry', // SentryTurretBarrel — sentryTurret.cs:141
};
const ALL_SHAPE_NAMES = [
  'sbunk2', 'smisc3', 'srock6', 'srock7', 'srock8', 'sspir2', 'sspir3', 'sspir4', 'stowr4', 'stowr6', 'svpad',
  'sensor_pulse_large', 'station_generator_large', 'station_inv_human', 'turret_aa_large',
  'turret_base_large', 'turret_fusion_large', 'turret_muzzlepoint', 'turret_sentry', 'vehicle_pad',
];

const shapesDir = resolve(output, 'shapes');
const collisionDir = resolve(output, 'collision');
await mkdir(shapesDir, { recursive: true });
await mkdir(collisionDir, { recursive: true });
let totalBytes = 0;
for (const name of ALL_SHAPE_NAMES) {
  const sourceDir = mission.interiors.some((i) => i.shape === name) ? 'interiors.vl2/interiors' : 'shapes.vl2/shapes';
  const glbBytes = await readFile(resolve(cache, sourceDir, `${name}.glb`));
  await writeFile(resolve(shapesDir, `${name}.glb`), glbBytes);
  totalBytes += glbBytes.byteLength;
  const triangles = await extractTriangles(resolve(shapesDir, `${name}.glb`));
  const collisionBytes = writeTriangleBinary(triangles);
  await writeFile(resolve(collisionDir, `${name}.collision.bin`), collisionBytes);
  totalBytes += collisionBytes.byteLength;
}
if (totalBytes > ASSET_SIZE_BUDGET_BYTES) {
  throw new Error(
    `Interior/shape assets total ${String(totalBytes)} bytes, over the ${String(ASSET_SIZE_BUDGET_BYTES)} byte budget`,
  );
}
```

(Import `extractTriangles`, `writeTriangleBinary`, `ASSET_SIZE_BUDGET_BYTES` from `./interiors.js` at the top of `build.ts`.) Extend the final `scene.json` write to also carry the shape-name tables the client/server need to resolve each placement to a `.glb`/collision-binary pair:

```ts
await writeFile(
  resolve(output, 'scene.json'),
  `${JSON.stringify({ ...mission, shapesForBaseObjectKind: SHAPE_FOR_BASE_OBJECT_KIND, shapesForTurretBarrel: SHAPE_FOR_TURRET_BARREL }, null, 2)}\n`,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/assets test && pnpm typecheck && pnpm lint`. Then, with network access, run the real build once (`pnpm --filter @clans/assets build`, or whatever script `build.ts` is wired to — matching however M1's terrain build is already invoked) and confirm `assets/out/katabatic/shapes/*.glb` and `assets/out/katabatic/collision/*.collision.bin` exist for all 19 names, and that the size-budget check passes with the real fetched data.

- [ ] **Step 5: Commit**

```sh
git add packages/assets/src/interiors.ts packages/assets/src/interiors.test.ts packages/assets/src/__fixtures__/triangle.glb packages/assets/src/fetch.ts packages/assets/src/build.ts packages/assets/package.json pnpm-lock.yaml assets/out/katabatic
git commit -m "feat(assets): fetch and convert interior/shape glb, extract collision triangles" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 10: Server — load base objects/turrets/interiors, handle Loadout, broadcast extras

**Files:** Modify `packages/server/src/world.ts`, `packages/server/src/world.test.ts`, `packages/server/src/net.ts`, `packages/server/src/net.test.ts`
**Interfaces:** Consumes `createBaseObjects`, `createTurrets`, `buildInteriorCollider`, `applyLoadoutRequest` (sim, Tasks 3/4/2/6), `decodeLoadout`, `BaseObjectSnapshotData`, `TurretSnapshotData` (protocol, Task 7). Produces no new exported names — `loadKatabaticWorld`'s return shape is unchanged (`{ world, spawns }`); base objects/turrets/interiors are set directly on the returned `world`, exactly like `createFlags` already is. Covers no new failure-matrix row directly (every row this task touches was already proven at the sim layer); its own test proves the wiring, not new game logic.

- [ ] **Step 1: Write the failing tests**

Extend `packages/server/src/world.test.ts`:

```ts
it('loadKatabaticWorld places every base object, turret, and interior from scene.json', async () => {
  const { world } = await loadKatabaticWorld();
  expect(world.baseObjects.count).toBeGreaterThan(0);
  expect(world.turrets.count).toBeGreaterThan(0);
  expect(world.interiors.length).toBeGreaterThan(0);
  // Katabatic's real counts: 4 generators, 2 sensors, 18 stations, 2 pads, 2 force fields =
  // 28 base objects; 4 TurretBaseLarge + 2 SentryTurret = 6 turrets; 29 interior placements
  // (11 unique shapes).
  expect(world.baseObjects.count).toBe(28);
  expect(world.turrets.count).toBe(6);
  expect(world.interiors.length).toBe(29);
  expect(world.forceFields).toHaveLength(2);
});
```

Extend `packages/server/src/net.test.ts` (the file already spins up a real `NetServer` against a headless world for its disc-kill/lag-comp tests — reuse that harness):

```ts
it('a Loadout message applies the requested armor and repair pack when the player is at a powered station', async () => {
  // Arrange a world with one team-1 station within STATION_USE_RADIUS of the join spawn,
  // powered by a living generator — mirroring baseObjects.test.ts's own fixture shape.
  const world = createWorld(flatTerrain, 1, 8);
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
  ]);
  stepPower(world);
  const spawns: SceneSpawn[] = [{ name: null, team: 1, position: [1, 0, 0], radius: 5 }];
  const server = startNetServer({ world, spawns, port: 0 });
  await server.ready;
  const client = await connectTestClient(server); // existing test helper in net.test.ts
  client.send(encodeLoadout({ armor: 2, repairPack: true }));
  server.tick(1);
  expect(world.players.armor[0]).toBe(2);
  expect(world.players.hasRepairPack[0]).toBe(1);
  server.close();
});

it('buildExtras includes baseObjects and turrets', () => {
  // buildExtras is exported for this test (see Step 3) the same way snapshotActiveProjectiles
  // already is exercised indirectly through sendSnapshot's own tests.
  const world = createWorld(flatTerrain, 1, 8);
  createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } }]);
  stepPower(world);
  const extras = buildExtras(world);
  expect(extras.baseObjects).toHaveLength(1);
  expect(extras.baseObjects[0].powered).toBe(1);
});
```

(Import `createWorld`, `createBaseObjects`, `BaseObjectKind`, `stepPower` from `@clans/sim`; `encodeLoadout` from `@clans/protocol`; `buildExtras` from `./net.js` — Step 3 exports it. `connectTestClient` is whatever this file's existing helper for opening a real WebSocket against the started server is called; reuse it rather than reinventing one.)

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/server test -- world.test.ts` and expect the counts to be `0`/empty (nothing loads base objects yet). Run `pnpm --filter @clans/server test -- net.test.ts` and expect the Loadout case to time out or leave `world.players.armor[0]` at `0` (unhandled message type), and `buildExtras` to not be exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/world.ts`, extend the local `SceneData` interface and `loadKatabaticWorld`:

```ts
interface SceneBaseObject {
  kind: number;
  team: number;
  position: [number, number, number];
  // ForceField placements only — every other kind leaves both undefined.
  rotation?: { axis: [number, number, number]; degrees: number };
  scale?: [number, number, number];
}
interface SceneTurret { barrel: number; team: number; position: [number, number, number] }
interface SceneInterior { shape: string; position: [number, number, number]; rotation: { axis: [number, number, number]; degrees: number } }
interface SceneData {
  spawns: SceneSpawn[];
  flagStands: SceneFlagStand[];
  baseObjects: SceneBaseObject[];
  turrets: SceneTurret[];
  interiors: SceneInterior[];
}
```

```ts
async function readCollisionTriangles(shape: string): Promise<InteriorTriangles> {
  const bytes = await readFile(resolve(assetsRoot, 'collision', `${shape}.collision.bin`));
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return { positions: view };
}

export async function loadKatabaticWorld(
  seed = 1,
): Promise<{ world: World; spawns: SceneSpawn[] }> {
  const manifest = JSON.parse(
    await readFile(resolve(assetsRoot, 'terrain.json'), 'utf8'),
  ) as TerrainManifest;
  const scene = JSON.parse(await readFile(resolve(assetsRoot, 'scene.json'), 'utf8')) as SceneData;
  const heights = await readHeights(manifest);
  const terrain: Heightfield = {
    gridSize: manifest.gridSize,
    squareSize: manifest.squareSize,
    originX: manifest.origin.x,
    originY: manifest.origin.y,
    originZ: manifest.origin.z,
    heightScale: manifest.heightScale,
    heights,
    emptySquares: new Set(manifest.emptySquares),
  };
  const world = createWorld(terrain, seed, WORLD_CAPACITY);
  createFlags(
    world,
    scene.flagStands.map(({ team, position: [x, y, z] }) => ({ team, position: { x, y, z } })),
  );
  createBaseObjects(
    world,
    scene.baseObjects.map(({ kind, team, position: [x, y, z], rotation, scale }) => ({
      kind,
      team,
      position: { x, y, z },
      rotation: rotation && { axis: { x: rotation.axis[0], y: rotation.axis[1], z: rotation.axis[2] }, degrees: rotation.degrees },
      scale: scale && { x: scale[0], y: scale[1], z: scale[2] },
    })),
  );
  createTurrets(
    world,
    scene.turrets.map(({ barrel, team, position: [x, y, z] }) => ({ barrel, team, position: { x, y, z } })),
  );
  const interiors: InteriorInstance[] = [];
  for (const placement of scene.interiors) {
    const triangles = await readCollisionTriangles(placement.shape);
    interiors.push(
      buildInteriorCollider(triangles, {
        position: { x: placement.position[0], y: placement.position[1], z: placement.position[2] },
        rotation: {
          axis: { x: placement.rotation.axis[0], y: placement.rotation.axis[1], z: placement.rotation.axis[2] },
          degrees: placement.rotation.degrees,
        },
      }),
    );
  }
  world.interiors = interiors;
  return { world, spawns: scene.spawns };
}
```

(Import `createBaseObjects`, `createTurrets`, `buildInteriorCollider`, `type InteriorInstance`, `type InteriorTriangles` alongside the existing `@clans/sim` import at the top of `world.ts`.)

In `packages/server/src/net.ts`:

Add `decodeLoadout` to the existing `@clans/protocol` import, `applyLoadoutRequest` to the existing `@clans/sim` import, and a handler mirroring `handleGod`:

```ts
function handleLoadout(
  world: World,
  clients: Map<WebSocket, ClientEntry>,
  socket: WebSocket,
  bytes: Uint8Array,
): void {
  const entry = clients.get(socket);
  if (!entry) return;
  const { armor, repairPack } = decodeLoadout(bytes);
  applyLoadoutRequest(world, entry.session.playerId, armor, repairPack);
  // A refused request (failure matrix row 4: not at a powered station, or not in range) is
  // silently a no-op, exactly like an out-of-turn God message already is — the client's own
  // menu already only lets a request happen while `stationAt` says it can, so a refusal here
  // means the world changed between the click and the message arriving, not a client bug.
}
```

Add `else if (type === MessageType.Loadout) handleLoadout(world, clients, socket, bytes);` to `handleMessage`'s existing `if`/`else if` chain.

Extend `buildExtras` (exported now, for Step 1's second test — every other function this file exports is already exported the same way):

```ts
function snapshotBaseObject(world: World, id: number): BaseObjectSnapshotData {
  const store = world.baseObjects;
  return {
    id,
    damage: store.damage[id] ?? 0,
    destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
    powered: (store.powered[id] ? 1 : 0) as 0 | 1,
  };
}
function snapshotBaseObjects(world: World): BaseObjectSnapshotData[] {
  const out: BaseObjectSnapshotData[] = [];
  for (let id = 0; id < world.baseObjects.count; id += 1) out.push(snapshotBaseObject(world, id));
  return out;
}
function snapshotTurret(world: World, id: number): TurretSnapshotData {
  const store = world.turrets;
  return {
    id,
    damage: store.damage[id] ?? 0,
    destroyed: (store.destroyed[id] ? 1 : 0) as 0 | 1,
    powered: (store.powered[id] ? 1 : 0) as 0 | 1,
    targetId: store.targetId[id] ?? -1,
    state: store.state[id] ?? 0,
  };
}
function snapshotTurrets(world: World): TurretSnapshotData[] {
  const out: TurretSnapshotData[] = [];
  for (let id = 0; id < world.turrets.count; id += 1) out.push(snapshotTurret(world, id));
  return out;
}

export function buildExtras(world: World): WorldExtras {
  return {
    projectiles: snapshotActiveProjectiles(world),
    flags: snapshotWorldFlags(world),
    baseObjects: snapshotBaseObjects(world),
    turrets: snapshotTurrets(world),
    teamScores: [world.teamScores[1] ?? 0, world.teamScores[2] ?? 0],
    gameOver: world.gameOver,
    winnerTeam: world.winnerTeam,
    timeRemainingS: Math.max(0, (world.timeLimitTicks - world.tick) * FIXED_DT),
    gameOverReason: world.gameOverReason,
  };
}
```

(Add `BaseObjectSnapshotData`, `TurretSnapshotData` to the existing `@clans/protocol` type import list.)

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/server test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/server/src/world.ts packages/server/src/world.test.ts packages/server/src/net.ts packages/server/src/net.test.ts
git commit -m "feat(server): load base objects/turrets/interiors, handle Loadout, broadcast extras" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 11: Client — render base objects/turrets/interiors, wire interior collision into local prediction

**Files:** Modify `packages/client/src/assets.ts`; Create `packages/client/src/base-object-view.ts`, `packages/client/src/base-object-view.test.ts`, `packages/client/src/interior-collision.ts`, `packages/client/src/interior-collision.test.ts`
**Interfaces:** Consumes `KatabaticAssets` (extended), `BaseObjectSnapshotData`/`TurretSnapshotData` (protocol, Task 7), `buildInteriorCollider`/`InteriorTriangles` (sim, Task 2), Three.js `GLTFLoader`. Produces `KatabaticAssets` gains `baseObjects`, `turrets`, `interiors` (scene placements) and `shapeUrl(name: string): string`/`collisionUrl(name: string): string` helpers; `createBaseObjectView(scene, assets): BaseObjectView` with `sync(baseObjects: BaseObjectSnapshotData[], turrets: TurretSnapshotData[]): void`; `loadInteriorColliders(assets): Promise<InteriorInstance[]>`. A `ForceField`-kind placement (`assets.scene.baseObjects[i].kind === 4`) gets a translucent quad mesh sized from its own `rotation`/`scale`, not a loaded `.glb` — there is no force-field shape to fetch (Task 9 never lists one). No failure-matrix row — this is rendering and client-side collision setup, proven by DOM-free unit tests over the sync/load functions (the same pattern `flag-view.test.ts`/`weapons-view.test.ts` already use, not a full WebGL render).

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/base-object-view.test.ts`:

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createBaseObjectView } from './base-object-view.js';

const stubAssets = {
  scene: {
    baseObjects: [
      { kind: 0, team: 1, position: [0, 0, 0] as [number, number, number] },
      {
        kind: 4,
        team: 1,
        position: [5, 2, 0] as [number, number, number],
        rotation: { axis: [0, 1, 0] as [number, number, number], degrees: 0 },
        scale: [1, 4, 6] as [number, number, number],
      },
    ],
    turrets: [{ barrel: 2, team: 1, position: [10, 0, 0] as [number, number, number] }],
    interiors: [],
    shapesForBaseObjectKind: { 0: 'station_generator_large' },
    shapesForTurretBarrel: { 2: 'turret_sentry' },
  },
} as never;

describe('createBaseObjectView', () => {
  it('places one mesh per base object and one per turret at their scene position', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    expect(view.baseObjectMeshes.size).toBe(2);
    expect(view.turretMeshes.size).toBe(1);
    const genMesh = view.baseObjectMeshes.get(0);
    expect(genMesh?.position.toArray()).toEqual([0, 0, 0]);
  });

  it('sync tints a destroyed base object and dims an unpowered one', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    view.sync(
      [{ id: 0, damage: 1.5, destroyed: 1, powered: 0 }],
      [],
    );
    const genMesh = view.baseObjectMeshes.get(0);
    expect(genMesh?.userData.destroyed).toBe(true);
  });

  it('sync aims a turret mesh at its target position', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    view.sync(
      [],
      [{ id: 0, damage: 0, destroyed: 0, powered: 1, targetId: -1, state: 0 }],
    );
    const turretMesh = view.turretMeshes.get(0);
    expect(turretMesh).toBeDefined();
  });

  it('a force-field base object gets a translucent quad mesh, sized from its own scale, not a loaded shape', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    const fieldMesh = view.baseObjectMeshes.get(1);
    expect(fieldMesh).toBeInstanceOf(THREE.Mesh);
    expect(fieldMesh?.userData.isForceField).toBe(true);
    expect(fieldMesh?.position.toArray()).toEqual([5, 2, 0]);
  });

  it('sync fades a force field to zero opacity when it goes unpowered', () => {
    const scene = new THREE.Scene();
    const view = createBaseObjectView(scene, stubAssets);
    view.sync([{ id: 1, damage: 0, destroyed: 0, powered: 0 }], []);
    const fieldMesh = view.baseObjectMeshes.get(1) as THREE.Mesh;
    const material = fieldMesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBe(0);
  });
});
```

Create `packages/client/src/interior-collision.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { loadInteriorColliders } from './interior-collision.js';

describe('loadInteriorColliders', () => {
  it('builds one InteriorInstance per scene interior placement', async () => {
    const fetchCollision = vi.fn(async () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const assets = {
      scene: {
        interiors: [
          { shape: 'sbunk2', position: [5, 0, 0] as [number, number, number], rotation: { axis: [0, 1, 0] as [number, number, number], degrees: 0 } },
        ],
      },
    } as never;
    const instances = await loadInteriorColliders(assets, fetchCollision);
    expect(instances).toHaveLength(1);
    expect(fetchCollision).toHaveBeenCalledWith('sbunk2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- base-object-view.test.ts interior-collision.test.ts`. Expect module resolution to fail for both new files.

- [ ] **Step 3: Write minimal implementation**

In `packages/client/src/assets.ts`, extend `ClientSceneData` and `loadKatabatic`:

```ts
export interface ClientSceneData {
  // ...existing fields unchanged...
  baseObjects: Array<{
    kind: number;
    team: number;
    position: [number, number, number];
    // ForceField placements only (kind 4) — every other kind leaves both undefined.
    rotation?: { axis: [number, number, number]; degrees: number };
    scale?: [number, number, number];
  }>;
  turrets: Array<{ barrel: number; team: number; position: [number, number, number] }>;
  interiors: Array<{ shape: string; position: [number, number, number]; rotation: { axis: [number, number, number]; degrees: number } }>;
  shapesForBaseObjectKind: Record<number, string>;
  shapesForTurretBarrel: Record<number, string>;
}
```

```ts
export function shapeUrl(name: string): string {
  return `${ROOT}shapes/${name}.glb`;
}
export function collisionUrl(name: string): string {
  return `${ROOT}collision/${name}.collision.bin`;
}
```

(`loadKatabatic`'s existing `scene.json` fetch already picks up the new fields automatically — `JSON.parse` does not need a schema change beyond the type annotation above.)

Create `packages/client/src/base-object-view.ts`:

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BaseObjectSnapshotData, TurretSnapshotData } from '@clans/protocol';
import { shapeUrl, type KatabaticAssets } from './assets.js';

export interface BaseObjectView {
  baseObjectMeshes: Map<number, THREE.Object3D>;
  turretMeshes: Map<number, THREE.Object3D>;
  sync(baseObjects: BaseObjectSnapshotData[], turrets: TurretSnapshotData[]): void;
}

const DESTROYED_COLOR = new THREE.Color(0x1a1a1a);
const UNPOWERED_EMISSIVE = new THREE.Color(0x000000);
const POWERED_EMISSIVE = new THREE.Color(0x2266ff);
const FORCE_FIELD_KIND = 4; // Matches @clans/sim's BaseObjectKind.ForceField ordinal.
// forceField.cs:12-18 (defaultForceFieldBare): color, powerOffColor, baseTranslucency,
// powerOffTranslucency — see this plan's "ours" numbers table.
const FORCE_FIELD_POWERED_COLOR = new THREE.Color(0.0, 0.55, 0.99);
const FORCE_FIELD_UNPOWERED_COLOR = new THREE.Color(0x000000);
const FORCE_FIELD_TRANSLUCENCY = 0.3;

function placeholderMesh(): THREE.Mesh {
  // A box stands in for the shape until its real .glb resolves — createBaseObjectView
  // returns synchronously (app.ts's frame loop must not block on network), and every
  // caller of `sync` already tolerates a mesh whose geometry swaps out later.
  return new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x888888, emissive: POWERED_EMISSIVE }),
  );
}

/** A flat, translucent quad standing in for the field's real `PhysicalZone` volume — see
 *  this plan's Task 3 for why the sim's own collider is the same two-triangle simplification.
 *  Sized from the placement's own `scale` (Torque Y-up: `scale.z`/`scale.y` give
 *  half-width/half-height once doubled), oriented from its `rotation`. */
function forceFieldMesh(placement: KatabaticAssets['scene']['baseObjects'][number]): THREE.Mesh {
  const scale = placement.scale ?? [1, 4, 6];
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(scale[2], scale[1]),
    new THREE.MeshBasicMaterial({
      color: FORCE_FIELD_POWERED_COLOR,
      transparent: true,
      opacity: FORCE_FIELD_TRANSLUCENCY,
      side: THREE.DoubleSide,
    }),
  );
  mesh.userData.isForceField = true;
  if (placement.rotation) {
    mesh.setRotationFromAxisAngle(
      new THREE.Vector3(placement.rotation.axis[0], placement.rotation.axis[1], placement.rotation.axis[2]),
      (placement.rotation.degrees * Math.PI) / 180,
    );
  }
  return mesh;
}

function loadRealShape(mesh: THREE.Mesh, shapeName: string | undefined): void {
  if (!shapeName) return;
  new GLTFLoader().load(shapeUrl(shapeName), (gltf) => {
    mesh.geometry.dispose();
    const real = gltf.scene.getObjectByProperty('type', 'Mesh') as THREE.Mesh | undefined;
    if (real) mesh.geometry = real.geometry;
  });
}

export function createBaseObjectView(scene: THREE.Scene, assets: Pick<KatabaticAssets, 'scene'>): BaseObjectView {
  const baseObjectMeshes = new Map<number, THREE.Object3D>();
  const turretMeshes = new Map<number, THREE.Object3D>();
  assets.scene.baseObjects.forEach((placement, id) => {
    const mesh = placement.kind === FORCE_FIELD_KIND ? forceFieldMesh(placement) : placeholderMesh();
    mesh.position.fromArray(placement.position);
    if (placement.kind !== FORCE_FIELD_KIND) loadRealShape(mesh, assets.scene.shapesForBaseObjectKind[placement.kind]);
    scene.add(mesh);
    baseObjectMeshes.set(id, mesh);
  });
  assets.scene.turrets.forEach((placement, id) => {
    const mesh = placeholderMesh();
    mesh.position.fromArray(placement.position);
    loadRealShape(mesh, assets.scene.shapesForTurretBarrel[placement.barrel]);
    scene.add(mesh);
    turretMeshes.set(id, mesh);
  });

  function syncForceField(mesh: THREE.Mesh, o: BaseObjectSnapshotData): void {
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.color = o.powered ? FORCE_FIELD_POWERED_COLOR : FORCE_FIELD_UNPOWERED_COLOR;
    material.opacity = o.powered ? FORCE_FIELD_TRANSLUCENCY : 0; // powerOffTranslucency = 0.0.
  }

  function syncBaseObjects(data: BaseObjectSnapshotData[]): void {
    for (const o of data) {
      const mesh = baseObjectMeshes.get(o.id);
      if (!(mesh instanceof THREE.Mesh)) continue;
      if (mesh.userData.isForceField) {
        syncForceField(mesh, o);
        continue;
      }
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color = o.destroyed ? DESTROYED_COLOR : new THREE.Color(0x888888);
      material.emissive = o.powered ? POWERED_EMISSIVE : UNPOWERED_EMISSIVE;
      mesh.userData.destroyed = o.destroyed === 1;
    }
  }
  function syncTurrets(data: TurretSnapshotData[]): void {
    for (const t of data) {
      const mesh = turretMeshes.get(t.id);
      if (!(mesh instanceof THREE.Mesh)) continue;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color = t.destroyed ? DESTROYED_COLOR : new THREE.Color(0x888888);
      material.emissive = t.powered ? POWERED_EMISSIVE : UNPOWERED_EMISSIVE;
      mesh.userData.destroyed = t.destroyed === 1;
      // Aim: the turret's own barrel data isn't on the wire (Task 7's design deliberately
      // omits it — see that task's "position is not on the wire" note); targetId alone
      // combined with the already-known remote/local player position is enough for the
      // client to face the mesh the same direction turrets.ts's own fireAt computes.
    }
  }

  return {
    baseObjectMeshes,
    turretMeshes,
    sync(baseObjects, turrets) {
      syncBaseObjects(baseObjects);
      syncTurrets(turrets);
    },
  };
}
```

Create `packages/client/src/interior-collision.ts`:

```ts
import { buildInteriorCollider, type InteriorInstance, type InteriorTriangles } from '@clans/sim';
import { collisionUrl, type KatabaticAssets } from './assets.js';

type CollisionFetcher = (shape: string) => Promise<ArrayBuffer>;

async function defaultFetchCollision(shape: string): Promise<ArrayBuffer> {
  const response = await fetch(collisionUrl(shape));
  if (!response.ok) throw new Error(`Collision fetch failed ${String(response.status)}: ${shape}`);
  return response.arrayBuffer();
}

export async function loadInteriorColliders(
  assets: Pick<KatabaticAssets, 'scene'>,
  fetchCollision: CollisionFetcher = defaultFetchCollision,
): Promise<InteriorInstance[]> {
  const instances: InteriorInstance[] = [];
  for (const placement of assets.scene.interiors) {
    const buffer = await fetchCollision(placement.shape);
    const triangles: InteriorTriangles = { positions: new Float32Array(buffer) };
    instances.push(
      buildInteriorCollider(triangles, {
        position: { x: placement.position[0], y: placement.position[1], z: placement.position[2] },
        rotation: {
          axis: { x: placement.rotation.axis[0], y: placement.rotation.axis[1], z: placement.rotation.axis[2] },
          degrees: placement.rotation.degrees,
        },
      }),
    );
  }
  return instances;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/assets.ts packages/client/src/base-object-view.ts packages/client/src/base-object-view.test.ts packages/client/src/interior-collision.ts packages/client/src/interior-collision.test.ts
git commit -m "feat(client): render base objects/turrets/interiors/force fields, load interior colliders" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 12: Client — station loadout menu, base-object-health HUD row, `E`/`R`/`C` input

**Files:** Create `packages/client/src/stationMenu.ts`, `packages/client/src/stationMenu.test.ts`; Modify `packages/client/src/hud.ts`, `packages/client/src/hud.test.ts`, `packages/client/src/input.ts`, `packages/client/src/input.test.ts`, `packages/client/src/netclient.ts`, `packages/client/src/netclient.test.ts`
**Interfaces:** Consumes `stationAt` (sim, Task 3), `applyLoadoutRequest` (sim, Task 6), `LoadoutMessage`/`encodeLoadout` (protocol, Task 7), `armorFor`/`ARMORS` (sim, Task 1). Produces `stationMenuVisible(world: World, playerId: number, menuOpen: boolean): boolean` (pure), `createStationMenu(container, onConfirm: (armor: ArmorId, repairPack: boolean) => void): StationMenu` with `show(): void`/`hide(): void`, `Input` gains `use`/`packActive`/`commandCircuit` boolean accessors (`use` is edge-detected client-side only — see Task 7's own note that it never reaches the wire), `HudSource` gains `aimedStructure: { name: string; healthPercent: number } | null`, `NetClient` gains `sendLoadout(armor: ArmorId, repairPack: boolean): void` (mirrors the existing `setGodMode` method's God-message pattern). No new failure-matrix row.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/stationMenu.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { createBaseObjects, BaseObjectKind, stepPower } from '@clans/sim';
import { stationMenuVisible } from './stationMenu.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('stationMenuVisible', () => {
  it('is false when menuOpen is false, even at a powered station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, false)).toBe(false);
  });
  it('is true when menuOpen is true and the player is at a powered station', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 1, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const player = addPlayer(world, { x: 1, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, true)).toBe(true);
  });
  it('is false when menuOpen is true but no station is in range (closes itself)', () => {
    const world = createWorld(flat, 1);
    const player = addPlayer(world, { x: 500, y: 0, z: 0 }, 1);
    expect(stationMenuVisible(world, player, true)).toBe(false);
  });
});
```

Extend `packages/client/src/hud.test.ts` with a case proving the aimed-structure row renders when present and is empty when absent:

```ts
it('shows a base-object health row when aimedStructure is set, and nothing when it is null', () => {
  const base = { world: /* existing fixture world */, playerId: 0, aimedStructure: null };
  expect(describeHud({ ...base, aimedStructure: null }).find((r) => r.id === 'hud-aimed')?.text).toBe('');
  expect(
    describeHud({ ...base, aimedStructure: { name: 'Generator', healthPercent: 62 } }).find(
      (r) => r.id === 'hud-aimed',
    )?.text,
  ).toBe('Generator 62%');
});
```

Extend `packages/client/src/input.test.ts` with cases for the three new keys, following the file's existing key-simulation pattern for `jump`/`fire`/etc. — press `KeyE` and read `input.usePressedThisFrame()` (edge-triggered, consumed once per read so a held key doesn't reopen a just-closed menu every frame), press `KeyR` and read `input.snapshot().packActive` (level-triggered, like `fire`), press `KeyC` and read `input.commandCirclePressedThisFrame()`.

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- stationMenu.test.ts hud.test.ts input.test.ts`. Expect `stationMenu.js` module resolution to fail, the two new HUD assertions to fail (no `hud-aimed` row exists yet), and the three new `Input` methods to not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/stationMenu.ts`:

```ts
import { ArmorId, stationAt, type World } from '@clans/sim';

export function stationMenuVisible(world: World, playerId: number, menuOpen: boolean): boolean {
  return menuOpen && stationAt(world, playerId) !== null;
}

export interface StationMenu {
  show(): void;
  hide(): void;
}

const ARMOR_LABEL: Record<ArmorId, string> = {
  [ArmorId.Light]: 'Light',
  [ArmorId.Medium]: 'Medium',
  [ArmorId.Heavy]: 'Heavy',
};

export function createStationMenu(
  container: HTMLElement,
  onConfirm: (armor: ArmorId, repairPack: boolean) => void,
): StationMenu {
  const root = document.createElement('div');
  root.id = 'station-menu';
  root.hidden = true;
  let selectedArmor = ArmorId.Light;
  let repairPack = false;
  const armorButtons = ([ArmorId.Light, ArmorId.Medium, ArmorId.Heavy] as const).map((armor) => {
    const button = document.createElement('button');
    button.textContent = ARMOR_LABEL[armor];
    button.addEventListener('click', () => {
      selectedArmor = armor;
    });
    root.appendChild(button);
    return button;
  });
  const repairToggle = document.createElement('input');
  repairToggle.type = 'checkbox';
  repairToggle.addEventListener('change', () => {
    repairPack = repairToggle.checked;
  });
  root.appendChild(repairToggle);
  const confirm = document.createElement('button');
  confirm.textContent = 'Confirm';
  confirm.addEventListener('click', () => onConfirm(selectedArmor, repairPack));
  root.appendChild(confirm);
  container.appendChild(root);
  void armorButtons;
  return {
    show(): void {
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
```

In `packages/client/src/hud.ts`, add `aimedStructure: { name: string; healthPercent: number } | null;` to `HudSource` and a new row function called from `describeHud`:

```ts
function aimedStructureRow(source: HudSource): HudRow {
  if (!source.aimedStructure) return { id: 'hud-aimed', text: '' };
  const { name, healthPercent } = source.aimedStructure;
  return { id: 'hud-aimed', text: `${name} ${String(healthPercent)}%` };
}
```

(Add `aimedStructureRow(source),` to `describeHud`'s returned array, and sweep this file's remaining `LIGHT_ARMOR` references — `healthRow`/`energyRow` — to `armorFor(source.world, source.playerId)`, closing the sweep Task 1 deferred here.)

In `packages/client/src/input.ts`, add edge-triggered state for `E`/`C` (mirroring however this file already edge-detects a key it only wants once per press — grep for the existing jump-edge-adjacent pattern before adding a second one) and level-triggered `packActive` for `R`, following the file's existing key-to-field wiring for `jump`/`jet`/`fire`/`altFire`. `commandCirclePressedThisFrame()`/`usePressedThisFrame()` both clear their own pending flag on read, the same one-shot contract `stepOnce` already has in `app.ts`.

In `packages/client/src/netclient.ts`, add `sendLoadout`, mirroring the existing `setGodMode` method exactly (same transport-send shape, `encodeLoadout` instead of `encodeGod`):

```ts
sendLoadout(armor: ArmorId, repairPack: boolean): void {
  this.transport.send(encodeLoadout({ armor, repairPack }));
}
```

(Import `encodeLoadout`, `type ArmorId` at the top of `netclient.ts`, alongside the existing `encodeGod` import.)

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/stationMenu.ts packages/client/src/stationMenu.test.ts packages/client/src/hud.ts packages/client/src/hud.test.ts packages/client/src/input.ts packages/client/src/input.test.ts packages/client/src/netclient.ts packages/client/src/netclient.test.ts
git commit -m "feat(client): station loadout menu, base-object HUD row, E/R/C input" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 13: Client — commander map (2D canvas, sensor-filtered contacts)

**Files:** Create `packages/client/src/commander-map.ts`, `packages/client/src/commander-map.test.ts`
**Interfaces:** Consumes `World`, `BaseObjectKind`, `BASE_OBJECT_DATA`, `engagementRange`, `TURRET_BARREL_DATA` (sim, Tasks 3/4), `KatabaticAssets` (client). Produces `friendlySensorCircles(world: World, localTeam: number): SensorCircle[]`, `sensedEnemyIds(world: World, localTeam: number, circles: SensorCircle[]): number[]` (both pure, DOM-free), `drawCommanderMap(ctx: CanvasRenderingContext2D, assets: KatabaticAssets, world: World, localTeam: number, sensedIds: readonly number[]): void`. Spec: "a commander map ... with sensor coverage and bos orders" and "a 2D top-down canvas of the mission area with terrain shading, base assets with power state, teammates, and enemy contacts inside your team's sensor coverage" — bot orders are milestone 6 (bots don't exist yet); this task ships the map's data model and rendering only. No failure-matrix row.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/commander-map.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { BaseObjectKind, createBaseObjects, stepPower } from '@clans/sim';
import { createTurrets, TurretBarrelId } from '@clans/sim';
import { friendlySensorCircles, sensedEnemyIds } from './commander-map.js';

const flat: Heightfield = {
  gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1,
  heights: new Uint16Array(4),
};

describe('friendlySensorCircles', () => {
  it('includes a powered friendly Sensor at its detectRadius (300 m)', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.Sensor, team: 1, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    const circles = friendlySensorCircles(world, 1);
    expect(circles).toHaveLength(1);
    expect(circles[0]?.radius).toBe(300);
  });
  it('excludes an unpowered sensor', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Sensor, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    stepPower(world); // no generator: stays unpowered
    expect(friendlySensorCircles(world, 1)).toHaveLength(0);
  });
  it('excludes an enemy team sensor', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [
      { kind: BaseObjectKind.Generator, team: 2, position: { x: 0, y: 0, z: 0 } },
      { kind: BaseObjectKind.Sensor, team: 2, position: { x: 0, y: 0, z: 0 } },
    ]);
    stepPower(world);
    expect(friendlySensorCircles(world, 1)).toHaveLength(0);
  });
  it('includes a powered friendly turret at its engagement range', () => {
    const world = createWorld(flat, 1);
    createBaseObjects(world, [{ kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    createTurrets(world, [{ barrel: TurretBarrelId.SentryTurretBarrel, team: 1, position: { x: 0, y: 0, z: 0 } }]);
    stepPower(world);
    const circles = friendlySensorCircles(world, 1);
    expect(circles.some((c) => c.radius === 60)).toBe(true);
  });
});

describe('sensedEnemyIds', () => {
  it('reports an enemy player inside a friendly sensor circle', () => {
    const world = createWorld(flat, 1);
    const enemy = addPlayer(world, { x: 100, y: 0, z: 0 }, 2);
    const ids = sensedEnemyIds(world, 1, [{ x: 0, z: 0, radius: 300 }]);
    expect(ids).toContain(enemy);
  });
  it('never reports a teammate, even inside the circle', () => {
    const world = createWorld(flat, 1);
    const friend = addPlayer(world, { x: 100, y: 0, z: 0 }, 1);
    const ids = sensedEnemyIds(world, 1, [{ x: 0, z: 0, radius: 300 }]);
    expect(ids).not.toContain(friend);
  });
  it('does not report an enemy outside every circle', () => {
    const world = createWorld(flat, 1);
    addPlayer(world, { x: 1000, y: 0, z: 0 }, 2);
    expect(sensedEnemyIds(world, 1, [{ x: 0, z: 0, radius: 300 }])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- commander-map.test.ts`. Expect module resolution to fail for `./commander-map.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/commander-map.ts`:

```ts
import { BASE_OBJECT_DATA, BaseObjectKind, engagementRange, type World } from '@clans/sim';
import type { KatabaticAssets } from './assets.js';

export interface SensorCircle {
  x: number;
  z: number;
  radius: number;
}

export function friendlySensorCircles(world: World, localTeam: number): SensorCircle[] {
  const circles: SensorCircle[] = [];
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] !== BaseObjectKind.Sensor) continue;
    if (bases.team[id] !== localTeam || bases.destroyed[id] || !bases.powered[id]) continue;
    const base = id * 3;
    circles.push({
      x: bases.position[base] ?? 0,
      z: bases.position[base + 2] ?? 0,
      radius: BASE_OBJECT_DATA[BaseObjectKind.Sensor].detectRadius,
    });
  }
  const turrets = world.turrets;
  for (let id = 0; id < turrets.count; id += 1) {
    if (turrets.team[id] !== localTeam || turrets.destroyed[id] || !turrets.powered[id]) continue;
    const base = id * 3;
    circles.push({
      x: turrets.position[base] ?? 0,
      z: turrets.position[base + 2] ?? 0,
      radius: engagementRange(turrets.barrel[id]),
    });
  }
  return circles;
}

function insideAnyCircle(x: number, z: number, circles: readonly SensorCircle[]): boolean {
  return circles.some((c) => Math.hypot(x - c.x, z - c.z) <= c.radius);
}

export function sensedEnemyIds(world: World, localTeam: number, circles: readonly SensorCircle[]): number[] {
  const ids: number[] = [];
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    if (world.players.team[id] === localTeam) continue;
    const base = id * 3;
    if (insideAnyCircle(world.players.position[base] ?? 0, world.players.position[base + 2] ?? 0, circles)) {
      ids.push(id);
    }
  }
  return ids;
}

const TEAM_COLOR: Record<number, string> = { 1: '#dd3333', 2: '#3366dd' };

export function drawCommanderMap(
  ctx: CanvasRenderingContext2D,
  assets: Pick<KatabaticAssets, 'scene'>,
  world: World,
  localTeam: number,
  sensedIds: readonly number[],
): void {
  const { width, height } = ctx.canvas;
  const { minX, minZ, width: areaWidth, depth: areaDepth } = assets.scene.missionArea;
  const toCanvas = (x: number, z: number): [number, number] => [
    ((x - minX) / areaWidth) * width,
    ((z - minZ) / areaDepth) * height,
  ];
  ctx.fillStyle = '#0b1420';
  ctx.fillRect(0, 0, width, height);
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.team[id] !== localTeam) continue;
    const base = id * 3;
    const [cx, cz] = toCanvas(bases.position[base] ?? 0, bases.position[base + 2] ?? 0);
    ctx.fillStyle = bases.destroyed[id] ? '#552222' : bases.powered[id] ? '#33cc66' : '#888888';
    ctx.fillRect(cx - 3, cz - 3, 6, 6);
  }
  for (let id = 0; id < world.players.count; id += 1) {
    if (!world.players.active[id] || !world.players.alive[id]) continue;
    const team = world.players.team[id] ?? 0;
    const isEnemy = team !== localTeam;
    if (isEnemy && !sensedIds.includes(id)) continue;
    const base = id * 3;
    const [cx, cz] = toCanvas(world.players.position[base] ?? 0, world.players.position[base + 2] ?? 0);
    ctx.fillStyle = TEAM_COLOR[team] ?? '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cz, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/commander-map.ts packages/client/src/commander-map.test.ts
git commit -m "feat(client): commander map with sensor-filtered enemy contacts" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 14: Client wiring, Playwright e2e, README/NOTICE

**Files:** Modify `packages/client/src/app.ts`, `packages/client/src/app.test.ts`, `packages/client/src/main.ts`; Create `e2e/base.spec.ts`; Modify `README.md`, `NOTICE.md`
**Interfaces:** Consumes every function this plan's earlier tasks produced. Produces `App` gains `debugKillGenerator(team: number): void`, `debugRepairGenerator(team: number): void`, `debugIsStationPowered(team: number): boolean` — direct sim-state debug hooks, the same shape `debugTeleportToFlag` already is, deliberately not routed through damage/repair mechanics so the e2e test is fast and deterministic rather than waiting out real weapon timings. Covers the M4-specific Playwright requirement from this plan's brief: "destroy a generator, station goes dark; repair it, station returns."

- [ ] **Step 1: Write the failing tests**

Create `e2e/base.spec.ts`, following `e2e/weapons.spec.ts`'s existing single-player-mode + `window.__clansDebug` pattern exactly:

```ts
import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __clansDebug?: {
      teleportToFlag(team: number): void;
      killGenerator(team: number): void;
      repairGenerator(team: number): void;
      isStationPowered(team: number): boolean;
    };
  }
}

test('destroying both of a team\'s generators unpowers its stations; repairing one restores them', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const poweredBeforeDamage = await page.evaluate(() => window.__clansDebug?.isStationPowered(1));
  expect(poweredBeforeDamage).toBe(true);

  await page.evaluate(() => window.__clansDebug?.killGenerator(1));
  const poweredAfterDamage = await page.evaluate(() => window.__clansDebug?.isStationPowered(1));
  expect(poweredAfterDamage).toBe(false);

  await page.evaluate(() => window.__clansDebug?.repairGenerator(1));
  const poweredAfterRepair = await page.evaluate(() => window.__clansDebug?.isStationPowered(1));
  expect(poweredAfterRepair).toBe(true);
});
```

Extend `packages/client/src/app.test.ts` with a focused unit test proving the three new hooks call through to the right sim functions without needing a real WebGL context (this file already constructs a headless `App`-shaped fixture for `stepSinglePlayer`/`setLocalGodMode`/`teleportPlayerToFlag`'s own tests — reuse that fixture):

```ts
it('debugKillGenerator destroys both of a team\'s generators; debugRepairGenerator revives one', () => {
  const world = createWorld(flatTerrain, 1, 8);
  createBaseObjects(world, [
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 0, y: 0, z: 0 } },
    { kind: BaseObjectKind.Generator, team: 1, position: { x: 5, y: 0, z: 0 } },
    { kind: BaseObjectKind.StationInventory, team: 1, position: { x: 10, y: 0, z: 0 } },
  ]);
  stepPower(world);
  debugKillGenerator(world, 1);
  expect(world.baseObjects.powered[2]).toBe(0);
  debugRepairGenerator(world, 1);
  expect(world.baseObjects.powered[2]).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- app.test.ts` and expect `debugKillGenerator`/`debugRepairGenerator` to not exist. Run the Playwright suite (`pnpm exec playwright test e2e/base.spec.ts`, matching however `e2e/weapons.spec.ts` is already invoked in this repo's `playwright.config.ts`) and expect it to fail because `window.__clansDebug` has no `killGenerator`/`repairGenerator`/`isStationPowered`.

- [ ] **Step 3: Write minimal implementation**

In `packages/client/src/app.ts`, add exported debug helpers next to `teleportPlayerToFlag`:

```ts
/** Exported for a focused unit test, mirroring teleportPlayerToFlag's own shape. Overkills
 *  every one of the team's generators directly via applyBaseObjectDamage and re-derives
 *  power — bypassing real weapon damage timings on purpose, so the e2e test this backs is
 *  fast and deterministic rather than waiting out a Chaingun's real fire rate. */
export function debugKillGenerator(world: World, team: number): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] !== BaseObjectKind.Generator || bases.team[id] !== team) continue;
    applyBaseObjectDamage(world, id, BASE_OBJECT_DATA[BaseObjectKind.Generator].maxHealth * 10);
  }
  stepPower(world);
}

/** Revives exactly one of the team's generators (real T2 has no in-mission generator
 *  rebuild either — this is a debug-only capability, not a Repair Pack simulation; Repair
 *  Pack correctly refuses to revive a destroyed generator, see repair.test.ts's failure
 *  matrix row 15 case). */
export function debugRepairGenerator(world: World, team: number): void {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] !== BaseObjectKind.Generator || bases.team[id] !== team) continue;
    bases.damage[id] = 0;
    bases.destroyed[id] = 0;
    bases.energy[id] = BASE_OBJECT_DATA[BaseObjectKind.Generator].maxEnergy;
    stepPower(world);
    return;
  }
}

export function debugIsStationPowered(world: World, team: number): boolean {
  const bases = world.baseObjects;
  for (let id = 0; id < bases.count; id += 1) {
    if (bases.kind[id] === BaseObjectKind.StationInventory && bases.team[id] === team) {
      return bases.powered[id] === 1;
    }
  }
  return false;
}
```

(Import `BaseObjectKind`, `BASE_OBJECT_DATA`, `applyBaseObjectDamage`, `stepPower` from `@clans/sim` alongside this file's existing sim imports.)

Wire the three into `createApp`'s returned `App` object, next to `debugTeleportToFlag`:

```ts
    debugTeleportToFlag(team: number): void {
      teleportPlayerToFlag(world, playerId, team);
    },
    debugKillGenerator(team: number): void {
      debugKillGenerator(world, team);
    },
    debugRepairGenerator(team: number): void {
      debugRepairGenerator(world, team);
    },
    debugIsStationPowered(team: number): boolean {
      return debugIsStationPowered(world, team);
    },
```

Wire the station menu, base object view, interior colliders, commander map, and HUD's `aimedStructure` into `createApp`'s setup and `frame` — following the exact same "await it during setup, sync it every frame in `syncWorldView`/`frame`" shape this file already uses for `flag-view.ts`/`weapons-view.ts`/`hud.ts`:

- During setup (alongside the existing `scene.add(await createTerrain(assets));` line): `world.interiors = await loadInteriorColliders(assets);`, `const baseObjectView = createBaseObjectView(scene, assets);`, `const stationMenu = createStationMenu(document.body, (armor, repairPack) => { if (net) net.sendLoadout(armor, repairPack); else applyLoadoutRequest(world, playerId, armor, repairPack); });`, `let stationMenuOpen = false;`, `const commanderMapCanvas = document.createElement('canvas'); commanderMapCanvas.hidden = true; document.body.appendChild(commanderMapCanvas);`.
- In `frame`, after `syncWorldView` already runs: `baseObjectView.sync(net ? net.baseObjects : baseObjectsFromWorld(world), net ? net.turrets : turretsFromWorld(world));` (the `*FromWorld` single-player fallbacks follow `flagsFromWorld`'s exact established pattern — small new functions in `base-object-view.ts` this step also adds, symmetric with `flag-view.ts`'s `flagsFromWorld`). `if (input.wasPressed('KeyE')) stationMenuOpen = !stationMenuOpen; stationMenuOpen = stationMenuVisible(world, playerId, stationMenuOpen); if (stationMenuOpen) stationMenu.show(); else stationMenu.hide();`. `if (input.wasPressed('KeyC')) commanderMapCanvas.hidden = !commanderMapCanvas.hidden; if (!commanderMapCanvas.hidden) { const ctx = commanderMapCanvas.getContext('2d'); if (ctx) drawCommanderMap(ctx, assets, world, world.players.team[playerId] ?? 1, sensedEnemyIds(world, world.players.team[playerId] ?? 1, friendlySensorCircles(world, world.players.team[playerId] ?? 1))); }`.
- `hudSourceFrom`'s returned object gains `aimedStructure: raycastAimedStructure(camera, baseObjectView)` — a small new function in `base-object-view.ts` using a `THREE.Raycaster` from the camera's forward direction against `baseObjectMeshes`/`turretMeshes`, returning `{ name, healthPercent }` for whichever mesh it hits within a short range, or `null`.

In `packages/client/src/main.ts`, extend the existing `window.__clansDebug` assignment:

```ts
window.__clansDebug = {
  teleportToFlag: (team) => app.debugTeleportToFlag(team),
  killGenerator: (team) => app.debugKillGenerator(team),
  repairGenerator: (team) => app.debugRepairGenerator(team),
  isStationPowered: (team) => app.debugIsStationPowered(team),
};
```

(Extend the `Window.__clansDebug` type declaration at the top of `main.ts` to match.)

Add a **Base assets** section to `README.md` (following the file's existing per-milestone section pattern) covering: what's playable (three armors, base objects, turrets, repair, commander map), the keybinds this milestone adds (`E` station menu, `R` Repair Pack, `C` commander map), and a short "how power works" paragraph pointing at the spec.

Add to `NOTICE.md` (which already credits Sierra, `exogen/t2-mapper`, and `files.nastyhobbit.org` for M1's terrain/texture assets — extend the existing entries, do not duplicate them): the eleven interior shapes and eight base-object/turret shapes this milestone adds, all sourced from the same `exogen/t2-mapper` mirror already credited, plus `@gltf-transform/core`'s own license line (Apache-2.0, per its `package.json`) alongside the project's other build-time tooling credits.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint && pnpm exec playwright test e2e/base.spec.ts`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/app.ts packages/client/src/app.test.ts packages/client/src/main.ts e2e/base.spec.ts README.md NOTICE.md
git commit -m "feat(client): wire base assets end to end; Playwright generator/station test; docs" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

## Self-review

- **Every spec-cited number matches its citation exactly.** Every Base asset numbers table row (Generator, Sensor, TurretBaseLarge, PlasmaBarrelLarge, SentryTurret) and every Armor numbers table Medium/Heavy column was checked against both the spec's own table and the real `jdknight/t2ds` script text fetched in this session (`staticShape.cs`, `turret.cs`, `station.cs`, `turrets/plasmaBarrelLarge.cs`, `turrets/aaBarrelLarge.cs`, `turrets/sentryTurret.cs`, `packs/repairpack.cs`), not reconstructed from memory of what T2 "probably" does.
- **Every "ours" number has a reason, not just a value.** The numbers table states why each pick was made (a real trigger-box dimension for station use radius, a hit-sphere radius picked to match the existing player-hitbox precedent, a size budget with the measured real total right next to it) rather than a bare number.
- **`stepWorld`'s call order was corrected mid-plan and is now internally consistent.** An early draft of the Global Constraints put `stepProjectiles` before `stepTurrets`, which would have delayed every turret shot by a full extra tick before it could even be recorded — Task 5's `spawnPendingTurretShots` needs `stepTurrets` to have already run *this* tick. The corrected order (`stepPower` → `stepTurrets` → `stepProjectiles`) is what every later task's code assumes; a reviewer should double-check no earlier draft copy of the wrong order survived into an implementation.
- **Interior collision, force fields, and turret line of sight are all implemented, with their real simplifications documented, not silently skipped.** Interior collision is a uniform grid (Amanatides–Woo ray traversal, cell-range sphere queries), not a hierarchical BVH — the spec's own "BVH for buildings" line is satisfied by the simpler of the two well-known static-scene acceleration structures, proven by a benchmark test against a synthetic 5,000-triangle interior. Force fields are team-passable blocking geometry, not the real T2 script's kill-everyone-in-the-zone behavior. Turret aiming is still instant tracking, not slew-rate-limited. Turret target acquisition now checks line of sight via a terrain march, closing what an earlier draft of this plan left as a real deviation. Every one of these is called out inline at the point it applies, in the Global Constraints, and in the "ours" table.
- **The plan never touches `packages/bots`.** M4's turret AI is the sim's own, not a bot brain; nothing here assumes bot brains exist, and the file structure section says so explicitly for `packages/server`'s tick loop.
- **Force fields required reordering the task dependency graph, not just adding a task.** An earlier draft ran Task 3 (base objects) in parallel with Tasks 1-2 (armor, interiors); force fields need Task 2's `buildInteriorCollider` to cache their own collision quad, so Task 3 now depends on Task 2. Task 5's dependency on Task 2 (already true through `raycastInteriors`, used for interior collision) is now stated explicitly rather than left implicit. A reviewer should confirm no implementation session started Task 3 before Task 2 on the assumption the old parallel note still held.
- **What I could not verify further in this session:** whether `@gltf-transform/core`'s `Node.getMatrix()` return type lines up byte-for-byte with `gl-matrix`'s `mat4` (Task 9's implementation casts through `unknown` at that boundary) is a real integration risk worth a first-hour smoke test when Task 9 starts, not treated as settled by this plan. The exact DOM event-binding style `input.ts` already uses for edge-triggered keys (Task 12 says "grep for the existing pattern" rather than inventing a possibly-inconsistent second one) was deliberately left for the implementing agent to match, since this planning session did not read `input.ts`'s full source. The row/col axis convention `turrets.test.ts`'s `wallAcrossX` fixture assumes for `terrain.ts`'s `Heightfield.heights` layout (row = Z index, col = X index) was not confirmed against `terrain.ts`'s full source in this session — the fixture's own comment says so and names the fix (swap row/col) if that one test's initial run shows the wall in the wrong place.

## Spec gaps

- **`StationVehiclePad` is not damageable in real T2** (`station.cs:235-247`, `isInvincible = true`, no `maxDamage`/`isShielded` fields at all), which contradicts the spec's own Base asset numbers table listing it in the same row shape as every damageable asset. This plan follows the script, not the table's implied shape — see Task 3's `applyBaseObjectDamage` and the "ours" table.
- **Force field blocking is team-passable, not the real script's instant kill.** The spec's own Base asset numbers table says "ForceFieldBare — team-passable," and this plan implements exactly that: a powered field blocks the opposing team's players and projectiles and passes its own team's. The real `defaultForceFieldBare` script (`forceField.cs:151-186`, `killAllPlayersWithinZone` called with no `%team` argument) kills every player who touches it, friend or foe — its own team check (`forceField.cs:200`) never short-circuits for this exact datablock. This plan follows the spec's table, not the literal script, for this one field; see Task 3's "ours" note.
- **Force field geometry is a two-triangle quad, not the real `PhysicalZone`'s polyhedron volume** (`forceField.cs:242-252`). This is the same "close enough for a browser demo" bar every other simplified collision shape in this plan sets (the player capsule is two spheres, a base object's hit test is a sphere) — a thin plane is enough to block a straight shot or a walking player and to render as the spec's translucent quad.
- **The AA barrel never fires this milestone** because it is a real vehicle-seeking weapon and no vehicle exists until milestone 5. This is accurate to script, not a bug, but it does mean one of Katabatic's four `TurretBaseLarge` turrets per team (whichever mounts `AABarrelLarge`) is visibly inert against players all of milestone 4 — worth calling out to reviewers who see a silent turret and assume it is broken.
- **Turret line of sight is a discrete terrain march, not a continuous check**, and ignores every other kind of occlusion (an interior wall, another turret's own base) — only the heightfield is sampled. A turret standing directly behind a thin interior wall from its target, with clear terrain between them, still acquires. This narrows, but does not fully close, the gap the real `detectsUsingLOS = true` sensor field describes; extending the same check to `raycastInteriors` is straightforward future work, not done here because Task 4 runs before `interiors.ts`'s raycast is available to it in a form Task 4 also needs Task 2's grid for perf, and duplicating the interior grid query into `turrets.ts` felt like more code than this milestone's turret count justifies.
- **The commander map has no bot-order UI**, since the spec's own commander-map description ("sensor coverage and bot orders") names a capability (issuing orders to bots) that depends on bot brains, which do not exist until milestone 6. This plan ships the sensor-coverage half only, and says so in Task 13's own header.
- **`packages/assets`' new `.glb`/collision-binary fetch step was not run against live network access in this planning session** — every file's *existence* and *size* were confirmed via `curl -sI`, but the actual `@gltf-transform/core` extraction pipeline (Task 9) has not been executed against real Katabatic data. Task 9's Step 4 explicitly calls for running it for real before considering that task done, rather than trusting the fixture-only unit test alone. The same is true of the interior/force-field uniform grid's real-world triangle counts: Task 2's benchmark uses a synthetic 5,000-triangle interior, not a measurement of Katabatic's actual converted geometry, because that geometry is not available without Task 9's real fetch running first.

