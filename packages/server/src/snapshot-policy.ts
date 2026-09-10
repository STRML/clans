import { SNAPSHOT_FALLBACK_MS, type WorldExtras } from '@clans/protocol';
import { BaseObjectKind, type PlayerSnapshotData } from '@clans/sim';

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

// Spec (Networking section, "Relevance"): "a client receives full updates for entities
// within 400 m, low-rate updates for the rest, and no updates for hidden interior items
// far away." Issue #5. The 400 m number is the spec's own; the sparse cadence below is
// ours -- snapshots go out every SNAPSHOT_EVERY_N_TICKS (2) ticks, so updating distant
// players every DISTANT_PLAYER_UPDATE_EVERY snapshots lands them at roughly 2 Hz instead
// of the near-field ~8 Hz, which is far beyond what a 400+ m spectator can resolve and
// (via the player delta encoder) makes their non-update snapshots cost zero bytes: a
// distant player whose stale copy matches the baseline produces an empty dirty mask.
export const RELEVANCE_RADIUS_M = 400;
export const DISTANT_PLAYER_UPDATE_EVERY = 4;

/**
 * Horizontal map distance is what "within 400 m" means for relevance: a player skiing 30 m
 * above the basin floor is still "here" for a viewer on the floor, and every entity this
 * policy classifies (players, projectiles, base objects) lives on the same terrain sheet.
 */
export function isBeyondRelevanceRadius(
  viewer: { x: number; z: number },
  entity: { x: number; z: number },
): boolean {
  return Math.hypot(entity.x - viewer.x, entity.z - viewer.z) > RELEVANCE_RADIUS_M;
}

/** The sparse-update phase for distant players, keyed off the global snapshot id so every
 * client's far field refreshes on the same snapshots (one shared counter, one phase). */
export function distantUpdateDue(snapshotId: number): boolean {
  return snapshotId % DISTANT_PLAYER_UPDATE_EVERY === 0;
}

/** The footprint test for the spec's "hidden interior items far away": an entity whose
 * position sits inside an interior instance's axis-aligned world bounds is inside a
 * building. Callers combine this with the radius check themselves -- an item inside a
 * building 100 m away is still fully relevant (you can walk in and see it). Bounds use the
 * horizontal plane only: interiors are buildings, so "inside the footprint" is the right
 * test even for an object on a floor a few metres above or below the bounds' mid-height.
 * Structurally satisfied by @clans/sim's InteriorInstance.bounds, whose full Aabb carries
 * the Y axis too -- sim doesn't export the Aabb interface itself, so this local shape is
 * what the policy accepts. */
export interface InteriorFootprint {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function isInsideInteriorFootprint(
  x: number,
  z: number,
  interiors: readonly InteriorFootprint[],
): boolean {
  return interiors.some(
    (bounds) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ,
  );
}

/** Per-base-object facts the relevance policy needs but the wire format doesn't carry:
 * BaseObjectSnapshotData is id/damage/destroyed/powered/energy only -- positions live in
 * world.baseObjects, so net.ts forwards them here once per snapshot send. */
export interface BaseObjectPlacement {
  id: number;
  x: number;
  z: number;
  kind: number;
}

/**
 * The per-client memory the sparse-player rule needs: the last data actually sent for
 * each distant player. A distant player between its sparse updates must still appear in
 * the snapshot carrying its STALE copy -- omitting it entirely would put it in the delta
 * encoder's removedIds and delete it client-side (decodeDelta removes every baseline id
 * absent from `current`), which is exactly the "read as removed" failure issue #5 calls
 * out. Re-sending the identical stale data diffs clean against the acked baseline and
 * keeps the entity alive on the client for free.
 */
export interface RelevanceCache {
  players: Map<number, PlayerSnapshotData>;
}

export function createRelevanceCache(): RelevanceCache {
  return { players: new Map() };
}

export interface RelevantSnapshotInput {
  snapshotId: number;
  /** True when this send is a full (baseline-less) snapshot: distant players are sent
   * fresh so a resync always carries current state, and the sparse phase restarts from it. */
  full: boolean;
  /** The receiving player's id, or null when it can't be resolved -- the caller then gets
   * the complete, unfiltered state rather than a guess. */
  viewerId: number | null;
  players: PlayerSnapshotData[];
  extras: WorldExtras;
  interiors: readonly InteriorFootprint[];
  baseObjectPositions: readonly BaseObjectPlacement[];
  cache: RelevanceCache;
}

export interface RelevantSnapshot {
  players: PlayerSnapshotData[];
  extras: WorldExtras;
}

/**
 * Builds the per-client view of one snapshot send (issue #5):
 *
 * - players within RELEVANCE_RADIUS_M (and the viewer's own player): fresh every snapshot;
 * - players beyond it: fresh data every DISTANT_PLAYER_UPDATE_EVERY-th snapshot, the last
 *   sent copy between those (see RelevanceCache for why omission is not an option);
 * - projectiles beyond the radius: never sent. They are transient and move hundreds of
 *   metres per second, so a stale copy would cost the same bytes as a fresh one while
 *   showing the viewer a position the projectile left several ticks ago; a projectile that
 *   simply never existed for a far viewer pops in when it crosses the radius, and one that
 *   flies out vanishes at it -- both invisible details at 400 m.
 * - base objects beyond the radius hidden inside an interior footprint: never sent (the
 *   spec's third clause). Force fields are exempt: they are the one base object meant to
 *   be seen (and collided with) from far outside, and their quad sits at base entrances
 *   rather than inside a building volume. Everything else static (turrets, flags, vehicles,
 *   bots, orders, scores) rides along unfiltered -- those arrays are O(map), not O(roster),
 *   so they are not where the 32-player bandwidth problem lives, and flags in particular
 *   must stay current on every client for CTF state to read coherently.
 *
 * The same view applies to full and delta snapshots alike: a full send is just the same
 * relevance set without a baseline, so the client's world never gains and then loses an
 * entity across a fallback resync.
 */
export function relevantSnapshotForViewer(input: RelevantSnapshotInput): RelevantSnapshot {
  const viewer =
    input.viewerId === null
      ? null
      : (input.players.find((player) => player.id === input.viewerId) ?? null);
  if (!viewer) return { players: input.players, extras: input.extras };
  return {
    players: playersForViewer(input, viewer),
    extras: extrasForViewer(input, viewer),
  };
}

function playersForViewer(
  input: RelevantSnapshotInput,
  viewer: PlayerSnapshotData,
): PlayerSnapshotData[] {
  const out: PlayerSnapshotData[] = [];
  for (const player of input.players) {
    const distant = player.id !== viewer.id && isBeyondRelevanceRadius(viewer, player);
    // Near players refresh the cache too, so an entity that crosses the radius outward
    // always falls back to data from the moment it left, never a stale pre-crossing copy.
    if (!distant) {
      input.cache.players.set(player.id, player);
      out.push(player);
      continue;
    }
    if (input.full || distantUpdateDue(input.snapshotId) || !input.cache.players.has(player.id)) {
      input.cache.players.set(player.id, player);
    }
    out.push(input.cache.players.get(player.id) ?? player);
  }
  // Ids vanish on disconnect (and can be reused by a new player immediately); a cached
  // copy of an id no longer in the roster must never resurface for a future occupant.
  const liveIds = new Set(input.players.map((player) => player.id));
  for (const id of input.cache.players.keys()) {
    if (!liveIds.has(id)) input.cache.players.delete(id);
  }
  return out;
}

function extrasForViewer(input: RelevantSnapshotInput, viewer: PlayerSnapshotData): WorldExtras {
  const projectiles = input.extras.projectiles.filter(
    (projectile) => !isBeyondRelevanceRadius(viewer, projectile),
  );
  const placementsById = new Map(input.baseObjectPositions.map((entry) => [entry.id, entry]));
  const baseObjects = input.extras.baseObjects.filter((object) => {
    const placement = placementsById.get(object.id);
    // No placement info (shouldn't happen -- net.ts derives the list from the same world
    // the snapshot was built from): keep the object rather than risk dropping live state.
    if (!placement) return true;
    if (!isBeyondRelevanceRadius(viewer, placement)) return true;
    if (placement.kind === BaseObjectKind.ForceField) return true;
    return !isInsideInteriorFootprint(placement.x, placement.z, input.interiors);
  });
  return { ...input.extras, projectiles, baseObjects };
}
