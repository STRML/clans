# Clans

A Tribes 2 tech demo for the browser. Katabatic from the original heightmap, skiing and
jetting with the T2 armor numbers, base assets and vehicles, and bots on an authoritative
Node server.

Status: v1 complete, all seven milestones shipped. See
`docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for what each
milestone shipped.

## Run it

```sh
pnpm install
pnpm dev
```

`assets/out/` (the converted Tribes 2 data) is committed to the repo, so a clean checkout
does not need `pnpm assets:fetch` or `pnpm assets:build` first. `pnpm dev` runs
`scripts/dev.ts`, which starts `dev:server` and `dev:client` together.

Open http://127.0.0.1:5173, click to capture the mouse, and ski.

| Key | Action |
|---|---|
| W A S D | move |
| Space | jump, hold to ski |
| Right mouse | jet |
| Left mouse | fire the held weapon |
| 1 2 3 4 5 | Spinfusor, Chaingun, Mortar, Laser Rifle, Blaster |
| G | throw a hand grenade |
| E | open the loadout menu at a powered inventory station, or open the vehicle spawn menu at a powered vehicle pad; mount an unoccupied vehicle within range, or dismount your own |
| R | hold to fire a Repair Pack beam (heals a damaged player, base asset, or turret) |
| C | open the commander map (see Command circuit below) |
| V | open the voice-bind quick-chat menu (see Voice binds below) |
| F1 | debug overlay (stats, time scale, pause, step, free cam, god mode) |

## Run it with a server

```sh
pnpm dev
```

This starts the authoritative server on `ws://127.0.0.1:7777` with 31 idle bots and the Vite
client on `http://127.0.0.1:5173`. Open `http://127.0.0.1:5173/?server=ws://127.0.0.1:7777`
to join. Without the `?server=` parameter the client runs the single-player path from
milestone 1.

Run the halves separately with `pnpm dev:server` and `pnpm dev:client`. The server takes
`--bots N` and `--port N`. The installed CLI is `clans-server --bots 31 --port 7777`.

Press F1 in a networked session for ping, snapshot bytes per second, packet loss estimate,
prediction error, entity count, the active projectile count, and the most recent kill-feed
event. The same F1 panel's lil-gui god-mode checkbox makes the local player invulnerable.
Networked, it toggles server-side via a `God` message; single-player, it zeroes damage locally
every tick.

## Base assets

Three armors are playable: Light, Medium, Heavy, each with its own speed, weapon slots, and
ammo caps. Visit a powered inventory station and press `E` to switch armor or equip a Repair
Pack.

Each team's base runs on power: at least one living generator keeps that team's stations,
sensors, base turrets, and force fields online. Destroy both of a team's generators and
everything else on that team goes dark — an unpowered station refuses a loadout change, an
unpowered turret stops firing, and an unpowered force field stops blocking. A Repair Pack beam
heals a damaged player, base asset, or turret within 10 m; it never revives something already
destroyed.

Base turrets (Plasma and AA barrels on the large turret base, plus the smaller Sentry Turret)
acquire and fire on enemy players within range and line of sight — a hill or wall between a
turret and its target blocks it exactly like it blocks a player's own shot. Katabatic's eleven
interior buildings render and block movement and projectiles through a per-instance collision
grid built once at load, not brute-force triangle checks. Press `C` for a top-down commander
map showing your team's base status and any enemy contacts inside your team's sensor coverage
(see Command circuit below for issuing orders from that map). See
`docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md` for exactly how
power, shields, and sensor coverage work.

## Vehicles

Each team's vehicle pad spawns a Shrike (a fast, armed flyer) or a Wildcat (a hovering ground
scout) once its team has power. Stand within the pad's use radius and press `E` to open the
spawn menu; picking a vehicle destroys whatever the pad already hosts. Walk up to an
unoccupied vehicle and press `E` to mount it — your own weapons go silent, the camera moves
to a third-person chase view, and WASD/mouse drive the vehicle's real T2 flight or hover
physics instead of your own movement. The Shrike's twin-barrel blaster fires from your own
fire button. Both vehicles take collision, ground-impact, and weapon damage against a shielded
energy pool, and explode past their damage cap, ejecting the pilot. Each team's AA barrel
turret now finds and fires on enemy vehicles in range with line of sight. Press `E` again to
dismount.

## Command circuit

Press `C` to open the commander map. Click a location, then press `1` (Attack), `2` (Defend),
or `3` (Repair) to issue an order to your team's bots at that location. A new order replaces
whatever order your team already has; there is no order queue, and an order expires on its own
after 90 seconds if it isn't replaced first. Bots read the active order off the server and
prioritize it over their own default behavior.

## Audio

Every sound in the game is synthesized at runtime with the Web Audio API. There are no sampled
audio files. Weapon fire, explosions, footsteps, jetting, skiing, flag touch and capture, and
station power hum are all generated from oscillators and filtered noise buffers
(`packages/client/src/audio.ts`).

## Voice binds

Press `V` to open a voice-bind quick-chat menu. Digit keys 1-9 send one of nine preset lines
(kill confirm, flag status, need repair, incoming, affirmative/negative, taunt). Each line is
played through the browser's own SpeechSynthesis API (Web Speech API) and broadcast to every
other client in the match.

## GitHub Pages demo

A client-only build deploys to GitHub Pages at https://strml.github.io/clans/ on every push to
`main` (`.github/workflows/deploy-pages.yml`, building `apps/demo`). GitHub Pages only serves
static files, so the hosted page has no server behind it — it shows a "bring your own server"
prompt until you append `?server=ws://your-host:7777` pointing at a Clans server you're running
yourself (`pnpm dev:server`, or `pnpm dev` for both halves) and that your browser can reach.

The Pages site is served over HTTPS. A browser blocks a plain `ws://` connection from an
HTTPS page as mixed content unless the target is a secure context on its own — in practice,
`ws://127.0.0.1:7777` or `ws://localhost:7777` works, but a remote host needs `wss://` (put a
TLS-terminating proxy in front of your server) or the connection will never open. If the demo
can't reach the server you gave it, it shows a "couldn't connect" message rather than staying
silently blank.

## Develop

```sh
pnpm test          # unit tests (Vitest)
pnpm e2e           # browser tests (Playwright, needs `pnpm exec playwright install chromium` once)
pnpm lint          # ESLint and Prettier
pnpm typecheck     # tsc -b
pnpm assets:build  # regenerate assets/out from the T2 data files (downloads them on first run)
```

## Layout

- `packages/sim`: the game simulation. Pure TypeScript, no DOM or Node imports, so it runs in the browser today and on the server. Health, fall damage, respawn, four weapons plus grenades, a projectile store, CTF flags and scoring, base objects and per-team power, turrets with terrain line of sight, a uniform-grid interior collider, the Repair Pack beam, and the Shrike/Wildcat vehicles (flight/hover physics, mount/dismount, shielded damage, destruction, ejection) all live here.
- `packages/assets`: build-time pipeline that turns Tribes 2 data files into `assets/out/`, including the interior/base-object/turret/vehicle `.glb` shapes (with an STL-then-procedural fallback chain for the vehicles) and their extracted collision triangles.
- `packages/client`: Three.js renderer, input, projectile/explosion/laser-beam/flag/base-object/turret/interior/vehicle rendering, the station loadout menu, the vehicle pad spawn menu, the commander map, a synthesized Web Audio engine, the HUD, debug overlay.
- `packages/protocol`: binary wire format. Message schemas (including `Event`, `God`, `Loadout`, `VehicleSpawn`, `CommandOrder`, and `VoiceBind`), full and delta snapshots with projectiles/flags/base-objects/turrets/vehicles/scores/active team orders sent in full each tick, a world hash for tests.
- `packages/server`: Node, `ws`, 32 ms catch-up tick loop, per-client input sessions, snapshots delta-compressed against the client's last acked snapshot, lag-compensated hit detection for the Chaingun and Laser Rifle, respawn, CTF, base-object/turret/interior/vehicle loading, and a per-team command-order board (Attack/Defend/Repair, one active order per team, no queue).
- `packages/bots`: server-side bot AI, read-only over the sim's exported API. A coarse waypoint graph (Dijkstra, seeded from spawn points, flag stands, and base objects) for navigation; perception that spots a living, unmounted enemy in line of sight and skips a low-health/low-energy retreat to a friendly station; combat that leads targets by projectile speed and prefers the Chaingun close, the Spinfusor/Mortar at range; CTF role assignment (Attacker/Defender) and a per-tick brain that chases or returns the flag, escorts a carrying teammate, heals at a station, mounts a nearby vehicle when nothing else is more urgent, and prioritizes a commander's active Attack/Defend/Repair order over its own default behavior. The server keeps both teams filled toward 16 a side by adding or removing bots on join/leave, never touching a human's seat; a debug-overlay row shows each team's bot count and idle/attack/defend split.

Every gameplay number (armor mass, jet force, speed caps) is copied from the T2 base scripts
and cited in the spec, except a handful of documented "ours" values where a script constant
had no direct equivalent under this codebase's own physics model (each one commented at its
definition and called out in the milestone's own PR). If a number looks wrong, check the
script before changing it.

## Credits

See [NOTICE.md](NOTICE.md). Tribes 2 belongs to its rights holders. This is a non-commercial
fan project.
