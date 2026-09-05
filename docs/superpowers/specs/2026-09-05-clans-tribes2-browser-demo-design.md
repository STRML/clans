# Clans: a Tribes 2 tech demo for the browser

Status: draft for review, 2026-09-05.

## What we are building

A browser game that plays like Tribes 2 (T2) on Katabatic: skiing, jetpacks, three armor
classes, Spinfusor, Chaingun, Mortar, Laser Rifle, the Wildcat and the Shrike, and a
working base (generators, inventory stations, turrets, sensors, command circuit). Capture
the Flag, 16 versus 16, every seat except yours filled by a bot. An authoritative Node
server runs the match so a hosted multiplayer server later is a deployment step, not a
rewrite.

The demo shows what a browser can do in 2026: a full 2 km outdoor map at 60 fps with 32
players, real netcode with prediction, and a debug mode that exposes everything.

Repo: `github.com/STRML/clans`, public.

### In scope

- Katabatic, rebuilt from the original heightmap, object placements, and building
  geometry.
- Light, Medium, and Heavy armor with T2 movement numbers.
- Skiing, jetting, jumping, fall damage.
- Spinfusor, Chaingun, Mortar, Laser Rifle, Blaster (default fallback), hand grenades.
- Packs: Energy, Repair, Shield, deployable Turret, deployable Sensor.
- Wildcat grav cycle, Shrike fighter, vehicle pad spawning.
- Base assets: generators and power, inventory stations, base turrets (AA and Plasma
  barrels), sentry turrets, large pulse sensor, force fields, repair.
- Command circuit (commander map) with sensor coverage and bot orders.
- CTF rules and scoring as in T2.
- Bots for both teams driven by the map's own objective markers.
- Client and server split with client prediction and snapshot interpolation.
- Audio: synthesized effects, CC0 samples where needed, text-to-speech voice binds.
- T2-style HUD, chat, voice bind menu, scoreboard, loadout menu.
- Debug mode and an automated test suite.

### Out of scope for v1

- Other maps, other game modes, the remaining weapons (Grenade Launcher, Plasma, ELF,
  Shocklance, Missile Launcher), cloak and satchel packs, the other vehicles.
- Accounts, matchmaking, a public server, voice chat, mobile input.
- Skeletal animation authoring. We use the animations that ship with the T2 models.

## Source material

Every gameplay number in this document comes from the T2 base scripts, read in this
session. No number is a guess. Where a value is an engine default that the scripts do not
state, the text says so.

| Source | What it gives us | Where |
|---|---|---|
| `jdknight/t2ds` on GitHub | T2 base scripts: `player.cs`, `disc.cs`, `chaingun.cs`, `mortar.cs`, `sniperRifle.cs`, `grenade.cs`, `vehicle_shrike.cs`, `vehicle_wildcat.cs`, `turret.cs`, `staticShape.cs`, `CTFGame.cs` | `GameData/base/scripts/` |
| `exogen/t2-mapper` on GitHub | Mirror of the T2 data files: `Katabatic.mis`, `Katabatic.ter`, every interior as `.dif` and converted `.glb`, every shape as `.dts` and converted `.glb` (skinned, animated), textures | `docs/base/@vl2/` |
| `files.nastyhobbit.org/t2-models/stl-files` | STL exports of the Dynamix source models, used only where no converted glb exists | 18 files |

`t2-mapper` has no license file. We use its converted data files, which are derivative
of Sierra's freeware game data, and we do not copy its source code. Our loaders are our
own. The data itself is Sierra's 2004 freeware release; this is a non-commercial fan
project and the README says so.

### Armor numbers from `player.cs`

| | Light | Medium | Heavy |
|---|---|---|---|
| mass (kg) | 90 | 130 | 180 |
| maxDamage (health) | 0.66 | 1.1 | 1.32 |
| maxEnergy | 60 | 80 | 110 |
| rechargeRate (per tick) | 0.256 | 0.256 | 0.256 |
| jetForce (N) | 26.21 × mass | 25.22 × mass | 22.47 × mass |
| jetEnergyDrain (per tick) | 0.8 | 1.0 | 1.1 |
| runForce (N) | 55.20 × mass | 46 × mass | 40.25 × mass |
| maxForwardSpeed (m/s) | 15 | 12 | 7 |
| maxBackward / maxSide (m/s) | 13 / 13 | 10 / 10 | 5 / 5 |
| jumpForce (N) | 8.3 × mass | 8.3 × mass | 8.3 × mass |
| minJumpSpeed / maxJumpSpeed | 20 / 30 | 15 / 25 | 20 / 30 |
| horizMaxSpeed (m/s) | 68 | 60 | 52 |
| horizResistSpeed / Factor | 33 / 0.35 | 28 / 0.32 | 23 / 0.29 |
| upMaxSpeed (m/s) | 80 | 70 | 60 |
| upResistSpeed / Factor | 25 / 0.3 | 30 / 0.23 | 35 / 0.18 |
| drag | 0.275 | 0.3 | 0.33 |
| boundingBox (m) | 1.2 × 1.2 × 2.3 | 1.45 × 1.45 × 2.4 | 1.63 × 1.63 × 2.6 |
| maxWeapons | 3 | 4 | 5 |
| Laser Rifle allowed | yes | no | no |
| Mortar allowed | no | no | yes |
| Disc ammo / Chaingun ammo / Mortar ammo | 15 / 100 / 0 | 15 / 150 / 0 | 15 / 200 / 10 |
| grenades | 5 | 6 | 8 |
| repairRate (Repair Pack, per tick) | 0.0033 | 0.0033 | 0.0033 |

Gravity is 20 m/s² downward, the Torque engine default (not stated in the scripts).
runSurfaceAngle is 70°, jumpSurfaceAngle 80°, speedDamageScale 0.004 for all armors.

### Weapon numbers

| Weapon | Projectile | Speed (m/s) | Damage | Radius (m) | Kickback | Fire / reload (s) | Notes |
|---|---|---|---|---|---|---|---|
| Spinfusor | LinearProjectile `DiscProjectile` | 90, velInherit 0.5 | 0 direct, 0.5 radius | 7.5 | 1750 | 1.25 fire, 0.5 reload | lifetime 5 s |
| Chaingun | TracerProjectile `ChaingunBullet` | 425, velInherit 1.0 | 0.0825 direct | 0 | 0 | 0.15 per shot, 0.5 spin-up, 1.0 spin-down | lifetime 3 s, client-side hits in T2 (`doDynamicClientHits`) |
| Mortar | GrenadeProjectile `MortarShot` | 63.7 muzzle, velInherit 0.5, drag 0.1 | 0 direct, 1.0 radius | 20 | 2500 | 0.8 fire, 2.0 reload | arms after 2 s, elasticity 0.15 |
| Laser Rifle | hitscan `BasicSniperShot` | instant, 1000 m max | 0.4 direct scaled by energy, ×1.3 head | 0 | 0 | 0.5 fire, 0.5 reload | uses energy, minEnergy 6 |
| Hand grenade | GrenadeProjectile | thrown | 0.4 radius | see `grenade.cs` | | | |

Vehicle blaster (Shrike): 0.125 direct damage, 425 m/s.

### Vehicle numbers

| | Shrike | Wildcat |
|---|---|---|
| mass (kg) | 150 | 400 |
| maxDamage | 1.40 | 0.60 |
| shielded, energy | yes, 280 (160 energy per damage point) | yes, 150 (75 per point) |
| rechargeRate | 0.8 | 0.7 |
| afterburner / boost | jetForce 2000, drain 2.8, minJetEnergy 28 | drain 1.3, minJetEnergy 15 |
| control forces | maneuveringForce 3000, steeringForce 1200, rollForce 4, horizontalSurfaceForce 6, vertThrustMultiple 3, minDrag 30, maxAutoSpeed 15 | steeringForce 30, rollForce 15, pitchForce 7, normalForce 30, restorativeForce 20, gyroDrag 16, dragForce 25/45, floatingGravMag 3.5, floatingThrustFactor 0.35 |
| hover height (m) | 5 (3 at spawn) | engine default |
| collision damage | threshold 23 m/s, ×0.02 | threshold 23 m/s, ×0.03 |
| seats | 1, Light or Medium | 1, Light or Medium |

### Base asset numbers

| Asset | maxDamage | Notes |
|---|---|---|
| GeneratorLarge | 1.50 | energyPerDamagePoint 30, powers the base |
| SensorLargePulse | 1.50 | detectRadius 300 m, line of sight, energyPerDamagePoint 33 |
| TurretBaseLarge | 2.25 | shielded, energyPerDamagePoint 50, sensor 80 m, elevation 15° to 140°, needs power |
| PlasmaBarrelLarge | | 0.5 radius damage at 10 m, 50 m/s, kickback 500, 0.3 s fire, 0.8 s reload |
| AABarrelLarge | | targets vehicles, numbers from `aaBarrelLarge.cs` at implementation time |
| SentryTurret | 1.2 | 0.1 direct at 200 m/s, 0.13 s fire, 0.40 s reload |
| StationInventory | from `station.cs` | needs power, full heal and reload plus loadout swap |
| StationVehiclePad | from `station.cs` | needs power, spawns one vehicle at a time |
| ForceFieldBare | | team-passable |

### CTF numbers from `CTFGame.cs`

- Score limit: 8 captures (`CTF_scoreLimit` in the mission), 100 team points per capture.
- Flag return delay: 45 s after a drop, with a 2 s fade.
- Player points: kill +10, flag capture +30, flag touch +20, suicide −10, team kill −10.
- Capture requires your own flag at its stand.

### Katabatic from `Katabatic.mis` and `Katabatic.ter`

- Terrain: 256 × 256 grid, 8 m squares (2048 m across), 16-bit heights divided by 32,
  range 50 m to 275 m. Torque splits each square on an alternating diagonal
  (`(x ^ y) & 1`), and our collision uses the same split so it matches the render.
- Mission area: −896, −696 to +608, +696. Visible distance 500 m. Snow precipitation.
  Sun direction (0.577, 0.577, −0.577), colour 0.7 grey.
- Team 1 base is centered near (330, −180); team 2 near (−580, 380). Each base has: two
  generators, nine inventory stations, one vehicle pad (`svpad.dif`), a large pulse sensor
  on the forward tower (`stowr4.dif`) with a sentry turret and two inventory stations, a
  main tower (`stowr6.dif`), a bunker (`sbunk2.dif`), a plasma base turret and an AA base
  turret, an exterior flag stand, force fields, repair packs, and pickup items.
- Rocks and spires (`srock6/7/8.dif`, `sspir2/3/4.dif`) and 62 `stackable*.dts` crates.
- 106 `AIObjective` markers and 4 spawn spheres, reused by the bots.

All positions, rotations (axis-angle), and scales are read from the file at build time,
converted from Torque Z-up to Three Y-up once, and written to a JSON scene file.

## Architecture

A pnpm monorepo. TypeScript everywhere. Vite builds the client, tsx runs the server.

```
packages/
  sim/        Pure TypeScript game simulation. No DOM, no Three.js, no Node APIs.
              Runs the same code on the server and inside the client for prediction.
  protocol/   Wire format: message schemas, binary snapshot encode/decode, delta
              compression. Depends on sim types only.
  server/     Node. Owns the authoritative sim, ticks it, runs bots, accepts
              WebSocket clients, sends snapshots. `clans-server --bots 31 --map katabatic`.
  client/     Three.js renderer, input, HUD, audio, prediction and interpolation,
              debug overlay. Connects to a server URL. Vite app.
  bots/       Bot brains. Pure TypeScript over the sim API; the server hosts them.
  assets/     Build-time pipeline: fetch sources, convert, write to assets/out/.
apps/
  demo/       Static site wrapper for GitHub Pages that boots the client against a
              server URL from the query string.
```

Coordinate system: Y-up metres everywhere in `sim`, `client`, and the JSON scene. The
asset pipeline is the only place that knows about Torque Z-up.

### Simulation (`packages/sim`)

- Fixed tick of 32 ms, the T2 tick. All per-tick numbers above are applied per tick.
- Entities in flat typed arrays keyed by entity id: players, projectiles, vehicles,
  base assets, flags, items, deployables. No class hierarchy for entity data. Systems are
  plain functions over the world state: `stepPlayers`, `stepProjectiles`, `stepVehicles`,
  `stepTurrets`, `stepPower`, `stepFlags`, `stepDamage`.
- The world state is a plain object that can be cloned, serialized, diffed, and hashed.
  That is what makes prediction, snapshots, replay, and tests cheap.
- Deterministic given the same inputs and seed. A seeded PRNG for spread and bot
  decisions. No wall-clock reads inside the sim.
- Collision: heightfield lookup for terrain, per-interior triangle meshes with a BVH for
  buildings, capsules for players, oriented boxes for vehicles, rays and swept spheres
  for projectiles. Interiors are static so the BVH is built once at load.

#### Movement

The T2 model, applied per tick:

1. On the ground, if the player is not holding jump, apply `runForce` toward the move
   direction, capped at the armor's max speeds, and apply ground friction.
2. On the ground with jump held (skiing): no friction, no run force above run speed,
   gravity and slope decide the rest. The `jumpForce` impulse fires once on the ground
   contact edge, not while held.
3. Jetting: apply `jetForce` upward while energy is above `minJetEnergy`, drain
   `jetEnergyDrain` per tick. No air run force. Recharge `rechargeRate` per tick when not
   jetting (Energy Pack doubles the recharge).
4. Velocity resistance: above `horizResistSpeed`, scale horizontal velocity by
   `1 − horizResistFactor × dt`, hard cap at `horizMaxSpeed`. Same for vertical with the
   `up*` numbers.
5. Fall damage: landing speed above `minJumpSpeed` scales by `speedDamageScale`.
6. Surface angle: above `runSurfaceAngle` (70°) the player slides; above
   `jumpSurfaceAngle` (80°) the jump impulse is refused.

#### Weapons and damage

- Each weapon is a small state machine copied from its datablock (Activate, Ready, Fire,
  Reload, NoAmmo, DryFire) with the timeouts above.
- Projectile types: linear (Spinfusor, Blaster, turret plasma, sentry), tracer (Chaingun,
  Shrike blaster), grenade (Mortar, hand grenade, with arming delay and bounce), hitscan
  (Laser Rifle).
- Radius damage falls off linearly from full at the center to zero at `damageRadius`.
  Kickback applies an impulse along the blast direction scaled by the same falloff.
  This is what makes disc jumping and mortar knockback work.
- Health is `maxDamage`; damage subtracts; shields (Shield Pack, vehicles, base turrets)
  spend energy at `energyPerDamagePoint` before health.
- Power: a base is powered while at least one of its generators is alive. Unpowered
  inventory stations, vehicle pads, base turrets, sensors, and force fields go offline.
  Repair Pack fires a repair beam that adds `repairRate` per tick to any damaged asset,
  vehicle, or player.

#### Vehicles

- Shrike: a flyer. Thrust along its heading, lift from `horizontalSurfaceForce`, mouse
  pitch and yaw through `steeringForce`, auto-roll, auto-stabilize below `maxAutoSpeed`,
  afterburner from energy. Collision damage above the threshold speed.
- Wildcat: a hover bike. Rides at hover height on a spring (`normalForce`,
  `restorativeForce`) with gyro damping, boost from energy, steering that leans the bike.
- Mount rules: Light and Medium only. A player mounts by using the vehicle within 3 m;
  the pilot's weapons are replaced by the vehicle's (Shrike blaster, Wildcat none).
- Vehicle pad: one active vehicle per pad; spawning a second destroys the first.

#### CTF and flags

States: `home`, `carried`, `dropped`. Touch the enemy flag to carry it. Die and it drops
where you died. Touch your own dropped flag to return it. Bring the enemy flag to your
stand while your flag is home to capture. Dropped flags return after 45 s. Match ends at
8 captures or at a configurable time limit (our default: 25 minutes; T2's value is not
verified), whichever comes first.

### Networking (`packages/protocol`, `server`, `client`)

- Transport is an interface with one method to send and one callback to receive.
  WebSocket implementation now, in both Node and the browser. WebRTC DataChannel later
  without touching the sim or the protocol.
- Server tick 32 ms. Snapshot send rate 1 in 2 ticks (about 15 Hz) per client, delta
  compressed against the last snapshot that client acknowledged. Binary, not JSON.
- Client sends an input packet every tick: move vector, look angles, buttons, sequence
  number. Inputs are redundantly sent for the last 3 ticks so a lost packet does not
  stall.
- Client prediction: the client runs `sim` for its own player and its own projectiles
  from the last acknowledged server state forward through unacknowledged inputs. When
  a snapshot arrives the client rewinds to it and replays. A mispredict above a small
  threshold snaps with a short visual smoothing.
- Other entities interpolate 100 ms behind the newest snapshot, extrapolate up to
  50 ms when snapshots are late.
- Hit detection is server side. For the Chaingun and Laser Rifle the server rewinds
  player positions to the shooter's view time (lag compensation, capped at 200 ms). For
  projectiles the server spawns them at the shooter's reported tick.
- Relevance: a client receives full updates for entities within 400 m, low-rate
  updates for the rest, and no updates for hidden interior items far away.

### Bots (`packages/bots`)

- Live on the server. Each bot produces the same input packet a human would; the sim
  does not know the difference.
- Tasks come from the map's 106 `AIObjective` markers: defend generator, defend flag,
  repair, attack flag, escort, pilot. Bots claim tasks by weight and distance, with
  team-level balancing so a team keeps two defenders, one repairer, and the rest on
  offense.
- Movement: a coarse navigation grid over the heightfield (8 m cells) with A* for long
  routes, then steering that skis downhill and jets uphill by comparing the slope to
  the armor's numbers. Bots ski because the nav cost function rewards descent.
- Combat: lead targets using the projectile speed, prefer the Spinfusor at range, the
  Chaingun close, the Mortar at assets. Aim error scales with a difficulty setting.
- Vehicles: a bot that claims a pilot task grabs the Shrike or the Wildcat from its
  pad when the pad is powered.

### Client (`packages/client`)

- Three.js, WebGL2. Terrain from the heightmap with a splat shader over the T2 ice
  textures, normal-based snow highlights, fog to the 500 m visible distance, snow
  particles, a sky dome from the T2 sky materials, shadows from one directional light.
- Interiors and shapes load as glb. Player models use the skinned T2 meshes with the
  shipped animation clips: `forward`, `back`, `side`, `jump`, `fall`, `land`, `jet`,
  `ski`, the `look*` set, and the `die*` set. Vehicles use `vehicle_air_scout.glb` and
  `vehicle_grav_scout.glb`. STL fallback only if a glb fails to convert.
- First person by default, a third-person toggle in vehicles and debug mode.
- Input: pointer lock, WASD, Space jump and ski, right mouse jet, mouse look, number
  keys for weapons, G grenade, E use, R pack, V voice bind menu, C command circuit,
  Tab scoreboard, Enter chat, Escape menu. Rebindable through a JSON keymap.
- HUD in T2 style: reticle per weapon, health and energy bars bottom left, weapon and
  ammo bottom right, IFF names and health over teammates, flag status top center, chat
  and kill feed top left, a compass strip with sensor contacts, damage flashes.
- Command circuit: a 2D top-down canvas of the mission area with terrain shading, base
  assets with power state, teammates, and enemy contacts inside your team's sensor
  coverage. Click a bot and a target to issue attack, defend, repair, or escort.
- Inventory station menu: pick an armor, weapons, pack, and grenades, save favorites.
- Audio: Web Audio synthesis for jets, skiing, weapon fire, explosions, hits, station
  and generator hums. CC0 samples for anything synthesis cannot do well. Voice binds
  rendered once with a text-to-speech pass into short clips and played from a VGS-style
  menu. Positional audio through a listener at the camera.

### Debug mode

A single toggle (F1) opens the debug layer. It is present in every build.

- Stats: fps, frame time, sim tick time on the server, snapshot size, ping, packet
  loss, prediction error, entity counts, draw calls.
- Wireframes for terrain collision, interior BVH, player capsules, projectile paths,
  turret arcs, sensor radii.
- Bot labels: task, target, nav path, energy, aim error.
- Free camera, time scale from 0.1× to 4×, pause and single-step the sim.
- Entity inspector: click any entity and see its sim state.
- Snapshot record and replay: dump a match to a file and play it back.
- A console (tilde) with server commands: spawn a vehicle, give a weapon, teleport,
  kill an asset, set bot difficulty, dump world state to JSON.

### Asset pipeline (`packages/assets`)

Build-time scripts, run once and committed:

1. Fetch: pull the listed files from `exogen/t2-mapper` (mission, terrain, the glb
   set Katabatic needs, textures) and the STLs from nastyhobbit into a local cache.
2. Terrain: decode `Katabatic.ter` into a 16-bit height PNG plus a material index map
   and material name list.
3. Mission: parse `Katabatic.mis` (Windows-1252, CRLF) into a JSON scene: entities with
   class, datablock, team, position, rotation, scale, and every property the sim
   needs. Convert to Y-up here.
4. Shapes: verify each glb loads, normalize units, write to `assets/out/`.
5. STL fallback: convert with a Three.js loader to glb, scale to the known size.

Output goes into `assets/out/`, committed to git so CI and Pages need no network access
and no Blender. Sources stay out of git. A `NOTICE` file credits Sierra, the model
sources, and the mapper project.

## Testing

Vitest for everything in `sim`, `protocol`, and `bots`. Playwright for the client.

- Movement: skiing accelerates on a slope with jump held and decelerates without;
  jet drains and recharges at the datablock rates; speed caps hold; heavy runs at 7 m/s.
- Weapons: each state machine's timings; disc travels 90 m/s and inherits half the
  shooter's velocity; mortar arms after 2 s; the sniper shot scales with energy and
  refuses below 6.
- Damage: radius falloff, kickback impulse, shields spend energy first, two discs kill a
  Light.
- Power: both generators down turns off stations, pads, turrets, sensors, fields; one
  generator repaired turns them back on.
- CTF: the flag state machine and every transition in the failure matrix.
- Protocol: encode then decode round-trips every message; delta against a known
  baseline reproduces the state; hash of world state matches across encode and decode.
- Prediction: a scripted client with 150 ms of simulated latency and 5 % loss ends a
  ski run within 0.5 m of the server's position.
- Bots: a headless server with 32 bots runs 5000 ticks under the 32 ms budget and both
  teams score.
- Client (Playwright): the page loads, connects to a local server, spawns, skis 200 m,
  fires each weapon, mounts each vehicle, and captures a flag with scripted input.
  Screenshots at fixed ticks for visual regression.

## Failure matrix

These rows become the red tests before the code that covers them exists. The plan carries
the full table; this is the part that shapes the design.

| State or input | What happens | How it can fail | What the caller sees |
|---|---|---|---|
| Flag carried, carrier dies | flag drops at death position, return timer starts | death position is inside a wall or below terrain | flag is placed at the nearest walkable point; test asserts it is reachable |
| Flag dropped, timer expires | flag returns home | the flag was picked up 1 ms before expiry | pickup cancels the timer; the return is a no-op if the flag is not `dropped` |
| Capture with own flag away | no capture | | carrier keeps the flag, HUD says "your flag is not home" |
| Both generators dead | assets unpowered | a station is mid-transaction when power drops | the transaction aborts, the player keeps their old loadout |
| Vehicle pad spawn while a vehicle exists | old vehicle destroyed | a pilot is inside it | pilot is dismounted first, takes no damage |
| Client input arrives out of order | | older sequence after newer | server drops it; client's replay never sees it |
| Snapshot lost | | delta baseline the client never got | client acks carry the last received id; server never deltas against an unacked snapshot, falls back to a full snapshot after 1 s |
| Client mispredicts | rewind and replay | replay would run more than 30 ticks | client hard-snaps, records a prediction error in stats |
| Bot task target destroyed | bot rechooses | every task claimed | bot falls back to defend nearest asset |
| Player joins mid-match | full snapshot then deltas | | player spawns after the next tick, team is the smaller one |
| Server tick overruns 32 ms | | bots or collision blow the budget | the server logs the overrun, skips no ticks, catches up over the next ticks; the debug stats show it |

## Milestones

Each milestone is a working product on its own.

1. Terrain and movement, single player: Katabatic heightmap, one Light armor, skiing,
   jetting, debug overlay with stats and free cam. This is where the feel gets tuned.
2. Client and server: the same map through a local server with prediction and
   interpolation, 31 idle bots standing in, protocol tests green.
3. Weapons, damage, CTF: all four weapons, grenades, flags, scoring, respawn, HUD.
4. Base: interiors, generators, stations, turrets, sensors, force fields, power, repair,
   loadout menu, all three armors.
5. Vehicles: Shrike, Wildcat, vehicle pad.
6. Bots: objectives, navigation, combat, vehicles.
7. Command circuit, audio, voice binds, visual polish, Playwright suite, GitHub Pages
   demo.

## Risks

- Performance at 32 players: the sim is flat arrays and the renderer instances crates
  and projectiles. If the server tick overruns, bot think rate drops to every 4th tick
  first.
- WebSocket is TCP, so a lost packet stalls later packets. The redundant input sending
  and the 100 ms interpolation buffer hide most of it. WebRTC is the fix and the
  transport interface keeps it cheap.
- The converted glb files may have unit or orientation problems per model. Milestone 1
  loads each one in a viewer page in the debug layer so problems are visible early.
- Licensing: Sierra freeware data in a public repo. The README and NOTICE state the
  source and the non-commercial intent. If a takedown ever arrives, the asset pipeline
  already isolates every Sierra file so the STL and procedural fallback is a config
  switch.
