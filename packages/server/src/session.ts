import type { InputMessage, NetInputSample } from '@clans/protocol';

export interface Session {
  playerId: number;
  team: number;
  /** Highest Input message sequence parsed so far. Governs message-level dedup only. */
  lastAppliedSequence: number;
  /**
   * Sequence of the newest sample actually dequeued into a simulation tick. A message
   * can queue more than one sample (its redundant samples catching up a missed tick),
   * and the server only ever applies one queued sample per tick, so this can trail
   * lastAppliedSequence by however many samples are still queued. This is what a
   * snapshot's lastInputSequence must report: it tells the client which of its inputs
   * are safe to drop from replay, and a sample only queued (not yet simulated) is not.
   */
  lastSimulatedSequence: number;
  lastAckedSnapshotId: number;
  lastAckedAt: number | null;
}

export function createSession(playerId: number, team: number, now: number): Session {
  return {
    playerId,
    team,
    lastAppliedSequence: 0,
    lastSimulatedSequence: 0,
    lastAckedSnapshotId: 0,
    lastAckedAt: now,
  };
}

/**
 * Returns the input samples this message adds, oldest first. A message whose sequence is
 * not newer than the last one applied is dropped entirely — a reordered or duplicate
 * packet never rewinds a session. `samples` is [newest, newest-1, newest-2]; when up to two
 * ticks were missed, the matching redundant sample fills the gap instead of being dropped.
 */
export function applyInputMessage(session: Session, message: InputMessage): NetInputSample[] {
  if (message.sequence <= session.lastAppliedSequence) return [];
  // Before the first message, there is no prior tick to catch up from — take only the
  // newest sample. Once a sequence has been applied, backfill up to two missed ticks
  // from the redundant samples the message carries.
  const missing =
    session.lastAppliedSequence === 0
      ? 1
      : Math.min(message.sequence - session.lastAppliedSequence, message.samples.length);
  const toApply = message.samples.slice(0, missing).reverse();
  session.lastAppliedSequence = message.sequence;
  return toApply;
}

export function recordAck(session: Session, snapshotId: number, now: number): void {
  if (snapshotId < session.lastAckedSnapshotId) return;
  session.lastAckedSnapshotId = snapshotId;
  session.lastAckedAt = now;
}
