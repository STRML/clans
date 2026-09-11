# Known issues and continuation notes

Updated September 11, 2026 (fourth pass: a measurement-and-attribution wave on issue #32, a
Wildcat bug fix, and a new `CHANGELOG.md`; the tree is at protocol 11, **1159 unit tests**
across 73 files plus the opt-in telemetry sweep, and a green 37-case browser suite). This is
the handoff for the next implementation agent, including DeepSeek. The original milestone
plans describe intended scope, not proof that the game faithfully reproduces Tribes 2.
Prefer current code, tests, source assets, and user observations over earlier completion
claims.

Priority: P1 affects ordinary gameplay; P2 is fidelity, robustness, or tooling.
“Historical report” means an existing GitHub report whose exact reproduction has not been
rerun in this audit. GitHub issue numbers below refer to
<https://github.com/STRML/clans/issues>.

## Start here

1. **#32 captures.** The mechanics are all in (navigation, fall arrest, pocket escape, escort
   formations, turret suppression, energy economy) and the last wave made the failure
   measurable and rewrote the story: with real per-seed variation, **no carrier ever reaches
   its own stand**. Over four seeds and 48000 ticks, carriers made 12 to 21 runs, none
   entered the 2 m capture radius, and the best approach was 33 m. They die in midfield to a
   single enemy: median killer distance 17-27 m, a median of one live enemy within 100 m,
   and a median of ZERO live teammates within 100 m, at ~780 m from the carrier's own stand.
   The capture-refusal rule (`flags.ts` `ownFlagHome`) is therefore still **untested by
   data**: `refused` is 0 in every measured configuration. Re-run the telemetry before
   theorizing, and read the ablation table below before changing any carrier policy: two of
   the three policies this issue's last wave added turned out to cost far more than they
   bought, and both were retuned on that evidence.
2. **Wildcat bugs (user report, 2026-09-10): spawn and handling fixed, camera still open.**
   The pad spawn and the steering limit cycle are fixed and measured (`1e26db4`); the
   third-person chase camera is deliberate code and awaits a product decision from the user,
   not another agent. Details in the P1 entry under Still open.
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

## Landed this wave (2026-09-10 to 2026-09-11)

| Commit | Work |
| --- | --- |
| `1e26db4` | Wildcat: spawns above its pad deck, hover support sees the deck, steering critically damped |
| `f137812` | Bot matches seeded from the world seed; carrier telemetry behind `BOT_TELEMETRY=1` (#32) |
| `5a89be9` | Escort threat priority and the carrier hold-fire predicates (#32) |
| `f47699b` | Terrain-profile route chains for long graph edges, with the turret-avoidance measurement (#32) |
| `20fd9c7` | Carrier stand hold, launch staging, thief recovery, escort engagement range (#32) |
| `4aa22eb` | Retune of the two carrier policies an ablation measured as harmful (#32) |

Verification: **1159 unit tests pass across 73 files** (the opt-in telemetry sweep is the one
skip); `pnpm typecheck`, `pnpm lint` and `prettier --check` clean; **37/37 Playwright cases
pass** (`env -u CI node_modules/.bin/playwright test`). Protocol stays **11**.

### The seed defect, and why every earlier "three seeds" result was one match

`createBotManager` started its bot RNG stream at a hardcoded 0, so the harness's seeds 1/2/3
produced **byte-identical matches** — bot jitter comes from `manager.nextSeed`, not from
`world.random`, which has no consumer in a vehicle-less match. The manager now seeds from
`world.random.value` while keeping the per-bot increment, proven both ways: reverting the one
line restores byte-identical rows across all four seeds. Any pre-`f137812` claim of the form
"passes on three seeds" was one scenario run three times.

### The telemetry, and the honest state of #32

`packages/server/src/carrier-telemetry.ts` records, per carrier run: pickup and end ticks,
end reason, killer with its relation (enemy / teammate / self / unattributed) and distance,
live enemies and teammates within 100 m, the closest approach to the carrier's own stand, and
the ticks inside the 2 m capture radius split by whether the own flag was home; per match, the
flag-state tick shares and the both-flags-carried ticks. Run it with:

```
BOT_TELEMETRY=1 node_modules/.bin/vitest run packages/server/src/bots.katabatic.test.ts \
  -t 'carrier telemetry sweep' --reporter=verbose > /tmp/telemetry.txt 2>&1
```

The `--reporter=verbose` is required: the default reporter drops `console.log` from a passing
test when stdout is not a TTY.

**Current configuration** (seeds 1-4, 12000 ticks each): 121 kills, 11 flag touches, **0
captures, 0 arrivals**, 0 refused ticks, 16484 both-flags-carried ticks of 48000 (34%),
carrier deaths 11 (all enemy-credited except one unattributed), best approach to a carrier's
own stand 45 m. For comparison, the same harness at `20fd9c7` measured 69 kills, 18199
both-flags ticks and 2 carrier **self-kills**.

### The ablation that retuned the wave's own policies

Each row is a single behavior disabled, everything else at `20fd9c7`, four seeds pooled; the
control reproduces byte-for-byte, so every delta is the edit and not sim noise.

| Configuration | kills | carrier deaths | self-kills | arrivals | both-flags ticks |
| --- | --- | --- | --- | --- | --- |
| Control (`20fd9c7` as shipped) | 69 | 7 | 2 | 0 | 18199 |
| No decision-layer hold-fire gate | 104 | 10 | 0 | 0 | 18265 |
| No 600-tick staged wait | 122 | 15 | 1 | 0 | 10371 |
| No terrain-profile route chain | 92 | 14 | 2 | 1 (seed 1, 2 m) | 9400 |
| No stand hold | 75 | 7 | 1 | 0 | 18020 |

Decisions taken on that table, all landed in `4aa22eb`: the decision-layer hold-fire gate is
**removed** (it cost 35 kills for zero arrivals), the 600-tick wait is **retuned to 100 ticks**
(it cost 53 kills and 7828 stalemate ticks for eight saved carriers that never converted), and
the route chain is **kept** — the single arrival seen without it is knife-edge and did not
reproduce under the retuned configuration (measured again: 103 kills, 11863 both-flags ticks,
still 0 arrivals). The stand hold is **kept** although it never fires on these seeds: `refused`
is 0 everywhere, so the state it exists for still has not occurred.

**The trap this table documents:** single-seed arrivals are not results. Three different
configurations produced one, on different seeds, and none reproduced. Do not tune a constant
because one seed arrived.

## Landed in the second wave

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

Verification for that wave: 1092 unit tests across 72 files, typecheck and lint clean, 37/37
Playwright cases.

## Resolved in the second wave

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

### P1: Wildcat — spawn and handling fixed, camera awaiting a product decision (2026-09-10, updated 2026-09-11)

User-reported. Two of the three symptoms are fixed and measured in `1e26db4`; the third is a
product decision, not a bug.

- **Spawned below the pad — FIXED.** The pad's deck top sits 2.3 m above the pad object's own
  origin, and `spawnVehicleAtPad` placed the craft at origin + 2 m: 0.30 m inside the deck
  mesh, which the hover spring then dragged down through (79.8 to 77.4 over 60 ticks, with
  lateral drift, because the spring read terrain before interiors). The spawn now probes the
  pad's own deck and starts at its top plus the hover rest height, and `applyHoverSpring`
  reads the higher of terrain and any deck within 8 m below the craft. Pinned by a
  regression test that fails on the old placement.
- **Handled awkwardly — FIXED.** The steering controller was underdamped (zeta about 0.05):
  a held 90-degree input overshot 77 degrees and limit-cycled 65 degrees under it forever,
  which is what "awkward" was. It is now critically damped with the plan's own steering
  constant restored; closed-loop 90% in 1.47 s, zero overshoot. Parked hover amplitude is
  0.000 m, so the spring was never the problem.
- **Third person — OPEN, by design.** `client/src/app.ts` `placeVehicleCamera` gives the
  Shrike its authored `Eye` node and the Wildcat a trailing chase camera. That is deliberate
  code, and the camera itself measures clean (first-order lerp, frame-rate independent,
  3.06 degrees of lag through a 90-degree flick), so the perceived badness was the steering
  limit cycle above, now fixed. Note the conflict with the repo's own reference material:
  `docs/ui-audio-reference.md` describes the source Wildcat frame as a third-person view on a
  pad, so "make it first person" is a product call rather than a proven fidelity fix. The
  Wildcat dashboard art already exists in the manifest (`hud_veh_new_dash.png` and the
  `hud_veh_*` set) if a cockpit view is wanted.

### P1: bots take the flag but never capture — #32

See Start here for the current measurements and the ablation table. In one line: carriers are
killed by lone enemies in midfield with no teammate within 100 m, roughly 780 m from their own
stand, and no carrier has yet reached the capture radius in any measured configuration, so the
capture-refusal rule remains untested by data.

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
- Gates: `pnpm test` (1159 tests, 73 files; the opt-in telemetry sweep is the one skip),
  `pnpm typecheck`, `pnpm lint`, and `env -u CI node_modules/.bin/playwright test` (37 cases;
  the environment sets `CI=true`, which disables reuse of an already-running dev server). Do
  not edit while browser tests run: HMR causes false failures.
- Measuring bot behavior: run the carrier telemetry sweep before and after any carrier-policy
  change, and treat a single-seed arrival as noise. The command, and the reason
  `--reporter=verbose` is required, are in the telemetry section above. Three different
  configurations produced one arrival each on three different seeds this wave, and none
  reproduced; a control re-run reproduces byte-for-byte, so any delta you see is your edit.
- `CHANGELOG.md` is maintained with the work: add an entry under Unreleased as each wave
  lands, and keep `docs/ISSUES.md` for what is still wrong or missing.
- Deliberate weapon tuning: Blaster 0.3 s cycle; Chaingun 0.1 s held fire versus source
  0.15 s, with 0.5 s spin-up; Shrike 0.2 s versus source 0.125 s. The user requested faster
  infantry guns and slower Shrike fire. Do not silently revert.
- Source references and original UI screenshots live in `docs/ui-audio-reference.md`;
  README has in-game screenshots. Primary movement/rules evidence for this pass came from
  the leaked T2/V12 engine source (`github.com/tribes2/engine`) and the retail scripts; cite
  the file and function in code comments when a constant is anchored to it.
