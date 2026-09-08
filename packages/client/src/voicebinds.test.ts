import { describe, expect, it, vi } from 'vitest';
import { VOICE_LINE_COUNT } from '@clans/protocol';
import { speakVoiceLine, VOICE_LINES } from './voicebinds.js';

describe('VOICE_LINES', () => {
  it("has exactly VOICE_LINE_COUNT (9) lines, one per menu digit -- matches the protocol's own wire-format bound", () => {
    expect(VOICE_LINES).toHaveLength(VOICE_LINE_COUNT);
  });
});

describe('speakVoiceLine', () => {
  it('speaks the text for a valid line id', () => {
    const speak = vi.fn();
    speakVoiceLine(0, { speak });
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = speak.mock.calls[0]?.[0] as SpeechSynthesisUtterance;
    expect(utterance.text).toBe(VOICE_LINES[0]);
  });

  it('does nothing for an out-of-range line id, never throws', () => {
    const speak = vi.fn();
    expect(() => speakVoiceLine(99, { speak })).not.toThrow();
    expect(speak).not.toHaveBeenCalled();
  });

  it('does nothing for a negative line id, never throws', () => {
    const speak = vi.fn();
    expect(() => speakVoiceLine(-1, { speak })).not.toThrow();
    expect(speak).not.toHaveBeenCalled();
  });
});
