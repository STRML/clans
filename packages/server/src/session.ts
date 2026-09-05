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

// The wire format serializes sequence as a u32 (see protocol's codec.ts), so a client
// that stays connected long enough eventually wraps back to 0. At one Input message per
// tick (FIXED_TICK_MS), that takes about 4.36 years -- rare, but not impossible for a
// long-running dedicated server -- and a plain `current > last` comparison would reject
// every sequence forever afterward, since nothing can look "newer" than 0xffffffff again.
const SEQUENCE_SPACE = 0x100000000; // 2^32
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
 * The forward distance is computed in a 32-bit circular sequence space (mirroring TCP's
 * own wraparound-safe comparison), not a plain subtraction: stepping forward from
 * 0xffffffff to 0 is a distance of 1, exactly like stepping from 1 to 2, so a genuine
 * wraparound after ~4.36 years of continuous play is accepted like any other tick advance
 * while a forged jump that looks huge in the forward direction is still rejected by the
 * same MAX_SEQUENCE_JUMP bound that catches a forged 0xffffffff today.
 */
export function applyInputMessage(session: Session, message: InputMessage): NetInputSample[] {
  const gap = (message.sequence - session.lastAppliedSequence + SEQUENCE_SPACE) % SEQUENCE_SPACE;
  if (gap === 0 || gap > MAX_SEQUENCE_JUMP) return [];
  const missing = Math.min(gap, message.samples.length);
  const toApply = message.samples.slice(0, missing).reverse();
  session.lastAppliedSequence = message.sequence;
  return toApply;
}

/**
 * snapshotId is the same wire-format u32 as an Input sequence (see snapshot.ts), so it
 * wraps back to 0 after long enough uptime too (roughly 8.7 years at one snapshot every
 * SNAPSHOT_EVERY_N_TICKS ticks) -- the same class of bug applyInputMessage above guards
 * against. handleAck in net.ts already rejects any snapshotId the server never actually
 * sent, so unlike applyInputMessage this needs no forged-jump bound: every id reaching
 * here is a real one from the server's own recent history, bounded to a handful of
 * candidates. A gap past the halfway point of the circular space means snapshotId is
 * really behind lastAckedSnapshotId once wraparound is accounted for (mirrors TCP's own
 * wrapped-sequence comparison).
 */
export function recordAck(session: Session, snapshotId: number, now: number): void {
  const gap = (snapshotId - session.lastAckedSnapshotId + SEQUENCE_SPACE) % SEQUENCE_SPACE;
  if (gap > SEQUENCE_SPACE / 2) return;
  session.lastAckedSnapshotId = snapshotId;
  session.lastAckedAt = now;
}
