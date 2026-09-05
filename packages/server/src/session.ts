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
 * packet never rewinds a session. `samples` is [newest, newest-1, newest-2]; when up to
 * two ticks were missed, the matching redundant sample fills the gap instead of being
 * dropped. This applies uniformly whether or not a message has ever been applied yet:
 * lastAppliedSequence stays 0 both before the true first message, and after the true
 * first message was itself lost, and only the second case has redundant samples worth
 * recovering. Special-casing "nothing applied yet" to take just the newest sample (as
 * this used to) is a no-op for a real first message (it already resolves to 1 sample
 * either way) but silently threw away the recoverable backfill in the second case,
 * permanently losing whatever jump or move key that lost first packet carried.
 */
export function applyInputMessage(session: Session, message: InputMessage): NetInputSample[] {
  if (message.sequence <= session.lastAppliedSequence) return [];
  const missing = Math.min(message.sequence - session.lastAppliedSequence, message.samples.length);
  const toApply = message.samples.slice(0, missing).reverse();
  session.lastAppliedSequence = message.sequence;
  return toApply;
}

export function recordAck(session: Session, snapshotId: number, now: number): void {
  if (snapshotId < session.lastAckedSnapshotId) return;
  session.lastAckedSnapshotId = snapshotId;
  session.lastAckedAt = now;
}
