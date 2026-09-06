import { describe, expect, it } from 'vitest';
import { isClientOverloaded, MAX_BUFFERED_BYTES } from './backpressure-policy.js';

describe('isClientOverloaded', () => {
  it('is false for a client keeping up with the send rate', () => {
    expect(isClientOverloaded(0)).toBe(false);
    expect(isClientOverloaded(MAX_BUFFERED_BYTES)).toBe(false);
  });

  it('is true once the outgoing backlog exceeds the bound', () => {
    // Codex round 14 (PR #4): socket.send() was called unconditionally for every client
    // on every snapshot tick, with no bufferedAmount check. A client that joins and stops
    // reading (a stalled tab, a malicious client) let Node queue every write forever,
    // growing unbounded server memory one client at a time.
    expect(isClientOverloaded(MAX_BUFFERED_BYTES + 1)).toBe(true);
  });
});
