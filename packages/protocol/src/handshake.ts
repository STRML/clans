import {
  bytesOf,
  createReader,
  createWriter,
  readF32,
  readU16,
  readU32,
  readU8,
  writeF32,
  writeU16,
  writeU32,
  writeU8,
  type Cursor,
} from './codec.js';
import {
  MessageType,
  type AckMessage,
  type InputMessage,
  type JoinMessage,
  type NetInputSample,
  type WelcomeMessage,
} from './messages.js';

const SAMPLE_BYTES = 13; // moveX, moveZ, yaw (f32 each) plus one flags byte
export const INPUT_MESSAGE_BYTES = 1 + 4 + SAMPLE_BYTES * 3;

function expectType(cursor: Cursor, expected: MessageType): void {
  const type = readU8(cursor);
  if (type !== expected)
    throw new RangeError(`Expected message type ${String(expected)}, got ${String(type)}`);
}

function writeSample(cursor: Cursor, sample: NetInputSample): void {
  writeF32(cursor, sample.moveX);
  writeF32(cursor, sample.moveZ);
  writeF32(cursor, sample.yaw);
  writeU8(cursor, (sample.jump ? 1 : 0) | (sample.jet ? 2 : 0));
}
function readSample(cursor: Cursor): NetInputSample {
  const moveX = readF32(cursor);
  const moveZ = readF32(cursor);
  const yaw = readF32(cursor);
  const flags = readU8(cursor);
  return { moveX, moveZ, yaw, jump: (flags & 1) !== 0, jet: (flags & 2) !== 0 };
}

export function encodeJoin(): Uint8Array {
  const cursor = createWriter(1);
  writeU8(cursor, MessageType.Join);
  return bytesOf(cursor);
}
export function decodeJoin(bytes: Uint8Array): JoinMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Join);
  return { type: MessageType.Join };
}

export function encodeWelcome(message: Omit<WelcomeMessage, 'type'>): Uint8Array {
  const cursor = createWriter(6);
  writeU8(cursor, MessageType.Welcome);
  writeU16(cursor, message.playerId);
  writeU8(cursor, message.team);
  writeU16(cursor, message.tickMs);
  return bytesOf(cursor);
}
export function decodeWelcome(bytes: Uint8Array): WelcomeMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Welcome);
  return {
    type: MessageType.Welcome,
    playerId: readU16(cursor),
    team: readU8(cursor),
    tickMs: readU16(cursor),
  };
}

export function encodeInput(message: Omit<InputMessage, 'type'>): Uint8Array {
  const cursor = createWriter(INPUT_MESSAGE_BYTES);
  writeU8(cursor, MessageType.Input);
  writeU32(cursor, message.sequence);
  for (const sample of message.samples) writeSample(cursor, sample);
  return bytesOf(cursor);
}
export function decodeInput(bytes: Uint8Array): InputMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Input);
  const sequence = readU32(cursor);
  const samples: [NetInputSample, NetInputSample, NetInputSample] = [
    readSample(cursor),
    readSample(cursor),
    readSample(cursor),
  ];
  return { type: MessageType.Input, sequence, samples };
}

export function encodeAck(message: Omit<AckMessage, 'type'>): Uint8Array {
  const cursor = createWriter(5);
  writeU8(cursor, MessageType.Ack);
  writeU32(cursor, message.snapshotId);
  return bytesOf(cursor);
}
export function decodeAck(bytes: Uint8Array): AckMessage {
  const cursor = createReader(bytes);
  expectType(cursor, MessageType.Ack);
  return { type: MessageType.Ack, snapshotId: readU32(cursor) };
}
