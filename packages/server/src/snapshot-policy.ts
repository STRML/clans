import { SNAPSHOT_FALLBACK_MS } from '@clans/protocol';

/**
 * A client never gets a delta against a snapshot it has not acknowledged. If a client's
 * ack is missing or more than SNAPSHOT_FALLBACK_MS stale, the next send is a full snapshot,
 * so a lost ack cannot stall the connection forever.
 */
export function needsFullSnapshot(
  lastAckedSnapshotId: number,
  lastAckedAt: number | null,
  now: number,
): boolean {
  if (lastAckedSnapshotId === 0 || lastAckedAt === null) return true;
  return now - lastAckedAt > SNAPSHOT_FALLBACK_MS;
}
