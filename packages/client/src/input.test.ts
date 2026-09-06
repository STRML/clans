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
