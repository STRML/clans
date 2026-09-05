# Milestone 1: Terrain and Movement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a deterministic single-player Katabatic demo with Light armor skiing, jetting, terrain rendering, and live debug controls.
**Architecture:** A build-time asset package converts Torque data to committed Y-up artifacts. A platform-free simulation package owns terrain collision and fixed-tick movement, while a Vite client renders those artifacts and feeds input into the same simulation API.
**Tech Stack:** pnpm workspaces, TypeScript 5.x, Vite, Three.js latest, Vitest, ESLint 9 flat config, typescript-eslint, Prettier, lil-gui, Playwright
**Spec:** docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md

## Global Constraints

- Use Y-up metres everywhere except inside the asset pipeline, which converts Torque Z-up once: Torque `(x, y, z)` becomes Three `(x, z, -y)`.
- Convert `.mis` axis-angle rotations `ax ay az degrees` with the same axis remap.
- Run the simulation at the fixed 32 ms tick and reject every other `dt` with a `RangeError` whose message names the fixed tick.
- Keep `packages/sim` free of DOM, Three.js, and Node imports.
- Use plain typed arrays and objects in the simulation. Do not add an ECS library.
- Use the Light armor values: mass 90, maxDamage 0.66, maxEnergy 60, rechargeRate 0.256, jetForce `26.21 * 90`, jetEnergyDrain 0.8, minJetEnergy 1, runForce `55.20 * 90`, maxForwardSpeed 15, maxBackwardSpeed 13, maxSideSpeed 13, jumpForce `8.3 * 90`, jumpDelay 0, minJumpSpeed 20, maxJumpSpeed 30, horizMaxSpeed 68, horizResistSpeed 33, horizResistFactor 0.35, upMaxSpeed 80, upResistSpeed 25, upResistFactor 0.3, drag 0.275, boundingBox `1.2 * 1.2 * 2.3`, runSurfaceAngle 70, jumpSurfaceAngle 80, and speedDamageScale 0.004.
- Use gravity 20 m/s² downward.
- Store `groundFriction = 40` m/s² in the Light armor datablock as our tuning value, not a T2 script value.
- Decode `.ter` version 2 as a 256 by 256 row-major u16 LE height field divided by 32, followed by 65536 material indices, length-prefixed material names ending in a zero-length entry, three bytes of unknown purpose, and one 65536-byte alpha map per material. Anchor the alpha maps on the file end.
- Use 8 m grid squares with Torque terrain origin `(-1024, -1024, 0)` and clamp outside lookups instead of wrapping.
- Split a terrain square on the `(col,row)` to `(col+1,row+1)` diagonal when `((col ^ row) & 1) === 0`; use the other diagonal otherwise.
- Parse `.mis` as Windows-1252 text with CRLF support into generic `{ class, name, props, children }` objects before typed extraction.
- Fetch only the six specified files from `https://raw.githubusercontent.com/exogen/t2-mapper/HEAD/docs/base/@vl2/`, cache them under gitignored `packages/assets/cache/`, and skip existing files.
- Write generated Katabatic artifacts to committed `assets/out/katabatic/`.
- Use four raw `alpha-<n>.bin` maps because they preserve source bytes and avoid a PNG encoder dependency.
- Render fog to 500 m, the mission sun, a gradient sky dome, and the four IceWorld texture layers.
- Spawn the player at team 1's first spawn sphere after asset conversion.
- Keep networking, weapons, other armors, vehicles, interiors, skinned models, audio, and non-debug HUD out of milestone 1.

## File structure

Root (committed in the scaffold, Task 1 verifies):

- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`: workspace and root scripts.
- `tsconfig.base.json`, `tsconfig.json`: strict shared settings and project references.
- `eslint.config.js`, `.prettierrc`, `.prettierignore`: lint and format policy.
- `vitest.config.ts`: Vitest projects over `packages/*`.
- `playwright.config.ts`: Playwright with the Vite dev server as `webServer` (Task 12 adds GL flags).
- `.github/workflows/ci.yml`: lint, typecheck, test, build, Playwright on ubuntu-latest, Node 24.
- `README.md`: one-command run and controls (Task 13).
- `NOTICE.md`: credits for Sierra/Dynamix data, nastyhobbit STLs, exogen/t2-mapper mirror (Task 13).
- `e2e/movement.spec.ts`: browser smoke test (Task 12).

`packages/assets` (Node only):

- `src/ter.ts`: decodes TerrainBlock version 2 (Task 2).
- `src/mis.ts`: parses generic mission objects with line numbers (Task 3).
- `src/scene.ts`: typed scene extraction and the single Torque to Y-up conversion (Task 4).
- `src/fetch.ts`: downloads the six-file allowlist into the gitignored cache (Task 4).
- `src/build.ts`: writes `assets/out/katabatic/` (Task 4).
- `src/__fixtures__/tiny-v2.ter`, `src/__fixtures__/scene.mis`: small checked-in fixtures.
- `src/ter.test.ts`, `src/mis.test.ts`, `src/scene.test.ts`.

`packages/sim` (no DOM, no Three.js, no Node):

- `src/terrain.ts`: heightfield sampling on Torque's alternating diagonals (Task 5).
- `src/random.ts`: seeded xorshift PRNG (Task 6).
- `src/types.ts`: `World`, `PlayerStore`, `PlayerInput`, `Vec3` (Task 6).
- `src/world.ts`: `createWorld`, `addPlayer`, `stepWorld` with the fixed-tick guard (Task 6).
- `src/armor.ts`: `LIGHT_ARMOR` datablock plus our `groundFriction` tuning value (Task 7).
- `src/movement.ts`: run, ski, jet, resistance, integrate, contact, snap (Task 7).
- `src/index.ts`: public API.
- `src/terrain.test.ts`, `src/world.test.ts`, `src/movement.test.ts`.

`packages/client` (Three.js, Vite):

- `index.html`: page shell and overlay styles.
- `vite.config.ts`: serves `assets/out` as the public dir (Task 9).
- `src/assets.ts`: loads `terrain.json`, `scene.json`, and the binary maps (Task 9).
- `src/terrain.ts`: parity-matched terrain mesh, splat shader, environment (Task 9).
- `src/loop.ts`: fixed-step accumulator (Task 10).
- `src/input.ts`: pointer lock, keys, mouse look (Task 10).
- `src/app.ts`: world, scene, camera, per-frame step and render (Task 10).
- `src/main.ts`: boots the app and the overlay (Tasks 10 and 11).
- `src/stats.ts`: pure debug row formatter (Task 11).
- `src/debug.ts`: F1 overlay, lil-gui controls, free camera toggle (Task 11).
- `src/terrain.test.ts`, `src/loop.test.ts`, `src/stats.test.ts`.

`assets/out/katabatic/` (committed, generated by Task 4): `heights.bin`, `materials.bin`, `alpha-0.bin` to `alpha-3.bin`, `terrain.json`, `scene.json`, `terrain.IceWorld.Snow.png`, `terrain.IceWorld.RockBlue.png`, `terrain.IceWorld.SnowRock.png`, `terrain.IceWorld.Ice.png`.

## Task dependency graph

- Task 1 has no dependency. The scaffold is already committed; the task verifies it and fixes two script paths.
- Tasks 2, 3, 5, and 6 depend on Task 1 and may run in parallel. Task 2 owns `.ter` decoder files. Task 3 owns `.mis` parser files. Task 5 owns simulation terrain files. Task 6 owns simulation state and PRNG files.
- Task 4 depends on Tasks 2 and 3. It owns asset extraction, fetching, building, and generated output.
- Task 7 depends on Tasks 5 and 6. It owns armor and movement files.
- Task 8 depends on Task 7. It extends only the movement test and implementation files.
- Task 9 depends on Task 4. It owns client asset loading and terrain rendering files.
- Task 10 depends on Tasks 7 and 9. It owns the loop, input, app, and main entry.
- Task 11 depends on Task 10. It owns stats and debug files and modifies main and index.html.
- Task 12 depends on Task 11. It owns the e2e spec and modifies the Playwright config.
- Task 13 depends on Tasks 4 and 12. It owns README and NOTICE and proves the asset build is reproducible.
- Parallel tasks above touch no common file.

---

### Task 1: Verify the workspace scaffold

**Files:** Already committed in `79abb85` on `feat/m1-terrain-movement`: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, and `packages/{sim,protocol,bots,assets,server,client}` with `package.json`, `tsconfig.json`, `vitest.config.ts` (client: `vite.config.ts`), and `src/index.ts` (client: `src/main.ts`, `index.html`). Modify: `packages/assets/package.json` (script paths).
**Interfaces:** Produces root scripts `dev`, `build`, `typecheck` (`tsc -b`), `lint` (ESLint + Prettier check), `format`, `test` (Vitest projects over `packages/*`, `src/**/*.test.ts`), `e2e` (Playwright, `testDir: e2e` at the repo root, `webServer` = `pnpm dev` on port 5173), `assets:fetch`, `assets:build`; workspace names `@clans/sim`, `@clans/assets`, `@clans/client`, `@clans/protocol`, `@clans/server`, `@clans/bots`.

Conventions every later task follows:

- Tests live next to their source: `packages/<pkg>/src/<name>.test.ts`, importing `./<name>.js`. Binary and text fixtures live in `packages/<pkg>/src/__fixtures__/`.
- `pnpm typecheck` runs `tsc -b` over project references. Every package's `tsconfig.json` has `rootDir: src`, so test files are typechecked and compiled to the gitignored `dist/`.
- ESLint enforces `complexity` 10 and `max-depth` 3. Split functions before the lint does.
- Prettier: 100 columns, single quotes, trailing commas. Markdown is ignored.

- [ ] **Step 1: Verify the gates on the committed scaffold**

Run:

```sh
git log --oneline -2
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: `79abb85 chore: scaffold pnpm monorepo ...` in the log, and all four gates green with no test files found.

- [ ] **Step 2: Point the assets scripts at the files Task 4 creates**

Change `packages/assets/package.json` scripts to:

```json
"scripts": {
  "build": "tsc -b",
  "test": "vitest run",
  "fetch": "tsx src/fetch.ts",
  "build:assets": "tsx src/fetch.ts && tsx src/build.ts"
}
```

- [ ] **Step 3: Commit**

```sh
git add packages/assets/package.json
git commit -m "chore(assets): point scripts at fetch and build entry files" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 2: Decode TerrainBlock version 2

**Files:** Create `packages/assets/src/ter.ts`, `packages/assets/src/__fixtures__/tiny-v2.ter`, and `packages/assets/src/ter.test.ts`
**Interfaces:** Consumes `Uint8Array` source bytes. Produces `decodeTer(bytes: Uint8Array, gridSize?: number): TerrainData`.

- [ ] **Step 1: Write the failing test**

Create the checked-in binary fixture with this one-time command:

```sh
node -e "const fs=require('node:fs');const a=[2,0x40,6,0x60,6,0x80,6,0xa0,6,0,1,2,3,4,83,110,111,119,3,73,99,101,0,0,0,0,255,128,64,0,0,64,128,255];fs.writeFileSync('packages/assets/src/__fixtures__/tiny-v2.ter',Buffer.from(a))"
```

Create `packages/assets/src/ter.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeTer } from './ter.js';

const fixture = new URL('./__fixtures__/tiny-v2.ter', import.meta.url);

describe('decodeTer', () => {
  it('decodes version 2 fields in source order', async () => {
    const data = decodeTer(await readFile(fixture), 2);
    expect([...data.heights]).toEqual([1600, 1632, 1664, 1696]);
    expect([...data.materials]).toEqual([0, 1, 2, 3]);
    expect(data.materialNames).toEqual(['Snow', 'Ice']);
    expect(data.alphaMaps.map((map) => [...map])).toEqual([
      [255, 128, 64, 0],
      [0, 64, 128, 255],
    ]);
  });

  it('reports the unsupported version', () => {
    expect(() => decodeTer(Uint8Array.of(7), 2)).toThrow('Unsupported .ter version 7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/assets test -- ter.test.ts`. Expect module resolution to fail for `./ter.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/assets/src/ter.ts`:

```ts
export interface TerrainData {
  version: 2;
  gridSize: number;
  heights: Uint16Array;
  materials: Uint8Array;
  materialNames: string[];
  alphaMaps: Uint8Array[];
}

function requireBytes(bytes: Uint8Array, offset: number, count: number): void {
  if (offset + count > bytes.byteLength) {
    throw new RangeError(`Truncated .ter at byte ${offset}; need ${count} bytes`);
  }
}

export function decodeTer(bytes: Uint8Array, gridSize = 256): TerrainData {
  requireBytes(bytes, 0, 1);
  const version = bytes[0];
  if (version !== 2) throw new Error(`Unsupported .ter version ${String(version)}`);

  const points = gridSize * gridSize;
  let offset = 1;
  requireBytes(bytes, offset, points * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, points * 2);
  const heights = new Uint16Array(points);
  for (let i = 0; i < points; i += 1) heights[i] = view.getUint16(i * 2, true);
  offset += points * 2;

  requireBytes(bytes, offset, points);
  const materials = bytes.slice(offset, offset + points);
  offset += points;

  const materialNames: string[] = [];
  while (true) {
    requireBytes(bytes, offset, 1);
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (length === 0) break;
    requireBytes(bytes, offset, length);
    materialNames.push(String.fromCharCode(...bytes.slice(offset, offset + length)));
    offset += length;
  }

  // Three bytes of unknown purpose sit between the name list and the alpha maps
  // (verified on Katabatic.ter: the maps occupy exactly the last names.length * points
  // bytes, and reading them from the terminator instead gives blend sums of 0 not 255).
  // Anchor on the file end so the decoder does not depend on what those bytes mean.
  const alphaStart = bytes.byteLength - materialNames.length * points;
  if (alphaStart < offset) {
    throw new RangeError(`Truncated .ter: alpha maps need ${String(materialNames.length * points)} bytes`);
  }
  offset = alphaStart;
  const alphaMaps = materialNames.map(() => {
    const map = bytes.slice(offset, offset + points);
    offset += points;
    return map;
  });

  return { version: 2, gridSize, heights, materials, materialNames, alphaMaps };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/assets test -- ter.test.ts`.

- [ ] **Step 5: Commit**

```sh
git add packages/assets/src/ter.ts packages/assets/src/__fixtures__/tiny-v2.ter packages/assets/src/ter.test.ts
git commit -m "feat(assets): decode terrain version two" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 3: Parse generic mission objects

**Files:** Create `packages/assets/src/mis.ts`, `packages/assets/src/__fixtures__/scene.mis`, and `packages/assets/src/mis.test.ts`
**Interfaces:** Consumes decoded mission text. Produces `MissionObject` and `parseMission(source: string): MissionObject[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/assets/src/__fixtures__/scene.mis`:

```text
new SimGroup(Team1) {
  team = "1";
  new SpawnSphere(SpawnA) {
    position = "326.888 -168.521 74.8106";
    radius = "5";
  };
};
new TerrainBlock(Terrain) {
  terrainFile = "Katabatic.ter";
  squareSize = "8";
  position = "-1024 -1024 0";
};
```

Create `packages/assets/src/mis.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMission } from './mis.js';

describe('parseMission', () => {
  it('parses properties and nested objects generically', async () => {
    const source = await readFile(new URL('./__fixtures__/scene.mis', import.meta.url), 'utf8');
    expect(parseMission(source)[0]).toEqual({
      class: 'SimGroup',
      name: 'Team1',
      props: { team: '1' },
      children: [
        {
          class: 'SpawnSphere',
          name: 'SpawnA',
          props: { position: '326.888 -168.521 74.8106', radius: '5' },
          children: [],
        },
      ],
    });
  });

  it('reports the opening line for an unterminated object', () => {
    expect(() => parseMission('new SimGroup(Broken) {\r\n key = "value";')).toThrow(
      'Unterminated SimGroup opened at line 1',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/assets test -- mis.test.ts`. Expect module resolution to fail for `./mis.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/assets/src/mis.ts`:

```ts
export interface MissionObject {
  class: string;
  name: string | null;
  props: Record<string, string>;
  children: MissionObject[];
}

interface Token {
  value: string;
  line: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (/\s/.test(char)) {
      if (char === '\n') line += 1;
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if ('{}();='.includes(char)) {
      tokens.push({ value: char, line });
      index += 1;
      continue;
    }
    if (char === '"') {
      const startLine = line;
      index += 1;
      let value = '';
      while (index < source.length && source[index] !== '"') {
        const next = source[index] ?? '';
        if (next === '\\' && index + 1 < source.length) {
          value += source[index + 1] ?? '';
          index += 2;
        } else {
          if (next === '\n') line += 1;
          value += next;
          index += 1;
        }
      }
      if (source[index] !== '"') throw new SyntaxError(`Unterminated string at line ${startLine}`);
      index += 1;
      tokens.push({ value, line: startLine });
      continue;
    }
    const start = index;
    while (index < source.length && !/[\s{}();="]/.test(source[index] ?? '')) index += 1;
    tokens.push({ value: source.slice(start, index), line });
  }
  return tokens;
}

export function parseMission(source: string): MissionObject[] {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = (): Token | undefined => tokens[cursor];
  const take = (value?: string): Token => {
    const token = tokens[cursor];
    if (!token || (value !== undefined && token.value !== value)) {
      throw new SyntaxError(`Expected ${value ?? 'token'} at line ${token?.line ?? source.split(/\r?\n/).length}`);
    }
    cursor += 1;
    return token;
  };

  const parseObject = (): MissionObject => {
    take('new');
    const classToken = take();
    take('(');
    const name = peek()?.value === ')' ? null : take().value;
    take(')');
    take('{');
    const object: MissionObject = { class: classToken.value, name, props: {}, children: [] };
    while (peek() && peek()?.value !== '}') {
      if (peek()?.value === 'new') {
        object.children.push(parseObject());
        continue;
      }
      const key = take().value;
      take('=');
      const parts: string[] = [];
      while (peek() && peek()?.value !== ';') parts.push(take().value);
      if (!peek()) throw new SyntaxError(`Unterminated ${classToken.value} opened at line ${classToken.line}`);
      take(';');
      object.props[key] = parts.join(' ');
    }
    if (!peek()) throw new SyntaxError(`Unterminated ${classToken.value} opened at line ${classToken.line}`);
    take('}');
    take(';');
    return object;
  };

  const objects: MissionObject[] = [];
  while (peek()) objects.push(parseObject());
  return objects;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/assets test -- mis.test.ts`.

- [ ] **Step 5: Commit**

```sh
git add packages/assets/src/mis.ts packages/assets/src/__fixtures__/scene.mis packages/assets/src/mis.test.ts
git commit -m "feat(assets): parse generic mission objects" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 4: Extract and build Katabatic assets

**Files:** Create `packages/assets/src/scene.ts`, `packages/assets/src/fetch.ts`, `packages/assets/src/build.ts`, and `packages/assets/src/scene.test.ts`; Modify `packages/assets/src/__fixtures__/scene.mis` and `packages/assets/package.json`; Generate every file under `assets/out/katabatic/`
**Interfaces:** Consumes `parseMission(source: string): MissionObject[]` and `decodeTer(bytes: Uint8Array, gridSize?: number): TerrainData`. Produces `torquePositionToYUp(value: string): Vec3`, `torqueAxisAngleToYUp(value: string): AxisAngle`, `extractScene(objects: MissionObject[]): SceneData`, and the `TerrainManifest` JSON shape used by Task 9.

- [ ] **Step 1: Write the failing test**

Append these objects to `packages/assets/src/__fixtures__/scene.mis`:

```text
new Sun(Sun) {
  direction = "0.57735 0.57735 -0.57735";
  color = "0.7 0.7 0.7 1";
  ambient = "0.3 0.3 0.3 1";
};
new Sky(Sky) {
  visibleDistance = "500";
  fogDistance = "400";
  fogColor = "0.65 0.65 0.7 1";
  materialList = "sky_ice_blue.dml";
};
new MissionArea(MissionArea) {
  area = "-896 -696 1504 1392";
};
```

Create `packages/assets/src/scene.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMission } from './mis.js';
import { extractScene, torqueAxisAngleToYUp, torquePositionToYUp } from './scene.js';

describe('scene extraction', () => {
  it('converts position and rotation axes exactly once', () => {
    expect(torquePositionToYUp('1 2 3')).toEqual([1, 3, -2]);
    expect(torqueAxisAngleToYUp('1 2 3 90')).toEqual({ axis: [1, 3, -2], degrees: 90 });
  });

  it('extracts typed leaves and inherited team membership', async () => {
    const source = await readFile(new URL('./__fixtures__/scene.mis', import.meta.url), 'utf8');
    const scene = extractScene(parseMission(source));
    expect(scene.terrain).toEqual({ terrainFile: 'Katabatic.ter', squareSize: 8, position: [-1024, 0, 1024] });
    expect(scene.sun.direction).toEqual([0.57735, -0.57735, -0.57735]);
    expect(scene.sky.visibleDistance).toBe(500);
    expect(scene.sky.fogDistance).toBe(400);
    expect(scene.sky.fogColor).toEqual([0.65, 0.65, 0.7, 1]);
    expect(scene.missionArea).toEqual({ minX: -896, minZ: -696, width: 1504, depth: 1392 });
    expect(scene.spawns).toEqual([
      { name: 'SpawnA', team: 1, position: [326.888, 74.8106, 168.521], radius: 5 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/assets test -- scene.test.ts`. Expect module resolution to fail for `./scene.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/assets/src/scene.ts`:

```ts
import type { MissionObject } from './mis.js';

export type Vec3 = [number, number, number];
export type Color4 = [number, number, number, number];
export interface AxisAngle { axis: Vec3; degrees: number }
export interface SceneData {
  terrain: { terrainFile: string; squareSize: number; position: Vec3 };
  sun: { direction: Vec3; color: Color4; ambient: Color4 };
  sky: { visibleDistance: number; fogDistance: number; fogColor: Color4; materialList: string };
  missionArea: { minX: number; minZ: number; width: number; depth: number };
  spawns: Array<{ name: string | null; team: number; position: Vec3; radius: number }>;
}

function numbers(value: string, count: number): number[] {
  const parsed = value.trim().split(/\s+/).map(Number);
  if (parsed.length !== count || parsed.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`Expected ${count} finite numbers, got "${value}"`);
  }
  return parsed;
}

export function torquePositionToYUp(value: string): Vec3 {
  const [x = 0, y = 0, z = 0] = numbers(value, 3);
  return [x, z, -y];
}

export function torqueAxisAngleToYUp(value: string): AxisAngle {
  const [x = 0, y = 0, z = 0, degrees = 0] = numbers(value, 4);
  return { axis: [x, z, -y], degrees };
}

function color(value: string): Color4 {
  const [r = 0, g = 0, b = 0, a = 1] = numbers(value, 4);
  return [r, g, b, a];
}

interface LocatedObject { object: MissionObject; ancestors: MissionObject[] }

function flatten(objects: MissionObject[], ancestors: MissionObject[] = []): LocatedObject[] {
  return objects.flatMap((object) => [
    { object, ancestors },
    ...flatten(object.children, [...ancestors, object]),
  ]);
}

function required(found: LocatedObject | undefined, className: string): LocatedObject {
  if (!found) throw new Error(`Mission is missing ${className}`);
  return found;
}

function teamFor(ancestors: MissionObject[]): number {
  for (const parent of [...ancestors].reverse()) {
    const property = Number(parent.props.team);
    if (Number.isInteger(property)) return property;
    const match = /^Team(\d+)$/i.exec(parent.name ?? '');
    if (match) return Number(match[1]);
  }
  throw new Error('SpawnSphere has no enclosing team');
}

export function extractScene(objects: MissionObject[]): SceneData {
  const all = flatten(objects);
  const terrain = required(all.find(({ object }) => object.class === 'TerrainBlock'), 'TerrainBlock').object;
  const sun = required(all.find(({ object }) => object.class === 'Sun'), 'Sun').object;
  const sky = required(all.find(({ object }) => object.class === 'Sky'), 'Sky').object;
  const area = required(all.find(({ object }) => object.class === 'MissionArea'), 'MissionArea').object;
  const [areaX = 0, areaY = 0, width = 0, depth = 0] = numbers(area.props.area ?? '', 4);
  return {
    terrain: { terrainFile: terrain.props.terrainFile ?? '', squareSize: Number(terrain.props.squareSize), position: torquePositionToYUp(terrain.props.position ?? '') },
    sun: { direction: torquePositionToYUp(sun.props.direction ?? ''), color: color(sun.props.color ?? ''), ambient: color(sun.props.ambient ?? '0 0 0 1') },
    sky: { visibleDistance: Number(sky.props.visibleDistance), fogDistance: Number(sky.props.fogDistance), fogColor: color(sky.props.fogColor ?? '0.65 0.65 0.7 1'), materialList: sky.props.materialList ?? '' },
    missionArea: { minX: areaX, minZ: -(areaY + depth), width, depth },
    spawns: all.filter(({ object }) => object.class === 'SpawnSphere').map(({ object, ancestors }) => ({
      name: object.name,
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
      radius: Number(object.props.radius),
    })),
  };
}
```

Create `packages/assets/src/fetch.ts`:

```ts
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/exogen/t2-mapper/HEAD/docs/base/@vl2/';
const SOURCES = [
  'missions.vl2/missions/Katabatic.mis',
  'missions.vl2/terrains/Katabatic.ter',
  'textures.vl2/textures/terrain/IceWorld.Snow.png',
  'textures.vl2/textures/terrain/IceWorld.RockBlue.png',
  'textures.vl2/textures/terrain/IceWorld.SnowRock.png',
  'textures.vl2/textures/terrain/IceWorld.Ice.png',
] as const;
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cacheRoot = resolve(packageRoot, 'cache');

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

for (const source of SOURCES) {
  const destination = resolve(cacheRoot, source);
  if (await exists(destination)) continue;
  const response = await fetch(new URL(source, BASE));
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}
```

Create `packages/assets/src/build.ts`:

```ts
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMission } from './mis.js';
import { extractScene } from './scene.js';
import { decodeTer } from './ter.js';

export interface TerrainManifest {
  gridSize: 256; squareSize: 8; origin: { x: number; y: number; z: number };
  minHeight: number; maxHeight: number; heightScale: 32;
  heights: 'heights.bin'; materials: 'materials.bin';
  layers: Array<{ name: string; texture: string; alpha: string }>;
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const cache = resolve(packageRoot, 'cache');
const output = resolve(repoRoot, 'assets/out/katabatic');
const missionBytes = await readFile(resolve(cache, 'missions.vl2/missions/Katabatic.mis'));
const mission = extractScene(parseMission(new TextDecoder('windows-1252').decode(missionBytes)));
const terrain = decodeTer(await readFile(resolve(cache, 'missions.vl2/terrains/Katabatic.ter')));
const expectedNames = ['terrain.IceWorld.Snow', 'terrain.IceWorld.RockBlue', 'terrain.IceWorld.SnowRock', 'terrain.IceWorld.Ice'];
if (terrain.materialNames.join('|') !== expectedNames.join('|')) {
  throw new Error(`Unexpected Katabatic materials: ${terrain.materialNames.join(', ')}`);
}

await mkdir(output, { recursive: true });
const heightBytes = new Uint8Array(terrain.heights.length * 2);
const heightView = new DataView(heightBytes.buffer);
terrain.heights.forEach((height, index) => heightView.setUint16(index * 2, height, true));
await writeFile(resolve(output, 'heights.bin'), heightBytes);
await writeFile(resolve(output, 'materials.bin'), terrain.materials);
const layers = [];
for (let index = 0; index < terrain.materialNames.length; index += 1) {
  const name = terrain.materialNames[index] ?? '';
  const texture = `${name}.png`;
  const alpha = `alpha-${index}.bin`;
  await writeFile(resolve(output, alpha), terrain.alphaMaps[index] ?? new Uint8Array());
  await copyFile(resolve(cache, 'textures.vl2/textures/terrain', basename(texture)), resolve(output, texture));
  layers.push({ name, texture, alpha });
}
let minHeight = Infinity;
let maxHeight = -Infinity;
for (const height of terrain.heights) {
  minHeight = Math.min(minHeight, height / 32);
  maxHeight = Math.max(maxHeight, height / 32);
}
const manifest: TerrainManifest = {
  gridSize: 256, squareSize: 8,
  origin: { x: mission.terrain.position[0], y: mission.terrain.position[1], z: mission.terrain.position[2] },
  minHeight, maxHeight,
  heightScale: 32, heights: 'heights.bin', materials: 'materials.bin', layers,
};
await writeFile(resolve(output, 'terrain.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(output, 'scene.json'), `${JSON.stringify(mission, null, 2)}\n`);
```

Change the `packages/assets/package.json` scripts to:

```json
"fetch": "tsx src/fetch.ts",
"build:assets": "tsx src/fetch.ts && tsx src/build.ts"
```

Run `pnpm assets:build`. Inspect `packages/assets/cache/missions.vl2/missions/Katabatic.mis` and confirm spawn ancestors resolve through `Team1` and `Team2`, or through their `team` properties. Keep `teamFor` generic for both forms.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/assets test && pnpm typecheck && pnpm assets:build`. Then run:

```sh
test "$(wc -c < assets/out/katabatic/heights.bin | tr -d ' ')" = 131072
test "$(wc -c < assets/out/katabatic/materials.bin | tr -d ' ')" = 65536
test "$(find assets/out/katabatic -name 'alpha-*.bin' | wc -l | tr -d ' ')" = 4
```

- [ ] **Step 5: Commit**

```sh
git add packages/assets/package.json packages/assets/src/scene.ts packages/assets/src/fetch.ts packages/assets/src/build.ts packages/assets/src/__fixtures__/scene.mis packages/assets/src/scene.test.ts assets/out/katabatic
git commit -m "feat(assets): build committed Katabatic data" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 5: Match terrain collision to render triangles

**Files:** Create `packages/sim/src/terrain.ts` and `packages/sim/src/terrain.test.ts`
**Interfaces:** Consumes `Heightfield` with raw u16 heights. Produces `sampleTerrain(terrain: Heightfield, x: number, z: number): TerrainSample` and `terrainIndex(terrain: Heightfield, col: number, row: number): number`.

- [ ] **Step 1: Write the failing test**

Create `packages/sim/src/terrain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sampleTerrain, type Heightfield } from './terrain.js';

function field(heights: number[], size = 3): Heightfield {
  return { gridSize: size, squareSize: 8, originX: 0, originY: 0, originZ: 16, heightScale: 1, heights: Uint16Array.from(heights) };
}

describe('sampleTerrain', () => {
  it('clamps grid edges and outside coordinates without throwing', () => {
    const terrain = field([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(sampleTerrain(terrain, -100, 100).height).toBe(10);
    expect(sampleTerrain(terrain, 100, -100).height).toBe(90);
    expect(sampleTerrain(terrain, 16, 0).height).toBe(90);
  });

  it('uses the split45 triangle planes for even parity', () => {
    // Square (col 0, row 0): h00=0, h10=8, h01=16, h11=40. h11 is off-plane so the two
    // diagonals give different answers.
    const terrain = field([0, 8, 0, 16, 40, 0, 0, 0, 0]);
    // u=0.75, v=0.25 lies in triangle (00,10,11): 0 + 0.75*8 + 0.25*(40-8) = 14.
    // The other diagonal's triangle (00,10,01) would give 10.
    expect(sampleTerrain(terrain, 6, 14).height).toBeCloseTo(14);
    // u=0.25, v=0.75 lies in triangle (00,01,11): 0.25*(40-16) + 0.75*16 = 18.
    expect(sampleTerrain(terrain, 2, 10).height).toBeCloseTo(18);
  });

  it('uses the opposite triangle planes for odd parity', () => {
    // Square (col 1, row 0): h00=0, h10=0, h01=8, h11=24.
    const terrain = field([0, 0, 0, 0, 8, 24, 0, 0, 0]);
    // u=0.75, v=0.25, u+v=1 lies in triangle (00,10,01): 0.25*8 = 2.
    // A split45 choice would give 0.25*24 = 6.
    expect(sampleTerrain(terrain, 14, 14).height).toBeCloseTo(2);
    // u=0.25, v=0.875, u+v>1 lies in triangle (11,01,10): 24 + 0.75*(8-24) + 0.125*(0-24) = 9.
    expect(sampleTerrain(terrain, 10, 9).height).toBeCloseTo(9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- terrain.test.ts`. Expect module resolution to fail for `./terrain.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/terrain.ts`:

```ts
export interface Heightfield {
  gridSize: number; squareSize: number; originX: number; originY: number;
  originZ: number; heightScale: number; heights: Uint16Array;
}
export interface TerrainSample {
  height: number;
  normal: { x: number; y: number; z: number };
  col: number; row: number; split45: boolean;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
export function terrainIndex(terrain: Heightfield, col: number, row: number): number {
  return row * terrain.gridSize + col;
}

export function sampleTerrain(terrain: Heightfield, x: number, z: number): TerrainSample {
  const max = terrain.gridSize - 1;
  const gridX = clamp((x - terrain.originX) / terrain.squareSize, 0, max);
  const gridY = clamp((terrain.originZ - z) / terrain.squareSize, 0, max);
  const col = Math.min(Math.floor(gridX), max - 1);
  const row = Math.min(Math.floor(gridY), max - 1);
  const u = gridX - col, v = gridY - row;
  const h = (dx: number, dy: number): number =>
    (terrain.heights[terrainIndex(terrain, col + dx, row + dy)] ?? 0) / terrain.heightScale + terrain.originY;
  const h00 = h(0, 0), h10 = h(1, 0), h01 = h(0, 1), h11 = h(1, 1);
  const split45 = ((col ^ row) & 1) === 0;
  let height: number, du: number, dv: number;
  if (split45 && u >= v) {
    height = h00 + u * (h10 - h00) + v * (h11 - h10); du = h10 - h00; dv = h11 - h10;
  } else if (split45) {
    height = h00 + u * (h11 - h01) + v * (h01 - h00); du = h11 - h01; dv = h01 - h00;
  } else if (u + v <= 1) {
    height = h00 + u * (h10 - h00) + v * (h01 - h00); du = h10 - h00; dv = h01 - h00;
  } else {
    height = h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11); du = h11 - h01; dv = h11 - h10;
  }
  const nx = -du / terrain.squareSize, ny = 1, nz = dv / terrain.squareSize;
  const length = Math.hypot(nx, ny, nz);
  return { height, normal: { x: nx / length, y: ny / length, z: nz / length }, col, row, split45 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test -- terrain.test.ts`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/terrain.ts packages/sim/src/terrain.test.ts
git commit -m "feat(sim): match alternating terrain collision" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 6: Create deterministic fixed-step world state

**Files:** Create `packages/sim/src/random.ts`, `packages/sim/src/types.ts`, `packages/sim/src/world.ts`, `packages/sim/src/index.ts`, and `packages/sim/src/world.test.ts`
**Interfaces:** Consumes `Heightfield` from Task 5. Produces `FIXED_DT`, `FIXED_TICK_MS`, `PlayerInput`, `World`, `createWorld(terrain: Heightfield, seed: number, capacity?: number): World`, `addPlayer(world: World, spawn: Vec3): number`, `nextRandom(state: RandomState): number`, and `stepWorld(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt?: number): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/sim/src/world.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createWorld, nextRandom, stepWorld, type Heightfield } from './index.js';

const terrain: Heightfield = { gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1, heights: new Uint16Array(4) };

describe('fixed world', () => {
  it('generates the same random stream from the same seed', () => {
    const a = { value: 123 }, b = { value: 123 };
    expect([nextRandom(a), nextRandom(a), nextRandom(a)]).toEqual([nextRandom(b), nextRandom(b), nextRandom(b)]);
  });
  it('rejects frame delta instead of the fixed tick', () => {
    const world = createWorld(terrain, 1);
    expect(() => stepWorld(world, new Map(), 1 / 60)).toThrowError(new RangeError('Simulation step requires fixed tick 32 ms'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- world.test.ts`. Expect module resolution to fail for `./index.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/random.ts`:

```ts
export interface RandomState { value: number }
export function nextRandom(state: RandomState): number {
  let value = state.value >>> 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  state.value = value >>> 0;
  return state.value / 0x1_0000_0000;
}
```

Create `packages/sim/src/types.ts`:

```ts
import type { RandomState } from './random.js';
import type { Heightfield } from './terrain.js';

export interface Vec3 { x: number; y: number; z: number }
export interface PlayerInput { moveX: number; moveZ: number; yaw: number; jump: boolean; jet: boolean }
export interface PlayerStore {
  count: number; position: Float64Array; velocity: Float64Array; yaw: Float64Array;
  energy: Float64Array; onGround: Uint8Array; ski: Uint8Array;
  wasGrounded: Uint8Array; wasJumpHeld: Uint8Array; landingSpeed: Float64Array;
}
export interface World { tick: number; random: RandomState; terrain: Heightfield; players: PlayerStore }
```

Create `packages/sim/src/world.ts`:

```ts
import type { Heightfield } from './terrain.js';
import type { PlayerInput, Vec3, World } from './types.js';

export const FIXED_TICK_MS = 32;
export const FIXED_DT = FIXED_TICK_MS / 1000;

export function createWorld(terrain: Heightfield, seed: number, capacity = 32): World {
  return { tick: 0, random: { value: seed || 1 }, terrain, players: {
    count: 0, position: new Float64Array(capacity * 3), velocity: new Float64Array(capacity * 3),
    yaw: new Float64Array(capacity), energy: new Float64Array(capacity), onGround: new Uint8Array(capacity),
    ski: new Uint8Array(capacity), wasGrounded: new Uint8Array(capacity), wasJumpHeld: new Uint8Array(capacity),
    landingSpeed: new Float64Array(capacity),
  } };
}

export function addPlayer(world: World, spawn: Vec3): number {
  const id = world.players.count;
  if (id >= world.players.energy.length) throw new RangeError('Player capacity exceeded');
  world.players.count += 1;
  world.players.position.set([spawn.x, spawn.y, spawn.z], id * 3);
  world.players.energy[id] = 60;
  return id;
}

export function stepWorld(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt = FIXED_DT): void {
  if (dt !== FIXED_DT) throw new RangeError(`Simulation step requires fixed tick ${FIXED_TICK_MS} ms`);
  void inputs;
  world.tick += 1;
}
```

Create `packages/sim/src/index.ts`:

```ts
export * from './random.js';
export * from './terrain.js';
export * from './types.js';
export * from './world.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test -- world.test.ts && pnpm typecheck`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/random.ts packages/sim/src/types.ts packages/sim/src/world.ts packages/sim/src/index.ts packages/sim/src/world.test.ts
git commit -m "feat(sim): create deterministic fixed-step world" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 7: Implement Light armor movement

**Files:** Create `packages/sim/src/armor.ts`, `packages/sim/src/movement.ts`, and `packages/sim/src/movement.test.ts`; Modify `packages/sim/src/world.ts` and `packages/sim/src/index.ts`
**Interfaces:** Consumes `World`, `PlayerInput`, `Heightfield`, and `FIXED_DT`. Produces `LIGHT_ARMOR: ArmorData` and `stepPlayers(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt: number): void`; changes `stepWorld` to call `stepPlayers`.

- [ ] **Step 1: Write the failing test**

Create `packages/sim/src/movement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FIXED_DT, addPlayer, createWorld, sampleTerrain, stepWorld, type Heightfield, type PlayerInput } from './index.js';

const flat: Heightfield = { gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1, heights: new Uint16Array(4) };
const idle: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };
const inputMap = (id: number, input: Partial<PlayerInput>) => new Map([[id, { ...idle, ...input }]]);

describe('Light movement', () => {
  it('reaches and holds 15 m/s when running forward on flat terrain', () => {
    const world = createWorld(flat, 1); const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1; world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < Math.ceil(2 / FIXED_DT); tick += 1) stepWorld(world, inputMap(id, { moveZ: 1 }));
    expect(Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0)).toBeCloseTo(15, 1);
  });

  it('stops from run speed in under 0.5 seconds', () => {
    const world = createWorld(flat, 1); const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.velocity[id * 3 + 2] = 15; world.players.onGround[id] = 1; world.players.wasGrounded[id] = 1;
    for (let tick = 0; tick < Math.floor(0.5 / FIXED_DT); tick += 1) stepWorld(world, inputMap(id, {}));
    expect(Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0)).toBe(0);
  });

  it('refuses a jet at minJetEnergy and never drains below zero', () => {
    const world = createWorld(flat, 1); const id = addPlayer(world, { x: 10, y: 10, z: 10 });
    world.players.energy[id] = 1;
    stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.energy[id]).toBe(1);
    expect(world.players.velocity[id * 3 + 1]).toBeCloseTo(-20 * FIXED_DT);
  });

  it('drains only while jetting and recharges 0.256 per released tick', () => {
    const world = createWorld(flat, 1); const id = addPlayer(world, { x: 10, y: 10, z: 10 });
    for (let tick = 0; tick < 10; tick += 1) stepWorld(world, inputMap(id, { jet: true }));
    expect(world.players.energy[id]).toBeCloseTo(52);
    for (let tick = 0; tick < 100; tick += 1) stepWorld(world, inputMap(id, {}));
    expect(world.players.energy[id]).toBeCloseTo(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- movement.test.ts`. Expect the movement assertions to fail because `stepWorld` has no player system.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/armor.ts`:

```ts
export interface ArmorData {
  mass: number; maxDamage: number; maxEnergy: number; rechargeRate: number;
  jetForce: number; jetEnergyDrain: number; minJetEnergy: number; runForce: number;
  maxForwardSpeed: number; maxBackwardSpeed: number; maxSideSpeed: number;
  jumpForce: number; jumpDelay: number; minJumpSpeed: number; maxJumpSpeed: number;
  horizMaxSpeed: number; horizResistSpeed: number; horizResistFactor: number;
  upMaxSpeed: number; upResistSpeed: number; upResistFactor: number; drag: number;
  boundingBox: readonly [number, number, number]; runSurfaceAngle: number;
  jumpSurfaceAngle: number; speedDamageScale: number; groundFriction: number;
}

export const LIGHT_ARMOR: ArmorData = {
  mass: 90, maxDamage: 0.66, maxEnergy: 60, rechargeRate: 0.256,
  jetForce: 26.21 * 90, jetEnergyDrain: 0.8, minJetEnergy: 1,
  runForce: 55.2 * 90, maxForwardSpeed: 15, maxBackwardSpeed: 13, maxSideSpeed: 13,
  jumpForce: 8.3 * 90, jumpDelay: 0, minJumpSpeed: 20, maxJumpSpeed: 30,
  horizMaxSpeed: 68, horizResistSpeed: 33, horizResistFactor: 0.35,
  upMaxSpeed: 80, upResistSpeed: 25, upResistFactor: 0.3, drag: 0.275,
  boundingBox: [1.2, 1.2, 2.3], runSurfaceAngle: 70, jumpSurfaceAngle: 80,
  speedDamageScale: 0.004,
  groundFriction: 40, // Our tuning value, not a T2 script value.
};
```

Create `packages/sim/src/movement.ts`. Each helper does one job so the repo's
`complexity: 10` lint rule holds. Order per tick: read state, sample terrain, run or
friction, jump edge, ground projection or air gravity, jet, resistance, integrate, collide,
snap, write state.

```ts
import { LIGHT_ARMOR, type ArmorData } from './armor.js';
import { sampleTerrain, type TerrainSample } from './terrain.js';
import type { PlayerInput, PlayerStore, World } from './types.js';

export const GRAVITY = 20;
// Contact tolerance for "is the player standing on the surface".
const GROUND_EPSILON = 0.001;
// A grounded player who did not jump or jet may drop this far in one tick and stay
// grounded. Without it a skier leaves the surface every tick the slope falls away.
const GROUND_SNAP = 1.0;
const IDLE: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };

interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

const degrees = (radians: number): number => (radians * 180) / Math.PI;
const clampAbs = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));
const approachZero = (value: number, amount: number): number => (value <= amount ? 0 : value - amount);

function readBody(players: PlayerStore, id: number): Body {
  const base = id * 3;
  return {
    x: players.position[base] ?? 0,
    y: players.position[base + 1] ?? 0,
    z: players.position[base + 2] ?? 0,
    vx: players.velocity[base] ?? 0,
    vy: players.velocity[base + 1] ?? 0,
    vz: players.velocity[base + 2] ?? 0,
  };
}

function writeBody(players: PlayerStore, id: number, body: Body): void {
  players.position.set([body.x, body.y, body.z], id * 3);
  players.velocity.set([body.vx, body.vy, body.vz], id * 3);
}

/** Add acceleration on one local axis. Never pushes past the cap; always allows braking. */
function accelerateAxis(velocity: number, acceleration: number, cap: number): number {
  if (Math.abs(velocity) <= cap) return clampAbs(velocity + acceleration, cap);
  return Math.sign(acceleration) === Math.sign(velocity) ? velocity : velocity + acceleration;
}

/** Run force in the player's local frame with T2's per-axis speed caps. */
function applyRun(body: Body, input: PlayerInput, armor: ArmorData, dt: number): void {
  const length = Math.hypot(input.moveX, input.moveZ);
  if (length === 0) return;
  const acceleration = (armor.runForce / armor.mass) * dt;
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  const side = body.vx * cos - body.vz * sin;
  const forward = body.vx * sin + body.vz * cos;
  const forwardCap = input.moveZ < 0 ? armor.maxBackwardSpeed : armor.maxForwardSpeed;
  const nextSide = accelerateAxis(side, (input.moveX / length) * acceleration, armor.maxSideSpeed);
  const nextForward = accelerateAxis(forward, (input.moveZ / length) * acceleration, forwardCap);
  body.vx = nextSide * cos + nextForward * sin;
  body.vz = nextForward * cos - nextSide * sin;
}

/** Ground friction when standing still on the surface without skiing. */
function applyFriction(body: Body, armor: ArmorData, dt: number): void {
  const speed = Math.hypot(body.vx, body.vz);
  if (speed === 0) return;
  const next = approachZero(speed, armor.groundFriction * dt);
  body.vx *= next / speed;
  body.vz *= next / speed;
}

/** Remove any velocity into the surface, then add the slope component of gravity. */
function applyGround(body: Body, sample: TerrainSample, dt: number): void {
  const { x: nx, y: ny, z: nz } = sample.normal;
  const along = body.vx * nx + body.vy * ny + body.vz * nz;
  if (along < 0) {
    body.vx -= along * nx;
    body.vy -= along * ny;
    body.vz -= along * nz;
  }
  body.vx += GRAVITY * ny * nx * dt;
  body.vy -= GRAVITY * (1 - ny * ny) * dt;
  body.vz += GRAVITY * ny * nz * dt;
}

function applyAir(body: Body, armor: ArmorData, dt: number): void {
  body.vy -= GRAVITY * dt;
  const airDrag = Math.max(0, 1 - armor.drag * dt);
  body.vx *= airDrag;
  body.vz *= airDrag;
}

/** Returns true when the jet fired this tick. Recharges only while the jet key is up. */
function applyJet(players: PlayerStore, id: number, body: Body, input: PlayerInput, armor: ArmorData, dt: number): boolean {
  const energy = players.energy[id] ?? 0;
  if (input.jet && energy > armor.minJetEnergy) {
    body.vy += (armor.jetForce / armor.mass) * dt;
    players.energy[id] = Math.max(0, energy - armor.jetEnergyDrain);
    return true;
  }
  if (!input.jet) players.energy[id] = Math.min(armor.maxEnergy, energy + armor.rechargeRate);
  return false;
}

function applyResistance(body: Body, armor: ArmorData, dt: number): void {
  const horizontal = Math.hypot(body.vx, body.vz);
  if (horizontal > armor.horizResistSpeed) {
    const resisted = Math.min(armor.horizMaxSpeed, horizontal * (1 - armor.horizResistFactor * dt));
    body.vx *= resisted / horizontal;
    body.vz *= resisted / horizontal;
  }
  if (Math.abs(body.vy) > armor.upResistSpeed) {
    const resisted = Math.min(armor.upMaxSpeed, Math.abs(body.vy) * (1 - armor.upResistFactor * dt));
    body.vy = Math.sign(body.vy) * resisted;
  }
}

interface Contact {
  grounded: boolean;
  landingSpeed: number;
}

/** Integrate, then resolve terrain contact: land, snap down, or stay airborne. */
function integrate(world: World, body: Body, wasGrounded: boolean, leftGround: boolean, dt: number): Contact {
  const impactSpeed = Math.max(0, -body.vy);
  body.x += body.vx * dt;
  body.y += body.vy * dt;
  body.z += body.vz * dt;
  const landing = sampleTerrain(world.terrain, body.x, body.z);
  const gap = body.y - landing.height;
  if (gap <= 0) {
    body.y = landing.height;
    applyGround(body, landing, 0);
    return { grounded: true, landingSpeed: wasGrounded ? -1 : impactSpeed };
  }
  if (wasGrounded && !leftGround && gap <= GROUND_SNAP) {
    body.y = landing.height;
    return { grounded: true, landingSpeed: -1 };
  }
  return { grounded: false, landingSpeed: -1 };
}

interface TickContext {
  sample: TerrainSample;
  grounded: boolean;
  slope: number;
  forcedSki: boolean;
  skiing: boolean;
  mayRun: boolean;
}

function classify(world: World, body: Body, input: PlayerInput, armor: ArmorData): TickContext {
  const sample = sampleTerrain(world.terrain, body.x, body.z);
  const grounded = body.y <= sample.height + GROUND_EPSILON;
  const slope = degrees(Math.acos(Math.max(-1, Math.min(1, sample.normal.y))));
  const forcedSki = slope > armor.runSurfaceAngle;
  const skiing = grounded && (input.jump || forcedSki);
  const belowRunSpeed = Math.hypot(body.vx, body.vz) < armor.maxForwardSpeed;
  const mayRun = grounded && !forcedSki && (!input.jump || belowRunSpeed);
  return { sample, grounded, slope, forcedSki, skiing, mayRun };
}

const isIdleOnGround = (ctx: TickContext, input: PlayerInput): boolean =>
  ctx.grounded && !ctx.skiing && input.moveX === 0 && input.moveZ === 0;

interface Forces {
  jumped: boolean;
  jetted: boolean;
}

function applyForces(players: PlayerStore, id: number, body: Body, input: PlayerInput, ctx: TickContext, armor: ArmorData, dt: number): Forces {
  if (ctx.mayRun) applyRun(body, input, armor, dt);
  if (isIdleOnGround(ctx, input)) applyFriction(body, armor, dt);
  const jumpEdge = input.jump && (!players.wasJumpHeld[id] || !players.wasGrounded[id]);
  const jumped = ctx.grounded && jumpEdge && ctx.slope <= armor.jumpSurfaceAngle;
  if (jumped) body.vy = Math.max(body.vy, armor.jumpForce / armor.mass);
  if (ctx.grounded) applyGround(body, ctx.sample, dt);
  else applyAir(body, armor, dt);
  const jetted = applyJet(players, id, body, input, armor, dt);
  return { jumped, jetted };
}

function writeState(players: PlayerStore, id: number, body: Body, contact: Contact, input: PlayerInput, skiing: boolean): void {
  writeBody(players, id, body);
  if (contact.landingSpeed >= 0) players.landingSpeed[id] = contact.landingSpeed;
  players.onGround[id] = contact.grounded ? 1 : 0;
  players.ski[id] = skiing ? 1 : 0;
  players.wasGrounded[id] = contact.grounded ? 1 : 0;
  players.wasJumpHeld[id] = input.jump ? 1 : 0;
}

function stepPlayer(world: World, id: number, input: PlayerInput, armor: ArmorData, dt: number): void {
  const players = world.players;
  const body = readBody(players, id);
  players.yaw[id] = input.yaw;
  const ctx = classify(world, body, input, armor);
  const forces = applyForces(players, id, body, input, ctx, armor, dt);
  applyResistance(body, armor, dt);
  const contact = integrate(world, body, ctx.grounded, forces.jumped || forces.jetted, dt);
  writeState(players, id, body, contact, input, ctx.skiing);
}

export function stepPlayers(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt: number): void {
  for (let id = 0; id < world.players.count; id += 1) {
    const input = inputs.get(id) ?? { ...IDLE, yaw: world.players.yaw[id] ?? 0 };
    stepPlayer(world, id, input, LIGHT_ARMOR, dt);
  }
}
```

Landing keeps momentum: `integrate` calls `applyGround` with `dt = 0`, which removes only
the velocity component into the surface. A skier who hits a slope at 80 m/s keeps the
tangent part. That redirect is the T2 skiing feel, so Task 8's landing test checks
"no velocity into the surface" rather than "vertical velocity is zero".

Add `import { stepPlayers } from './movement.js';` to `packages/sim/src/world.ts`. Replace `void inputs;` with `stepPlayers(world, inputs, dt);`. Add these exports to `packages/sim/src/index.ts`:

```ts
export * from './armor.js';
export * from './movement.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test -- movement.test.ts && pnpm typecheck`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/armor.ts packages/sim/src/movement.ts packages/sim/src/world.ts packages/sim/src/index.ts packages/sim/src/movement.test.ts
git commit -m "feat(sim): implement Light armor movement" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 8: Lock slope, jump, cap, and landing behavior

**Files:** Modify `packages/sim/src/movement.test.ts`
**Interfaces:** Consumes `stepWorld`, `LIGHT_ARMOR`, and player state from Task 7. Produces no new public symbol. Verifies `ski`, `onGround`, and `landingSpeed` behavior.

- [ ] **Step 1: Write the failing test**

Append these tests inside the existing `describe` block:

```ts
  it('pushes a fast descending player onto a slope and records landing speed', () => {
    const slope: Heightfield = { gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1, heights: Uint16Array.from([0, 4, 0, 4]) };
    const world = createWorld(slope, 1); const id = addPlayer(world, { x: 4, y: 3, z: 4 });
    world.players.velocity[id * 3 + 1] = -80;
    stepWorld(world, inputMap(id, {}));
    expect(world.players.position[id * 3 + 1]).toBeCloseTo(2);
    // Landing removes the velocity into the surface and keeps the tangent part.
    const { normal } = sampleTerrain(slope, 4, 4);
    const [vx, vy, vz] = [world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 1] ?? 0, world.players.velocity[id * 3 + 2] ?? 0];
    expect(vx * normal.x + vy * normal.y + vz * normal.z).toBeCloseTo(0);
    expect(Math.hypot(vx, vy, vz)).toBeGreaterThan(30);
    expect(world.players.landingSpeed[id]).toBeGreaterThanOrEqual(80);
  });

  it('gains speed every tick while skiing down a 20 degree slope for 3 seconds', () => {
    const rise = Math.tan(20 * Math.PI / 180) * 1000;
    const slope: Heightfield = { gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1, heights: Uint16Array.from([Math.round(rise), Math.round(rise), 0, 0]) };
    const world = createWorld(slope, 1); const id = addPlayer(world, { x: 500, y: rise / 2, z: 500 });
    world.players.onGround[id] = 1; world.players.wasGrounded[id] = 1; world.players.wasJumpHeld[id] = 1;
    let previous = 0;
    for (let tick = 0; tick < Math.ceil(3 / FIXED_DT); tick += 1) {
      stepWorld(world, inputMap(id, { jump: true }));
      const speed = Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0);
      expect(speed + 1e-9).toBeGreaterThanOrEqual(previous);
      previous = speed;
    }
    // 3 s at g*sin(20 deg) = 6.84 m/s^2 stays under horizResistSpeed (33), so speed is
    // monotonic. Above 33 the resistance term can win a tick and the assertion is invalid.
    expect(previous).toBeGreaterThan(15);
  });

  it('fires one jump impulse and refuses it above 80 degrees', () => {
    const world = createWorld(flat, 1); const id = addPlayer(world, { x: 10, y: 0, z: 10 });
    world.players.onGround[id] = 1; world.players.wasGrounded[id] = 1;
    stepWorld(world, inputMap(id, { jump: true }));
    const first = world.players.velocity[id * 3 + 1] ?? 0;
    stepWorld(world, inputMap(id, { jump: true }));
    expect(world.players.velocity[id * 3 + 1]).toBeLessThan(first);

    const cliff: Heightfield = { gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1, heights: Uint16Array.from([64, 64, 0, 0]) };
    const steep = createWorld(cliff, 1); const steepId = addPlayer(steep, { x: 4, y: 32, z: 4 });
    steep.players.onGround[steepId] = 1; steep.players.wasGrounded[steepId] = 1;
    stepWorld(steep, inputMap(steepId, { jump: true }));
    // Refused jump: no upward impulse. Slope gravity may pull the value below zero.
    expect(steep.players.velocity[steepId * 3 + 1]).toBeLessThanOrEqual(0);
    expect(steep.players.ski[steepId]).toBe(1);
  });

  it('hard caps horizontal speed at 68 m/s for 100 ticks', () => {
    const slope: Heightfield = { gridSize: 2, squareSize: 1000, originX: 0, originY: 0, originZ: 1000, heightScale: 1, heights: Uint16Array.from([1000, 1000, 0, 0]) };
    const world = createWorld(slope, 1); const id = addPlayer(world, { x: 500, y: 500, z: 500 });
    world.players.velocity[id * 3 + 2] = -80; // downhill: row 1 (z = 0) is the low edge
    world.players.wasGrounded[id] = 1; world.players.wasJumpHeld[id] = 1;
    for (let tick = 0; tick < 100; tick += 1) stepWorld(world, inputMap(id, { jump: true }));
    expect(Math.hypot(world.players.velocity[id * 3] ?? 0, world.players.velocity[id * 3 + 2] ?? 0)).toBeLessThanOrEqual(68);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/sim test -- movement.test.ts`. Expect any disagreement to identify a movement defect. Do not change the verified armor values or the hard cap.

- [ ] **Step 3: Write minimal implementation**

Fix only the failing helper in `packages/sim/src/movement.ts`. The tick order is fixed by Task 7: run or friction, jump edge, ground projection or air gravity, jet, resistance, integrate, contact or snap, state edges. Do not change the armor values, the caps, `GROUND_SNAP`, or the tick order. If all new tests pass immediately, leave the implementation unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/sim test && pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```sh
git add packages/sim/src/movement.ts packages/sim/src/movement.test.ts
git commit -m "test(sim): lock skiing and landing behavior" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 9: Render Katabatic terrain and environment

**Files:** Create `packages/client/src/assets.ts`, `packages/client/src/terrain.ts`, `packages/client/src/terrain.test.ts`, and `packages/client/vite.config.ts`
**Interfaces:** Consumes the `TerrainManifest` and `SceneData` JSON shapes from Task 4. Produces `loadKatabatic(): Promise<KatabaticAssets>`, `buildTerrainGeometry(data: KatabaticAssets): THREE.BufferGeometry`, `createTerrain(data: KatabaticAssets): Promise<THREE.Mesh>`, and `addEnvironment(target: THREE.Scene, data: KatabaticAssets): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/terrain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTerrainGeometry } from './terrain.js';
import type { KatabaticAssets } from './assets.js';

const data = {
  terrain: { gridSize: 3, squareSize: 8, origin: { x: 0, y: 0, z: 16 }, minHeight: 0, maxHeight: 0, heightScale: 32, heights: 'heights.bin', materials: 'materials.bin', layers: [] },
  scene: { terrain: { terrainFile: 'x', squareSize: 8, position: [0, 0, 16] }, sun: { direction: [1, -1, 0], color: [0.7, 0.7, 0.7, 1], ambient: [0.3, 0.3, 0.3, 1] }, sky: { visibleDistance: 500, fogDistance: 400, fogColor: [0.65, 0.65, 0.7, 1], materialList: '' }, missionArea: { minX: 0, minZ: 0, width: 16, depth: 16 }, spawns: [] },
  heights: new Uint16Array(9), materials: new Uint8Array(9), alphaMaps: [],
} as KatabaticAssets;

describe('buildTerrainGeometry', () => {
  it('uses split45 on even squares and the opposite split on odd squares', () => {
    const index = [...(buildTerrainGeometry(data).getIndex()?.array ?? [])];
    expect(index.slice(0, 6)).toEqual([0, 3, 4, 0, 4, 1]);
    expect(index.slice(6, 12)).toEqual([1, 4, 2, 2, 4, 5]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- terrain.test.ts`. Expect module resolution to fail for `./terrain.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/assets.ts`:

```ts
export interface TerrainManifest {
  gridSize: number; squareSize: number; origin: { x: number; y: number; z: number };
  minHeight: number; maxHeight: number; heightScale: number; heights: string; materials: string;
  layers: Array<{ name: string; texture: string; alpha: string }>;
}
export interface ClientSceneData {
  terrain: { terrainFile: string; squareSize: number; position: [number, number, number] };
  sun: { direction: [number, number, number]; color: [number, number, number, number]; ambient: [number, number, number, number] };
  sky: { visibleDistance: number; fogDistance: number; fogColor: [number, number, number, number]; materialList: string };
  missionArea: { minX: number; minZ: number; width: number; depth: number };
  spawns: Array<{ name: string | null; team: number; position: [number, number, number]; radius: number }>;
}
export interface KatabaticAssets {
  terrain: TerrainManifest; scene: ClientSceneData; heights: Uint16Array;
  materials: Uint8Array; alphaMaps: Uint8Array[];
}

const ROOT = '/katabatic/';
async function response(path: string): Promise<Response> {
  const result = await fetch(`${ROOT}${path}`);
  if (!result.ok) throw new Error(`Asset load failed ${result.status}: ${path}`);
  return result;
}
export async function loadKatabatic(): Promise<KatabaticAssets> {
  const terrain = await (await response('terrain.json')).json() as TerrainManifest;
  const scene = await (await response('scene.json')).json() as ClientSceneData;
  const heightBytes = await (await response(terrain.heights)).arrayBuffer();
  const heightView = new DataView(heightBytes);
  const heights = new Uint16Array(heightBytes.byteLength / 2);
  for (let index = 0; index < heights.length; index += 1) heights[index] = heightView.getUint16(index * 2, true);
  const materials = new Uint8Array(await (await response(terrain.materials)).arrayBuffer());
  const alphaMaps = await Promise.all(terrain.layers.map(async (layer) => new Uint8Array(await (await response(layer.alpha)).arrayBuffer())));
  return { terrain, scene, heights, materials, alphaMaps };
}
```

Create `packages/client/src/terrain.ts`:

```ts
import * as THREE from 'three';
import type { KatabaticAssets } from './assets.js';

export function fogColor(data: KatabaticAssets): THREE.Color {
  const [r, g, b] = data.scene.sky.fogColor;
  return new THREE.Color(r, g, b);
}

export function buildTerrainGeometry(data: KatabaticAssets): THREE.BufferGeometry {
  const { gridSize, squareSize, origin, heightScale } = data.terrain;
  const positions = new Float32Array(gridSize * gridSize * 3);
  const uvs = new Float32Array(gridSize * gridSize * 2);
  for (let row = 0; row < gridSize; row += 1) for (let col = 0; col < gridSize; col += 1) {
    const point = row * gridSize + col;
    positions.set([origin.x + col * squareSize, origin.y + (data.heights[point] ?? 0) / heightScale, origin.z - row * squareSize], point * 3);
    uvs.set([col / (gridSize - 1), row / (gridSize - 1)], point * 2);
  }
  const indices: number[] = [];
  for (let row = 0; row < gridSize - 1; row += 1) for (let col = 0; col < gridSize - 1; col += 1) {
    const a = row * gridSize + col, b = a + 1, c = a + gridSize, d = c + 1;
    if (((col ^ row) & 1) === 0) indices.push(a, c, d, a, d, b);
    else indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

export async function createTerrain(data: KatabaticAssets): Promise<THREE.Mesh> {
  const loader = new THREE.TextureLoader();
  const textures = await Promise.all(data.terrain.layers.map(async (layer) => loader.loadAsync(`/katabatic/${layer.texture}`)));
  textures.forEach((texture) => { texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.colorSpace = THREE.SRGBColorSpace; });
  const alpha = data.alphaMaps.map((bytes) => {
    const texture = new THREE.DataTexture(bytes, data.terrain.gridSize, data.terrain.gridSize, THREE.RedFormat);
    texture.needsUpdate = true; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter;
    return texture;
  });
  const material = new THREE.ShaderMaterial({
    fog: true,
    uniforms: {
      map0: { value: textures[0] }, map1: { value: textures[1] }, map2: { value: textures[2] }, map3: { value: textures[3] },
      alpha0: { value: alpha[0] }, alpha1: { value: alpha[1] }, alpha2: { value: alpha[2] }, alpha3: { value: alpha[3] },
      fogColor: { value: fogColor(data) }, fogNear: { value: data.scene.sky.fogDistance }, fogFar: { value: data.scene.sky.visibleDistance },
    },
    vertexShader: `varying vec2 vUv; varying float vFogDepth; void main(){vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.0);vFogDepth=-mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `uniform sampler2D map0,map1,map2,map3,alpha0,alpha1,alpha2,alpha3;uniform vec3 fogColor;uniform float fogNear,fogFar;varying vec2 vUv;varying float vFogDepth;void main(){vec2 tile=vUv*64.0;vec4 w=vec4(texture2D(alpha0,vUv).r,texture2D(alpha1,vUv).r,texture2D(alpha2,vUv).r,texture2D(alpha3,vUv).r);w/=max(dot(w,vec4(1.0)),0.0001);vec3 color=texture2D(map0,tile).rgb*w.x+texture2D(map1,tile).rgb*w.y+texture2D(map2,tile).rgb*w.z+texture2D(map3,tile).rgb*w.w;float fog=smoothstep(fogNear,fogFar,vFogDepth);gl_FragColor=vec4(mix(color,fogColor,fog),1.0);}`,
  });
  const mesh = new THREE.Mesh(buildTerrainGeometry(data), material);
  mesh.receiveShadow = true; mesh.name = 'katabatic-terrain';
  return mesh;
}

export function addEnvironment(target: THREE.Scene, data: KatabaticAssets): void {
  const skyMaterial = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x5b7899) }, bottom: { value: new THREE.Color(0xd7e2e8) } },
    vertexShader: `varying vec3 world;void main(){world=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform vec3 top,bottom;varying vec3 world;void main(){float h=clamp(normalize(world).y*0.5+0.5,0.0,1.0);gl_FragColor=vec4(mix(bottom,top,h),1.0);}`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), skyMaterial);
  sky.name = 'sky'; // Task 10 moves this mesh to the camera position every frame.
  target.add(sky);
  const sun = new THREE.DirectionalLight(new THREE.Color(...data.scene.sun.color.slice(0, 3) as [number, number, number]), 1);
  sun.position.fromArray(data.scene.sun.direction).multiplyScalar(-300); sun.castShadow = true; target.add(sun);
  target.add(new THREE.AmbientLight(new THREE.Color(...data.scene.sun.ambient.slice(0, 3) as [number, number, number]), 1));
  target.fog = new THREE.Fog(fogColor(data), data.scene.sky.fogDistance, data.scene.sky.visibleDistance);
  target.background = fogColor(data);
}
```

Replace `packages/client/vite.config.ts` (the scaffold version aliased `/assets`; serving `assets/out` as the public dir is simpler and gives `/katabatic/...` URLs):

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: '../../assets/out',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { name: 'client', environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test -- terrain.test.ts && pnpm typecheck`.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/assets.ts packages/client/src/terrain.ts packages/client/src/terrain.test.ts packages/client/vite.config.ts
git commit -m "feat(client): render Katabatic terrain" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 10: Input, fixed-step loop, first-person player

**Files:** Create `packages/client/src/loop.ts`, `packages/client/src/loop.test.ts`, `packages/client/src/input.ts`, `packages/client/src/app.ts`; Modify `packages/client/src/main.ts`
**Interfaces:** Consumes `loadKatabatic`, `createTerrain`, `addEnvironment` (Task 9) and `createWorld`, `addPlayer`, `stepWorld`, `sampleTerrain`, `FIXED_DT`, `Heightfield`, `PlayerInput` (Tasks 5 to 7). Produces `advance(acc: Accumulator, frameSeconds: number, timeScale: number, fixedDt: number): number`, `Input` (class with `attach()`, `snapshot(): PlayerInput`, `isDown(code: string): boolean`, `yaw`, `pitch`), and `App` (`createApp(container: HTMLElement): Promise<App>`) with fields `world`, `playerId`, `input`, `camera`, `scene`, `renderer`, `timeScale`, `paused`, `stepOnce`, `freeCam`, `freeCamPosition`, `stats: { fps, frameMs, simMs }`, and `frame(dtSeconds: number): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/loop.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_STEPS_PER_FRAME, advance, type Accumulator } from './loop.js';

const DT = 0.032;

describe('advance', () => {
  it('accumulates sub-tick frames into whole steps', () => {
    const acc: Accumulator = { remainder: 0 };
    let steps = 0;
    for (let frame = 0; frame < 32; frame += 1) steps += advance(acc, 1 / 60, 1, DT);
    expect(steps).toBe(16);
    expect(acc.remainder).toBeCloseTo(32 / 60 - 16 * DT);
  });

  it('caps a long frame and drops the excess time', () => {
    const acc: Accumulator = { remainder: 0 };
    expect(advance(acc, 1, 1, DT)).toBe(MAX_STEPS_PER_FRAME);
    expect(acc.remainder).toBe(0);
  });

  it('runs nothing at time scale zero or for a negative frame', () => {
    const acc: Accumulator = { remainder: 0 };
    expect(advance(acc, 0.1, 0, DT)).toBe(0);
    expect(advance(acc, -0.1, 1, DT)).toBe(0);
    expect(acc.remainder).toBe(0);
  });

  it('scales frame time by the time scale', () => {
    const acc: Accumulator = { remainder: 0 };
    expect(advance(acc, DT, 4, DT)).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- loop.test.ts`. Expect module resolution to fail for `./loop.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/loop.ts`:

```ts
export const MAX_STEPS_PER_FRAME = 5;

export interface Accumulator {
  remainder: number;
}

/**
 * Fixed-step accumulator. Returns the number of simulation steps to run for this frame.
 * A frame longer than MAX_STEPS_PER_FRAME steps drops the excess instead of spiralling.
 */
export function advance(acc: Accumulator, frameSeconds: number, timeScale: number, fixedDt: number): number {
  acc.remainder += Math.max(0, frameSeconds) * timeScale;
  const steps = Math.floor(acc.remainder / fixedDt);
  if (steps > MAX_STEPS_PER_FRAME) {
    acc.remainder = 0;
    return MAX_STEPS_PER_FRAME;
  }
  acc.remainder -= steps * fixedDt;
  return steps;
}
```

Create `packages/client/src/input.ts`:

```ts
import type { PlayerInput } from '@clans/sim';

const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Pointer-lock mouse look plus keyboard state. Yaw follows the sim convention: forward is
 * (sin yaw, 0, cos yaw) in world space, so yaw decreases when the mouse moves right.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  jet = false;
  sensitivity = 0.002;
  private readonly keys = new Set<string>();

  constructor(private readonly target: HTMLElement) {}

  attach(): void {
    const { target } = this;
    target.addEventListener('click', () => {
      if (document.pointerLockElement !== target) target.requestPointerLock();
    });
    target.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space' || event.code.startsWith('F')) event.preventDefault();
      this.keys.add(event.code);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousedown', (event) => {
      if (event.button === 2) this.jet = true;
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 2) this.jet = false;
    });
    window.addEventListener('mousemove', (event) => this.look(event));
  }

  private look(event: MouseEvent): void {
    if (document.pointerLockElement !== this.target) return;
    this.yaw -= event.movementX * this.sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - event.movementY * this.sensitivity));
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** The sim input for this tick. Keys work without pointer lock; only the mouse needs it. */
  snapshot(): PlayerInput {
    const axis = (positive: string, negative: string): number =>
      (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
    return {
      moveX: axis('KeyD', 'KeyA'),
      moveZ: axis('KeyW', 'KeyS'),
      yaw: this.yaw,
      jump: this.isDown('Space'),
      jet: this.jet,
    };
  }
}
```

Create `packages/client/src/app.ts`:

```ts
import * as THREE from 'three';
import {
  FIXED_DT,
  addPlayer,
  createWorld,
  sampleTerrain,
  stepWorld,
  type Heightfield,
  type PlayerInput,
  type World,
} from '@clans/sim';
import { loadKatabatic, type KatabaticAssets } from './assets.js';
import { Input } from './input.js';
import { advance, type Accumulator } from './loop.js';
import { addEnvironment, createTerrain } from './terrain.js';

// Light armor is 2.3 m tall; the camera sits just below the top of the bounding box.
const EYE_HEIGHT = 2.0;
const FREE_CAM_SPEED = 40;
const FREE_CAM_FAST = 4;
const IDLE: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false };

export interface AppStats {
  fps: number;
  frameMs: number;
  simMs: number;
}

export interface App {
  world: World;
  playerId: number;
  input: Input;
  assets: KatabaticAssets;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  timeScale: number;
  paused: boolean;
  stepOnce: boolean;
  freeCam: boolean;
  freeCamPosition: THREE.Vector3;
  stats: AppStats;
  frame(dtSeconds: number): void;
}

function toHeightfield(assets: KatabaticAssets): Heightfield {
  const { gridSize, squareSize, origin, heightScale } = assets.terrain;
  return {
    gridSize,
    squareSize,
    originX: origin.x,
    originY: origin.y,
    originZ: origin.z,
    heightScale,
    heights: assets.heights,
  };
}

function spawnPoint(assets: KatabaticAssets, terrain: Heightfield): { x: number; y: number; z: number } {
  const spawn = assets.scene.spawns.find((candidate) => candidate.team === 1);
  if (!spawn) throw new Error('Katabatic scene has no team 1 spawn');
  const [x, y, z] = spawn.position;
  const ground = sampleTerrain(terrain, x, z).height;
  return { x, y: Math.max(y, ground + 0.1), z };
}

function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  container.replaceChildren(renderer.domElement);
  return renderer;
}

/** Camera looks along (sin yaw, 0, cos yaw) for yaw 0, which is Three's rotation.y = yaw + PI. */
function aimCamera(camera: THREE.PerspectiveCamera, yaw: number, pitch: number): void {
  camera.rotation.set(pitch, yaw + Math.PI, 0, 'YXZ');
}

function moveFreeCam(app: App, dt: number): void {
  const speed = FREE_CAM_SPEED * (app.input.isDown('ShiftLeft') ? FREE_CAM_FAST : 1) * dt;
  const forward = new THREE.Vector3();
  app.camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, app.camera.up).normalize();
  const move = app.input.snapshot();
  app.freeCamPosition.addScaledVector(forward, move.moveZ * speed);
  app.freeCamPosition.addScaledVector(right, move.moveX * speed);
  if (app.input.isDown('Space')) app.freeCamPosition.y += speed;
  if (app.input.isDown('ControlLeft')) app.freeCamPosition.y -= speed;
}

function placeCamera(app: App, sky: THREE.Object3D): void {
  aimCamera(app.camera, app.input.yaw, app.input.pitch);
  if (app.freeCam) {
    app.camera.position.copy(app.freeCamPosition);
  } else {
    const base = app.playerId * 3;
    const position = app.world.players.position;
    app.camera.position.set(position[base] ?? 0, (position[base + 1] ?? 0) + EYE_HEIGHT, position[base + 2] ?? 0);
  }
  sky.position.copy(app.camera.position);
}

export async function createApp(container: HTMLElement): Promise<App> {
  const assets = await loadKatabatic();
  const terrain = toHeightfield(assets);
  const world = createWorld(terrain, 1);
  const playerId = addPlayer(world, spawnPoint(assets, terrain));

  const scene = new THREE.Scene();
  addEnvironment(scene, assets);
  scene.add(await createTerrain(assets));
  const sky = scene.getObjectByName('sky');
  if (!sky) throw new Error('addEnvironment did not add the sky');

  const camera = new THREE.PerspectiveCamera(90, container.clientWidth / container.clientHeight, 0.1, 1200);
  const renderer = createRenderer(container);
  const input = new Input(renderer.domElement);
  input.attach();
  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  const acc: Accumulator = { remainder: 0 };
  let fpsWindowStart = performance.now();
  let fpsFrames = 0;

  const app: App = {
    world,
    playerId,
    input,
    assets,
    camera,
    scene,
    renderer,
    timeScale: 1,
    paused: false,
    stepOnce: false,
    freeCam: false,
    freeCamPosition: new THREE.Vector3(),
    stats: { fps: 0, frameMs: 0, simMs: 0 },
    frame(dtSeconds: number): void {
      const frameStart = performance.now();
      let steps = advance(acc, dtSeconds, app.paused ? 0 : app.timeScale, FIXED_DT);
      if (app.stepOnce) {
        steps = 1;
        app.stepOnce = false;
      }
      const inputs = new Map<number, PlayerInput>([
        [playerId, app.freeCam ? { ...IDLE, yaw: input.yaw } : input.snapshot()],
      ]);
      const simStart = performance.now();
      for (let step = 0; step < steps; step += 1) stepWorld(world, inputs);
      app.stats.simMs = performance.now() - simStart;
      if (app.freeCam) moveFreeCam(app, dtSeconds);
      placeCamera(app, sky);
      renderer.render(scene, camera);
      app.stats.frameMs = performance.now() - frameStart;
      fpsFrames += 1;
      if (frameStart - fpsWindowStart >= 500) {
        app.stats.fps = (fpsFrames * 1000) / (frameStart - fpsWindowStart);
        fpsWindowStart = frameStart;
        fpsFrames = 0;
      }
    },
  };
  return app;
}
```

Replace `packages/client/src/main.ts`:

```ts
import { createApp } from './app.js';

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

const app = await createApp(container);
let last = performance.now();
const tick = (now: number): void => {
  app.frame((now - last) / 1000);
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`. Then run `pnpm dev`, open `http://127.0.0.1:5173`, click, and confirm: the terrain renders with fog, W moves, Space held while moving downhill speeds up, right mouse lifts, the mouse turns the view.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/loop.ts packages/client/src/loop.test.ts packages/client/src/input.ts packages/client/src/app.ts packages/client/src/main.ts
git commit -m "feat(client): first-person Light armor on Katabatic with fixed-step loop" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 11: Debug overlay

**Files:** Create `packages/client/src/stats.ts`, `packages/client/src/stats.test.ts`, `packages/client/src/debug.ts`; Modify `packages/client/src/main.ts`, `packages/client/index.html`
**Interfaces:** Consumes `App` from Task 10. Produces `describePlayer(world: World, playerId: number, stats: AppStats): DebugRow[]` where `DebugRow = { id: string; label: string; text: string; value: number }`, and `createDebug(app: App, container: HTMLElement): { update(): void }`.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/stats.test.ts`:

```ts
import { addPlayer, createWorld, type Heightfield } from '@clans/sim';
import { describe, expect, it } from 'vitest';
import { describePlayer } from './stats.js';

const flat: Heightfield = { gridSize: 2, squareSize: 8, originX: 0, originY: 0, originZ: 8, heightScale: 1, heights: new Uint16Array(4) };

describe('describePlayer', () => {
  it('reports speed as the horizontal magnitude and flags as 0 or 1', () => {
    const world = createWorld(flat, 1);
    const id = addPlayer(world, { x: 1, y: 2, z: 3 });
    world.players.velocity.set([3, 9, 4], id * 3);
    world.players.onGround[id] = 1;
    const rows = Object.fromEntries(describePlayer(world, id, { fps: 60, frameMs: 2.5, simMs: 0.4 }).map((row) => [row.id, row]));
    expect(rows['debug-speed']?.value).toBe(5);
    expect(rows['debug-speed']?.text).toBe('5.0 m/s');
    expect(rows['debug-pos']?.text).toBe('1.0, 2.0, 3.0');
    expect(rows['debug-ground']?.value).toBe(1);
    expect(rows['debug-ski']?.value).toBe(0);
    expect(rows['debug-energy']?.value).toBe(60);
    expect(rows['debug-fps']?.text).toBe('60');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm --filter @clans/client test -- stats.test.ts`. Expect module resolution to fail for `./stats.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/client/src/stats.ts`:

```ts
import type { World } from '@clans/sim';
import type { AppStats } from './app.js';

export interface DebugRow {
  id: string;
  label: string;
  text: string;
  value: number;
}

const fixed = (value: number, digits = 1): string => value.toFixed(digits);

export function describePlayer(world: World, playerId: number, stats: AppStats): DebugRow[] {
  const base = playerId * 3;
  const p = world.players;
  const [x, y, z] = [p.position[base] ?? 0, p.position[base + 1] ?? 0, p.position[base + 2] ?? 0];
  const [vx, vy, vz] = [p.velocity[base] ?? 0, p.velocity[base + 1] ?? 0, p.velocity[base + 2] ?? 0];
  const speed = Math.hypot(vx, vz);
  const energy = p.energy[playerId] ?? 0;
  return [
    { id: 'debug-fps', label: 'fps', text: fixed(stats.fps, 0), value: stats.fps },
    { id: 'debug-frame-ms', label: 'frame', text: `${fixed(stats.frameMs, 2)} ms`, value: stats.frameMs },
    { id: 'debug-sim-ms', label: 'sim', text: `${fixed(stats.simMs, 2)} ms`, value: stats.simMs },
    { id: 'debug-tick', label: 'tick', text: String(world.tick), value: world.tick },
    { id: 'debug-pos', label: 'pos', text: `${fixed(x)}, ${fixed(y)}, ${fixed(z)}`, value: y },
    { id: 'debug-vel', label: 'vel', text: `${fixed(vx)}, ${fixed(vy)}, ${fixed(vz)}`, value: vy },
    { id: 'debug-speed', label: 'speed', text: `${fixed(speed)} m/s`, value: speed },
    { id: 'debug-energy', label: 'energy', text: fixed(energy), value: energy },
    { id: 'debug-ground', label: 'ground', text: String(p.onGround[playerId] ?? 0), value: p.onGround[playerId] ?? 0 },
    { id: 'debug-ski', label: 'ski', text: String(p.ski[playerId] ?? 0), value: p.ski[playerId] ?? 0 },
  ];
}
```

Create `packages/client/src/debug.ts`:

```ts
import GUI from 'lil-gui';
import type { App } from './app.js';
import { describePlayer } from './stats.js';

/**
 * F1 toggles the overlay. The stats element updates every frame even while hidden so
 * automated tests can read it through its data attributes.
 */
export function createDebug(app: App, container: HTMLElement): { update(): void } {
  const stats = document.createElement('div');
  stats.id = 'debug-stats';
  stats.hidden = true;
  container.appendChild(stats);
  const rows = new Map<string, HTMLElement>();
  for (const row of describePlayer(app.world, app.playerId, app.stats)) {
    const line = document.createElement('div');
    line.id = row.id;
    line.dataset['label'] = row.label;
    stats.appendChild(line);
    rows.set(row.id, line);
  }

  const gui = new GUI({ title: 'Clans debug' });
  gui.add(app, 'timeScale', 0.1, 4, 0.1);
  gui.add(app, 'paused');
  gui.add({ step: () => (app.stepOnce = true) }, 'step').name('step once');
  gui.add(app, 'freeCam').onChange((on: boolean) => {
    if (on) app.freeCamPosition.copy(app.camera.position);
  });
  gui.hide();

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F1') return;
    event.preventDefault();
    stats.hidden = !stats.hidden;
    if (stats.hidden) gui.hide();
    else gui.show();
  });

  return {
    update(): void {
      for (const row of describePlayer(app.world, app.playerId, app.stats)) {
        const line = rows.get(row.id);
        if (!line) continue;
        line.textContent = `${row.label}: ${row.text}`;
        line.dataset['value'] = String(row.value);
      }
      stats.dataset['ready'] = '1';
    },
  };
}
```

Modify `packages/client/src/main.ts` so the loop updates the overlay:

```ts
import { createApp } from './app.js';
import { createDebug } from './debug.js';

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

const app = await createApp(container);
const debug = createDebug(app, document.body);
let last = performance.now();
const tick = (now: number): void => {
  app.frame((now - last) / 1000);
  debug.update();
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
```

Add to the `<style>` block in `packages/client/index.html`:

```css
#debug-stats {
  position: fixed;
  top: 8px;
  left: 8px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.55);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
  white-space: pre;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm --filter @clans/client test && pnpm typecheck && pnpm lint`. Then `pnpm dev`, press F1, and confirm the stats and the lil-gui panel appear, `paused` freezes the player, `step once` advances one tick, `timeScale` 0.1 slows skiing, and `freeCam` detaches the camera with WASD, Space, and Ctrl.

- [ ] **Step 5: Commit**

```sh
git add packages/client/src/stats.ts packages/client/src/stats.test.ts packages/client/src/debug.ts packages/client/src/main.ts packages/client/index.html
git commit -m "feat(client): F1 debug overlay with stats, time scale, pause, step, free cam" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 12: Playwright smoke test

**Files:** Create `e2e/movement.spec.ts`; Modify `playwright.config.ts`
**Interfaces:** Consumes the `#debug-stats[data-ready]` and `#debug-speed[data-value]` DOM contract from Task 11 and the root `e2e` script from Task 1.

- [ ] **Step 1: Write the failing test**

Create `e2e/movement.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('loads Katabatic and reaches running speed', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug-stats[data-ready="1"]').waitFor({ timeout: 30_000 });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  await page.waitForTimeout(3_000);
  const speed = Number(await page.locator('#debug-speed').getAttribute('data-value'));
  expect(speed).toBeGreaterThan(5);
  const ground = Number(await page.locator('#debug-ground').getAttribute('data-value'));
  expect([0, 1]).toContain(ground);
});
```

Modify `playwright.config.ts` so headless Chromium has a software GL context in CI:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'pnpm --filter @clans/client dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm exec playwright install chromium` once, then `git stash push packages/client/src/debug.ts` and `pnpm e2e`. Expect the `#debug-stats` wait to time out. Run `git stash pop` to restore the overlay.

- [ ] **Step 3: Write minimal implementation**

No new application code. If the speed assertion fails, the spawn is on a flat or uphill patch: change `spawnPoint` in `packages/client/src/app.ts` to take the team 1 spawn with the higher `y` (both team 1 spheres are on the base hill) and re-run.

- [ ] **Step 4: Run tests to verify they pass**

Run `pnpm e2e`. Expected: 1 passed.

- [ ] **Step 5: Commit**

```sh
git add e2e/movement.spec.ts playwright.config.ts
git commit -m "test(e2e): Playwright smoke test loads Katabatic and moves the player" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```

---

### Task 13: Docs and final verification

**Files:** Modify `README.md`, `NOTICE.md` (drafts exist uncommitted in the working tree); verify `assets/out/katabatic/` is reproducible.
**Interfaces:** Consumes every root script from Task 1.

- [ ] **Step 1: Check the drafts against what shipped**

Open `README.md`. Confirm every command in it exists in the root `package.json` and every key in the controls table matches `packages/client/src/input.ts` (W A S D, Space, right mouse, F1). Open `NOTICE.md`. Confirm the file list matches `packages/assets/src/fetch.ts`.

- [ ] **Step 2: Prove the asset build is reproducible**

```sh
pnpm assets:build
git status --short assets/out
```

Expected: no output from `git status` (a rebuild changes nothing).

- [ ] **Step 3: Run every gate**

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e
```

Expected: all green.

- [ ] **Step 4: Commit**

```sh
git add README.md NOTICE.md
git commit -m "docs: README with one-command run and NOTICE crediting data sources" -m "Claude-Session: https://claude.ai/code/session_01LsuR7ZawmmXohrHsrR68HP"
```
