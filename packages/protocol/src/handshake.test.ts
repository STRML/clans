import { describe, expect, it } from 'vitest';
import {
  decodeAck,
  decodeInput,
  decodeJoin,
  decodeWelcome,
  encodeAck,
  encodeInput,
  encodeJoin,
  encodeWelcome,
} from './handshake.js';
import { MessageType, type InputMessage } from './messages.js';

describe('handshake codec', () => {
  it('round-trips a Join message', () => {
    expect(decodeJoin(encodeJoin())).toEqual({ type: MessageType.Join });
  });

  it('round-trips a Welcome message, including the spawn point', () => {
    const bytes = encodeWelcome({
      playerId: 5,
      team: 2,
      tickMs: 32,
      spawnX: 10,
      spawnY: 1,
      spawnZ: -20,
    });
    expect(decodeWelcome(bytes)).toEqual({
      type: MessageType.Welcome,
      playerId: 5,
      team: 2,
      tickMs: 32,
      spawnX: 10,
      spawnY: 1,
      spawnZ: -20,
    });
  });

  it('round-trips an Input message with three distinct redundant samples', () => {
    const message: Omit<InputMessage, 'type'> = {
      sequence: 42,
      samples: [
        { moveX: 1, moveZ: -1, yaw: 0.5, jump: true, jet: false },
        { moveX: 0, moveZ: 1, yaw: 0.25, jump: false, jet: true },
        { moveX: -1, moveZ: 0, yaw: -0.5, jump: false, jet: false },
      ],
    };
    const decoded = decodeInput(encodeInput(message));
    expect(decoded.sequence).toBe(42);
    expect(decoded.samples).toEqual(message.samples);
  });

  it('round-trips an Ack message', () => {
    expect(decodeAck(encodeAck({ snapshotId: 777 }))).toEqual({
      type: MessageType.Ack,
      snapshotId: 777,
    });
  });

  it('rejects decoding bytes tagged as the wrong message type', () => {
    expect(() => decodeAck(encodeJoin())).toThrow(RangeError);
  });

  it('rejects an Input message carrying a non-finite move axis', () => {
    // Codex round 1 (PR #4): an unvalidated NaN or Infinity axis would otherwise reach
    // the movement sim and poison the authoritative player's position and velocity.
    const message: Omit<InputMessage, 'type'> = {
      sequence: 1,
      samples: [
        { moveX: Number.NaN, moveZ: 0, yaw: 0, jump: false, jet: false },
        { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false },
        { moveX: 0, moveZ: 0, yaw: 0, jump: false, jet: false },
      ],
    };
    expect(() => decodeInput(encodeInput(message))).toThrow(RangeError);
  });
});
