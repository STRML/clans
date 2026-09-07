import { describe, expect, it } from 'vitest';
import { Input } from './input.js';

describe('Input.releaseAll', () => {
  it('drops the jet flag, the fire flag, and every held key', () => {
    const input = new Input({} as HTMLElement);
    input.jet = true;
    input.fire = true;
    (input as unknown as { keys: Set<string> }).keys.add('KeyW');
    expect(input.snapshot()).toMatchObject({ jet: true, fire: true, moveZ: 1 });
    input.releaseAll();
    expect(input.snapshot()).toMatchObject({ jet: false, fire: false, moveZ: 0, jump: false });
  });
});

describe('Input.snapshot: weapon slot and grenade key', () => {
  it('reads the lowest held number key 1-5 as slot, 0 when none are held', () => {
    const input = new Input({} as HTMLElement);
    expect(input.snapshot().slot).toBe(0);
    (input as unknown as { keys: Set<string> }).keys.add('Digit3');
    expect(input.snapshot().slot).toBe(3);
  });

  it('reads altFire from the G key', () => {
    const input = new Input({} as HTMLElement);
    expect(input.snapshot().altFire).toBe(false);
    (input as unknown as { keys: Set<string> }).keys.add('KeyG');
    expect(input.snapshot().altFire).toBe(true);
  });
});

describe('Input: station use (E), Repair Pack (R), commander map (C)', () => {
  it('usePressedThisFrame fires once on the rising edge, not again while held', () => {
    const input = new Input({} as HTMLElement);
    const keys = (input as unknown as { keys: Set<string> }).keys;
    expect(input.usePressedThisFrame()).toBe(false);
    keys.add('KeyE');
    expect(input.usePressedThisFrame()).toBe(true);
    expect(input.usePressedThisFrame()).toBe(false); // still held, no re-fire
    keys.delete('KeyE');
    expect(input.usePressedThisFrame()).toBe(false);
    keys.add('KeyE');
    expect(input.usePressedThisFrame()).toBe(true); // a fresh press fires again
  });

  it('packActive is level-triggered from the R key, like fire', () => {
    const input = new Input({} as HTMLElement);
    expect(input.snapshot().packActive).toBe(false);
    (input as unknown as { keys: Set<string> }).keys.add('KeyR');
    expect(input.snapshot().packActive).toBe(true);
  });

  it('commandCirclePressedThisFrame fires once on the rising edge, not again while held', () => {
    const input = new Input({} as HTMLElement);
    const keys = (input as unknown as { keys: Set<string> }).keys;
    keys.add('KeyC');
    expect(input.commandCirclePressedThisFrame()).toBe(true);
    expect(input.commandCirclePressedThisFrame()).toBe(false);
  });

  it('releaseAll clears the use/commander-map edge state so a held key does not fire stale', () => {
    const input = new Input({} as HTMLElement);
    const keys = (input as unknown as { keys: Set<string> }).keys;
    keys.add('KeyE');
    expect(input.usePressedThisFrame()).toBe(true);
    input.releaseAll();
    keys.add('KeyE'); // releaseAll cleared `keys` too; re-add to simulate the key still held
    expect(input.usePressedThisFrame()).toBe(true); // treated as a fresh press after release
  });
});
