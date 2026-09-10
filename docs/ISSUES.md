# Known issues and continuation notes

Updated September 9, 2026 (third pass: two more parallel implementation waves landed on
`main`, taking the tree from protocol 9 to **protocol 11**, 958 to **1092 unit tests**, and a
green 37-case browser suite). This is the handoff for the next implementation agent,
including DeepSeek. The original milestone plans describe intended scope, not proof that the
game faithfully reproduces Tribes 2. Prefer current code, tests, source assets, and user
observations over earlier completion claims.

Priority: P1 affects ordinary gameplay; P2 is fidelity, robustness, or tooling.
“Historical report” means an existing GitHub report whose exact reproduction has not been
rerun in this audit. GitHub issue numbers below refer to
<https://github.com/STRML/clans/issues>.

## Start here

1. **#32 captures.** Navigation, fall arrest, pocket escape, escort formations, turret
   suppression and energy economy are all in, and carriers now cross the map with energy
   instead of dying in the enemy base. Still **zero completed captures**: the residual
   blocker is mid-route duel attrition (chains of pursuers 400–900 m from home). Next
   levers, in order: escort climb/regroup cohesion across the ridge, a carrier
   hold-fire-to-sprint trade study, and a dynamic post-sally to cover the last 400 m.
   Evidence caveat: the harness result is byte-identical across world seeds because the
   world seed does not reach bot RNG (`manager.nextSeed` does), so cross-seed variance is
   inherently low — do not read three identical seeds as three independent samples.
2. **Wildcat bugs (user report, 2026-09-10).** Spawns below its own pad, handles awkwardly,
   and drives in a third-person chase camera. Filed with evidence and a reproduce-first
   instruction in the P1 entry under Still open.
3. **#53 remaining art.** The IFL playback driver and frame table are in and tested, but
   only frame-0 PNGs are committed, so real sequence playback needs the frame images copied
   from the cached `skins.vl2` archive under the manifest keys. Blaster ball/trail and
   Chaingun crossed-ribbon tracers remain approximations. Per-side Shrike muzzle origins
   need `VehicleFireEvent` side data in the sim (the client already alternates visually).
4. **#51 remaining.** The repair beam, HUD feedback and lifecycle are wired, but no
   original repair-beam sample exists in the cached T2 audio, so the loop is silent until a
   source sample is added to the manifest and the asset build. Player-candidate repair also
   still ignores terrain occlusion in the sim (base objects and turrets check it).
5. **#2 terrain texture scale.** Cannot be established from committed evidence; `terrain.ts`
   keeps 64 repeats over 2048 m with the uncertainty documented. Closing it needs the
   original renderer/material data, not another guess.
6. **Fidelity backlog:** #54's conservative turret collision sphere, the #5/#10 residuals
   below, #56's missing recordings, #55's unconsumed `maxWeapons` and absent Repair Pack
   icon, then #57's remaining vehicle scope.

## Landed this pass

| Commit | Work |
| --- | --- |
| `0c63aee` | Authoritative projectile impacts, protocol 10 (#52) |
| `14f1e3b` | Movement and armor constants anchored to the leaked T2 engine source (#3) |
| `814f27b` | Carriers survive the trip home: fall arrest, pocket escape, escort, heal detour (#32) |
| `1e31581` | Snapshot relevance filtering and two-sided lag compensation (#5, #10) |
| `4cc8ebc` | Full station loadout system with Energy Pack and networked HUD, protocol 11 (#55) |
| `4d662ec` | Vehicle-player collision, AA seekers, vehicle kill scoring (#57) |
| `ce0f9d2` | Network time scaling refused, team-full joins refused (#7, #31) |
| `893afc2` | Spatial audio, impact cues, loop lifecycle (#56, plus #52's missing audio) |
| `a83edfc` | Carrier escort, turret suppression, energy reserve (#32) |
| `2befc3d` | Last loadout callers cut over to the #55 selection API |
| `4e59d58` | Open station menu no longer re-prefills under the player's click (#55) |
| `b7ce7b5` | Parked vehicle no longer shoves a player standing at its center (#57) |

Verification for the wave: **1092 unit tests pass across 72 files**; `pnpm typecheck` clean;
`pnpm lint` clean; **37/37 Playwright cases pass** (`env -u CI node_modules/.bin/playwright
test` with the dev server running). Protocol is now **11**.

Three browser regressions were caught by that gate and fixed before push: the station menu
re-prefilled every frame so a click could not stick, the HUD weapon rack assertion still
expected five icons after the rack started hiding uncarried weapons, and the new
vehicle-player contact rule read a dismounted player's fall back into the parked vehicle's
own sphere as a fresh collision, producing a perpetual micro-bounce.

## Resolved this pass

### P2: authoritative projectile impacts — #52

- `ProjectileImpact { x, y, z, weaponId, type, reason, seq }` plus
  `ProjectileImpactReason` (Direct/Bounce/Timeout/World) live in the sim; the store carries
  a monotonic sequence and a per-tick `lastImpacts` list, reset at the top of
  `stepProjectiles` and emitted from every resolution path (`resolveImpact`, both bounce
  branches, all expiry branches, and `deactivateProjectile` for lag-comp corrections).
- Wire: `EventKind.ProjectileImpact = 7`, an optional `impact` payload on `EventMessage`,
  `IMPACT_EVENT_BYTES = 25` with the frame length as the discriminator, protocol 9 → 10.
- Server broadcasts impacts inside `runOneTick` before the snapshot-parity gate, so impacts
  between snapshots still arrive; the lag-comp correction path passes the rewound hit point.
- Client effects are driven by records only: direct/bounce/timeout/world, tracer cross vs
  weapon fireball vs disc explosion, timeouts suppressed for non-explosives. The
  disappearance-diff effect path was deleted.

### P2: movement solver fidelity — #3

- Primary evidence found: the leaked T2/V12 engine source (`github.com/tribes2/engine`,
  `game/player.cc` updateMove/updatePos/findContact) plus retail `player.cs`.
  `amterp/tribes-movement` is a Unity approximation, not evidence.
- Verdicts, recorded in code comments: resistance applies to velocity exactly as
  `applyResistance` already did (the issue's force-based hypothesis is disproven);
  `groundFriction` has no engine counterpart (run steering toward zero is the stop);
  `drag` is water-only; `GROUND_SNAP` remains a documented demo choice for 32 ms heightfield
  ticks.
- Vanilla corrections: Heavy `jumpSurfaceAngle` 80 → 75 and `speedDamageScale` 0.004 →
  0.006. Jet steering 0.8 is anchored to vanilla `maxJetHorizontalPercentage`.
- Six new integration tests (cap-then-resist convergence, no terminal fall velocity, ground
  snap glue-vs-detach, exact `g·sin(θ)` slope kinematics, jet/up-resistance equilibrium,
  Heavy vs Light jump gates). Approved ski/jet feel untouched.

### P2: snapshot relevance filtering — #5

- `packages/server/src/snapshot-policy.ts` implements the 400 m radius: players inside it
  are fresh every snapshot; players beyond it refresh every 4th snapshot with the last-sent
  stale copy re-sent in between (a stale copy diffs to zero bytes against the client's acked
  baseline, so it persists the entity instead of the delta encoder reading omission as
  removal). Far projectiles are omitted; far base objects hidden inside an interior
  footprint are omitted with force fields exempt. Statics ride unfiltered.
- Measured with the real encoder on a 31-player distant roster: 1035 → 74 bytes on sparse
  ticks (92.9% drop), with a deliberate full-refresh tick for convergence.

### P2: one-sided lag compensation — #10

- The rewound recheck now arbitrates live hits too: live hit + rewound miss is rejected
  (damage reverted with the victim's real armor, kill un-made, score reverted, a carried
  flag restored if still dropped, no `PlayerKilled` on the wire, the event reshaped to an
  honest miss); live hit + rewound same target is honored untouched; live miss + rewound hit
  keeps the existing generous correction. The world is never rewound or re-stepped.
- Residual: a retargeted Chaingun correction can leave the already-recorded Direct impact
  puff at the live contact point rather than the rewound one — damage, events and
  exactly-once delivery are correct, only that FX point can differ.

### P2: UI, inventory and loadout fidelity — #55

- Full loadout selection end to end: `PackId` (None/Repair/Energy), `applyLoadoutSelection`
  with an armor-sanitized `1 << WeaponId` mask (mask 0 = armor defaults, never an unarmed
  loadout), `carriedWeapons` persisting through respawn, and the Energy Pack's +0.15/tick
  recharge term in `movement.ts`.
- Wire: `LoadoutMessage` gains pack and weapons bytes (`LOADOUT_MESSAGE_BYTES = 4`), the
  player snapshot carries `hasEnergyPack` + `carriedWeapons` (`PLAYER_FULL_BYTES` 61 → 63),
  protocol 10 → 11 with two-direction rejection tests.
- Client: a full armor/pack/weapons station menu (`LoadoutChoice` state machine, refilled
  per visit and idempotent while open), a HUD pack row and weapon rack that shows the
  carried set, and a two-level quick-chat tree over the nine committed Bot1 lines.
- Documented gaps: reticle/compass/vehicle-instrument pixel layout is not constrained by
  the committed reference and was left alone; the Repair Pack has no committed icon
  (`hud_new_packrepair.png` is absent) so it renders as a text cell; `maxWeapons` has no
  committed semantics and is deliberately unconsumed (gating uses the grounded
  `laserRifleAllowed`/`mortarAllowed` flags).

### P2: vehicle and bot feature scope — #57

- Vehicle-versus-player contact: overlap against `checkRadius + player hitbox`, a two-body
  elastic shove, damage from closing speed above the vehicle's own `collDamageThresholdVel`,
  attribution to the current driver (else -1), and self-damage to the vehicle. The event
  belongs to the vehicle's own swept motion (`VEHICLE_STRIKE_MIN_CLOSING = 0.5 m/s`), so a
  parked vehicle cannot micro-bounce a standing player.
- AA seeker behavior: lock is the firing turret's `targetId`; straight fly-out for the
  source's 1.0 s seek time, then rate-limited turning (4.5 rad/s, ours) that preserves
  speed; a lost lock flies straight. Covered by a full `stepWorld` AA-versus-crossing-Shrike
  engagement.
- Vehicle kill scoring: +5 enemy / -5 friendly, credited to the last player to damage the
  vehicle (a vehicle's own crash is -1 and credits nobody); Shrike blaster kills now carry
  the driver's id from `VehicleFireEvent.ownerId`.

### P2: network debug time scaling — #7

- `pinNetworkTimeScale` pins `app.timeScale = 1` whenever a network transport exists, the
  debug slider is disabled and relabelled, and the pin re-applies every frame so a
  programmatic write cannot keep a divergent scale. Residual: a write landing between
  `frame()` and the debug update can scale one frame (≤5 ticks) before the pin; closing that
  needs an app.ts-side guard, and normal reconciliation absorbs it.

### P2: team cap for humans — #31

- `joinableTeam` returns the smaller team, then the alternate, else null; a team exactly at
  cap qualifies only if a bot can be shed, and an over-cap team never does. A refused join
  answers with `WelcomeStatus.TeamFull = 2` (byte-compatible, no version bump); clients
  already treat any non-Ok Welcome as a failed join.

### P2: remaining sound fidelity — #56 (partial)

- Impact audio now comes only from authoritative records (per-weapon sample by reason,
  silent for non-explosive timeouts, grenade detonations on timeout). The disappearance-based
  inference in `syncProjectileAudio` is gone.
- Added: equal-power panner routing for positioned one-shots and spatial loops with a
  per-frame listener orientation, terrain-only occlusion ducking
  (`OCCLUSION_ATTENUATION = 0.3`, ours), a footstep cue table keyed by armor and surface,
  and loop stops on destruction, death, disconnect, power loss and menu transitions.
- Documented gaps: no committed spin-up/spin-down or continuous fire-loop recordings, no
  medium/heavy-armor or interior footstep recordings, no hand-grenade detonation sample, no
  turret-impact samples, and interior/force-field occlusion is not modeled. None of these
  are synthesized (repo rule).
- Perceptual QA note: the panner path is exercised through fakes in unit tests; a two-client
  browser listen is still the honest check.

## Still open

### P1: Wildcat spawns under its pad, handles poorly, drives in third person (2026-09-10)

User-reported, three symptoms, each with the evidence a fix needs so nobody re-derives it:

- **Spawns below the pad.** `spawnVehicleAtPad` writes the vehicle at the pad's own position,
  so the Wildcat starts inside the pad's geometry and the hover spring has to push it out.
  Reproduce headless first: spawn at a powered pad and record `world.vehicles.position` on
  the y axis for the first 60 ticks. The fix belongs in the spawn placement, not in a
  damping tweak that hides the pop.
- **Handles awkwardly.** The Wildcat's steering and thrust constants are the script's values
  treated as accelerations (`vehicles.ts` `applyWildcatSteering` / `applyWildcatThrust`; the
  plan's numbers table records which of them are ours), and its top speed is a flat
  `WILDCAT_MAX_SPEED` cap standing in for the script's drag term. Those are the levers;
  a handling change must name which one moved and what it fixed.
- **Third person.** Deliberate code, not an accident: `client/src/app.ts`
  `placeVehicleCamera` gives the Shrike its authored `Eye` node and falls back for the
  Wildcat to a trailing chase camera. Note the conflict with the repo's own reference
  material: `docs/ui-audio-reference.md` describes the source Wildcat frame as a third-person
  view on a pad, so "make it first person" is a product decision rather than a proven
  fidelity fix. The Wildcat dashboard art already exists in the manifest
  (`hud_veh_new_dash.png` and the `hud_veh_*` set) if a cockpit view is wanted.

### P1: bots take the flag but never capture — #32

See Start here. All the mechanical blockers are gone; the remainder is combat economics on
the return leg.

### P2: projectile art and texture animation — #53

- IFL playback driver: a 12-resource frame table from the upstream `.ifl` files (30 Hz
  ticks) injected into `withVisibility`, keyed to the GLB's `ifl_sequence`/`ifl_duration`/
  `ifl_cyclic`, with a shared frame cache and rebinding on clone. Only frame-0 PNGs are
  committed, so playback keeps the last available map until the frame images are copied
  under the manifest keys — the fallback stays honest.
- Disc plate uses the source `disc.glb` proportions (r 0.408 / thickness 0.062) and spins
  from a per-frame delta; blue additive glow and velocity + projected-world-up orientation
  unchanged. Shrike bolts alternate ±1.93/+0.044 muzzle origins per `vehicle_shrike.cs`
  PairImage offsets, client-side only. Blaster ball/trail and Chaingun crossed-ribbon
  tracers remain approximations. Do not reapply world yaw to first-person models.

### P2: repair presentation — #51

- Beam, HUD row (`REPAIRING <label> <hp>% · <d> m · ENERGY <e>%`, plus depleted and
  no-target variants) and lifecycle gating are in; the Repair Pack rebuilds destroyed
  generators and stations at damage 0, with enemy rejection and line of sight enforced.
- Remaining: no committed repair-beam recording exists, so the loop is silent until a source
  sample is added; player-candidate repair still ignores terrain occlusion in the sim.

### P2: terrain texture repeat scale — #2

- Not verifiable from committed evidence (manifest has no scale field, `.ter` v2 stores
  none, no Torque renderer source in the repo). `terrain.ts` documents the uncertainty and a
  do-not-bump guide.

### P2: turret animation QA — #54

- Aim limits derive from the mount (pedestal → Large 15/140, none → Sentry 89/175), targets
  clamp to the source theta band, no-target syncs relax to the authored rest pose, and
  presentation advances in simulated seconds (`{ dt, timeScale }` from `app.ts`).
- Remaining: collision still uses a conservative elevated sphere rather than exact barrel
  geometry; check edge hits and splash/repair targeting consistency before treating it as
  physically exact.

### P2: remaining net and protocol residuals

- Retargeted Chaingun corrections can render their impact puff at the live rather than
  rewound contact point (see #10 above).
- `session.ts` still documents u32 input/snapshot counter exhaustion after years of
  uninterrupted operation; reconnect is the accepted recovery.

### P2: vehicle and bot scope residuals — #57

- Only Shrike and Wildcat exist. The four remaining T2 base vehicles, per `jdknight/t2ds`'s
  `GameData/base/scripts/vehicles/`: **Bomber** (`vehicle_bomber.cs`), **Havoc**
  (`vehicle_havoc.cs`), **Tank** (`vehicle_tank.cs`) and the **Mobile Point Base**
  (`vehicle_mpb.cs`) — each with its own weapons, mount rules and passenger seats.
  `vehicle.cs` (the shared base) and `serverVehicleHud.cs` are the shared plumbing they need,
  and the AA barrel's vehicle targeting, vehicle shields, ejection and collision damage
  already exist, having been built against the two implemented kinds.
- Bot carrier survival is unfinished (#32), and complete vehicle piloting, strategic
  loadouts, and a full match with captures remain unproven.

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
  aiming/fire, flag cues, original blue disc explosions, blue flying disc glow, pitched-disc
  orientation across four cardinal headings, shield energy round trips, turret target kind,
  signed projectile owners, snapshot count guards, invalid decoded vehicle kinds,
  determinism hash coverage, structure occlusion for hitscan and turret acquisition,
  vehicle slot lifetime and interpolation across recycled ids, and the STL asset fallback.

## Development handoff

- Work directly on `main`; the user authorized commits/pushes and requested no PRs and no CI
  waiting. Keep private `.claude/` files out of commits. Use `trash` (not `rm`) for deletions
  and never leave probe scripts in the tree — a stray `packages/**` probe breaks `tsc -b`
  project-wide.
- Use Node 24+ and repository-pinned **pnpm 11.0.3**; a system pnpm 7 previously damaged the
  workspace install/lockfile.
- `pnpm dev` starts client 5173 and server 7777. Use
  `http://127.0.0.1:5173/?server=ws://127.0.0.1:7777` for network testing; the bare URL
  follows the solo path. Restart both after protocol/server changes.
- Current protocol is **11** (impacts, shields, turret target kind, signed projectile owner,
  and the loadout/pack/weapons selection). Converted assets are committed; ordinary startup
  needs no fetch/build. Asset additions need manifest, builder and generated output changes
  together.
- Gates: `pnpm test` (1092 tests, 72 files), `pnpm typecheck`, `pnpm lint`, and
  `env -u CI node_modules/.bin/playwright test` (37 cases; the environment sets `CI=true`,
  which disables reuse of an already-running dev server). Do not edit while browser tests
  run: HMR causes false failures.
- Deliberate weapon tuning: Blaster 0.3 s cycle; Chaingun 0.1 s held fire versus source
  0.15 s, with 0.5 s spin-up; Shrike 0.2 s versus source 0.125 s. The user requested faster
  infantry guns and slower Shrike fire. Do not silently revert.
- Source references and original UI screenshots live in `docs/ui-audio-reference.md`;
  README has in-game screenshots. Primary movement/rules evidence for this pass came from
  the leaked T2/V12 engine source (`github.com/tribes2/engine`) and the retail scripts; cite
  the file and function in code comments when a constant is anchored to it.
