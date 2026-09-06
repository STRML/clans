import { describe, expect, it } from 'vitest';
import {
  decodeAck,
  decodeEvent,
  decodeGod,
  decodeInput,
  decodeJoin,
  decodeWelcome,
  encodeAck,
  encodeEvent,
  encodeGod,
  encodeInput,
  encodeJoin,
  encodeWelcome,
} from './handshake.js';
import {
  EventKind,
  MessageType,
  PROTOCOL_VERSION,
  WelcomeStatus,
  type InputMessage,
} from './messages.js';

describe('handshake codec', () => {
  it('round-trips a Join message carrying the protocol version', () => {
    expect(decodeJoin(encodeJoin())).toEqual({ type: MessageType.Join, version: PROTOCOL_VERSION });
  });

  it('round-trips an accepted Welcome message, including the spawn point', () => {
    const bytes = encodeWelcome({
      playerId: 5,
      team: 2,
      tickMs: 32,
      status: WelcomeStatus.Ok,
      spawnX: 10,
      spawnY: 1,
      spawnZ: -20,
    });
    expect(decodeWelcome(bytes)).toEqual({
      type: MessageType.Welcome,
      playerId: 5,
      team: 2,
      tickMs: 32,
      status: WelcomeStatus.Ok,
      spawnX: 10,
      spawnY: 1,
      spawnZ: -20,
    });
  });

  it('round-trips a version-mismatch Welcome', () => {
    const bytes = encodeWelcome({
      playerId: 0,
      team: 0,
      tickMs: 32,
      status: WelcomeStatus.VersionMismatch,
      spawnX: 0,
      spawnY: 0,
      spawnZ: 0,
    });
    expect(decodeWelcome(bytes).status).toBe(WelcomeStatus.VersionMismatch);
  });

  it('round-trips an Input message with three distinct redundant samples, including the new fields', () => {
    const message: Omit<InputMessage, 'type'> = {
      sequence: 42,
      samples: [
        {
          moveX: 1,
          moveZ: -1,
          yaw: 0.5,
          pitch: 0.25,
          jump: true,
          jet: false,
          fire: true,
          altFire: false,
          slot: 2,
          packActive: false,
        },
        {
          moveX: 0,
          moveZ: 1,
          yaw: 0.25,
          pitch: -0.125,
          jump: false,
          jet: true,
          fire: false,
          altFire: true,
          slot: 0,
          packActive: false,
        },
        {
          moveX: -1,
          moveZ: 0,
          yaw: -0.5,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
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

  it('round-trips an Event message', () => {
    const bytes = encodeEvent({ kind: EventKind.PlayerKilled, a: 3, b: 9 });
    expect(decodeEvent(bytes)).toEqual({
      type: MessageType.Event,
      kind: EventKind.PlayerKilled,
      a: 3,
      b: 9,
    });
  });

  it('round-trips a negative "a"/"b" (miss/no-attacker sentinel) on an Event message', () => {
    const bytes = encodeEvent({ kind: EventKind.LaserFired, a: 2, b: -1 });
    expect(decodeEvent(bytes)).toEqual({
      type: MessageType.Event,
      kind: EventKind.LaserFired,
      a: 2,
      b: -1,
    });
  });

  it('round-trips a God message', () => {
    expect(decodeGod(encodeGod({ enabled: true }))).toEqual({
      type: MessageType.God,
      enabled: true,
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
        {
          moveX: Number.NaN,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
        {
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
        {
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
      ],
    };
    expect(() => decodeInput(encodeInput(message))).toThrow(RangeError);
  });

  it('rejects an Input message carrying a non-finite pitch', () => {
    const message: Omit<InputMessage, 'type'> = {
      sequence: 1,
      samples: [
        {
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: Number.POSITIVE_INFINITY,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
        {
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
        {
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
      ],
    };
    expect(() => decodeInput(encodeInput(message))).toThrow(RangeError);
  });

  it('rejects a Welcome message carrying a non-finite spawn coordinate', () => {
    // Codex round 3 (PR #4): an unvalidated NaN spawn would otherwise be written straight
    // into the client's local prediction world and resurface, still NaN, the first time
    // it falls below the kill plane and gets reset to "spawn".
    const bytes = encodeWelcome({
      playerId: 1,
      team: 1,
      tickMs: 32,
      status: WelcomeStatus.Ok,
      spawnX: Number.NaN,
      spawnY: 0,
      spawnZ: 0,
    });
    expect(() => decodeWelcome(bytes)).toThrow(RangeError);
  });

  it('clamps an out-of-range move axis instead of letting it scale past the speed cap', () => {
    // Codex round 5 (PR #4): desiredSpeed scales the armor's speed cap directly by the
    // raw axis with no clamp of its own, so a crafted moveZ = 100 reached 68 m/s after
    // 100 ticks against the legal 15 m/s run cap.
    const message: Omit<InputMessage, 'type'> = {
      sequence: 1,
      samples: [
        {
          moveX: -100,
          moveZ: 100,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
        {
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
        {
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          jet: false,
          fire: false,
          altFire: false,
          slot: 0,
          packActive: false,
        },
      ],
    };
    const decoded = decodeInput(encodeInput(message));
    expect(decoded.samples[0]).toEqual({
      moveX: -1,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      jump: false,
      jet: false,
      fire: false,
      altFire: false,
      slot: 0,
      packActive: false,
    });
  });
});
