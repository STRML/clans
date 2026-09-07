# Clans

A Tribes 2 tech demo for the browser. Katabatic from the original heightmap, skiing and
jetting with the T2 armor numbers, and eventually the full base game with bots on an
authoritative Node server.

Status: milestone 4 of 7 (base assets and power). See
`docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for what each
milestone ships.

## Run it

```sh
pnpm install
pnpm dev
```

Open http://127.0.0.1:5173, click to capture the mouse, and ski.

| Key | Action |
|---|---|
| W A S D | move |
| Space | jump, hold to ski |
| Right mouse | jet |
| Left mouse | fire the held weapon |
| 1 2 3 4 5 | Spinfusor, Chaingun, Mortar, Laser Rifle, Blaster |
| G | throw a hand grenade |
| E | open the loadout menu at a powered inventory station |
| R | hold to fire a Repair Pack beam (heals a damaged player, base asset, or turret) |
| C | toggle the commander map |
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
map showing your team's base status and any enemy contacts inside your team's sensor coverage.
See `docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md` for exactly how
power, shields, and sensor coverage work.

## Develop

```sh
pnpm test          # unit tests (Vitest)
pnpm e2e           # browser tests (Playwright, needs `pnpm exec playwright install chromium` once)
pnpm lint          # ESLint and Prettier
pnpm typecheck     # tsc -b
pnpm assets:build  # regenerate assets/out from the T2 data files (downloads them on first run)
```

## Layout

- `packages/sim`: the game simulation. Pure TypeScript, no DOM or Node imports, so it runs in the browser today and on the server. Health, fall damage, respawn, four weapons plus grenades, a projectile store, CTF flags and scoring, base objects and per-team power, turrets with terrain line of sight, a uniform-grid interior collider, and the Repair Pack beam all live here.
- `packages/assets`: build-time pipeline that turns Tribes 2 data files into `assets/out/`, including the interior and base-object/turret `.glb` shapes and their extracted collision triangles.
- `packages/client`: Three.js renderer, input, projectile/explosion/laser-beam/flag/base-object/turret/interior rendering, the station loadout menu, the commander map, the HUD, debug overlay.
- `packages/protocol`: binary wire format. Message schemas (including `Event`, `God`, and `Loadout`), full and delta snapshots with projectiles/flags/base-objects/turrets/scores sent in full each tick, a world hash for tests.
- `packages/server`: Node, `ws`, 32 ms catch-up tick loop, per-client input sessions, snapshots delta-compressed against the client's last acked snapshot, lag-compensated hit detection for the Chaingun and Laser Rifle, respawn, CTF, and base-object/turret/interior loading.
- `packages/bots`: placeholder until milestone 6. The server's `--bots` are idle stand-ins.

Every gameplay number (armor mass, jet force, speed caps) is copied from the T2 base scripts
and cited in the spec. If a number looks wrong, check the script before changing it.

## Credits

See [NOTICE.md](NOTICE.md). Tribes 2 belongs to its rights holders. This is a non-commercial
fan project.
