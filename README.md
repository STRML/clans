# Clans

A Tribes 2 tech demo for the browser. Katabatic from the original heightmap, skiing and
jetting with the T2 armor numbers, and eventually the full base game with bots on an
authoritative Node server.

Status: milestone 1 of 7 (terrain and movement, single player). See
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

## Develop

```sh
pnpm test          # unit tests (Vitest)
pnpm e2e           # browser smoke test (Playwright, needs `pnpm exec playwright install chromium` once)
pnpm lint          # ESLint and Prettier
pnpm typecheck     # tsc -b
pnpm assets:build  # regenerate assets/out from the T2 data files (downloads them on first run)
```

## Layout

- `packages/sim`: the game simulation. Pure TypeScript, no DOM or Node imports, so it runs in the browser today and on the server in milestone 2.
- `packages/assets`: build-time pipeline that turns Tribes 2 data files into `assets/out/`.
- `packages/client`: Three.js renderer, input, debug overlay.
- `packages/protocol`, `packages/server`, `packages/bots`: placeholders until milestones 2 and 6.

Every gameplay number (armor mass, jet force, speed caps) is copied from the T2 base scripts
and cited in the spec. If a number looks wrong, check the script before changing it.

## Credits

See [NOTICE.md](NOTICE.md). Tribes 2 belongs to its rights holders. This is a non-commercial
fan project.
