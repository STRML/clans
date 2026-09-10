import { describe, expect, it, vi } from 'vitest';
import { VOICE_LINE_COUNT } from '@clans/protocol';
import { resolveVoicePick, speakVoiceLine, VOICE_CATEGORIES, VOICE_LINES } from './voicebinds.js';

describe('VOICE_LINES', () => {
  it("has exactly VOICE_LINE_COUNT (9) lines, one per menu digit -- matches the protocol's own wire-format bound", () => {
    expect(VOICE_LINES).toHaveLength(VOICE_LINE_COUNT);
  });

  it('keeps index = protocol line id in the audio.ts VOICE_SOUND order (label/sample pairing)', () => {
    // audio.ts indexes its sample table with the same id: reordering this array would make
    // every menu label disagree with the recording a receiving client plays.
    expect(VOICE_LINES[0]).toBe('Target destroyed');
    expect(VOICE_LINES[1]).toBe('Taking the flag');
    expect(VOICE_LINES[2]).toBe('Thanks');
    expect(VOICE_LINES[5]).toBe('Incoming enemy');
    expect(VOICE_LINES[8]).toBe('Nice shot');
  });

  it('the category tree covers each line exactly once -- no invented or duplicated lines', () => {
    const ids = VOICE_CATEGORIES.flatMap((category) => category.lines.map((line) => line.id));
    expect([...ids].sort((a, b) => a - b)).toEqual([...Array(VOICE_LINE_COUNT).keys()]);
    for (const category of VOICE_CATEGORIES) {
      for (const line of category.lines) expect(line.label).toBe(VOICE_LINES[line.id]);
    }
  });
});

describe('resolveVoicePick (two-level V-menu navigation)', () => {
  it('drills from the category list into a category without sending anything', () => {
    const result = resolveVoicePick(null, 6); // 6th category: General
    expect(result.next).toBe(VOICE_CATEGORIES[5]!);
    expect(result.lineId).toBeNull();
  });

  it('picks a line inside a category and returns its flat protocol id', () => {
    const general = VOICE_CATEGORIES[5]!;
    // General's first entry is protocol id 2 ('Thanks'), not index 2 -- the tree reorders
    // presentation, never wire ids.
    expect(resolveVoicePick(general, 1)).toEqual({ next: general, lineId: 2 });
  });

  it('ignores out-of-range digits at both levels', () => {
    expect(resolveVoicePick(null, 0).lineId).toBeNull();
    expect(resolveVoicePick(null, 99).next).toBeNull();
    const general = VOICE_CATEGORIES[5]!;
    expect(resolveVoicePick(general, 5).lineId).toBeNull();
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
