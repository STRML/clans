/**
 * The action keymap: the one place that maps gameplay actions to `KeyboardEvent.code`
 * physical keys, so the design spec's "Rebindable through a JSON keymap" input bullet
 * (`docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md:319`) is data
 * instead of literals scattered through `input.ts`. The committed
 * `assets/out/keymap.json` -- the client's Vite public dir, served at `/keymap.json` --
 * is fetched once at boot; input.ts reads every gameplay key through the exported
 * `keymap` object below.
 *
 * Schema: a flat JSON object, action name -> a single `KeyboardEvent.code` string.
 * A file that omits actions is fine -- omitted actions keep the built-in defaults --
 * but anything else wrong is rejected with a thrown `Error` naming the problem:
 *
 * - a key that is not a known action (`keymap: unknown action "foward" ...`),
 * - a value that is not a `KeyboardEvent.code` (`keymap: "forward" is bound to
 *   "Ctrl+W", which is not a KeyboardEvent.code ...`; chords like "Ctrl+W" are not
 *   expressible -- one physical key per action, like the original game's opts),
 * - two actions resolved onto one code, whether inside the JSON or by overriding an
 *   action onto another's untouched default (`keymap: actions "forward" and "back"
 *   are both bound to "KeyW" ...`).
 *
 * A rejected or missing file keeps the built-in bindings: a typo in a customization
 * file must never dead-key the game, so the boot loader reports the error on the
 * console and moves on. The set of actions is exactly the keys input.ts consumes:
 * jet and fire stay mouse buttons (input.ts's own mousedown handlers, the original
 * game's default triggers too), and the number keys 1-9 double as the hardcoded
 * dialog-selection keys inside the commander-map and voice-bind menus, exactly as
 * T2's own GUI hardwires option picks to the digits.
 */

/** Every action the map knows, and therefore every gameplay key input.ts reads. */
export const KEYMAP_ACTIONS = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'grenade',
  'pack',
  'zoom',
  'scoreboard',
  'use',
  'commanderMap',
  'voiceMenu',
  'cameraToggle',
  'escape',
  'slot1',
  'slot2',
  'slot3',
  'slot4',
  'slot5',
] as const;

export type KeymapAction = (typeof KEYMAP_ACTIONS)[number];
export type Keymap = Readonly<Record<KeymapAction, string>>;

/** Today's bindings, unchanged by this feature: W/A/S/D, Space, G, R, Z, Tab, E, C,
 *  V, X, Escape, Digit1-5. `Record<KeymapAction, ...>` makes a missing default a
 *  compile error; `resolveKeymap` re-checks at runtime so an incomplete merged map
 *  fails loudly instead of leaving an action with no key at all. */
export const DEFAULT_KEYMAP: Keymap = Object.freeze({
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  grenade: 'KeyG',
  pack: 'KeyR',
  zoom: 'KeyZ',
  scoreboard: 'Tab',
  use: 'KeyE',
  commanderMap: 'KeyC',
  voiceMenu: 'KeyV',
  cameraToggle: 'KeyX',
  escape: 'Escape',
  slot1: 'Digit1',
  slot2: 'Digit2',
  slot3: 'Digit3',
  slot4: 'Digit4',
  slot5: 'Digit5',
});

/** The `KeyboardEvent.code` value space (https://www.w3.org/TR/uievents-code/): the
 *  layout-independent physical key names browsers actually emit. Chords, literals
 *  like "w", and event.key values ("Ctrl", "W") all fail this -- they are the exact
 *  mistakes the error message should name. */
const KEY_CODE_PATTERN =
  /^(?:Key[A-Z]|Digit[0-9]|F[1-9][0-9]?|Numpad[0-9]|Numpad(?:Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Meta(?:Left|Right)|Escape|Tab|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|ContextMenu|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

/** Whether `code` is a `KeyboardEvent.code` a keymap value may take. */
export function isKeyCode(code: string): boolean {
  return KEY_CODE_PATTERN.test(code);
}

/** Validates one JSON object as a set of overrides: every key a known action, every
 *  value a `KeyboardEvent.code`. Throws with the offending name quoted so a bad
 *  keymap.json names its own mistake. */
function parseKeymap(raw: unknown): Partial<Record<KeymapAction, string>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('keymap: expected a JSON object mapping action names to KeyboardEvent codes');
  }
  const parsed: Partial<Record<KeymapAction, string>> = {};
  for (const [action, code] of Object.entries(raw)) {
    if (!KEYMAP_ACTIONS.includes(action as KeymapAction)) {
      throw new Error(
        `keymap: unknown action "${action}" -- known actions: ${KEYMAP_ACTIONS.join(', ')}`,
      );
    }
    if (typeof code !== 'string' || !isKeyCode(code)) {
      throw new Error(
        `keymap: "${action}" is bound to ${JSON.stringify(code)}, which is not a KeyboardEvent.code -- expected a physical key code like "KeyW", "Digit1", or "Space"`,
      );
    }
    parsed[action as KeymapAction] = code;
  }
  return parsed;
}

/** Merges `overrides` over `base` (the built-in defaults) into a complete map, then
 *  rejects any code two actions landed on -- checking the MERGE, not just the JSON,
 *  is what catches overriding an action onto another's untouched default. The `base`
 *  parameter is a seam for the tests' incomplete-map case; callers use the default.
 *  Throws if any action ends up with no code: that is a broken DEFAULT_KEYMAP edit,
 *  which should fail loudly the moment the module loads, not silently dead-key. */
export function resolveKeymap(overrides?: unknown, base: Keymap = DEFAULT_KEYMAP): Keymap {
  const merged: Record<KeymapAction, string> = { ...base };
  const parsed = parseKeymap(overrides === undefined ? {} : overrides);
  for (const [action, code] of Object.entries(parsed)) {
    merged[action as KeymapAction] = code as string;
  }
  const byCode = new Map<string, string>();
  for (const action of KEYMAP_ACTIONS) {
    const code = merged[action];
    if (typeof code !== 'string' || !isKeyCode(code)) {
      throw new Error(`keymap: action "${action}" has no valid key binding`);
    }
    const previous = byCode.get(code);
    if (previous !== undefined) {
      throw new Error(`keymap: actions "${previous}" and "${action}" are both bound to "${code}"`);
    }
    byCode.set(code, action);
  }
  return Object.freeze(merged);
}

/** The live map input.ts reads. Starts at the defaults; `applyKeymap` overwrites
 *  properties in place so every importer sees the same object update. */
export const keymap: Keymap = { ...DEFAULT_KEYMAP };

/** Applies a parsed keymap JSON over the current bindings. Throws on invalid input
 *  (see the module comment); the boot loader decides what a throw means at boot. */
export function applyKeymap(overrides: unknown): void {
  Object.assign(keymap, resolveKeymap(overrides));
}

/** Restores the built-in defaults (the boot loader's no-customization state). */
export function resetKeymap(): void {
  Object.assign(keymap, DEFAULT_KEYMAP);
}

// Boot: fetch the committed keymap once, when this module is first imported in a
// browser. Relative to the document, so it serves the same way at `/` (the client's
// own dev config) and under a base-prefixed deploy, the same property assets.ts's
// BASE_URL handling exists for. Node test runs never see a `window`, so the pure
// parts above are all the unit tests exercise. A missing file is the normal
// un-customized case (response not ok -> keep defaults, silently); a present but
// invalid file reports the parse/validation error and keeps the defaults.
if (typeof window !== 'undefined') {
  void fetch('keymap.json')
    .then(async (response) => {
      if (response.ok) applyKeymap(await response.json());
    })
    .catch((error: unknown) => {
      console.error('keymap.json rejected; built-in bindings stay active', error);
    });
}
