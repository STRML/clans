import { describe, expect, it } from 'vitest';
import { MessageType, type InputMessage, type NetInputSample } from '@clans/protocol';
import { applyInputMessage, createSession, recordAck } from './session.js';

const sample = (moveZ: number): NetInputSample => ({
  moveX: 0,
  moveZ,
  yaw: 0,
  jump: false,
  jet: false,
});
const inputMessage = (
  sequence: number,
  samples: [NetInputSample, NetInputSample, NetInputSample],
): InputMessage => ({
  type: MessageType.Input,
  sequence,
  samples,
});

describe('applyInputMessage', () => {
  it('drops a message whose sequence is not newer than the last applied one', () => {
    const session = createSession(0, 1, 0);
    // A gap of 10 with only 3 redundant samples per message backfills at most 3.
    expect(applyInputMessage(session, inputMessage(10, [sample(1), sample(1), sample(1)]))).toEqual(
      [sample(1), sample(1), sample(1)],
    );
    expect(
      applyInputMessage(session, inputMessage(7, [sample(-1), sample(-1), sample(-1)])),
    ).toEqual([]);
    expect(session.lastAppliedSequence).toBe(10);
  });

  it('replays the redundant samples that fill a single dropped packet', () => {
    const session = createSession(0, 1, 0);
    applyInputMessage(session, inputMessage(5, [sample(5), sample(4), sample(3)]));
    const filled = applyInputMessage(session, inputMessage(7, [sample(7), sample(6), sample(5)]));
    expect(filled).toEqual([sample(6), sample(7)]);
  });

  it('recovers redundant samples even on the very first message a session ever sees', () => {
    // Codex round 5 (PR #4): "nothing applied yet" is true both before a genuine first
    // message and after a genuine first message was itself lost, but only the second
    // case has a redundant sample worth recovering. Forcing exactly one sample through
    // regardless (as this used to) permanently lost whatever a lost first packet
    // carried -- often the player's very first jump or move key.
    const session = createSession(0, 1, 0);
    // Sequence 1 was lost in transit; sequence 2 is the first message this session sees,
    // and its redundant samples still carry sequence 1's input.
    expect(applyInputMessage(session, inputMessage(2, [sample(2), sample(1), sample(1)]))).toEqual([
      sample(1),
      sample(2),
    ]);
    expect(session.lastAppliedSequence).toBe(2);
  });

  it('rejects an implausibly large sequence jump instead of poisoning the session forever', () => {
    // Codex round 10 (PR #4): decodeInput accepts any u32 sequence. A forged or corrupted
    // 0xffffffff passed the "newer than lastAppliedSequence" check once and became the
    // new lastAppliedSequence -- after that, no real client sequence could ever be
    // "newer" than the wire format's own maximum again, permanently freezing the session.
    const session = createSession(0, 1, 0);
    expect(
      applyInputMessage(session, inputMessage(0xffffffff, [sample(1), sample(1), sample(1)])),
    ).toEqual([]);
    expect(session.lastAppliedSequence).toBe(0);

    // Normal input keeps working: the forged message never touched the session.
    expect(applyInputMessage(session, inputMessage(1, [sample(2), sample(2), sample(2)]))).toEqual([
      sample(2),
    ]);
    expect(session.lastAppliedSequence).toBe(1);
  });
});

describe('recordAck', () => {
  it('ignores an ack older than the one already recorded', () => {
    const session = createSession(0, 1, 0);
    recordAck(session, 5, 100);
    recordAck(session, 3, 200);
    expect(session.lastAckedSnapshotId).toBe(5);
    expect(session.lastAckedAt).toBe(100);
  });
});
