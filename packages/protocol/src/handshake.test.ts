import { describe, expect, it } from 'vitest';
import {
  decodeAck,
  decodeCommandOrder,
  decodeEvent,
  decodeGod,
  decodeInput,
  decodeJoin,
  decodeLoadout,
  decodeVehicleSpawn,
  decodeVoiceBind,
  decodeWelcome,
  encodeAck,
  encodeCommandOrder,
  encodeEvent,
  encodeGod,
  encodeInput,
  encodeJoin,
  encodeLoadout,
  encodeVehicleSpawn,
  encodeVoiceBind,
  encodeWelcome,
  IMPACT_EVENT_BYTES,
  LOADOUT_MESSAGE_BYTES,
} from './handshake.js';
import {
  EventKind,
  MessageType,
  OrderKind,
  PROTOCOL_VERSION,
  WelcomeStatus,
  type InputMessage,
  type NetInputSample,
} from './messages.js';

describe('handshake codec', () => {
  it('round-trips a Join message carrying the protocol version', () => {
    expect(decodeJoin(encodeJoin())).toEqual({ type: MessageType.Join, version: PROTOCOL_VERSION });
  });

  it('is version 11, so a #55-era v10 peer fails the Join equality check in both directions', () => {
    // #55 changed the Loadout frame (3 -> 4 bytes, pack byte + weapons bitmask). Both the
    // server's join.version !== PROTOCOL_VERSION check and the client's Welcome status
    // reject a 10.x peer -- this pins the actual number so the bump cannot silently
    // regress to a value a stale peer happens to share.
    expect(PROTOCOL_VERSION).toBe(11);
    expect(decodeJoin(encodeJoin()).version).not.toBe(10);
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
          use: false,
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
      use: false,
    });
  });
});

describe('Loadout round trip', () => {
  it('encodes and decodes armor, pack and the weapons bitmask exactly (#55)', () => {
    const bytes = encodeLoadout({ armor: 2, pack: 1, weapons: 0b10111 });
    expect(decodeLoadout(bytes)).toEqual({
      type: MessageType.Loadout,
      armor: 2,
      pack: 1,
      weapons: 0b10111,
    });
  });
  it('round-trips an Energy Pack loadout with armor-default weapons (weapons mask 0)', () => {
    const bytes = encodeLoadout({ armor: 0, pack: 2, weapons: 0 });
    expect(decodeLoadout(bytes)).toEqual({
      type: MessageType.Loadout,
      armor: 0,
      pack: 2,
      weapons: 0,
    });
  });
  it('keeps the exact 4-byte frame a pre-#11 peer cannot decode (#55)', () => {
    // Byte-count contract: type + armor + pack + weapons bitmask. The 10.x decoder read
    // only 3 bytes and mapped the pack byte onto a Repair Pack boolean, so an Energy Pack
    // silently became "Repair Pack" and the weapons byte vanished; the frame length and
    // the PROTOCOL_VERSION bump are both load-bearing.
    expect(encodeLoadout({ armor: 1, pack: 0, weapons: 0 }).length).toBe(LOADOUT_MESSAGE_BYTES);
    expect(() => decodeLoadout(new Uint8Array([MessageType.Loadout, 1, 0]))).toThrow(RangeError);
  });
  it('masks weapon bits above the five WeaponId bits and rejects an out-of-range pack', () => {
    const masked = decodeLoadout(encodeLoadout({ armor: 0, pack: 0, weapons: 0xff }));
    expect(masked.weapons).toBe(0x1f);
    expect(() => decodeLoadout(new Uint8Array([MessageType.Loadout, 0, 3, 0]))).toThrow(RangeError);
  });
  it('no longer round-trips the pre-#11 repairPack boolean shape', () => {
    // Pins the breaking change: a v10 client's 3-byte frame must fail, and the message
    // shape has pack/weapons where repairPack used to be.
    const decoded = decodeLoadout(encodeLoadout({ armor: 2, pack: 2, weapons: 0 }));
    expect(decoded).not.toHaveProperty('repairPack');
    expect(decoded.pack).toBe(2);
  });
});

describe('packActive input bit', () => {
  it('round-trips through encodeInput/decodeInput alongside every other flag', () => {
    const sample: NetInputSample = {
      moveX: 1,
      moveZ: -1,
      yaw: 0.5,
      pitch: -0.2,
      jump: true,
      jet: false,
      fire: true,
      altFire: false,
      slot: 3,
      packActive: true,
      use: false,
    };
    const bytes = encodeInput({ sequence: 1, samples: [sample, sample, sample] });
    const decoded = decodeInput(bytes);
    expect(decoded.samples[0].packActive).toBe(true);
    expect(decoded.samples[0].jump).toBe(true);
    expect(decoded.samples[0].fire).toBe(true);
  });
});

describe('use input bit (M5)', () => {
  it('round-trips through encodeInput/decodeInput alongside every other flag', () => {
    const sample: NetInputSample = {
      moveX: 1,
      moveZ: -1,
      yaw: 0.5,
      pitch: -0.2,
      jump: false,
      jet: false,
      fire: false,
      altFire: false,
      slot: 2,
      packActive: false,
      use: true,
    };
    const bytes = encodeInput({ sequence: 1, samples: [sample, sample, sample] });
    expect(decodeInput(bytes).samples[0].use).toBe(true);
  });

  it('does not leak into packActive or vice versa', () => {
    const sample: NetInputSample = {
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      pitch: 0,
      jump: false,
      jet: false,
      fire: false,
      altFire: false,
      slot: 0,
      packActive: true,
      use: false,
    };
    const bytes = encodeInput({ sequence: 1, samples: [sample, sample, sample] });
    const decoded = decodeInput(bytes);
    expect(decoded.samples[0].packActive).toBe(true);
    expect(decoded.samples[0].use).toBe(false);
  });
});

describe('VehicleSpawn round trip (M5)', () => {
  it('encodes and decodes padId and kind exactly', () => {
    const bytes = encodeVehicleSpawn({ padId: 4, kind: 1 });
    expect(decodeVehicleSpawn(bytes)).toEqual({
      type: MessageType.VehicleSpawn,
      padId: 4,
      kind: 1,
    });
  });

  it('round-trips a padId above 255 (u16, not u8)', () => {
    const bytes = encodeVehicleSpawn({ padId: 300, kind: 0 });
    expect(decodeVehicleSpawn(bytes).padId).toBe(300);
  });
});

describe('CommandOrder codec (M7)', () => {
  it('round-trips kind and a world position', () => {
    const bytes = encodeCommandOrder({ kind: OrderKind.Attack, x: 123.5, z: -40.25 });
    const decoded = decodeCommandOrder(bytes);
    expect(decoded).toEqual({
      type: MessageType.CommandOrder,
      kind: OrderKind.Attack,
      x: 123.5,
      z: -40.25,
    });
  });

  it('carries no team field at all', () => {
    const bytes = encodeCommandOrder({ kind: OrderKind.Defend, x: 0, z: 0 });
    expect(decodeCommandOrder(bytes)).not.toHaveProperty('team');
  });
});

describe('VoiceBind codec (M7)', () => {
  it('round-trips a line id', () => {
    const bytes = encodeVoiceBind({ lineId: 4 });
    expect(decodeVoiceBind(bytes)).toEqual({ type: MessageType.VoiceBind, lineId: 4 });
  });
});

describe('laser beam endpoints', () => {
  it('round trips a beam for a shot that hit terrain instead of a player', () => {
    const event = {
      kind: EventKind.LaserFired,
      a: 2,
      b: -1,
      beam: { from: { x: 1, y: 2, z: 3 }, to: { x: 100, y: 25, z: -50 } },
    };
    expect(decodeEvent(encodeEvent(event))).toEqual({ type: MessageType.Event, ...event });
  });
  it('rejects an incomplete beam payload', () => {
    const event = encodeEvent({
      kind: EventKind.LaserFired,
      a: 2,
      b: -1,
      beam: { from: { x: 1, y: 2, z: 3 }, to: { x: 100, y: 25, z: -50 } },
    });
    expect(() => decodeEvent(event.subarray(0, 20))).toThrow();
  });
});

describe('ProjectileImpact event codec (#52)', () => {
  const impact = {
    x: 1.5,
    y: 2.5,
    z: -3.5,
    weaponId: 0,
    type: 0,
    reason: 0,
    seq: 42,
  };

  it('round-trips the full authoritative impact record at the exact wire length', () => {
    const bytes = encodeEvent({ kind: EventKind.ProjectileImpact, a: 0, b: -1, impact });
    // Byte-count contract: 6-byte Event header + 3 f32 contact coordinates + u8 weaponId +
    // u8 type + u8 reason + u32 sequence. The length alone discriminates the event shapes.
    expect(bytes.length).toBe(IMPACT_EVENT_BYTES);
    expect(decodeEvent(bytes)).toEqual({
      type: MessageType.Event,
      kind: EventKind.ProjectileImpact,
      a: 0,
      b: -1,
      impact,
    });
  });

  it('rejects a truncated impact payload instead of decoding a partial record', () => {
    const bytes = encodeEvent({ kind: EventKind.ProjectileImpact, a: 0, b: -1, impact });
    expect(() => decodeEvent(bytes.subarray(0, 24))).toThrow(RangeError);
  });
});
