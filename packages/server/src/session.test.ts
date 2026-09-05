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
    expect(applyInputMessage(session, inputMessage(10, [sample(1), sample(1), sample(1)]))).toEqual(
      [sample(1)],
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
