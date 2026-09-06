import { describe, expect, it } from 'vitest';
import { needsFullSnapshot } from './snapshot-policy.js';

describe('needsFullSnapshot', () => {
  it('requires a full snapshot before any ack has arrived', () => {
    expect(needsFullSnapshot(0, null, 1000)).toBe(true);
  });
  it('allows a delta right after a fresh ack', () => {
    expect(needsFullSnapshot(4, 1000, 1000)).toBe(false);
  });
  it('falls back to full once the ack is more than 1 s stale', () => {
    expect(needsFullSnapshot(4, 0, 1000)).toBe(false);
    expect(needsFullSnapshot(4, 0, 1001)).toBe(true);
  });
});
