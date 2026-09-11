# Changelog

Notable changes to Clans, in the order they landed on `main`. This file is maintained with
the work: a wave of changes gets an entry under Unreleased before its final commit. Issue
numbers refer to <https://github.com/STRML/clans/issues>. This file records what changed;
`docs/ISSUES.md` records what is still wrong or missing.

The format follows [Keep a Changelog](https://keepachangelog.com). There are no releases or
version tags yet. The project versions its wire format instead (`PROTOCOL_VERSION`), so each
entry notes the protocol it shipped, because a bump requires the client and server to be
redeployed together.

## Unreleased

### 2026-09-11 — the four remaining vehicles, and an asset pipeline that builds from source

#### Added

- The four remaining Tribes 2 vehicles as full simulation kinds, each with its own source
  constants cited by script line: **Bomber** (`FlyingVehicleData(BomberFlyer)`, mass 350, 400
  energy, 85 m/s forward cutoff, camera 22/5/1.0), **Havoc** (`HAPCFlyer`, mass 550, 550
  energy, 71 m/s, camera 17/2/8.5), **Tank** (`HoverVehicleData(AssaultVehicle)`, mass 1500,
  floating gravity 4.5, gyro 400, camera 20/3/1.5) and **Mobile Point Base**
  (`WheeledVehicleData(MobileBaseVehicle)`, mass 2000, `maxWheelSpeed` 20, `cantAbandon`),
  with their own models and skins. The physics went from two hardcoded kinds to three classes
  (`stepFlyer`, `stepHover`, and a new `stepWheeled`) with the Shrike and Wildcat proven
  bit-identical across a 900-tick differential before and after. Their weapons, mounted
  turrets, passenger seats and the MPB's deployment are not in yet and are named as such
  (#57).
- A Tribes 2 `.dts` shape reader (`packages/assets/src/dts.ts`) written from the Torque
  engine's stream code with a citation per field group, emitting GLB with the node hierarchy,
  names, transforms and bounds the shipped files had. It reproduces the cached reference
  Wildcat exactly on bounds and triangle count, and it is what builds the four new vehicle
  models from their original sources. Its sequence reading is complete and its animation
  emission is written but not enabled, with the parity table and the three known deviations
  recorded in the function's own doc comment (#57).
- The twelve original recordings whose absence the audio gaps were blamed on: the repair
  beam's own `CloseLooping3d` firing state, its activate one-shot, the chaingun's activate /
  spin-up / spin-down, the hand grenade's detonation, both turret impacts, and the medium and
  heavy armour footstep sets, each mapped from the T2 profile that names it rather than by
  filename (#51, #56).
- All 104 IFL sequence frames across twelve sequences, so the texture sequences animate
  instead of holding frame 0 (#53).
- Per-team seat cap (`--team-size`) and a match clock (`--time-limit`), plus an intermission
  (`--intermission`), so a 24-versus-24 match can be seated and a match can end and be
  replaced without restarting the process (#31, #57).
- A 24-versus-24 case in the bot acceptance harness, which until now measured 8-versus-8
  while the project targets 24-versus-24, and a `hashWorld` fingerprint on the telemetry path
  so a table can be attributed to one world state (#32).

#### Changed

- `MAX_SNAPSHOT_BOTS` is the roster capacity (64) rather than 32, which is what a 48-bot
  match needs: the match used to throw `RangeError: Snapshot bot count exceeds 32` on its
  first snapshot. The count is a u8 on the wire, so no bytes and no protocol bump changed.
- Spawns are seated apart and respawn waves rotate. Twenty-four bots per team on Katakatic's
  two spawn spheres landed 0.05 m apart with 57 pairs inside a capsule's diameter, and a full
  team derived a constant respawn index, so every wave reused one point; the minimum
  same-team distance is now 1.66 m with zero overlapping pairs, and consecutive waves land
  516 m apart.
- The bot stall detector measures net progress toward the goal instead of the absolute change
  in distance to it, which had let a carrier hold one waypoint for 3,020 ticks without
  tripping a single escape. Carrier stall share fell from 59% to 43% at the same match size
  (#32).
- The armour weapon-slot cap is enforced where a client cannot lie about it, and the client
  now refuses the tick that would exceed it rather than letting the simulation silently drop
  the weapon (#55).
- Turret collision uses a shape measured from the source models -- a pedestal cylinder, a
  head cylinder and a barrel capsule read out of the GLB node bounds -- instead of one
  conservative sphere that was 73% phantom volume on the large turret and mis-scored a barrel
  hit by 1.83 m (#54).
- Player repair candidates honour terrain and interior line of sight, which base objects and
  turrets already did (#51).

#### Fixed

- Light armour's default loadout granted four weapons against its own cap of three, because
  the target laser is allowed but must not count against the slot count; defaults are clamped
  to the armour, and the legacy no-station spawn table is clipped the same way (#55).
- The HUD rack's end-to-end expectation was a hand copy of the armour table, so it disagreed
  with the client the moment the slot cap landed; it now derives from the simulation's own
  helper and asserts the visible slot count equals the armour's.

### 2026-09-11 — the regenerated shapes are back in the basis the shipped ones used

#### Fixed

- `dtsToGlb` writes the Torque-to-glTF basis (`(-x, z, y)`, a half turn about the (0, 1, 1)
  diagonal) that every `.glb` this repository has ever published used, as one node wrapping
  the shape's roots, and `parseDts` publishes the conjugate of each stored node rotation --
  the rotation the engine actually applies, because `QuatF::setMatrix` (`m_quatF_set_matF_C`)
  builds the transpose of the standard rotation matrix. Reading the shapes without either left
  all 21 of them lying on their side and put every non-180-degree node in the wrong place: the
  Shrike's nose-to-heading alignment in `e2e/shrike-spawn.spec.ts` read 0.0054 against the
  >0.98 a correct basis gives, and the vehicle pad's `Mount0` attachment moved 8-10 m, taking
  the spawned station's `usePosition` with it. With both, every shape that has a shipped
  counterpart matches it vertex for vertex (100% of its vertices within 0.02, mean nearest
  5e-5, Draco quantization), all 22 converted shapes carry exactly their `.dts` source's
  triangle count, and `assets/out/katabatic/scene.json` returns to its committed values to
  within 8e-6 m of float32 noise in one coordinate (no protocol change).

### 2026-09-11 — a match cycle: an ended match starts the next one

#### Added

- A match cycle. `sim`'s `resetMatch` (packages/sim/src/match.ts) returns a loaded world to
  its as-loaded state -- clock, outcome, team scores, every player's row, flags, base assets,
  turrets, vehicles, projectiles, and the one-tick event queues -- written as a table of named
  slices, so the reset's implementation and its documented list of responsibilities cannot
  drift apart. The server drives it: when the sim freezes at game over the final state stays
  up for an intermission (`--intermission`, seconds, default 5 -- the stock Torque
  `$Game::EndGamePause`), and then the next match begins on the same map in the same process,
  with the bots stepping again. `--time-limit` (seconds, default the sim's own 25 minutes) sets
  the clock. The reset is sim state, so it is predictable and hashable like every other
  transition: `hashWorld` after a reset equals a freshly created world's at the same tick. No
  new message: the reset reaches clients on the existing snapshot path, as a forced full send,
  and the kill feed clears on the snapshot that reports `gameOver` false again (protocol 11).

### 2026-09-11 — measurement wave on bot captures, Wildcat fixes

#### Added

- Carrier telemetry and a real seed dimension for the bot acceptance harness. Bot matches now
  derive their RNG from the world seed (a hardcoded `0` had made "seeds 1/2/3" the same match
  three times), and `BOT_TELEMETRY=1` prints per-run and per-match carrier data: end reason,
  the killer and its relation, nearby enemies and teammates at the death, closest approach to
  the carrier's own stand, ticks inside the capture radius with the own flag home or out, and
  both-flags-carried ticks. The three existing acceptance thresholds are unchanged (#32).
- Terrain-profile route chains: a long waypoint-graph edge can now follow a graded line across
  the terrain instead of cutting straight over a crest, within a documented length budget.
  The enemy-turret avoidance it was meant to enable is measured to be infeasible on Katabatic,
  and that measurement is recorded at the constant (#32).
- A configurable per-team seat cap: `--team-size` (default 16, the spec's own "16 versus 16")
  raises the cap that both bot seating and the human-join gate read, so `--bots 48
  --team-size 24` seats the 24-versus-24 target match. Omitting the flag leaves every
  existing invocation's seating unchanged, including the startup warning above 32 bots; the
  team-full Welcome refusal (issue #31) now follows whatever cap the match runs (#31,
  protocol 11).
- The original recordings issues #51 and #56 recorded as missing: the Repair Pack's beam loop
  and its Activate one-shot (#51), and the Chaingun's Activate, Spinup and Spindown state
  sounds, the hand grenade's own detonation, the sentry and plasma turret impact samples, and
  the medium and heavy armour footstep sets (#56). Every entry in the audio manifest cites the
  datablock and `stateSound` index it was taken from. The files were in the t2-mapper volume
  the manifest already fetches from; they had simply never been listed, so the beam and every
  turret bolt were mute (#51, #56).

#### Changed

- Cue selection follows those recordings. The repair beam loops and the pack's Activate
  one-shot fire independently (#51); the Chaingun plays Activate/Spinup/Spindown off the sim's
  own weapon state; a hand grenade detonates with `fx/weapons/grenade_explode` rather than the
  mortar's explosion; turret bolts resolve through their barrel script's own recording; and the
  medium and heavy footstep rows resolve to their armour's `soft` (terrain) and `metal`
  (interior) takes. Light armour's recordings are unchanged (#56).

- Carrier policies retuned on a four-seed ablation: the decision-layer hold-fire gate is
  removed (it cost 35 kills for zero arrivals) and the 600-tick staged wait becomes 100 ticks
  (it cost 53 kills and 7828 both-flags-carried ticks for eight saved carriers that never
  converted). Escort threat priority, the own-flag-out stand hold and thief recovery stay.
  Net effect against the previous revision: 69 kills to 121, carrier self-kills 2 to 0,
  both-flags-carried ticks 18199 to 16484 (#32).
- The Wildcat's camera is T2's own. It rests on the model's authored `Eye` node, which is the
  source game's default view (`GameConnection::mFirstPerson` is true), and `X` slides it to
  the datablock's chase end and back at the engine's own traversal speed: Wildcat 5.0 m behind
  and 0.7 m up, Shrike 15 / 2.5, with the trailing end keeping the `cameraLag` smoothing
  (#57).
- The Wildcat's steering controller is critically damped, with the plan's own steering
  constant restored. A held 90-degree input previously overshot by 77 degrees and then
  limit-cycled 65 degrees under it forever; it now closes 90% in 1.47 s with zero overshoot,
  which is what the "handles awkwardly" report was. Parked hover amplitude is 0.000 m.

#### Fixed

- The Wildcat no longer spawns inside its vehicle pad. The pad's deck top sits 2.3 m above the
  pad's own origin, so the old spawn started 0.30 m inside the deck mesh and the hover spring
  dragged the craft down through it. The spawn probes the deck and starts at hover rest
  height, and the hover spring now reads interior decks as well as terrain, since terrain
  alone can never hold a hover vehicle on a pad.
- The station picker, the HUD rack and the never-visited-station spawn table now agree with the
  armor weapon-slot cap the sim enforces. The picker refuses a pick past the armor's own
  `maxWeapons` slots (Light's fourth weapon, previously ticked and then silently dropped on
  Confirm) and shows the slot count as full; the menu and the rack expand the mask-0 "no
  station visit" state to the same clamped default the sim grants; and that legacy spawn table
  is capped too, so a Light spawns on three usable weapons (Spinfusor, Chaingun, Laser Rifle)
  instead of four -- the surplus Blaster is 0-ammo and no longer the spawn slot, while the
  table's infinite Laser Rifle and Medium/Heavy's own sets are unchanged (#55).
- Turret collision now follows the measured assembly instead of one conservative sphere
  (#54). The pedestal is a cylinder at `turret_base_large.glb`'s BaseMain circumscribed
  radius (2.3543 m) up to the base's 1.3260 m post caps; the head is a second cylinder at the
  Arms/Sleeve's measured 1.3130 m radius up to the intact 2.2179 m top; and the barrel is a
  capsule from the mount socket out to its own Muzzlepoint (radius 0.4363 m). Direct hits,
  splash falloff, repair selection and bot threat targeting all read that one shape. The
  sphere this replaces reached y 3.30 -- 1.08 m above anything the model draws -- so it stopped
  shots that passed over the turret, while stopping short of the 2.3543 m base corners it
  should have covered; 44.4% of the new shape's volume lies outside the model's own bounds,
  against the sphere's 73.1%. Sentry turrets collapse to one measured cylinder (r 0.629),
  exact in every yaw. Protocol stays 11. The residuals that remain (the 2.7385 m wing tips,
  and a yawed or elevated mount leaving the barrel capsule) are recorded in `docs/ISSUES.md`.

#### Known gaps

Captures still do not happen: no carrier has reached the capture radius in any measured
configuration, so the capture-refusal rule remains untested by data (#32). The remaining four
T2 vehicles (Bomber, Havoc, Tank, Mobile Point Base) are unbuilt. Details in `docs/ISSUES.md`.

### 2026-09-10 — capture work, vehicle scope, loadouts, audio (protocol 8 to 11)

#### Added

- Authoritative projectile impacts: the sim resolves every projectile end (direct, bounce,
  timeout, world) into a sequence-numbered record, the server broadcasts them, and client
  effects are driven by those records instead of diffing projectile arrays. Protocol 9 to
  10 (#52).
- Full station loadout system: armor, pack and weapon selection with a sanitized carried
  mask, the Energy Pack's recharge, and a networked pack and weapon rack on the HUD.
  Protocol 10 to 11 (#55).
- Spatial audio: equal-power panner routing, a per-frame listener orientation, terrain
  occlusion ducking, armor and surface footstep cues, and loop lifecycle on destruction,
  death, disconnect, power loss and menu transitions (#56).
- Snapshot relevance filtering: players beyond 400 m refresh every fourth snapshot, far
  projectiles and hidden interior objects are omitted, force fields stay. Measured with the
  real encoder on a 31-player distant roster: 1035 to 74 bytes on sparse ticks (#5).
- Interior-aware occlusion for hitscan, turret acquisition and lag compensation, as a
  separate module from the terrain-only line of sight (#21, #49).
- Vehicle-player collision with a two-body shove and closing-speed damage, AA seeker flight
  behavior, and vehicle kill scoring with last-damager attribution (#57).
- A debug readout for network time scaling and a team-full join refusal (byte-compatible,
  no protocol bump) (#7, #31).
- Playwright coverage for turret presentation, plus a 1.6 s to 0.2 s speedup of the spawn
  walk test (#58).

#### Changed

- Movement and armor constants anchored to the leaked T2/V12 engine source where they had
  been guessed: Heavy `jumpSurfaceAngle` 80 to 75, `speedDamageScale` 0.004 to 0.006, with
  the issue's force-based resistance hypothesis disproven and the reasons recorded in code
  (#3).
- Two-sided lag compensation: a live hit that misses in the rewound view is now rejected and
  its damage, kill, score and flag effects are reverted (#10).
- Turret aim limits derive from the mount, and presentation advances in simulated seconds so
  a paused match freezes (#54).
- Bots route on the production Katabatic landmark graph, with clearance-validated edges,
  stepping stones, local avoidance, under-deck pocket escape and fall arrest (#32).
- Vehicle slots survive id reuse and interpolate across recycled ids (#26, #27).

#### Fixed

- Repair: destroyed base objects and stations rebuild from a repair pack, with beam and HUD
  feedback (#50, #51).
- Occlusion and snapshot codec round trips, including shield energy and several malformed
  snapshot rejections (#14, #24, #15, #16, #25, #13).
- A parked vehicle no longer shoves a player standing at its center: the contact rule belongs
  to the vehicle's own swept motion (#57).
- An open station menu no longer re-prefills under the player's click, a bug that silently
  reset a loadout choice every frame (#55).

#### Known gaps

Deliberately not done, with reasons, in `docs/ISSUES.md`: captures still do not land (#32);
IFL texture-sequence frames beyond frame 0 are not committed (#53); the repair beam is silent
because no original sample exists (#51); the terrain texture repeat scale is not verifiable
from committed evidence (#2); the Wildcat's dashboard and cockpit view did not exist yet, its
camera then a trailing chase camera (`client/src/app.ts` `placeVehicleCamera`) — both landed
the next day (see 2026-09-11 above).

### 2026-09-09 — bug waves (protocol 8)

#### Added

- Occlusion-aware line of sight for projectiles, turrets and lag compensation (#21, #49).
- Protocol hardening: shields round-trip, turret target kind, signed projectile owners,
  snapshot count guards, decoded vehicle kind validation, and expanded determinism hash
  coverage (#14, #24, #15, #16, #25, #13).
- Bot navigation on the production Katabatic graph, with obstacle validation and a recovery
  ladder (#32).
- Repair packs rebuilding base assets, with a client repair beam (#50, #51).
- IFL texture-sequence playback for disc and muzzle art, and the source disc plate
  proportions (#53).
- Terrain scale uncertainty documented rather than guessed (#2).

#### Fixed

- Vehicle slot lifetime and interpolation across recycled ids (#26, #27).
- Turret aim limits and presentation timing, so a paused match freezes (#54).
- The unrenderable STL asset tier removed rather than converted (#29).

## 2026-09-07 — M7: command circuit, audio, voice binds, polish (#35)

Command circuit with the commander map, sensor coverage and bot orders; audio and voice
binds; visual polish; the Playwright suite and the GitHub Pages demo.

## 2026-09-07 — M6: bots (#30)

Bot brains: objectives, navigation, combat and vehicle claiming, on the authoritative server
with the same input path a human client uses.

## 2026-09-07 — M5: Shrike and Wildcat vehicles (#23)

Vehicle pads and the station-like spawn menu, mount and dismount, Shrike flight physics and
its blaster, Wildcat hover physics, vehicle shields, collision damage and ejection. Every
number cites `vehicle_shrike.cs` / `vehicle_wildcat.cs` or is marked ours in the plan's
numbers table.

## 2026-09-06 — M4: base assets and power (#11)

Generators and power, inventory stations, base turrets (plasma and AA barrels), sentry
turrets, the large pulse sensor, force fields, and repair.

## 2026-09-06 — M3: weapons, damage, CTF, HUD (#9)

Spinfusor, Chaingun, Mortar, Laser Rifle, Blaster and grenades with the real projectile
types; damage, armor classes and death; CTF with flags, scoring and the match clock; the
original HUD artwork.

## 2026-09-05 — M2: authoritative server, client prediction, interpolation (#4)

The authoritative Node server and the client's prediction and interpolation of remote
entities.

## 2026-09-05 — M1: Katabatic terrain, Light armor skiing and jetting (#1)

Real Katabatic terrain and interiors, Light armor movement: skiing, jetting, jumping and
collision. Plus the debug overlay that made the rest measurable.

## 2026-09-05 — Design spec committed

`docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md`: the scope, the
numbers tables and the fidelity bar every milestone is held to.
