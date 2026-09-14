import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYMAP,
  KEYMAP_ACTIONS,
  applyKeymap,
  isKeyCode,
  keymap,
  resetKeymap,
  resolveKeymap,
} from './keymap.js';

beforeEach(() => resetKeymap());

describe('default keymap', () => {
  it('gives every action a valid KeyboardEvent code', () => {
    expect(Object.keys(DEFAULT_KEYMAP).sort()).toEqual([...KEYMAP_ACTIONS].sort());
    for (const action of KEYMAP_ACTIONS) {
      expect(isKeyCode(DEFAULT_KEYMAP[action]), action).toBe(true);
    }
  });

  it('resolves the complete map without throwing, covering every action', () => {
    const resolved = resolveKeymap();
    expect([...KEYMAP_ACTIONS].every((action) => typeof resolved[action] === 'string')).toBe(true);
  });

  it('fails loudly when an action lacks a default', () => {
    const incomplete = { forward: 'KeyW' } as typeof DEFAULT_KEYMAP;
    expect(() => resolveKeymap(undefined, incomplete)).toThrow(/no valid key binding/);
  });

  it('ships the committed keymap.json at exactly the built-in defaults', () => {
    // The committed file is the documented schema example; it must parse, validate,
    // and currently change nothing, or a half-edited file would ship a rebinding.
    const committed = JSON.parse(
      readFileSync(new URL('../../../assets/out/keymap.json', import.meta.url), 'utf8'),
    );
    expect(() => resolveKeymap(committed)).not.toThrow();
    expect(resolveKeymap(committed)).toEqual(resolveKeymap());
  });
});

describe('applyKeymap', () => {
  it('overrides specific actions and keeps the rest at their defaults', () => {
    applyKeymap({ forward: 'KeyQ' });
    expect(keymap.forward).toBe('KeyQ');
    expect(keymap).toEqual({ ...DEFAULT_KEYMAP, forward: 'KeyQ' });
  });

  it('resetKeymap restores the built-in defaults', () => {
    applyKeymap({ forward: 'KeyQ', slot3: 'BracketRight' });
    resetKeymap();
    expect(keymap).toEqual(DEFAULT_KEYMAP);
  });

  it('rejects values that are not KeyboardEvent codes, with the action named', () => {
    expect(() => applyKeymap({ forward: 'Ctrl+W' })).toThrow(
      /"forward" is bound to "Ctrl\+W", which is not a KeyboardEvent\.code/,
    );
    expect(() => applyKeymap({ forward: 'keyw' })).toThrow(/not a KeyboardEvent\.code/);
    expect(() => applyKeymap({ forward: 42 })).toThrow(/not a KeyboardEvent\.code/);
  });

  it('rejects two actions bound to the same code inside the JSON', () => {
    expect(() => applyKeymap({ forward: 'KeyQ', back: 'KeyQ' })).toThrow(
      /actions "forward" and "back" are both bound to "KeyQ"/,
    );
  });

  it("rejects an override colliding with another action's untouched default", () => {
    expect(() => applyKeymap({ back: 'KeyW' })).toThrow(
      /actions "forward" and "back" are both bound to "KeyW"/,
    );
  });

  it('rejects unknown action names, listing the known set', () => {
    expect(() => applyKeymap({ foward: 'KeyW' })).toThrow(
      /unknown action "foward" -- known actions: forward, /,
    );
  });

  it('rejects JSON that is not an object', () => {
    for (const bad of [null, 'KeyW', ['KeyW'], 7]) {
      expect(() => applyKeymap(bad)).toThrow(/expected a JSON object/);
    }
  });
});
