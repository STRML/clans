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

1. **#32 captures.** The failure is now measured at the project's own match size, and the
   story changed again: **no carrier reaches its own stand at any size**, but how close they
   get scales hard with the number of bodies. Four seeds, 12,000 ticks each:

   | | 8v8 | 12v12 | 24v24 |
   | --- | --- | --- | --- |
   | kills | 106 | 185 | **370** |
   | flag touches | 12 | 14 | 19 |
   | carrier runs | 15 | 16 | 24 |
   | closest approach, min/median | 570/801 m | 270/681 m | **48/730 m** |
   | carrier deaths | 13 | 10 | 21 |

   Captures, arrivals and refused ticks are **0 in every configuration**, so the
   capture-refusal rule (`flags.ts` `ownFlagHome`) is still untested by data. At the target
   size 21 of 24 runs end in death, 16 of them by an enemy, a median 1,455 ticks after pickup
   and 730 m from home, at 15 m/s with the killer 23 m away. The one-sided match the smaller
   sizes showed (one flag never taken in 48,000 ticks) disappears at 24v24, where both flags
   are carried and both sides lose carriers.

   Four carrier-side levers are measured and **closed**, each with the number that killed it:
   a lateral dodge (target size: closest approach 48 to 85 m, enemy-caused deaths 16 to 18,
   minus 14% kills), a tighter escort station (escort distance 38 to 37 m, deaths flat, closest
   approach 48 to 268 m), letting the carrier ski for speed (home leg 14.6 to 18.4 m/s and
   exposure 1296 to 1011 ticks, but kills 370 to 257 and closest approach 48 to 264 m), and a
   fourth, decisive one: **carrier rally**, where a threatened carrier turns back onto its
   nearest teammate. It met its precondition -- 13 of 21 threatened runs closed to within 25 m
   of a teammate -- and **12 of those 13 carriers died anyway**, while kills fell 370 to 341 and
   the closest approach went 48 to 204 m. Meeting the help does not save the carrier, so the
   help is not a combat asset.

   The number behind all four: at the death tick the nearest live teammate is a median **209 m
   behind the carrier** while the team is at full strength, and the carrier is killed by the
   first enemy that reaches it, a median 23 m away, at 15 m/s. Every lever that tried to move
   the carrier, its speed or its company failed the same way. Re-run the telemetry before
   theorizing, and read the wave section below before changing any carrier policy.
2. **Wildcat bugs (user report, 2026-09-10): closed.** Pad spawn and steering were fixed and
   measured in `1e26db4`; the camera followed in `c9e729f`, which gives the Wildcat T2's own
   camera: the cockpit rests on the model's authored `Eye` node and `X` slides it to the
   script's chase end (cameraMaxDist 5.0, cameraOffset 0.7) at the engine's own traversal
   speed. T2 ships that resting mode by default (`GameConnection::mFirstPerson`), matching
   what the user asked for. See the wave section below.
3. **#53 remaining art.** The IFL playback driver, its frame table and **all 104 sequence
   frames** are committed (12 sequences: disc explosion, plasma barrel glow, both blaster
   muzzles, laser sweeps, spinfusor casing, jet exhaust, pad light, station blink, screen
   static), so the sequences now animate instead of holding frame 0. Blaster ball/trail and
   Chaingun crossed-ribbon tracers remain approximations. Per-side Shrike muzzle origins need
   `VehicleFireEvent` side data in the sim (the client already alternates visually).
4. **#51 remaining: the perceptual listen.** The beam, HUD feedback, lifecycle gating, the
   player-candidate line-of-sight fix and the recording are all in: the "no source sample
   exists" claim was wrong, `fx/packs/repair_use.wav` is the source's own
   `CloseLooping3d` firing state (`repairpack.cs:33-39`) and it is now wired. What remains is
   the two-client listen, which needs a human and cannot be asserted by a test.
5. **#2 terrain texture scale.** Cannot be established from committed evidence; `terrain.ts`
   keeps 64 repeats over 2048 m with the uncertainty documented. Closing it needs the
   original renderer/material data, not another guess.
6. **Fidelity backlog:** #54's yawed and elevated mount coverage (the measured shape replaces
   the sphere for every static pose, and the residual is written down in the shape data),
   the #5/#10 residuals below, #56's interior and force-field occlusion and its two-client
   listen. #57's vehicles are done to the extent the scripts describe them: all six kinds
   exist, the four new ones have their own models converted from source, their physics
   classes, their script-cited armament, passenger seats on the wire (`passengerId`, protocol
   11) with protected mounts, and the Mobile Point Base deploys a working station and turret
   and packs them away again. The seat-count and protected-mount table is now pinned by a
   test, and three of its citations were found to have drifted when it was written.
7. **Interiors cannot be rebuilt from source.** Every `interiors.vl2/interiors/*.glb` source
   is 404 while the `.dif` originals are served, so a clean clone cannot build the interiors;
   the local cache hides that. A DIF reader is the same kind of job as the `.dts` reader and
   is not started. See the asset section below.

## Landed this wave (2026-09-10 to 2026-09-11)

| Commit | Work |
| --- | --- |
| `1e26db4` | Wildcat: spawns above its pad deck, hover support sees the deck, steering critically damped |
| `f137812` | Bot matches seeded from the world seed; carrier telemetry behind `BOT_TELEMETRY=1` (#32) |
| `5a89be9` | Escort threat priority and the carrier hold-fire predicates (#32) |
| `f47699b` | Terrain-profile route chains for long graph edges, with the turret-avoidance measurement (#32) |
| `20fd9c7` | Carrier stand hold, launch staging, thief recovery, escort engagement range (#32) |
| `4aa22eb` | Retune of the two carrier policies an ablation measured as harmful (#32) |
| `c9e729f` | Wildcat camera: T2's own Eye-node cockpit, chase end behind the `X` toggle |

Verification: **1159 unit tests pass across 73 files** (the opt-in telemetry sweep is the one
skip); `pnpm typecheck`, `pnpm lint` and `prettier --check` clean; **38/38 Playwright cases
pass** (`env -u CI node_modules/.bin/playwright test`). Protocol stays **11**.

## Landed in the second 2026-09-11 wave

| Commit | Work |
| --- | --- |
| `3dc8aa4` | Armor weapon-slot cap enforced, with the Light default it was silently breaking (#55) |
| `5e8d2bd` | Per-team seat cap configurable, so `--bots 48 --team-size 24` seats 24 versus 24 (#31, #57) |
| `c76e5e9` | Snapshot bot bound raised to the roster capacity: a 48-bot match no longer throws on its first snapshot |
| `70548f8` | Spawns separated (0.05 to 1.66 m minimum) and respawn waves rotated instead of one fixed point |
| `e3f79ff` | All 104 IFL sequence frames committed, so the texture sequences animate (#53) |
| `b1b7866` | Player repair candidates obey line of sight like the other three kinds (#51) |
| `e59eb98`, `f1ce478` | The twelve recordings the audio gaps blamed on missing source, listed and wired; Repair Pack icon bitmap (#51, #56) |
| `76dfc9f`, `2176d67` | Turret hit shape measured from the source models, replacing a 73%-phantom sphere (#54) |
| `ff16620` | Match cycle: intermission, restart, `--time-limit`, `--intermission` |
| `6807cf7` | Stall detection measures net progress, not distance moved (#32) |
| `7a440cf` | The HUD rack's expectation comes from the simulation instead of a hand copy |
| `f6be7b7` | The harness measures the project's own match size, with a 24v24 acceptance case (#32) |
| `b27fe50` | Station picker, HUD and the legacy spawn path all honour the weapon-slot cap (#55) |
| `78ad7bf`, `90f4d94`, `7ad5feb` | A `.dts` shape reader, the four missing vehicle models built from source, and the four vehicles as full kinds (#57) |

Measured and **reverted**, with the numbers that killed each: the carrier lateral dodge, the
tighter escort station, carrier ski speed, and carrier rally (which met its precondition and
still lost the carrier -- see Start here item 1). Also reverted on evidence in the earlier
wave: launch staging and the decision-layer hold-fire gate.

### The asset pipeline was fetching dead URLs

Every pre-converted `shapes.vl2/shapes/*.glb` source is 404 upstream, including the two
vehicles the repo shipped, so the cache was a relic and a clean clone could not build any
shape. The `.dts` originals are still served (345 of them) and `packages/assets/src/dts.ts`
now reads that format, implemented from the Torque engine's own stream code with a citation
per field group.

The switch is deliberately partial and the reason is in the code: the pipeline cannot yet
emit animation clips, and the 17 shapes that already have a committed GLB carry clips the
client plays by name (weapons' `discSpin`/`Fire`/`Reload`, turrets' `Deploy`/`Elevate`/`Turn`,
stations' and pads' powered states). Regenerating those today would silently strip their
animations, so only the four shapes with no prior asset convert from source. The sequence
work is in the tree and dormant with its parity table in the doc comment: clip names,
durations, targets and sampled poses match on every real transform clip, and the three known
deviations are named there. That comment is where the next pass starts.

Interiors are the remaining hole: `.dif` sources are served and their `.glb` counterparts are
404, so a clean clone still cannot build them.

### The Wildcat report, closed

All three user-reported symptoms are fixed. The pad spawn was placing the craft 0.30 m inside
the deck mesh (the deck top is 2.3 m above the pad object's own origin) and the hover spring,
reading terrain before interiors, then dragged it down 79.8 to 77.4 with lateral drift; the
spawn now probes the deck and starts at its top plus hover rest height, and the spring sees
interiors within 8 m. The handling was a steering controller with zeta about 0.05: a held
90-degree input overshot 77 degrees and limit-cycled 65 degrees under it forever, now
critically damped with the plan's own constant restored (90% closed in 1.47 s, no overshoot,
parked hover amplitude 0.000 m). The third-person camera was never broken, only not T2's
default: `c9e729f` puts the camera on the model's authored `Eye` node for every vehicle and
moves the chase end -- Wildcat 5.0 m / 0.7 m, Shrike 15 / 2.5 -- behind the `X` toggle, with
`GameConnection::mFirstPerson` defaulting true as the source does. `e2e/vehicle-camera.spec.ts`
pins both ends of that slider.

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

### P2: 48-bot tick bursts during mass engagements

A 24-versus-24 match runs at a mean of 1.8 to 2.4 ms per tick against the sim's 32 ms budget
(`FIXED_TICK_MS`), but not uniformly: measured over four seeds by 12,000 ticks, the
over-budget ticks cluster instead of scattering. Seed 2 held 31 to 36 ms per tick for twenty
consecutive ticks (3236 to 3255), and instrumenting that window puts **all** of it in the bot
half -- 30 to 35 ms of bot decision-making while the simulation itself stayed at about 1.2 ms
-- with 43 of 48 players alive, no deaths, and the projectile count climbing through 126 to
158. So the server cannot hold 50 Hz for the duration of a big fight, and the cause is bot
cost under load rather than physics or startup.

The projectile count is a proxy rather than the input: nothing in `packages/bots` reads the
projectile store at all, and the perception scans that dominate cost walk the PLAYER store
(`perception.ts`'s `findNearestVisibleEnemy` and `findCarrierThreat` at :73 and :193) and the
turret store (:252), each candidate costing a terrain line-of-sight march. A rising
projectile count therefore means many bots engaged, and more bots with a target is more
roster scanning. Two runs of the identical tree counted 27 and 82 over-budget ticks out of
48,000, so host contention moves the count too; the burst itself is compute.

Attributing the burst to one specific scan and cutting it is the open work, and the fix has a
shape already suggested by the numbers: the scans are per-bot and per-candidate over the full
roster, so anything that shares or bounds them (a spatial bucket, a re-scan interval, or
reusing one bot's visibility result for a neighbour) attacks the super-linear term.

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
- Collision is now the measured assembly rather than one conservative sphere: a pedestal
  cylinder and a head cylinder read from `turret_base_large.glb` (radii 2.3543 m and 1.3130 m,
  top 2.2179 m), plus a barrel capsule out to `turret_fusion_large.glb`'s own Muzzlepoint
  (`turretHitShape`). Direct hits, splash falloff and repair/bot targeting all share it, and
  tests pin the shots that used to stop in the air above or beside the turret.
- Remaining, both needing scene rotation on the sim store — a `createTurrets` field no call
  site passes today (the client's is out of scope), so they are measured, not guessed:
  the base wings reach 2.7385 m from the placement axis, 0.384 m past the pedestal cylinder
  (the old sphere missed them by 0.739 m); and the barrel capsule sits in the placement's own
  frame, so a mount whose head has yawed (the socket swings 0.4001..1.7979 m from the
  placement axis about `DumTurn`) or whose barrel is pitched anywhere in its 15..140° theta
  band can leave it — measured over that band, the drawn barrel mesh reaches y 2.6402 and its
  `Muzzlepoint` (the fired extension's tip) 3.0010, with the horizontal radius growing to
  1.3572 m. Covering every yaw instead measures r 2.4939 about the placement axis; a cylinder
  over the head's own band alone is 36.4 m³, more than the whole new shape's 34.653 m³, and it
  blocks shots that visibly pass beside the barrel.

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
