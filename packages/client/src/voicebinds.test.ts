import { describe, expect, it, vi } from 'vitest';
import { VOICE_LINE_COUNT } from '@clans/protocol';
import { speakVoiceLine, VOICE_LINES } from './voicebinds.js';

describe('VOICE_LINES', () => {
  it("has exactly VOICE_LINE_COUNT (9) lines, one per menu digit -- matches the protocol's own wire-format bound", () => {
    expect(VOICE_LINES).toHaveLength(VOICE_LINE_COUNT);
  });
});

describe('speakVoiceLine', () => {
  it('plays the original voice sample for a valid line id', () => {
    const voice = vi.fn();
    speakVoiceLine(0, { voice });
    expect(voice).toHaveBeenCalledTimes(1);
    expect(voice).toHaveBeenCalledWith(0);
  });

  it('does nothing for an out-of-range line id, never throws', () => {
    const voice = vi.fn();
    expect(() => speakVoiceLine(99, { voice })).not.toThrow();
    expect(voice).not.toHaveBeenCalled();
  });

  it('does nothing for a negative line id, never throws', () => {
    const voice = vi.fn();
    expect(() => speakVoiceLine(-1, { voice })).not.toThrow();
    expect(voice).not.toHaveBeenCalled();
  });
});
