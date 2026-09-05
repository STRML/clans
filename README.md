# Clans

A Tribes 2 tech demo for the browser. Katabatic from the original heightmap, skiing and
jetting with the T2 armor numbers, and eventually the full base game with bots on an
authoritative Node server.

Status: milestone 2 of 7 (client and server, prediction and interpolation, 31 idle bots). See
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
| F1 | debug overlay (stats, time scale, pause, step, free cam) |

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
prediction error, and entity count.

## Develop

```sh
pnpm test          # unit tests (Vitest)
pnpm e2e           # browser tests (Playwright, needs `pnpm exec playwright install chromium` once)
pnpm lint          # ESLint and Prettier
pnpm typecheck     # tsc -b
pnpm assets:build  # regenerate assets/out from the T2 data files (downloads them on first run)
```

## Layout

- `packages/sim`: the game simulation. Pure TypeScript, no DOM or Node imports, so it runs in the browser today and on the server in milestone 2.
- `packages/assets`: build-time pipeline that turns Tribes 2 data files into `assets/out/`.
- `packages/client`: Three.js renderer, input, debug overlay.
- `packages/protocol`: binary wire format. Message schemas, full and delta snapshots, a world hash for tests.
- `packages/server`: Node, `ws`, 32 ms catch-up tick loop, per-client input sessions, snapshots delta-compressed against the client's last acked snapshot.
- `packages/bots`: placeholder until milestone 6. The server's `--bots` are idle stand-ins.

Every gameplay number (armor mass, jet force, speed caps) is copied from the T2 base scripts
and cited in the spec. If a number looks wrong, check the script before changing it.

## Credits

See [NOTICE.md](NOTICE.md). Tribes 2 belongs to its rights holders. This is a non-commercial
fan project.
