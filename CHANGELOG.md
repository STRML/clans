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

#### Changed

- Carrier policies retuned on a four-seed ablation: the decision-layer hold-fire gate is
  removed (it cost 35 kills for zero arrivals) and the 600-tick staged wait becomes 100 ticks
  (it cost 53 kills and 7828 both-flags-carried ticks for eight saved carriers that never
  converted). Escort threat priority, the own-flag-out stand hold and thief recovery stay.
  Net effect against the previous revision: 69 kills to 121, carrier self-kills 2 to 0,
  both-flags-carried ticks 18199 to 16484 (#32).
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

#### Known gaps

Captures still do not happen: no carrier has reached the capture radius in any measured
configuration, so the capture-refusal rule remains untested by data (#32). The Wildcat's
third-person chase camera is deliberate code awaiting a product decision; the remaining four
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
from committed evidence (#2); the Wildcat dashboard and cockpit view does not exist, its
authoritative camera is a trailing chase camera (`client/src/app.ts` `placeVehicleCamera`).

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
