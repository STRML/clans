# Known issues and continuation notes

Updated September 9, 2026 (second pass: a parallel implementation wave landed on `main`;
see "Landed this pass" for the evidence and "Start here" for what is actually left). This
is the handoff for the next implementation agent, including DeepSeek. The original
milestone plans describe intended scope, not proof that the game faithfully reproduces
Tribes 2. Prefer current code, tests, source assets, and user observations over earlier
completion claims.

Priority: P1 affects ordinary gameplay; P2 is fidelity, robustness, or tooling.
“Historical report” means an existing GitHub report whose exact reproduction has not been
rerun in this audit. GitHub issue numbers below refer to
<https://github.com/STRML/clans/issues>.

## Start here

1. **#32 carrier survival.** Navigation is fixed (bots route around interiors on the real
   Katabatic graph, fight, and take the enemy flag), but carriers die on the ~1 km walk
   home, so a completed capture is still not demonstrated. This is combat attrition and
   multi-level interior exits, not pathing. Escort/defender behavior and carrier routing
   through the base are the next work.
2. **#52 projectile impact events.** Effects are still inferred from a projectile
   disappearing. Deliver impact position/weapon/reason/sequence exactly once and cover
   direct hit, bounce, timeout, and events entirely between snapshots.
3. **#53 remaining art.** The IFL playback driver and frame table are in, but only frame-0
   PNGs are committed, so real sequence playback needs the frame images copied from the
   cached `skins.vl2` archive (see the manifest keys). Blaster ball/trail and Chaingun
   crossed-ribbon tracers remain approximations, and per-side Shrike muzzle origins need a
   sim-side `VehicleFireEvent` change.
4. **#51 repair sound.** The beam, HUD feedback, and lifecycle are wired; no original
   repair-beam sample exists in the cached T2 audio, so the cue is silent until a source
   sample is sourced. Player-candidate repair also still ignores terrain occlusion in the
   sim (pre-existing; base objects and turrets check it).
5. **Net and presentation backlog:** #5 snapshot relevance filtering, #10 one-sided lag
   compensation, #7 debug time scaling in network play, then #55/#56 UI and audio
   fidelity, #3 movement solver fidelity, #2 terrain texture scale, #57 vehicle/bot scope.

## Landed this pass

All on `main`, no PRs. Each commit is atomic and the tree builds at every one.

| Commit | Work |
| --- | --- |
| `2af4dc5` | Occlusion (#21, #49) plus shields/target-kind/owner-sentinel/count-guard/hash fields (#14, #24, #15, #16, #25, #13) |
| `36c1eeb` | Bots route around interiors on the production Katabatic graph (#32) |
| `99cbf85` | Rebuild destroyed base assets, repair beam and feedback (#50, #51) |
| `45bfa96` | Vehicle slot reuse and interpolation across recycled IDs (#26, #27) |
| `52c9b60` | Drop the unrenderable STL fallback tier (#29) |
| `e145209` | Turret aim limits and presentation timing (#54) |
| `faa21fb` | IFL texture sequences, disc plate and muzzle art (#53) |
| `c9a7faf` | Terrain scale uncertainty documented, spawn walk test sped up (#2, #58) |
| `81476f1` | Turret presentation driven from simulated time (#54 follow-up) |

Verification for the wave: **958 tests pass across 72 files**; `pnpm typecheck` clean;
`pnpm lint` (eslint + prettier) clean; 13 targeted Playwright cases pass
(`base`, `bot-combat`, `movement`, `projectile-fidelity`, `turret-effects`, `weapons`)
with the client dev server running. Protocol is now **9**.

## Resolved this pass

### P1: bots stall against buildings — #32 (navigation fixed, capture still open)

- The deployed graph is now interior-validated: `packages/bots/src/waypoints.ts` rejects
  edges whose segment crosses interiors and adds 346 clearance-verified relay nodes
  (including deck and door aprons), taking the production graph from 34 to 380 nodes.
  `steering.ts` adds interior local avoidance with hysteresis, climb jets, crawl-to-hurdle
  jumps, under-floor waypoint skips with jet escape, and a perpendicular stuck-skip escape;
  `brain.ts` bounds heal chasing so carriers never detour to a station.
- Acceptance harness: `packages/server/src/bots.katabatic.test.ts` runs deterministic
  bot-only matches on the real Katabatic world with the production landmark set (every
  spawn, flag stand, and base object) over seeds 1–3 and asserts kills > 3 per seed,
  at least one enemy-flag touch across seeds, and wedged-stall windows under 20% of
  bot-time. Baseline before the change: 93 stall windows, zero kills, zero flag touches.
- **Still open:** no capture lands. Carriers grab the flag off the enemy deck and die on
  the return (turrets plus roaming enemies), and a carrier can end up in an under-deck
  pocket whose exit is not always reachable. Keep #32 open for carrier survival/escort
  work; do not re-file navigation as broken.

### P1: Laser Rifle ignores structure occlusion — #21, and turret acquisition sees through walls — #49

- New `packages/sim/src/occlusion.ts` exposes `segmentBlockedByInteriors`, built on the
  existing `raycastInteriors` machinery, plus the interior/force-field collider list.
- `resolveHitscan` and `hitTestHitscan` (both in `packages/sim/src/projectiles.ts`) now
  take the nearest structure hit (generator/station/turret/vehicle spheres) into the laser's
  visible span, so the closest valid obstruction wins in the live path and the lag-comp
  correction path; `beamEnd` stops at the nearest obstruction.
- Turrets use `turretCanSee` = terrain `hasLineOfSight` AND `!segmentBlockedByInteriors` in
  acquisition, retention, and the engagement check, without self-occluding on their own
  assembly.
- **Contract preserved:** the exported `hasLineOfSight(world, from, to)` keeps its
  terrain-only semantics; `packages/bots` perception/pathing and `packages/sim/src/repair.ts`
  depend on it.
- Fail-before was proven against a `git archive HEAD` snapshot in `/tmp`: the new blocking
  tests fail on the old sources. Suite: `pnpm exec vitest run packages/sim/src/projectiles.test.ts
  packages/sim/src/turrets.test.ts packages/sim/src/interiors.test.ts
  packages/sim/src/occlusion.test.ts packages/server/src/lagcomp.test.ts
  packages/server/src/net.test.ts` → 173/173.

### P2: structure shield state and feedback — #14

- `BaseObjectSnapshotData` and `TurretSnapshotData` carry `energy?: number`; the wire writes
  the f32 unconditionally (writers default 0) and both stores apply it when present
  (`applyBaseObjectSnapshot`, `applyTurretSnapshot`), skipping undefined so pre-9 snapshots
  and hand-built literals keep store defaults.
- `BASE_OBJECT_BYTES` 8 → 12, `TURRET_BYTES` 12 → 17, `PROTOCOL_VERSION` 8 → 9.
- Client feedback: the aimed-structure HUD callout gains `Shield N%` beside hull health, so
  a hit absorbed entirely by shields is visible even when hull damage does not change.

### P2: turret target type missing from snapshots — #24

- `TurretSnapshotData.targetKind?: number` (u8, 0 = player, 1 = vehicle) is appended to
  turret frames; `base-object-view.ts` prefers the wire discriminator over the AA-barrel
  inference and falls back to the old rule when the field is absent. Pairwise test proves a
  player and a vehicle sharing an id decode distinctly.

### P2: turret projectile owner sentinel corruption — #15

- Projectile `ownerId` is now written and read as signed i16 (`PROJECTILE_BYTES` unchanged),
  matching the flag `carrierId` `-1` convention. Turret shot `-1` and player shots round-trip
  distinctly.

### P2: snapshot count overflow — #16

- `writeExtras` rejects flag/base-object/turret counts at their `MAX_SNAPSHOT_*` ceilings
  (below the u8 wrap point, matching `readExtras` and the existing vehicles/bots/orders
  convention). Tests cover over-limit throws, exactly-at-limit round-trip, and a hostile
  255-count frame failing loudly instead of silently misaligning later arrays.

### P2: invalid decoded vehicle kind — #25

- `deserializeVehicle` rejects kinds absent from `VEHICLE_DATA` before slot activation or
  count growth, so one hostile byte no longer crashes prediction; valid Shrike/Wildcat
  frames still apply.

### P2: missing determinism hash fields — #13

- `mixProjectiles` covers team, `sourceTurretId`, and `sourceVehicleId`; `mixTurrets` covers
  the timer; base-object/turret energy and turret `targetKind` are hashed. Pairwise tests
  cover each field.

### P2: vehicle slot lifetime — #26, and interpolation across ID reuse — #27

- `flushPendingVehicleFreeIds` deactivates a slot exactly when the flush frees its id, so the
  destruction visibility window is byte-for-byte unchanged and a wreck can no longer persist
  after reuse.
- `VehicleBuffer.push` resets on kind change and on destroyed→alive, catching same-kind
  nearby respawns where distance heuristics structurally fail; a 15 m teleport backstop
  covers a respawn whose snapshots were all dropped. Mesh identity is tracked in
  `userData.vehicleKind` and a mismatch disposes and recreates the mesh.
- Known limit: same-kind nearby respawn with every snapshot in the retention window dropped
  and no destroyed sample is undetectable from samples alone; that needs a wire generation
  flag, the same WONTFIX `remote.ts` documents for players.

### P2: unsupported STL fallback — #29

- The STL tier is gone: `convertVehicleShape(glbUrl)` resolves GLB or falls through to the
  procedural placeholder, and `build.ts` no longer emits raw STL bytes under a `.glb` name.
  A forced GLB 404 test asserts only the GLB URL is fetched, no bytes are written, and the
  vehicle is honestly labeled procedural.

### P2: destroyed non-turret assets cannot be rebuilt — #50

- Base assets now rebuild at damage 0 (full rebuild; stock T2 static shapes have no turret
  `disabledLevel`, and a below-max threshold would one-tick-revive a capped wreck). Overkill
  is clamped at the first heal tick, so a generator takes ~455 ticks (~14.6 s) and a station
  ~303.
- Enemy rejection and line-of-sight are now enforced for base-object candidates the same way
  as turrets (previously enemy generators/stations were repairable and LOS was turret-only).
  Vehicle wreck repair stays excluded: the vehicle pad is the only re-entry path and keeps
  its spawn cost/cooldown.

### P2: repair presentation — #51 (beam and feedback landed, sound sample missing)

- New `packages/client/src/repair-beam.ts` renders the beam; the HUD shows
  `REPAIRING <label> <hp>% · <d> m · ENERGY <e>%`, with `ENERGY DEPLETED` and
  `NO TARGET · REPAIR RANGE 10 m` variants, hidden unless the trigger is held.
- Beam gates: pack equipped, alive, R held, no UI, no free cam, energy > 0, and a sim target
  found through the same `findRepairTarget` the healing uses, so preview and healing cannot
  drift. Stop covers release, occlusion, range, depletion, death, and menu opening.
- Audio: a dedicated per-player `repair-beam` loop slot starts and stops with the beam and
  never synthesizes. **No original repair-beam sample exists in the cached T2 audio**, so the
  loop is silent until a source sample is added to the manifest and the asset build.
- Known gap: player-candidate repair still ignores terrain occlusion in the sim; the beam
  preview matches what the sim heals, but both heal soldiers through hills.

### P2: remaining turret animation QA — #54

- `aimAt` clamps the target direction's own elevation to the source theta band before the
  joint delta, so near-overhead/underfoot targets pin at the limit instead of chasing it.
  Limits are derived per mount: pedestal → Large (turret.cs 15/140), none → Sentry
  (sentryTurret.cs 89/175).
- No-target syncs (idle or destroyed) relax toward the authored rest pose at the same 12/s
  smoothing, so a repaired mount restarts from a defined pose.
- Presentation time now advances in simulated seconds: `syncTurretPresentation` accepts
  `{ dt, timeScale }`, `base-object-view.ts` forwards it, and `app.ts` passes the same
  pause/gameOver-gated delta the weapon animation uses. Pause freezes the pose; time scaling
  is rate-correct. The e2e test was updated accordingly (it used to rely on the mount
  animating through a pause).
- Collision still uses a conservative elevated sphere, not exact barrel geometry. Check edge
  hits and splash/repair targeting consistency before treating it as physically exact.

### P2: projectile art and texture animation — #53 (partially resolved)

- IFL playback driver: authored 12-resource frame table from the upstream `.ifl` files
  (30 Hz ticks) injected into `withVisibility`, keyed to the GLB's `ifl_sequence`/
  `ifl_duration`/`ifl_cyclic`, with a shared frame cache and rebinding on clone. Only
  frame-0 PNGs are committed, so playback keeps the last available map until the frame
  images are copied under the manifest keys — the fallback stays honest.
- Flying disc plate now uses the source `disc.glb` proportions (r 0.408 / thickness 0.062)
  and spins from a per-frame delta; the previous code re-applied accumulated rotation and
  spun quadratically. Blue additive glow and velocity + projected-world-up orientation are
  unchanged.
- Shrike bolts alternate ±1.93/+0.044 muzzle origins per `vehicle_shrike.cs` PairImage
  offsets, client-side; true per-side origins need `VehicleFireEvent` in the sim.
- Still approximations: Blaster ball/trail and Chaingun crossed-ribbon tracers. Do not
  reapply world yaw to first-person models.

### P2: terrain texture repeat scale — #2 (documented, not verified)

- The source scale cannot be established from committed evidence: the terrain manifest has
  no scale field, the `.ter` v2 layout stores none, `docs/ui-audio-reference.md` has no
  terrain-tiling section, and no Torque renderer source is in the repo. `terrain.ts` keeps
  64 repeats over 2048 m and now documents the uncertainty plus a do-not-bump guide.

### P2: spawn-test timing sensitivity — #58

- Root cause was fixture cost, not spawning: the walk-out test called
  `loadKatabaticWorld()` per sample (64 full loads, ~2,100 file reads, ~1,856 interior
  collider builds). It now loads the committed assets once and rebuilds a pristine world per
  sample with the same create calls; the tests phase dropped from ~1.6 s to ~0.2 s and the
  test is stable across repeat runs. No timeout was raised.

## Still open

### P1: bots take the flag but never capture — #32 (carrier survival)

See "Resolved this pass" for the navigation fix. Remaining work: carrier routing through
the base interior, escort behavior, and defender pressure. Acceptance still needs a real
capture over deterministic seeds on the production graph.

### P2: authoritative projectile impact effects — #52

- Files: `packages/client/src/weapons-view.ts`, app/network event handling.
  Effects rely on the last observed projectile disappearing rather than an authoritative
  impact record. Shots born and destroyed between snapshots can miss effects; position can
  be stale and lifetime removal can look like an impact.
- Repro/QA: fire at a nearby wall and compare solo/network at latency and low snapshot rate;
  also let a shot expire without striking anything.
- Acceptance: impact position, weapon, reason and sequence delivered exactly once; cover
  direct hit, bounce, timeout and events entirely between snapshots.

### P2: snapshot relevance filtering absent — #5

- File: `packages/server/src/net.ts`. The spec promises full updates inside 400 m, slower
  distant updates, and filtering hidden distant interior items. All extras currently go to
  every client every snapshot.
- Acceptance: tests at 500 m and real 32-player bandwidth measurements; ensure distant
  entities persist between updates instead of being interpreted as removed.

### P2: one-sided lag compensation — #10

- File: `packages/server/src/net.ts`, lag-comp hit application. The design accepts live hits
  and only rewinds misses to grant extra hits, so a target entering the ray after the
  shooter's viewed time can be hit unfairly.
- Acceptance: side-effect-free hit testing against the shooter's view before committing
  damage. Do not rewind/re-step the whole world: earlier attempts corrupted unrelated
  movement, energy and fall damage.

### P2: network debug time scaling — #7

- Client debug/app stepping can advance local prediction faster than the server. Repro: F1,
  time scale above 1 in a network session; watch corrections/drift. Either disable the
  control in network play or make time scaling server-authoritative; do not mistake it for a
  normal movement regression.

### P2: team cap not enforced for humans — #31

- Server join and `packages/server/src/bots.ts` rebalance only remove bots to make space.
  With no bot left, humans can exceed 16 on a team.
- Acceptance: explicit team-full/alternate-team handling, client-visible response, tests
  with bots disabled and a full human team.

### P2: movement solver fidelity — #3

- Files: `packages/sim/src/movement.ts`, `armor.ts`. Script constants do not prove
  Torque-equivalent integration: resistance interpretation, ground friction and ground snap
  include demo choices. User approved the recent ski/jet feel.
- Research starting point supplied by user: <https://github.com/amterp/tribes-movement>.
  Compare engine integration as well as data values; record citations and trace
  velocity/energy across ground, jump, ski, jet and slope transitions.
- Acceptance: distinguish vanilla values from deliberate tuning. Do not silently remove the
  stronger sideways jet control or reintroduce jump momentum loss.

### P2: UI, inventory and loadout fidelity — #55

- Original HUD bitmaps, weapon icons, reticles, compass and vehicle instruments are present,
  but layout is adapted. Inventory/preferences menus are simplified; station selection
  covers armor and Repair Pack, not the full T2 loadout system. Energy Packs are absent.
  Quick chat is nine Bot1 lines, not the full voice tree.
- Files: `stationMenu.ts`, `hud.ts`, `voicebinds.ts`, related client menus and sim loadout
  handling. Reference evidence: `docs/ui-audio-reference.md`.
- Acceptance: compare on-foot, zoom, vehicle, station and commander screens at matching
  aspect ratios; reproduce source functionality and selected loadouts. Preserve contact
  activation, number-key vehicle selection and released cursor.

### P2: remaining sound fidelity — #56

- Original recordings replaced synthetic hum/fire sounds. The mix still lacks full
  directional panning/occlusion, surface/armor footstep variants, explosion variants, and
  continuous weapon spin/fire/stop loop timing. See `audio.ts` and the audio source manifest;
  do not restore invented oscillator modulation.
- Flag pickup/drop/return/capture cues use original samples and team-relative events; QA two
  clients on opposite teams, manual drops, carrier death, timed returns and capture/reset
  boundaries. Audio decoding alone is not perceptual QA.
- Acceptance: source recording comparisons and lifecycle tests so loops stop on destruction,
  death, disconnect, range/power loss and menu/input transitions.

### P2: vehicle and bot feature scope — #57

- Only Shrike and Wildcat are implemented. Other T2 vehicles, passengers and their weapons
  are feature gaps, not regressions.
- The M5 deferred-work list also records missing vehicle-versus-player collision, AA seeker
  behavior, and vehicle-kill scoring. Reconfirm these against the current sim before
  implementing; acceptance needs collision/attribution tests and an actual AA-versus-Shrike
  flight scenario, not just a projectile spawn assertion.
- Bots now navigate, fight, and take flags on the production graph, but carrier survival and
  escort behavior are unfinished (see #32), and complete vehicle piloting, strategic
  loadouts, and a full match with captures are unproven. Treat those as QA/feature work.
- Acceptance: end-to-end play evidence for each claimed behavior; preserve the user's
  approved movement feel and avoid declaring bots finished from unit tests.

## Resolved earlier (regression watch list)

- Interior ray/AABB boundary failure (#17): `rayAabbInterval` handles infinite inverse
  directions before multiplication; a parallel-boundary regression exists in
  `interiors.test.ts`. Distinct from the previously fixed player ceiling-clipping report.
- Vehicle disappearance without explosion (#22): destruction now produces an expanding
  visual and sound. Exact T2 explosion art remains fidelity work.
- Old oscillator loop-freeze report (#36): implementation replaced by original samples; ski
  is a source-correct onset one-shot.
- Earlier reports addressed: spawn inside base geometry, jumping through ceilings, missing
  terrain/material textures, floating turret assemblies, white weapon materials, absent
  first-person models/animations, pointer-locked popup menus, vehicle-pad E prompt,
  backwards Shrike cockpit, passive falling, trivial crash disappearance, steering reversal
  at yaw wrap, friendly turret wreck repair, elevated Shrike/turret hits, animated turret
  aiming/fire, flag cues, original blue disc explosions, blue flying disc glow, and
  pitched-disc orientation across four cardinal headings.
- Accepted low-priority: `packages/server/src/session.ts` u32 input/snapshot counter
  exhaustion after years of uninterrupted operation; reconnect is the accepted recovery.

## Development handoff

- Work directly on `main`; the user authorized commits/pushes and requested no PRs and no CI
  waiting. Keep private `.claude/` files out of commits.
- Use Node 24+ and repository-pinned **pnpm 11.0.3**; a system pnpm 7 previously damaged the
  workspace install/lockfile.
- `pnpm dev` starts client 5173 and server 7777. Use
  `http://127.0.0.1:5173/?server=ws://127.0.0.1:7777` for network testing; the bare URL
  follows the solo path. Restart both after protocol/server changes.
- Current protocol is **9** (shield energy, turret target kind, signed projectile owner).
  Converted assets are committed; ordinary startup needs no fetch/build. Asset additions
  need manifest, builder and generated output changes together.
- Gates: `pnpm test` (958 tests, 72 files), `pnpm typecheck`, `pnpm lint`. Browser tests:
  `node_modules/.bin/playwright test <spec>` with the dev server running; the environment
  sets `CI=true`, so unset it (`env -u CI`) to reuse an already-running dev server. Do not
  edit while browser tests run: HMR causes false failures.
- Deliberate weapon tuning: Blaster 0.3 s cycle; Chaingun 0.1 s held fire versus source
  0.15 s, with 0.5 s spin-up; Shrike 0.2 s versus source 0.125 s. The user requested faster
  infantry guns and slower Shrike fire. Do not silently revert.
- Source references and original UI screenshots live in `docs/ui-audio-reference.md`;
  README has in-game screenshots. Add necessary new evidence under `docs/`.
