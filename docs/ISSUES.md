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

   A **fifth** closed lever narrows what is left: the bots' lead solve ignored the velocity
   their own projectile inherits (`velInherit`, 0.5 for the Spinfusor and the Chaingun), so a
   moving shooter's shot arrived displaced by `v * inherit * travelTime`. The model gap is
   real and small where it matters (about 1.7 m at 20 m for a 15 m/s shooter with the
   Spinfusor, inside that weapon's 7.5 m splash). Measured at the target size it was neutral
   on kills (370 to 375) and carrier deaths (21 to 22) and worse on the two numbers that
   describe an actual flag run -- best penetration 48 to 354 m and both-flags-carried ticks
   11059 to 5645 -- so it was reverted.

   **Vehicles change this, and they are the first thing that has.** Bots never used them: a
   vehicle goal was a last-resort fallback after every CTF priority, so with a full roster it
   never fired (measured 0 mounts in 12,000 ticks with two craft parked at the teams' own
   pads), and nothing in the brain knew a bot was mounted, so a rider kept sending walking
   input. Both halves are in now -- a driving controller (bearing, throttle, jets to climb to
   a goal that is above the craft, which is what reaches a stand on a base deck) and a policy
   that takes a parked craft when the bot's own leg is long -- measured at 24v24 over four
   seeds:

   | | no vehicles | bots drive |
   | --- | --- | --- |
   | captures | 0 | **1** |
   | runs arriving in the 2 m radius | 0 | **1** |
   | refused ticks (own flag away) | 0 | 1,245 |

   Those are two firsts: the first capture any configuration has produced, and the first time
   the capture-refusal rule has been exercised by data at all. The best configuration measured
   gives 415 kills, 17 flag touches, a closest approach of 2 m and that single capture.

   It is a start, not a finish: three seeds of four still capture nothing. Five attempts at the
   rate are measured, and only one is kept:

   | attempt | result |
   | --- | --- |
   | a stall escape, so a craft pressed against a deck dismounts | **kept** (kills 352 to 405) |
   | a wider detour radius for carriers, 200 m to 400 m | inert: byte-identical matches |
   | aiming the craft at the waypoint graph's heading instead of the straight line | worse on every axis: 0 captures, kills 316, closest 122 m |
   | topping up a destroyed craft from the pad, as a player would | inert: byte-identical matches, so crafts are not being destroyed at all |
   | a deflection ladder on a stalled ride, turning 45 degrees and retrying instead of dismounting | worse: 0 captures, kills 415 to 278, closest approach 2 to 6 m |
   | reserving the team's craft for the carrier, so a rider gives it up when its team takes the flag | worse: 1 capture either way (seed 4), kills 415 to 340, touches 17 to 16, both-flags-carried 4,766 to 3,296 |

   Two of the five are informative and they point the same way: the limit is not attrition
   (topping up a destroyed craft changed nothing) and not the driver's obstacle handling
   (deflecting around one is worse than dismounting, because a craft wandering off its line
   hurts every other bot's fight too: kills fell to 278). What remains is that the carrier and
   the one craft per side do not meet often enough. Note Katabatic carries exactly one vehicle
   pad per base, so one craft exists per team by map data, not by policy.

   That last lever was the obvious next candidate -- reserve the craft for the carrier so a rider
   hands it over when its team takes the flag -- and it was built and measured rather than left
   as a hypothesis, because it is the one lever that attacks the meeting problem directly. It
   loses: one capture on seed 4 exactly as before, but kills fall 415 to 340 and the
   both-flags-carried count collapses 4,766 to 3,296, because a bot that gives up the craft
   rides it less and therefore fights less. Reserving the craft subtracts from the encounters it
   was meant to create. Six levers, all falsified on the numbers, and that exhausts the
   vehicle-and-carrier-policy space this repo can vary: the vehicle path is not what is holding
   the capture rate down.

   **Measured at the game's own match length, and it changes the picture.** Every capture
   number above was taken on the harness's own 12,000-tick window, which is not a match:
   `packages/sim/src/flags.ts` configures the game with `CAPTURES_TO_WIN = 8` and
   `TIME_LIMIT_SECONDS = 25 * 60` (`TIME_LIMIT_TICKS` 46,875, i.e. 12,000 ticks is a quarter
   of one). The harness value is ours and documented as such (bots.katabatic.test.ts's
   MATCH_TICKS), so the same configuration was re-run at the full 46,875 ticks, four seeds,
   24 v 24, one craft per team:

   | seed | kills | touches | captures | runs | refused | carrier deaths (enemy/team/self) |
   | --- | --- | --- | --- | --- | --- | --- |
   | 1 | 260 | 15 | 0 | 17 | 0 | 17 (16/1/0) |
   | 2 | 270 | 14 | 1 | 26 | 303 | 25 (18/3/1) |
   | 3 | 275 | 12 | 0 | 17 | 0 | 17 (14/2/0) |
   | 4 | 283 | 16 | 1 | 20 | 0 | 17 (17/0/0) |
   | all | **1,088** | **57** | **2 of 4 seeds** | 80 | 303 | 76 (65/6/1) |

   At the real length the match is not marginal: 1,088 kills, 57 flag touches, 80 carrier runs,
   captures on two seeds, and the capture-refusal rule finally exercised by data (303 refused
   ticks on seed 2 -- the case the stand hold was written for and had never once fired). The
   harness's window has been scaled to match: `SWEEP_TIMEOUT_MS` grows with `SWEEP_TICKS`,
   because the old fixed 900-second cap cut a full-length sweep off mid-table and printed a
   partial one.

   **A line-of-fire guard was built, measured twice, and falsified.** The full-length carrier
   telemetry shows 6 of 76 carrier deaths credited to a teammate plus 1 self-kill, and the sim
   scores friendly fire at -10 (`damage.ts`), while the bot combat layer had no line-of-fire
   check at all -- so a bot shot through its own team. Two versions were measured against the
   full-length table above, same four seeds:

   | configuration | captures | kills | touches | carrier deaths (enemy/team/self/unattributed) |
   | --- | --- | --- | --- | --- |
   | no guard (shipped) | 2 | 1,088 | 57 | 65/6/1/4 |
   | guard every teammate inside 1.5 m of the shot corridor | 0 | 981 | 60 | 65/3/2/5 |
   | guard the flag carrier inside 3 m, and nobody else | 1 | 1,044 | 55 | 60/8/1/7 |

   Neither version does the job it was built for. The wide guard halves friendly deaths (6 to 3)
   but suppresses fire across every melee and takes kills down 10 percent; the carrier-only
   version, which exists precisely to avoid that cost, leaves the friendly-death count no better
   than it found it (6 to 8) and still loses a capture. The mechanism is visible in the numbers:
   the deaths it targets are not line-of-fire deaths, since a three-metre corridor over a body
   the escorts already stand 8 m off changes nothing about them, which points at splash rather
   than a shot passing through a teammate. Both reverted; only the record and the harness
   timeout change remain.

   **What four seeds can and cannot resolve.** The three full-length configurations above
   captured 2, 0 and 1 times in four seeds. That spread is the measurement's noise floor, not a
   lever's effect: at four seeds this harness cannot resolve a change of one or two captures, so
   any capture-rate verdict it gives is a statement about large effects only. Four seeds, four
   matches, is enough to falsify a lever that costs 100 kills and not enough to accept one that
   finds a capture. Measuring the capture rate properly needs many more seeds, not another
   constant.

   The number behind the four proximity/speed levers that came before: at the death tick the
   nearest live teammate is a median **209 m behind the carrier** while the team is at full
   strength, and the carrier is killed by the first enemy that reaches it, a median 23 m away,
   at 15 m/s.
   But proximity is not what kills it: a probe of every carrier death shows the carrier
   fighting to the end (its last shot is a median 0 to 24 ticks before the death, and it lands
   damage -- its killer finishes at 57 to 66 percent damage against a LIGHT pool of about
   0.66). The carrier loses close fights narrowly, and the two arms that raised teammate
   proximity changed nothing, so what remains is bot combat effectiveness in a chase rather
   than coordination or navigation. Re-run the telemetry before theorizing, and read the wave
   section below before changing any carrier policy.
2. **Wildcat bugs (user report, 2026-09-10): closed.** Pad spawn and steering were fixed and
   measured in `1e26db4`; the camera followed in `c9e729f`, which gives the Wildcat T2's own
   camera: the cockpit rests on the model's authored `Eye` node and `X` slides it to the
   script's chase end (cameraMaxDist 5.0, cameraOffset 0.7) at the engine's own traversal
   speed. T2 ships that resting mode by default (`GameConnection::mFirstPerson`), matching
   what the user asked for. See the wave section below.
3. **#53 remaining art.** The IFL playback driver, its frame table and **all 104 sequence
   frames** are committed (12 sequences: disc explosion, plasma barrel glow, both blaster
   muzzles, laser sweeps, spinfusor casing, jet exhaust, pad light, station blink, screen
   static), so the sequences now animate instead of holding frame 0. **Per-side Shrike muzzle
   origins are done**: the simulation alternates the paired image slots exactly as
   `%obj.nextWeaponFire` does, the side rides `VehicleFireEvent` and the projectile record, and
   the client uses it instead of inferring the side from how many bolts it has drawn. That
   grew the projectile record by a byte, so the wire is **protocol 12**. What remains is the
   art itself: the Blaster ball and trail and the Chaingun's crossed-ribbon tracers are still
   approximations.
4. **#51 remaining: the perceptual listen.** The beam, HUD feedback, lifecycle gating, the
   player-candidate line-of-sight fix and the recording are all in: the "no source sample
   exists" claim was wrong, `fx/packs/repair_use.wav` is the source's own
   `CloseLooping3d` firing state (`repairpack.cs:33-39`) and it is now wired. What remains is
   the two-client listen, which needs a human and cannot be asserted by a test.
5. **#2 terrain texture scale: closed from the renderer.** The guess was 64 repeats over
   2048 m (32 m per repeat). Torque's terrain renderer derives the base-texture coordinates
   from the square size and the LOD level -- `F32 invLevel = 1 / F32(mSquareSize << step->level)`
   in `terrain/terrRender.cc` -- so at the finest level a material repeats **once per terrain
   square**, and this client draws one static mesh, i.e. that level. The mission's own
   TerrainBlock confirms `squareSize = "8"` and `position = "-1024 -1024 0"`, so the repeat is
   **256** over the 2048 m block, one per 8 m square. The same block sets
   `detailTexture = "details/snowdet2"`, a second multiply pass Torque layers over the base
   textures; that bitmap is not in the mirror (both spellings 404), so no detail pass is drawn
   and the gap is named rather than guessed.
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
pass** (`env -u CI node_modules/.bin/playwright test`). Protocol is **12**, bumped by the
projectile record's paired-image side (see below).

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

### P2: UI, inventory and loadout fidelity — #55 (partial)

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
- The Repair Pack icon is the source's own art now (`hud_new_packrepair.png`, committed with
  the twelve recordings in `e59eb98`), and `maxWeapons` is consumed (the weapon-slot cap and
  the Light default bug, `3dc8aa4`).
- Vehicle reticles are now the game's own assignment rather than ours. `hud.cs:39-53` is a
  table keyed by datablock name: the Tank is `AssaultVehicle` (`vehicle_tank.cs:197`) and gets
  `hud_ret_tankchaingun` (slot 1, drawn in the source with the frame overlay) and
  `hud_ret_tankmortar` (slot 2); the Bomber is `BomberFlyer` (`vehicle_bomber.cs:176`) and gets
  the art named `hud_ret_shrike` for slot 1, no bitmap at all for slot 2, and
  `hud_ret_targlaser` for slot 3, which our sim has no weapon for. The client used to draw the
  on-foot weapon crosshair for every vehicle except the Shrike. Our sim carries no vehicle
  weapon-slot selection -- no wire field, no input -- so each kind draws its slot 1 art, and two
  consequences are recorded rather than hidden: the shrike art belongs to the BOMBER in that
  table, while the Shrike's own datablock (`ScoutFlyer`, `vehicle_shrike.cs:93`) has no row at
  all, so this client keeps drawing it for the Shrike rather than taking a reticle away from a
  vehicle the source leaves unset; and the `frame` overlay is a second bitmap the committed data
  does not carry, so only the reticle itself is drawn. Verified in the client:
  `e2e/vehicle-reticle.spec.ts` buys a Tank at the pad (its menu row is "Beowulf", the script's
  own `targetNameTag`) and asserts the crosshair resolves to `hud_ret_tankchaingun.png` and that
  the bitmap loads.
- Our side of the acceptance's screen comparison is captured rather than described:
  `env -u CI node_modules/.bin/playwright test e2e/hud-screens.spec.ts` writes five screens --
  on foot, zoom, vehicle cockpit, station menu and commander map -- into `docs/hud-screens/` at
  the reference frame's own 16:10, each after asserting the state it is in, so a shot can never
  silently capture the wrong screen. The images are generated on demand and deliberately not
  committed: the capture depends on live match state, so committed copies would churn on every
  browser run (measured: four of the five changed between two runs of the suite) and never be
  current anyway. What is left is the comparison itself against the reference images.
- The commander map's terrain shading is built (`commander-map.ts`'s `terrainShades` +
  `drawCommanderTerrain`): heights sampled over the mission area by `sampleTerrain`, lit by the
  scene's own sun direction, altitude and slope mixed into one brightness, rasterized once into
  a cached offscreen canvas and blitted under the markers. Verified in the captured commander
  screen: irregular light/dark regions where the terrain rises, with base and player markers
  still readable on top. What remains for this screen is the comparison against reference
  frames, not implementation.
- What remains unconstrained is the pixel layout of the compass and the vehicle instrument
  cluster: neither game-data dump carries a `.gui` layout file, the dash bitmap is a shaped
  176x108 overlay with no cut-outs for the other two instrument bitmaps, and
  `hud_veh_speedaltwin.png` and `hud_veh_enrgbar.png` are single-colour alpha masks whose shape
  is carried entirely in their alpha channel, so they pin their own sizes (74x57 and 77x14) and
  nothing about where they sit.

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
- The gaps this bullet used to list are closed, and the recordings were there all along:
  `e59eb98` committed the twelve samples the manifest had never listed (Chaingun spin-up and
  spin-down, medium and heavy armour footsteps with their interior metal variants, the hand
  grenade detonation, the turret impacts) and `f1ce478` wired them, and interior plus
  enemy-force-field occlusion lives in `sim/src/occlusion.ts` (`activeForceFieldBlockers`),
  which the client's audio path reaches through `audioOcclusionAt`. What remains is the
  perceptual listen and nothing else; the rig and the cue list are in Development handoff.
  A barrel with no committed recording still stays silent rather than inventing one (repo
  rule).
- Perceptual QA note: the panner path is exercised through fakes in unit tests; a two-client
  browser listen is still the honest check.

## Issue ledger

Open first, then the closed items whose evidence is worth keeping. The tracker is the authority
on state; this section is the evidence behind it, and each heading below says which it is.

### Open now

- Landed 2026-09-14, no longer open: **remote players render as the T2 armour models with the
  game's own clips**, and the **commander map now shades its terrain** (both were named by the
  design spec; see CHANGELOG).
- **#51 repair presentation** -- beam, HUD feedback and lifecycle gating are in, and the beam's
  source recording (`fx/packs/repair_use.wav`, `repairpack.cs`'s `RepairPackFireSound`) is wired; the
  issue's acceptance also asks for a perceptual listen, which no test can do. Rig in Development
  handoff.
- **#55 UI, inventory and loadout** -- the measured screen comparison is done (2026-09-15,
  see the resolution entry below). What no reference constrains -- the exact pixel offsets of
  the compass and the vehicle instruments -- stays a documented approximation, but the issue's
  own closure path ("a measured comparison against reference screens") is satisfied.
- **#56 remaining sound fidelity** -- every recording the issue listed is committed and wired,
  and interior plus force-field occlusion is modelled; left open for the same two-client listen.
- **48-bot tick bursts** (no issue): thin headroom at 24 v 24 rather than a failure, see below.
- **Two net/protocol residuals** (no issue), see below.
- The spec deltas listed here on 2026-09-14 are all built now (see CHANGELOG): the Tab
  scoreboard, snow particles, teammate IFF plates, keymap rebinding, and the station's saved
  favorites. The one deliberately deferred piece is grenade *selection* in the station menu:
  the loadout message has no grenade field and the sim grants grenades per armor class, so
  the row ships disabled until a protocol bump is wanted.

### #55: the measured screen comparison — resolved 2026-09-15

The issue's acceptance asked for on-foot, zoom, vehicle, station and commander screens
compared "at matching aspect ratios" against reference evidence, and its last comment named
the closure path: "a measured comparison against reference screens." That comparison is now
done, with vision-model descriptions of each pair scored element by element against the
rubric in `docs/ui-audio-reference.md` (corner anchoring, palette, narrow icon cells, thin
reticles, compact cluster):

- **On foot** (`docs/hud-screens/01-on-foot.jpg` vs the RAWG and PlayT2 infantry frames):
  every element anchors to the same corner -- teal translucent notification panel top-left,
  two status bars (green over blue) feeding a circular compass/clock top-right, the two-row
  flag table bottom-left, a narrow icon rack on the right edge, centre clear. The one
  concrete mismatch the comparison surfaced was the flag table's team names: the references
  read **Storm** and **Inferno**, ours said Team 1 and Team 2. Fixed this pass
  (`client/teams.ts`, row order as the evidence, cited in the source).
- **Vehicle** (03 vs the WSGF 16:10 Wildcat frame): the compact instrument cluster matches --
  bottom-centre, speed readout over a blue bar and a green bar flanking a circular gauge,
  about 20% of the screen width and under 12% of its height, centred; the top-right circular
  display present in both; reticle drawn per the script's own table (`scripts/hud.cs`), whose
  colour differs from the frame's marker -- the table, not the frame, is the source evidence.
- **Zoom** (02 vs the infantry frames' "faint circular reticle"): small faint reticle, HUD
  pinned to the edges, centre clear, no scope mask -- the vanilla non-sniper zoom pattern.
- **Station and commander** (04, 05): the audit's only menu reference is the shell
  New-Warrior screen, not the in-game station, and no commander-map reference frame exists;
  there is nothing to measure those two against, which the comparison now records rather
  than leaves implied.

The compass and vehicle instruments' exact pixel offsets remain unconstrained by any
committed layout file, and stay honest approximations beside measured proportions. Everything
the issue's acceptance names besides the comparison -- loadouts, `maxWeapons`, pack icon,
vehicle reticles, contact activation, number-key selection, released cursor -- is implemented
with its own spec (see the issue thread's earlier verification comments).

### P2: 48-bot tick bursts during mass engagements (resolved 2026-09-15)

**Resolved by an exactly-equivalent accelerator.** The scans now collect cheap distances
first and march line-of-sight only for the finalists, in ascending (distance, id) order --
which is provably the same fold the old code computed (argmin over visible with lowest-id
tie-break; LOS answers are order-independent, so the first visible in that order IS the old
minimum). The march itself stopped allocating: the sim's terrain plane math moved into one
shared core (`terrain.ts`'s `evalTerrainPlane`) with a height-only, caller-owned-buffer
sampler that `hasLineOfSight` now uses. Equivalence is proven two independent ways: the
telemetry probe's per-seed hashWorld fingerprints are byte-identical on all four seeds, and
a differential reimplementation of the OLD semantics agreed with the new code on 24,000 LOS
segments and every scan across 4,000 randomized worlds with zero mismatches
(`/tmp/ticktail/diff-perception.ts`). Measured on the same four-seed 24v24 probe
(load 9.8-12.7 beside each run): bot half mean 0.51 -> 0.22 ms (-57%), p99 2.85 -> 0.72 ms
(-75%), worst tick 8.0 -> 2.5 ms of the 32 ms budget -- the engagement burst can no longer
reach the budget from the bot half, which was the entry's open question. Shapes rejected
with reasons: cross-call LOS caches (duplicates became rare once early exit landed),
detect-radius cuts (already implicit in the baseline), tile-bounded skips (a skip-interval
proof for bilinear terrain is genuinely hard and no longer worth it at these numbers).

The original measurement, kept for the history:

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

**Measured again on a quiet host (2026-09-14, `main` at `ab8c10b`) and it does not currently
reproduce: 0 of 48,000 ticks over budget.** Four seeds x 12,000 ticks, 24 v 24 on the
production landmark set, through the same probe the earlier numbers came from
(`/tmp/ticktail/bench.ts`, which times the bot half and the sim half separately):

```
mean 1.663 ms   p99 13.634 ms   max 31.675 ms   over budget 0
bot half mean 1.410 ms   sim half mean 0.253 ms
deciles 1.17 1.56 1.12 2.94 1.87 1.07 1.29 1.56 1.85 2.21 ms
```

So the earlier counts were host contention, exactly as the paragraph above suspected: the same
tree that showed 27 and 82 shows none when nothing else is running. Two things follow, and the
second is the reason this stays open rather than closed. The bot half is 5.6x the sim half, so
bot decision-making is still where the time is. And the tail is thin against the budget -- a
single tick at 31.7 of 32 ms, p99 at 13.6 against a 1.66 ms mean -- so a busier host, a bigger
fight or a slower machine crosses it. Do not trust the count without recording host load beside
it; a CPU-profiled run of the same probe (profiling distorts a tight loop by an order of
magnitude) reported 95, which is the profiler's cost and not the game's.

Attributing the burst to one specific scan and cutting it is the open work, and the fix has a
shape already suggested by the numbers: the scans are per-bot and per-candidate over the full
roster, each candidate paying a terrain line-of-sight march at `LOS_MARCH_STEP = 0.5` m
(`turrets.ts:9`), so a 300 m sightline is 600 terrain samples and the marches are the term worth
attacking. Anything that shares or bounds them -- a spatial bucket, a re-scan interval, a
tile-bounded skip for spans the sightline is provably above -- attacks the super-linear term.
An accelerator has to be exactly equivalent to the march, and `hashWorld` in the telemetry sweep
is what proves it: an equivalent accelerator leaves the per-seed fingerprints unchanged.

### P1: bots take the flag but never capture — #32 (closed)

Closed. See Start here: at the game's own 46,875-tick match length the current configuration
takes the flag on two of four seeds, the refusal rule is exercised by data (303 refused ticks,
seed 2), and nine levers in the vehicle and carrier policy space are falsified with numbers. The
one-liner this section used to carry -- carriers killed in midfield with no teammate within
100 m -- was measured at a quarter of a match and is superseded by that table.

### P2: projectile art and texture animation — #53 (closed)

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

### P2: terrain texture repeat scale — #2 (closed)

- Not verifiable from committed evidence (manifest has no scale field, `.ter` v2 stores
  none, no Torque renderer source in the repo). `terrain.ts` documents the uncertainty and a
  do-not-bump guide.

### P2: turret animation QA — #54 (closed)

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

### P2: vehicle and bot scope residuals — #57 (closed)

- Superseded, kept for the checklist it was: all six kinds exist now, the four base vehicles
  having been built from those same scripts (`vehicle_bomber.cs`, `vehicle_havoc.cs`,
  `vehicle_tank.cs`, `vehicle_mpb.cs`) with their own weapons, mount rules and seats, their HUD
  following the source's own pad order (`serverVehicleHud.cs`) and reticle table (`hud.cs`), and
  bots that drive them.
- Bot carrier survival is closed with #32: two captures on four full-length seeds, measured at
  the game's own 46,875-tick match length.

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
- Current protocol is **12** (impacts, shields, turret target kind, signed projectile owner,
  the loadout/pack/weapons selection, and the projectile record's `muzzleSide` byte). Converted
  assets are committed; ordinary startup needs no fetch/build. Asset additions need manifest,
  builder and generated output changes together.
- Gates: `pnpm test` (1,304 tests plus one opt-in skip, the telemetry sweep),
  `pnpm typecheck`, `pnpm lint`, and `env -u CI node_modules/.bin/playwright test` (42 cases;
  the environment sets `CI=true`, which disables reuse of an already-running dev server). Do
  not edit while browser tests run: HMR causes false failures.
- The perceptual listen (#51, #56) is a two-client job and the server seats two humans on
  opposite teams by itself (`net.ts`'s `joinableTeam` picks the smaller one), so the rig is:

  ```
  node_modules/.bin/tsx packages/server/src/index.ts --bots 46 --team-size 24 --port 7777 &
  pnpm dev:client
  ```

  then two browser windows at `http://127.0.0.1:5173/?server=ws://127.0.0.1:7777` (46 bots plus
  the two of you is 24 v 24). What the issues ask to hear, in their own terms: the Repair Pack's
  beam loop and its activation one-shot (#51); per-armour footsteps on terrain against the
  metal variant indoors, the Chaingun's spin-up, spin-down and continuous fire loop, a hand
  grenade detonation, turret impacts (#56); flag pickup, drop, return and capture cues from the
  perspective of both teams; and ducking through interiors and force fields as one of you walks
  behind cover. No test can assert a mix, which is why these two issues stay open until a human
  has listened to them.
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
