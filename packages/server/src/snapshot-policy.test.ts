import { describe, expect, it } from 'vitest';
import {
  emptyExtras,
  encodeSnapshot,
  decodeSnapshot,
  type ProjectileSnapshotData,
  type WorldExtras,
} from '@clans/protocol';
import {
  BaseObjectKind,
  addPlayer,
  createWorld,
  serializeActivePlayers,
  type Heightfield,
  type PlayerSnapshotData,
} from '@clans/sim';
import {
  DISTANT_PLAYER_UPDATE_EVERY,
  RELEVANCE_RADIUS_M,
  createRelevanceCache,
  distantUpdateDue,
  isBeyondRelevanceRadius,
  isInsideInteriorFootprint,
  needsFullSnapshot,
  relevantSnapshotForViewer,
  type BaseObjectPlacement,
  type InteriorFootprint,
} from './snapshot-policy.js';
import { buildExtras } from './net.js';

describe('needsFullSnapshot', () => {
  it('requires a full snapshot before any ack has arrived', () => {
    expect(needsFullSnapshot(0, null, 1000)).toBe(true);
  });
  it('allows a delta right after a fresh ack', () => {
    expect(needsFullSnapshot(4, 1000, 1000)).toBe(false);
  });
  it('falls back to full once the ack is more than 1 s stale', () => {
    expect(needsFullSnapshot(4, 0, 1000)).toBe(false);
    expect(needsFullSnapshot(4, 0, 1001)).toBe(true);
  });
});

describe('relevance radii and phases (issue #5)', () => {
  it('classifies the spec radius inclusively: exactly 400 m is relevant, beyond it is not', () => {
    const viewer = { x: 0, z: 0 };
    expect(isBeyondRelevanceRadius(viewer, { x: RELEVANCE_RADIUS_M - 0.1, z: 0 })).toBe(false);
    expect(isBeyondRelevanceRadius(viewer, { x: 0, z: RELEVANCE_RADIUS_M })).toBe(false);
    expect(isBeyondRelevanceRadius(viewer, { x: 500, z: 500 })).toBe(true);
  });

  it('puts distant players on a 1-in-N update phase keyed off the snapshot id', () => {
    for (let id = 1; id < DISTANT_PLAYER_UPDATE_EVERY; id += 1) {
      expect(distantUpdateDue(id)).toBe(false);
    }
    expect(distantUpdateDue(DISTANT_PLAYER_UPDATE_EVERY)).toBe(true);
    expect(distantUpdateDue(DISTANT_PLAYER_UPDATE_EVERY * 2 + 1)).toBe(false);
    expect(distantUpdateDue(DISTANT_PLAYER_UPDATE_EVERY * 3)).toBe(true);
  });

  it('tests interior footprints inclusively on the horizontal plane', () => {
    const footprint: InteriorFootprint = { minX: -5, minZ: -5, maxX: 5, maxZ: 5 };
    expect(isInsideInteriorFootprint(0, 0, [footprint])).toBe(true);
    expect(isInsideInteriorFootprint(5, -5, [footprint])).toBe(true);
    expect(isInsideInteriorFootprint(5.1, 0, [footprint])).toBe(false);
    expect(isInsideInteriorFootprint(0, 0, [])).toBe(false);
  });
});

/** A fully-populated snapshot record at one position -- every test below only cares about
 * id/x/z, but the wire type demands the whole roster shape. */
function makePlayer(id: number, x: number, z: number): PlayerSnapshotData {
  return {
    id,
    team: 1,
    x,
    y: 0,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    energy: 60,
    health: 0.66,
    weaponSlot: 0,
    onGround: 1,
    ski: 0,
    respawnSeq: 0,
    discAmmo: 0,
    chaingunAmmo: 0,
    mortarAmmo: 0,
    grenades: 0,
    weaponState: 1,
    weaponTimer: 0,
    spunUp: 0,
    grenadeCooldown: 0,
    score: 0,
    wasJumpHeld: 0,
    godMode: 0,
    armor: 0,
    hasRepairPack: 0,
    // #55: the networked loadout rides the player snapshot; this literal is the full-fidelity
    // roster shape, so it carries the new pack and carried-weapons fields too.
    hasEnergyPack: 0,
    carriedWeapons: 0,
  };
}

/** Two players at fixed ids: 0 (the viewer, at the origin) and 1 (500 m out, the issue's
 * own example distance). `moveFresh` simulates a sim tick by shifting the distant player
 * so the tests can tell fresh data from a stale re-send. */
function rosterWithDistantPair(): {
  fresh: () => PlayerSnapshotData[];
  moveDistant: () => void;
} {
  let distantX = 500;
  return {
    fresh: () => [makePlayer(0, 0, 0), makePlayer(1, distantX, 0)],
    moveDistant: () => {
      distantX += 1;
    },
  };
}

describe('relevantSnapshotForViewer: sparse distant players that persist (issue #5)', () => {
  it('sends the near viewer and a distant player fresh on the update snapshot', () => {
    const roster = rosterWithDistantPair();
    const cache = createRelevanceCache();
    const view = relevantSnapshotForViewer({
      snapshotId: DISTANT_PLAYER_UPDATE_EVERY,
      full: false,
      viewerId: 0,
      players: roster.fresh(),
      extras: emptyExtras(),
      interiors: [],
      baseObjectPositions: [],
      cache,
    });
    expect(view.players.map((player) => player.id)).toEqual([0, 1]);
    expect(view.players[1]?.x).toBe(500);
  });

  it('re-sends the distant player STALE between updates instead of omitting them (persistence)', () => {
    // Omitting the distant player would put their id in the delta encoder's removedIds and
    // delete them client-side; the stale copy must ride along instead, diffing clean.
    const roster = rosterWithDistantPair();
    const cache = createRelevanceCache();
    const baseInput = {
      full: false,
      viewerId: 0,
      extras: emptyExtras(),
      interiors: [],
      baseObjectPositions: [],
      cache,
    };
    relevantSnapshotForViewer({ ...baseInput, snapshotId: 1, players: roster.fresh() });
    roster.moveDistant(); // the distant player moves; the sparse tick must NOT show it yet
    const staleView = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 2,
      players: roster.fresh(),
    });
    expect(staleView.players).toHaveLength(2);
    expect(staleView.players[1]?.x).toBe(500);
    roster.moveDistant();
    const stillStale = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 3,
      players: roster.fresh(),
    });
    expect(stillStale.players[1]?.x).toBe(500);
    roster.moveDistant();
    const updated = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 4,
      players: roster.fresh(),
    });
    expect(updated.players[1]?.x).toBe(503);
  });

  it('seeds a distant player fresh the first time it crosses out of the radius', () => {
    const cache = createRelevanceCache();
    const baseInput = {
      full: false,
      viewerId: 0,
      extras: emptyExtras(),
      interiors: [],
      baseObjectPositions: [],
      cache,
    };
    relevantSnapshotForViewer({ ...baseInput, snapshotId: 2, players: [makePlayer(0, 0, 0)] });
    // Player 1 appears at 500 m with no cache entry: it must be sent fresh (a stale copy of
    // data the client never saw does not exist), not dropped.
    const view = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 2,
      players: [makePlayer(0, 0, 0), makePlayer(1, 500, 0)],
    });
    expect(view.players[1]?.x).toBe(500);
  });

  it('sends everyone fresh on a full snapshot regardless of phase', () => {
    const roster = rosterWithDistantPair();
    const cache = createRelevanceCache();
    roster.moveDistant();
    const view = relevantSnapshotForViewer({
      snapshotId: 2,
      full: true,
      viewerId: 0,
      players: roster.fresh(),
      extras: emptyExtras(),
      interiors: [],
      baseObjectPositions: [],
      cache,
    });
    expect(view.players[1]?.x).toBe(501);
  });

  it('keeps near players fresh every snapshot and their cache warm for an outward crossing', () => {
    const cache = createRelevanceCache();
    const baseInput = {
      full: false,
      viewerId: 0,
      extras: emptyExtras(),
      interiors: [],
      baseObjectPositions: [],
      cache,
    };
    // Player 1 walks toward the boundary while still near (fresh every snapshot, the cache
    // tracking it), crosses to just beyond 400 m, and the very next sparse tick falls back
    // to data from the moment it left -- never an older position from an earlier far stay.
    let player1X = 398;
    const roster = () => [makePlayer(0, 0, 0), makePlayer(1, player1X, 0)];
    relevantSnapshotForViewer({ ...baseInput, snapshotId: 1, players: roster() });
    player1X = 399;
    const stillNear = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 2,
      players: roster(),
    });
    expect(stillNear.players[1]?.x).toBe(399);
    player1X = 401;
    const crossed = relevantSnapshotForViewer({ ...baseInput, snapshotId: 3, players: roster() });
    expect(crossed.players[1]?.x).toBe(399);
    player1X = 402;
    const updated = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 4,
      players: roster(),
    });
    expect(updated.players[1]?.x).toBe(402);
  });

  it('forgets the cached copy of a player id that left the roster', () => {
    const cache = createRelevanceCache();
    const baseInput = {
      full: false,
      viewerId: 0,
      extras: emptyExtras(),
      interiors: [],
      baseObjectPositions: [],
      cache,
    };
    relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 2,
      players: [makePlayer(0, 0, 0), makePlayer(1, 500, 0)],
    });
    expect(cache.players.has(1)).toBe(true);
    relevantSnapshotForViewer({ ...baseInput, snapshotId: 3, players: [makePlayer(0, 0, 0)] });
    expect(cache.players.has(1)).toBe(false);
  });

  it('passes everything through unfiltered when the viewer cannot be resolved', () => {
    const players = [makePlayer(0, 0, 0), makePlayer(1, 500, 0)];
    const extras = emptyExtras();
    const view = relevantSnapshotForViewer({
      snapshotId: 2,
      full: false,
      viewerId: null,
      players,
      extras,
      interiors: [],
      baseObjectPositions: [],
      cache: createRelevanceCache(),
    });
    expect(view.players).toBe(players);
    expect(view.extras).toBe(extras);
  });
});

describe('relevantSnapshotForViewer: extras filtering (issue #5)', () => {
  function extrasWith(
    projectiles: ProjectileSnapshotData[],
    baseObjects: WorldExtras['baseObjects'],
  ): WorldExtras {
    return { ...emptyExtras(), projectiles, baseObjects };
  }

  const interiors: InteriorFootprint[] = [{ minX: 495, minZ: 495, maxX: 505, maxZ: 505 }];
  const placements: BaseObjectPlacement[] = [
    { id: 0, x: 500, z: 500, kind: BaseObjectKind.Generator },
    { id: 1, x: 500, z: 520, kind: BaseObjectKind.ForceField },
  ];

  it('drops far projectiles and keeps near ones', () => {
    const far: ProjectileSnapshotData = {
      id: 0,
      type: 0,
      weaponId: 0,
      x: 600,
      y: 0,
      z: 600,
      vx: 0,
      vy: 0,
      vz: 0,
      ownerId: -1,
      armed: 1,
    };
    const near = { ...far, id: 1, x: 10, z: 10 };
    const view = relevantSnapshotForViewer({
      snapshotId: 2,
      full: false,
      viewerId: 0,
      players: [makePlayer(0, 0, 0)],
      extras: extrasWith([far, near], []),
      interiors: [],
      baseObjectPositions: [],
      cache: createRelevanceCache(),
    });
    expect(view.extras.projectiles.map((projectile) => projectile.id)).toEqual([1]);
  });

  it('drops a far base object hidden inside an interior, keeping force fields and near objects', () => {
    const baseObjects: WorldExtras['baseObjects'] = [
      { id: 0, damage: 0, destroyed: 0, powered: 1, energy: 50 },
      { id: 1, damage: 0, destroyed: 0, powered: 1, energy: 0 },
    ];
    const view = relevantSnapshotForViewer({
      snapshotId: 2,
      full: false,
      viewerId: 0,
      players: [makePlayer(0, 0, 0)],
      extras: extrasWith([], baseObjects),
      interiors,
      baseObjectPositions: placements,
      cache: createRelevanceCache(),
    });
    // The generator sits inside the interior footprint 500 m away: hidden, never sent. The
    // force field is just as far but exempt -- it is the one base object meant to be seen
    // (and collided with) from far outside.
    expect(view.extras.baseObjects.map((object) => object.id)).toEqual([1]);
  });

  it('sends an interior item once the viewer is within the radius, hidden or not', () => {
    const baseObjects: WorldExtras['baseObjects'] = [
      { id: 0, damage: 0, destroyed: 0, powered: 1, energy: 50 },
    ];
    const view = relevantSnapshotForViewer({
      snapshotId: 2,
      full: false,
      viewerId: 0,
      players: [makePlayer(0, 490, 490)],
      extras: extrasWith([], baseObjects),
      interiors,
      baseObjectPositions: placements,
      cache: createRelevanceCache(),
    });
    expect(view.extras.baseObjects).toHaveLength(1);
  });
});

describe('per-client bandwidth on a full 32-player roster (issue #5, real encoder)', () => {
  // Flat heightfield, the same shape every server test uses; capacity 32 is the spec's full
  // roster (the bots milestone fills the server to exactly this).
  const terrain: Heightfield = {
    gridSize: 2,
    squareSize: 8,
    originX: 0,
    originY: 0,
    originZ: 8,
    heightScale: 1,
    heights: new Uint16Array(4),
  };

  /** The roster moves one metre per simulated tick: every distant player's transform is
   * genuinely dirty, the worst case for the old everyone-everything send. */
  function moveEveryone(world: ReturnType<typeof createWorld>): void {
    for (let id = 0; id < world.players.count; id += 1) {
      world.players.position[id * 3] = (world.players.position[id * 3] ?? 0) + 1;
    }
  }

  it('costs less per sparse snapshot than sending every player every snapshot', () => {
    const world = createWorld(terrain, 1, 32);
    const viewerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
    // 31 others ringed ~500 m out: every one beyond the relevance radius, the exact
    // scenario the issue says blows the spec's bandwidth budget.
    for (let id = 1; id < 32; id += 1) {
      const angle = (id / 31) * Math.PI * 2;
      addPlayer(world, { x: 500 + (id % 4) * 20, y: 0, z: Math.sin(angle) * 520 }, 2);
    }
    const cache = createRelevanceCache();
    const baseInput = {
      viewerId,
      extras: buildExtras(world),
      interiors: [] as InteriorFootprint[],
      baseObjectPositions: [] as BaseObjectPlacement[],
      cache,
    };

    // The client's acked baseline: a full (baseline-less) snapshot of the viewer's view.
    moveEveryone(world);
    const fullView = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 1,
      full: true,
      players: serializeActivePlayers(world),
    });
    const decodedFull = decodeSnapshot(
      encodeSnapshot(1, world.tick, 0, fullView.players, null, fullView.extras),
      null,
    );
    const baseline = { snapshotId: decodedFull.snapshotId, players: decodedFull.players };

    // Next tick: the whole roster moves again. The pre-#5 server encoded the complete
    // fresh roster for this client; the relevant view is the sparse tick (snapshot 2, not
    // a multiple of DISTANT_PLAYER_UPDATE_EVERY) where every distant player rides stale.
    moveEveryone(world);
    const freshRoster = serializeActivePlayers(world);
    const oldBytes = encodeSnapshot(2, world.tick, 0, freshRoster, baseline, baseInput.extras);
    const sparseView = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: 2,
      full: false,
      players: freshRoster,
    });
    const sparseBytes = encodeSnapshot(
      2,
      world.tick,
      0,
      sparseView.players,
      baseline,
      sparseView.extras,
    );
    const decodedSparse = decodeSnapshot(sparseBytes, baseline);

    // Persistence (the encoder's removal semantics are exactly why omission is wrong):
    // every one of the 32 players survives the sparse snapshot, and none of the distant
    // players' stale copies cost a single changed-record byte -- only genuinely moved
    // data enters the diff. The pre-#5 encode changed all 31 distant transforms.
    expect(decodedSparse.players).toHaveLength(32);
    const before = new Map(baseline.players.map((player) => [player.id, player]));
    const changedCount = (decoded: typeof decodedFull) =>
      decoded.players.filter((player) => {
        const previous = before.get(player.id);
        return previous === undefined || Math.abs(previous.x - player.x) > 1e-4;
      }).length;
    // Exactly one player changed on the sparse tick: the viewer themself (always near,
    // always fresh). All 31 distant players' stale copies diff clean against the baseline.
    expect(changedCount(decodedSparse)).toBe(1);
    // The pre-#5 encode moved all 32 transforms (the whole roster moved, viewer included).
    expect(changedCount(decodeSnapshot(oldBytes, baseline))).toBe(32);

    // The measured drop, derived entirely from the real encoder above: a sparse tick on a
    // full roster costs strictly less than the old send-everything snapshot.
    expect(sparseBytes.length).toBeLessThan(oldBytes.length);
    // And the update snapshot still carries everyone fresh, so the sparse cadence converges.
    const updateView = relevantSnapshotForViewer({
      ...baseInput,
      snapshotId: DISTANT_PLAYER_UPDATE_EVERY,
      full: false,
      players: freshRoster,
    });
    const decodedUpdate = decodeSnapshot(
      encodeSnapshot(
        DISTANT_PLAYER_UPDATE_EVERY,
        world.tick,
        0,
        updateView.players,
        baseline,
        updateView.extras,
      ),
      baseline,
    );
    expect(changedCount(decodedUpdate)).toBe(32);
  });
});
