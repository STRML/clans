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

// A real client starts its sequence at 1 and advances it by exactly one per tick, so
// even a long reconnect stall only produces a gap of however many ticks were missed —
// nowhere near this. This exists to catch a forged or corrupted sequence (a raw u32 up
// to 0xffffffff): without a bound, accepting it as "newer" would set lastAppliedSequence
// to that value forever, since nothing sent over the wire can ever be newer than the
// format's own maximum again, permanently freezing the session's real input.
const MAX_SEQUENCE_JUMP = 10_000;

/**
 * Returns the input samples this message adds, oldest first. A message whose sequence is
 * not newer than the last one applied, or whose jump ahead is implausibly large, is
 * dropped entirely — a reordered, duplicate, or forged packet never rewinds or poisons a
 * session. `samples` is [newest, newest-1, newest-2]; when up to two ticks were missed,
 * the matching redundant sample fills the gap instead of being dropped. This applies
 * uniformly whether or not a message has ever been applied yet: lastAppliedSequence stays
 * 0 both before the true first message, and after the true first message was itself
 * lost, and only the second case has redundant samples worth recovering. Special-casing
 * "nothing applied yet" to take just the newest sample (as this used to) is a no-op for a
 * real first message (it already resolves to 1 sample either way) but silently threw
 * away the recoverable backfill in the second case, permanently losing whatever jump or
 * move key that lost first packet carried.
 *
 * WONTFIX (PR #4, M2 status table): the wire format serializes sequence as a u32, so a
 * session kept continuously open for ~4.36 years at one Input message per tick would wrap
 * back to 0 and this comparison would then reject all further input, requiring a
 * reconnect. Round 11 made this comparison wraparound-safe (circular sequence-space
 * arithmetic), but every downstream consumer of a sequence or snapshotId -- the client's
 * own unwrapped bookkeeping, the server's ack matching, remote-interpolation timestamps,
 * packet-loss accounting -- would need the same treatment to stay consistent, and round
 * 12 found exactly that: fixing one site surfaced the next. Given the years-long timescale
 * involved, a clean "please reconnect" after a session outlives the wire format is an
 * acceptable terminal state; chasing wraparound-consistency across every subsystem is not
 * proportionate to a scenario no real deployment of this project will reach. Reverted to
 * a plain forward comparison plus the MAX_SEQUENCE_JUMP bound below, which still closes
 * the actually-reachable finding (a forged large jump poisoning the session) without
 * pretending to support multi-year uninterrupted uptime.
 */
export function applyInputMessage(session: Session, message: InputMessage): NetInputSample[] {
  if (message.sequence <= session.lastAppliedSequence) return [];
  const gap = message.sequence - session.lastAppliedSequence;
  if (gap > MAX_SEQUENCE_JUMP) return [];
  const missing = Math.min(gap, message.samples.length);
  const toApply = message.samples.slice(0, missing).reverse();
  session.lastAppliedSequence = message.sequence;
  return toApply;
}

export function recordAck(session: Session, snapshotId: number, now: number): void {
  if (snapshotId < session.lastAckedSnapshotId) return;
  session.lastAckedSnapshotId = snapshotId;
  session.lastAckedAt = now;
}
