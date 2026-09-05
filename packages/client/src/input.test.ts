import { describe, expect, it } from 'vitest';
import { Input } from './input.js';

describe('Input.releaseAll', () => {
  it('drops the jet flag and every held key', () => {
    const input = new Input({} as HTMLElement);
    input.jet = true;
    (input as unknown as { keys: Set<string> }).keys.add('KeyW');
    expect(input.snapshot()).toMatchObject({ jet: true, moveZ: 1 });
    input.releaseAll();
    expect(input.snapshot()).toMatchObject({ jet: false, moveZ: 0, jump: false });
  });
});
