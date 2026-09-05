import type { InputMessage, NetInputSample } from '@clans/protocol';

export interface Session {
  playerId: number;
  team: number;
  lastAppliedSequence: number;
  lastAckedSnapshotId: number;
  lastAckedAt: number | null;
}

export function createSession(playerId: number, team: number, now: number): Session {
  return { playerId, team, lastAppliedSequence: 0, lastAckedSnapshotId: 0, lastAckedAt: now };
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
