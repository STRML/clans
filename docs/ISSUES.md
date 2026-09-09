# Known issues and continuation notes

Updated September 9, 2026. This is the handoff for the next implementation agent,
including DeepSeek. The original milestone plans describe intended scope, not proof
that the game faithfully reproduces Tribes 2. Prefer current code, tests, source
assets, and user observations over earlier completion claims.

Priority: P1 affects ordinary gameplay; P2 is fidelity, robustness, or tooling.
“Historical report” means an existing GitHub report whose exact reproduction has
not been rerun in this audit. “QA” means a risk to verify, not a confirmed defect.
GitHub issue numbers below refer to <https://github.com/STRML/clans/issues>.

## Start here

1. Fix production-map bot navigation (#32), then demonstrate a real bot-only match
   with sustained combat and captures. Small fixes landed, but navigation is not solved.
2. Fix turret target acquisition through interior walls and Laser Rifle structure
   occlusion (#21). Add shield feedback (#14) so hits visibly register.
3. Finish repair presentation and rebuilding destroyed base assets.
4. Validate the latest disc and turret visuals in ordinary play, then finish
   projectile impact events and original animated textures.
5. Work through the protocol and rendering backlog below.

## Existing GitHub issues

### P1: bots stall against buildings — #32, still open

- Files: `packages/bots/src/waypoints.ts`, `steering.ts`, `brain.ts`, and server
  landmark creation. Edges and the final leg to a goal are not validated against
  interiors; straight-line fallback can still point through the same wall.
- Historical repro: a 20,000-tick match with the production landmark set produced
  zero kills/captures. Spawn-only graph tests do not prove the deployed graph works.
- Current changes preserve repeated-stall counters across ordinary ticks; they do
  not make paths collision-aware. Moving-goal repathing (#33) was already fixed.
- Acceptance: use the actual Katabatic interiors and production landmarks; record
  progress/stalls, kills and captures over multiple deterministic seeds. Cover
  indoor flag routes, final goal legs, recovery, and doorways.

### P1: Laser Rifle ignores structure occlusion — #21

- Files: `packages/sim/src/projectiles.ts`, live `resolveHitscan` and lag-comp
  `hitTestHitscan` paths. Historical report: terrain/interiors/fields block shots,
  but generator/station/turret volumes do not block a player hit behind them.
- Repro: put a player directly behind an intact structure and fire through it,
  then repeat with latency. Acceptance: the closest valid obstruction wins in
  both paths, with tests for structures and exposed targets.

### Resolved: interior ray/AABB boundary failure — #17

- File: `packages/sim/src/interiors.ts`. Historical report: zero direction gives
  an infinite inverse; an origin exactly on the corresponding box face yields
  `0 * Infinity = NaN` and can miss contact. Current `rayAabbInterval` explicitly
  handles infinite inverse directions before multiplication; a parallel-boundary
  regression exists in `interiors.test.ts`. The stale report is now closed.
- Repro/test: rays parallel to every face, starting on, inside, and outside the
  slab, including negative directions, if extending coverage.
- This is distinct from the previously fixed player ceiling-clipping report.

### P2: missing structure shield state and feedback — #14

- Files: `packages/protocol/src/snapshot.ts`, sim snapshot/apply paths,
  `packages/client/src/base-object-view.ts`, HUD. Base-object/turret snapshots omit
  dynamic energy. Damage first drains shields, so unchanged health can look like
  a missed shot even after the elevated turret hitbox fix.
- Repro: repeatedly shoot a powered large turret with a Shrike. Verify server
  shield depletion and client feedback independently of hull damage.
- Acceptance: round-trip energy, display shield hits/depletion, preserve health
  semantics, and update protocol version/byte counts/tests together.

### P2: turret target type missing from snapshots — #24

- `TurretSnapshotData` sends `targetId` but not player-versus-vehicle `targetKind`.
  Player and vehicle IDs overlap. Current rendering infers vehicle targeting from
  AA barrel type; that works for today's fixed barrel rules, not a general codec.
- Acceptance: round-trip the discriminator in `packages/protocol/src/snapshot.ts`
  and sim serialization/application; test a player and vehicle sharing an ID.

### P2: turret projectile owner sentinel corruption — #15

- `packages/protocol/src/snapshot.ts` writes and reads owner as unsigned u16;
  turret owner `-1` returns as `65535`. Confirmed in current codec.
- Acceptance: reserve/decode a sentinel consistently or use a signed field;
  round-trip turret and player shots and verify attribution/self-exclusion.

### P2: snapshot count overflow — #16

- `writeExtras` still writes unchecked u8 counts for flags, base objects and
  turrets. At 256 entries the count wraps and misaligns subsequent decoding.
  Vehicles already have a count guard.
- Acceptance: reject oversized arrays or expand fields; cover 255/256 and ensure
  malformed frames cannot silently corrupt later arrays.

### P2: invalid decoded vehicle kind — #25

- Files: protocol `readVehicle`, sim `deserializeVehicle`, `VEHICLE_DATA` lookup.
  Historical report: kind 255 is accepted and later crashes prediction. Spawn
  request validation on the server does not validate incoming snapshots.
- Acceptance: reject invalid enum values before activating a slot; test malformed
  frames and valid Shrike/Wildcat snapshots.

### P2: vehicle slot lifetime — #26

- File: `packages/sim/src/vehicles.ts`, `flushPendingVehicleFreeIds`. Historical
  report: retained destroyed IDs become reusable without clearing `active`, so
  wreck records remain in snapshots indefinitely.
- Acceptance: preserve the destruction visibility window, then deactivate before
  reuse; verify serialization, allocation, and client removal together.

### P2: vehicle interpolation across ID reuse — #27

- File: `packages/client/src/vehicle-view.ts`, `VehicleBuffer` and mesh lookup.
  Historical report: recycled IDs retain old interpolation history; changing
  Shrike to Wildcat may retain the wrong mesh.
- Acceptance: test destroy/respawn with the same ID, both same and different kind,
  nearby and distant spawn positions. Prefer lifecycle/generation identity over
  only a distance heuristic. Audit current mitigations before rewriting them.

### P2: unsupported STL fallback — #29

- `packages/assets/src/vehicleShapes.ts` returns raw STL bytes and `build.ts`
  writes them to a `.glb` path. GLTFLoader cannot parse them; procedural fallback
  remains. Actual Katabatic vehicles currently resolve real GLBs.
- Acceptance: convert STL to valid renderable geometry, or explicitly skip this
  tier rather than emit a mislabeled file. Test forced GLB failure.

### P2: missing determinism hash fields — #13

- File: `packages/sim/src/hash.ts`. Historical report: projectile team and
  sourceTurretId, and turret timer, do not affect the hash.
- Acceptance: pairwise worlds differing in each simulation-relevant field must
  hash differently. Audit the hash policy against new protocol/sim fields too.

### P2: one-sided lag compensation — #10

- File: `packages/server/src/net.ts`, lag-comp hit application. Historical design
  accepts live hits and only rewinds misses to grant extra hits. A target entering
  the ray after the shooter's viewed time can therefore be hit unfairly.
- Acceptance: side-effect-free hit testing against the shooter's view before
  committing damage. Do not rewind/re-step the whole world: earlier attempts
  corrupted unrelated movement, energy and fall damage.

### P2: team cap not enforced for humans — #31

- Server join and `packages/server/src/bots.ts` rebalance only remove bots to make
  space. Historical report: with no bot left, humans can exceed 16 on a team.
- Acceptance: explicit team-full/alternate-team handling, client-visible response,
  tests with bots disabled and a full human team.

### P2: snapshot relevance filtering absent — #5

- File: `packages/server/src/net.ts`. The spec promises full updates inside 400 m,
  slower distant updates, and filtering hidden distant interior items. Historical
  report: all extras go to every client every snapshot.
- Acceptance: tests at 500 m and real 32-player bandwidth measurements; ensure
  distant entities persist between updates instead of being interpreted as removed.

### P2: network debug time scaling — #7

- Client debug/app stepping can advance local prediction faster than the server.
  Repro: F1, time scale above 1 in a network session; watch corrections/drift.
- Previously accepted as a debug limitation. Either disable this control in
  network play or make time scaling server-authoritative; do not mistake it for a
  normal movement regression.

### P2: movement solver fidelity — #3

- Files: `packages/sim/src/movement.ts`, `armor.ts`. Script constants do not prove
  Torque-equivalent integration: resistance interpretation, ground friction and
  ground snap include demo choices. User approved the recent ski/jet feel.
- Research starting point supplied by user: <https://github.com/amterp/tribes-movement>.
  Compare engine integration as well as data values; record citations and trace
  velocity/energy across ground, jump, ski, jet and slope transitions.
- Acceptance: distinguish vanilla values from deliberate tuning. Do not silently
  remove the stronger sideways jet control or reintroduce jump momentum loss.

### P2: terrain texture repeat scale — #2

- File: `packages/client/src/terrain.ts`. Historical report: 64 repeats over
  2048 m (32 m per repeat) was an artistic guess, not original material scaling.
- Acceptance: verify source terrain renderer/material scale, then compare matching
  Katabatic viewpoints. Terrain now has textures; this concerns their scale.

## Additional open work from current playtesting and code audit

Filed individually in GitHub:

| Issue | Work |
| --- | --- |
| [#49](https://github.com/STRML/clans/issues/49) | Turret interior occlusion |
| [#50](https://github.com/STRML/clans/issues/50) | Rebuild destroyed base assets |
| [#51](https://github.com/STRML/clans/issues/51) | Repair presentation |
| [#52](https://github.com/STRML/clans/issues/52) | Authoritative projectile impact effects |
| [#53](https://github.com/STRML/clans/issues/53) | Projectile art and animated textures |
| [#54](https://github.com/STRML/clans/issues/54) | Turret animation QA |
| [#55](https://github.com/STRML/clans/issues/55) | UI and loadouts |
| [#56](https://github.com/STRML/clans/issues/56) | Remaining audio fidelity |
| [#57](https://github.com/STRML/clans/issues/57) | Vehicle and bot feature scope |
| [#58](https://github.com/STRML/clans/issues/58) | Spawn-test timing sensitivity |

### P1: turret acquisition sees through interior walls

- Confirmed: `hasLineOfSight` in `packages/sim/src/turrets.ts` samples terrain
  only. Acquisition and target retention call it; it never checks interiors.
  Projectiles can hit walls even while a turret continues tracking/firing at the
  hidden target. The old README claimed stronger behavior than the code provides.
- Repro: enemy within turret range behind a base wall, with no hill between them.
- Acceptance: interior/force-field-aware acquisition and retention for both
  players and vehicles, without self-occluding on the turret's own assembly.

### P1: destroyed non-turret assets cannot be rebuilt

- Confirmed: `packages/sim/src/repair.ts` now revives friendly turret wrecks but
  still excludes destroyed generators, stations and vehicles. Destroying both
  generators can leave a team permanently without power during the match.
- Repro: destroy both generators and try the Repair Pack. Debug repair is not
  an in-game recovery mechanism.
- Acceptance: decide source-correct rebuild thresholds for base assets, restore
  power/visibility on repair, test enemy rejection and obstructed beams. Vehicle
  wreck repair should be a separate source-fidelity decision, not assumed equal.

### P2: repair lacks visible weapon/beam/audio feedback

- Current client has Repair Pack input/menu state and simulation healing but no
  repair-beam rendering path or dedicated repair sound in `audio.ts`.
- Repro: equip Repair Pack at a powered inventory station, aim within 10 m of a
  damaged friendly turret, hold R. Healing works but is hard to perceive.
- Acceptance: source repair weapon/beam and sound, target/range/energy feedback,
  and correct start/stop on release, occlusion, depletion, death and menu opening.

### P2: projectile impacts inferred from disappearance

- Files: `packages/client/src/weapons-view.ts`, app/network event handling.
  Effects rely on the last observed projectile disappearing, rather than a full
  authoritative impact record. Shots born and destroyed between snapshots can
  miss effects; position can be stale and lifetime removal can look like impact.
- Repro/QA: fire at a nearby wall and compare solo/network at latency and low
  snapshot rate; also let a shot expire without striking anything.
- Acceptance: impact position, weapon, reason and sequence delivered exactly once;
  cover direct hit, bounce, timeout and events entirely between snapshots.

### P2: projectile art and texture animation remain approximate

- Flying disc is now blue/additive with a glow, and its orientation uses velocity
  plus projected world-up to remove cardinal-direction-dependent roll. Its plate
  is still procedural geometry; glow is a textured plane.
- Blaster ball/trail and Chaingun crossed-ribbon tracers are approximations.
  Shrike bolts are blue, but the shot origin does not reproduce alternating twin
  muzzle emission. Inspect `weapons-view.ts` and sim `projectiles.ts`.
- `disc-explosion.ts` now plays the original animated `disc_explosion` shape,
  camera-facing and additive. Texture lists (IFL) still use only their first frame,
  including weapon indicators and effect textures. A loading fallback remains.
- Acceptance: source-frame comparisons for all five weapons and Shrike at several
  distances/headings, original texture sequence playback, and separate geometry
  animation versus texture-animation tests. Do not reapply world yaw to FP models.

### P2: remaining turret animation QA

- `turret-mount.ts` now uses authored mount/muzzle nodes, world-axis-correct joint
  rotations, smoothing and source Fire/Fire1/Fire2 clips. A real loaded Plasma
  turret muzzle-direction browser test passes.
- QA still needed: AA tracking actual vehicles, Sentry elevation, angle extremes,
  near targets, destroyed-to-repaired transitions and original rotation limits.
  Presentation timing uses wall-clock delta; verify pause/time-scale behavior.
- Collision uses a conservative elevated sphere, not exact barrel geometry.
  Check edge hits and splash/repair targeting consistency before treating it as
  physically exact. The old Shrike-above-pedestal miss now has a regression test.

### P2: UI, inventory and loadout fidelity incomplete

- Original HUD bitmaps, weapon icons, reticles, compass and vehicle instruments
  are present, but layout is adapted. Inventory/preferences menus are simplified;
  station selection covers armor and Repair Pack, not the full T2 loadout system.
  Energy Packs are absent. Quick chat is nine Bot1 lines, not the full voice tree.
- Files: `stationMenu.ts`, `hud.ts`, `voicebinds.ts`, related client menus and sim
  loadout handling. Reference evidence: `docs/ui-audio-reference.md`.
- Acceptance: compare on-foot, zoom, vehicle, station and commander screens at
  matching aspect ratios; reproduce source functionality and selected loadouts.
  Preserve contact activation, number-key vehicle selection and released cursor.

### P2: remaining sound fidelity

- Original recordings replaced synthetic hum/fire sounds. Current mix still lacks
  full directional panning/occlusion, surface/armor footstep variants, explosion
  variants, and continuous weapon spin/fire/stop loop timing. See `audio.ts` and
  the audio source manifest; do not restore invented oscillator modulation.
- Flag pickup/drop/return/capture cues now use original samples and team-relative
  events. QA two clients on opposite teams, manual drops, carrier death, timed
  returns and capture/reset boundaries; audio decoding alone is not perceptual QA.
- Acceptance: source recording comparisons and lifecycle tests so loops stop on
  destruction, death, disconnect, range/power loss and menu/input transitions.

### P2: vehicle and bot feature scope

- Only Shrike and Wildcat are implemented. Other T2 vehicles, passengers and their
  weapons are feature gaps, not regressions in existing implementations.
- The M5 deferred-work list also records missing vehicle-versus-player collision,
  AA seeker behavior, and vehicle-kill scoring. Reconfirm these against the current
  sim before implementing; acceptance needs collision/attribution tests and an
  actual AA-versus-Shrike flight scenario, not just a projectile spawn assertion.
- Shrike hover, neutral upward jet, cockpit eye, wing deployment, fabrication,
  auto-boarding, collision damage and heading wrap were fixed in earlier work.
  The flight solver remains a demo adaptation, not Torque rigid-body simulation.
- Bots have coarse attacker/defender and commander-order behavior. This pass fixed
  Chaingun spin-up weapon thrashing, repeated-stall accounting, and enemy repair
  orders equipping packs. It did not validate complete vehicle piloting, strategic
  loadouts, or a full match on the production graph. Treat those as QA/feature work.
- Acceptance: end-to-end play evidence for each claimed behavior; preserve the
  user's approved movement feel and avoid declaring bots finished from unit tests.

### P2: spawn-test timing sensitivity

- `packages/server/src/world.test.ts`, “every real spawn lets a player walk forward
  out of the starting area” timed out at 5 s in a loaded full-suite run (872 other
  tests passed). Its isolated rerun passed all 12 tests in 1.27 s total.
- This is observed test instability, not evidence that spawning is currently
  broken. Investigate fixture cost/concurrency if it recurs; do not delete the
  production-spawn coverage or blanket-increase every test timeout.
- A subsequent full run passed **873/873 tests across 69 files**. A separate
  sandboxed attempt failed socket tests with `listen EPERM`; rerunning with local
  listener permission resolved those environment failures.

### Accepted low-priority sequence lifetime limitation

- `packages/server/src/session.ts` and its tests document u32 input/snapshot
  counter exhaustion after years of uninterrupted operation (roughly 4.36/8.7
  years). Reconnect is the accepted recovery. This is not an observed ordinary
  match bug; no urgent implementation is requested.

## Resolved reports and regression watch list

- Vehicle disappearance without explosion (#22): destruction now produces an
  expanding visual and sound. Exact T2 explosion art remains part of fidelity work.
- Old oscillator loop-freeze report (#36): implementation replaced by original
  samples; ski is a source-correct onset one-shot, not a continuously modulated
  oscillator. Its suggested pitch/filter fix no longer applies.
- Earlier reports addressed: spawn inside base geometry, jumping through ceilings,
  missing terrain/material textures, floating turret assemblies, white weapon
  materials, absent first-person models/animations, pointer-locked popup menus,
  vehicle-pad E prompt, backwards Shrike cockpit, passive falling, trivial crash
  disappearance, and steering reversal at yaw wrap. Retest if reported again;
  do not reopen these solely because an old handoff describes them.
- Latest fixes include friendly turret wreck repair, elevated Shrike/turret hits,
  animated turret aiming/fire, flag cues, original blue disc explosions, blue flying
  disc glow, and pitched-disc orientation across four cardinal headings.
- User has not yet confirmed the very latest disc/turret presentation in play.

## Development handoff

- Work directly on `main`; user explicitly authorized commits/pushes and requested
  no PRs and no CI waiting. Luna/Terra implementation agents are welcome; minimize
  token use. Keep private `.claude/` files out of commits.
- Use Node 24+ and repository-pinned **pnpm 11.0.3**. A system pnpm 7 previously
  damaged the workspace install/lockfile; check versions before installing.
- `pnpm dev` starts client port 5173 and server port 7777. Use
  `http://127.0.0.1:5173/?server=ws://127.0.0.1:7777` for network testing; the bare
  URL follows the solo path. Restart both after protocol/server changes.
- Current protocol is **8** (new flag drop/return events). Converted assets are
  committed; ordinary startup needs no fetch/build. Asset additions need manifest,
  builder and generated output changes together.
- Run `pnpm test`, `pnpm lint`, `pnpm build`; use targeted Playwright tests with the
  dev server running. Do not edit while browser tests run: HMR causes false failures.
- Latest validation before documentation: lint/build pass; six focused browser
  cases pass (network bots, turret wreck, original explosion, audio decode, weapon
  effect cleanup, flag capture), plus loaded turret aiming and projectile glow
  cases pass. Final full-suite rerun: **873 tests pass across 69 files**; the earlier
  timeout and sandbox socket failures are described above.
- Deliberate weapon tuning: Blaster 0.3 s cycle; Chaingun 0.1 s held fire versus
  source 0.15 s, with 0.5 s spin-up; Shrike 0.2 s versus source 0.125 s. The user
  requested faster infantry guns and slower Shrike fire. Do not silently revert.
- Source references and original UI screenshots live in `docs/ui-audio-reference.md`;
  README has in-game screenshots. Temporary files and conversation screenshots are
  not durable dependencies. Add any necessary new evidence under `docs/`.
