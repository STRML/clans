import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  armorFor,
  createWorld,
  defaultWeaponMask,
  GameOverReason,
  LIGHT_ARMOR,
  VEHICLE_DATA,
  VehicleKind,
  WeaponId,
  type Heightfield,
} from '@clans/sim';
import {
  armHitMarker,
  carriedWeaponSlots,
  describeHud,
  describeKillFeed,
  hitMarkerIsShown,
  HIT_MARKER_MS,
  packIconSrc,
  RETICLE_NATIVE_SIZE,
  reticleBitmapFor,
  reticleBox,
  reticleScale,
  type HitMarker,
  type HudSource,
} from './hud.js';
import { EventKind, type EventMessage, type FlagSnapshotData } from '@clans/protocol';

const flat: Heightfield = {
  gridSize: 2,
  squareSize: 1000,
  originX: 0,
  originY: 0,
  originZ: 1000,
  heightScale: 1,
  heights: new Uint16Array(4),
};

function baseSource(overrides: Partial<HudSource> = {}): HudSource {
  const world = createWorld(flat, 1);
  const playerId = addPlayer(world, { x: 0, y: 0, z: 0 }, 1);
  return {
    world,
    playerId,
    networkPlayerId: playerId,
    connection: 'online',
    teamScores: [0, 0],
    flags: [],
    gameOver: false,
    winnerTeam: 0,
    timeRemainingS: 0,
    gameOverReason: GameOverReason.CaptureLimit,
    recentEvents: [],
    aimedStructure: null,
    ...overrides,
  };
}
function rowsOf(source: HudSource): Record<string, string> {
  return Object.fromEntries(describeHud(source).map((row) => [row.id, row.text]));
}

describe('describeHud', () => {
  it('reports health and energy as percentages of the armor max', () => {
    const source = baseSource();
    source.world.players.damage[source.playerId] = LIGHT_ARMOR.maxDamage / 2;
    source.world.players.energy[source.playerId] = LIGHT_ARMOR.maxEnergy / 4;
    const rows = rowsOf(source);
    expect(rows['hud-health']).toBe('50%');
    expect(rows['hud-energy']).toBe('25%');
  });

  it('names the held weapon and reports infinite ammo as the infinity symbol', () => {
    const source = baseSource();
    source.world.players.weaponSlot[source.playerId] = WeaponId.LaserRifle;
    const rows = rowsOf(source);
    expect(rows['hud-weapon']).toBe('Laser Rifle');
    expect(rows['hud-ammo']).toBe('∞');
  });

  it('reports finite ammo as a count, e.g. a fresh Spinfusor loadout of 15', () => {
    const source = baseSource();
    source.world.players.weaponSlot[source.playerId] = WeaponId.Spinfusor;
    expect(rowsOf(source)['hud-ammo']).toBe(String(LIGHT_ARMOR.discAmmo));
  });

  it('shows the team scores line', () => {
    expect(rowsOf(baseSource({ teamScores: [300, 100] }))['hud-team-scores']).toBe(
      'Storm: 300 — Inferno: 100',
    );
  });

  it('warns "your flag is not home" only while carrying the enemy flag with your own away (failure matrix row 3)', () => {
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 1, x: 0, y: 0, z: 0, carrierId: 99, returnInS: -1 }, // ours, stolen
      { id: 1, team: 2, state: 1, x: 0, y: 0, z: 0, carrierId: 0, returnInS: -1 }, // enemy, carried by us
    ];
    expect(rowsOf(baseSource({ flags }))['hud-flag-status']).toBe('your flag is not home');
  });

  it('shows "carrying the enemy flag" when the real network player id carries it, even though the local prediction slot is 0 (Codex review round 5, finding 4)', () => {
    // The dev server starts with 31 bots already connected, so a joining human is very
    // likely assigned a real id other than 0 (e.g. 31) -- but this client's own predicted
    // state always lives at world.players slot 0 (the fixed local-prediction convention),
    // regardless of that real id. Before this fix, flagStatusRow compared carrierId
    // against `playerId` (always 0 for the local slot), so this case never matched and the
    // HUD stayed blank even though the server-side flag really is Carried by this player.
    const source = baseSource({ playerId: 0, networkPlayerId: 31 });
    const flags: FlagSnapshotData[] = [
      { id: 0, team: 1, state: 0, x: 0, y: 0, z: 0, carrierId: -1, returnInS: -1 }, // ours, home
      { id: 1, team: 2, state: 1, x: 0, y: 0, z: 0, carrierId: 31, returnInS: -1 }, // enemy, carried by us
    ];
    expect(rowsOf({ ...source, flags })['hud-flag-status']).toBe('carrying the enemy flag');
  });

  it('shows a respawn countdown only while dead', () => {
    const source = baseSource();
    expect(rowsOf(source)['hud-respawn']).toBe('');
    source.world.players.alive[source.playerId] = 0;
    source.world.players.respawnAt[source.playerId] = 100;
    source.world.tick = 50;
    expect(rowsOf(source)['hud-respawn']).toBe('respawning in 2s');
  });

  it('names a capture-limit win plainly', () => {
    const source = baseSource({
      gameOver: true,
      winnerTeam: 2,
      gameOverReason: GameOverReason.CaptureLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Match ended: Inferno wins. Movement is paused.');
  });

  it('names a time-limit win with "on time"', () => {
    const source = baseSource({
      gameOver: true,
      winnerTeam: 1,
      gameOverReason: GameOverReason.TimeLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe(
      'Match ended: Storm wins on time. Movement is paused.',
    );
  });

  it('names a time-limit tie as a tie, not a team win', () => {
    const source = baseSource({
      gameOver: true,
      winnerTeam: 0,
      gameOverReason: GameOverReason.TimeLimit,
    });
    expect(rowsOf(source)['hud-game-over']).toBe('Match ended: tie game. Movement is paused.');
  });

  it('shows nothing before the game ends', () => {
    expect(rowsOf(baseSource())['hud-game-over']).toBe('');
  });

  it('formats the match clock as minutes:seconds, rounded up to the next second', () => {
    expect(rowsOf(baseSource({ timeRemainingS: 90 }))['hud-clock']).toBe('1:30');
    expect(rowsOf(baseSource({ timeRemainingS: 5.2 }))['hud-clock']).toBe('0:06');
    expect(rowsOf(baseSource({ timeRemainingS: -1 }))['hud-clock']).toBe('0:00'); // clamped
  });

  it('shows a base-object health row when aimedStructure is set, and nothing when it is null', () => {
    expect(rowsOf(baseSource({ aimedStructure: null }))['hud-aimed']).toBe('');
    expect(
      rowsOf(baseSource({ aimedStructure: { name: 'Generator', healthPercent: 62 } }))['hud-aimed'],
    ).toBe('Generator 62%');
  });

  it('appends a shield readout to the aimed-structure row when the structure has a pool, and none when it does not (issue #14)', () => {
    // A hit absorbed entirely by shields leaves healthPercent pinned -- the pool readout is
    // the only thing that moves, which is the whole point of #14's client feedback.
    expect(
      rowsOf(
        baseSource({
          aimedStructure: { name: 'Generator', healthPercent: 100, shieldPercent: 40 },
        }),
      )['hud-aimed'],
    ).toBe('Generator 100% · Shield 40%');
    // No pool (shieldPercent undefined, e.g. an invincible vehicle pad) -> no suffix.
    expect(
      rowsOf(baseSource({ aimedStructure: { name: 'Vehicle Pad', healthPercent: 100 } }))[
        'hud-aimed'
      ],
    ).toBe('Vehicle Pad 100%');
  });

  it('hides the vehicle row when the local player is not mounted', () => {
    expect(rowsOf(baseSource())['hud-vehicle']).toBe('');
  });

  it('shows vehicle health and speed while mounted', () => {
    const source = baseSource();
    const world = source.world;
    world.vehicles.active[0] = 1;
    world.vehicles.count = 1;
    world.vehicles.kind[0] = VehicleKind.Wildcat;
    world.vehicles.damage[0] = VEHICLE_DATA[VehicleKind.Wildcat].maxDamage / 2; // 50% health
    world.vehicles.velocity.set([3, 0, 4], 0); // 5 m/s
    world.players.mountedVehicleId[source.playerId] = 0;
    const rows = rowsOf(source);
    expect(rows['hud-vehicle']).toBe('Hull 50% · Shield 0% — 5.0 m/s');
  });

  describe('station loadout HUD (#55)', () => {
    it('names the carried pack and shows nothing without one', () => {
      const source = baseSource();
      expect(rowsOf(source)['hud-pack']).toBe('');
      source.world.players.hasEnergyPack[source.playerId] = 1;
      expect(rowsOf(source)['hud-pack']).toBe('Energy Pack');
      // Mutually exclusive by construction; the row shows whichever pack is set.
      source.world.players.hasEnergyPack[source.playerId] = 0;
      source.world.players.hasRepairPack[source.playerId] = 1;
      expect(rowsOf(source)['hud-pack']).toBe('Repair Pack');
    });

    it('resolves the pack cell to the original bitmap for each pack, and to none without one', () => {
      // The rack cell grounds its <img> on these paths; the Repair Pack's bitmap was missing
      // from packages/assets/src/gui-sources.ts, which is why its cell showed text instead.
      const source = baseSource();
      expect(packIconSrc(source)).toBeNull();
      source.world.players.hasEnergyPack[source.playerId] = 1;
      expect(packIconSrc(source)).toBe('/katabatic/gui/hud_new_packenergy.png');
      // The station replaces the whole pack, so Repair arrives as Energy leaves.
      source.world.players.hasEnergyPack[source.playerId] = 0;
      source.world.players.hasRepairPack[source.playerId] = 1;
      expect(packIconSrc(source)).toBe('/katabatic/gui/hud_new_packrepair.png');
    });

    it('expands a zero carriedWeapons mask (no station visit) to the same capped default the sim grants', () => {
      const source = baseSource();
      const armor = armorFor(source.world, source.playerId);
      // baseObjects.ts's defaultWeaponMask, not every weapon the armor allows: Light allows
      // four and carries three (#55), so the rack must not show a Blaster the sim drops.
      expect(carriedWeaponSlots(source.world, source.playerId)).toBe(defaultWeaponMask(armor));
      expect(carriedWeaponSlots(source.world, source.playerId)).toBe(0b01011);
    });

    it('reports an explicit station selection as-is', () => {
      const source = baseSource();
      source.world.players.carriedWeapons[source.playerId] =
        (1 << WeaponId.Spinfusor) | (1 << WeaponId.Blaster);
      expect(carriedWeaponSlots(source.world, source.playerId)).toBe(
        (1 << WeaponId.Spinfusor) | (1 << WeaponId.Blaster),
      );
    });
  });
});

describe('describeKillFeed', () => {
  it('formats a kill line and an environment-death line, keeping only the last 5', () => {
    const events: EventMessage[] = [
      { type: 6, kind: EventKind.PlayerKilled, a: 3, b: 9 },
      { type: 6, kind: EventKind.PlayerKilled, a: -1, b: 2 },
      { type: 6, kind: EventKind.FlagTouched, a: 1, b: 0 },
    ];
    expect(describeKillFeed(baseSource({ recentEvents: events }))).toEqual([
      'P3 eliminated P9',
      'P2 died',
    ]);
  });
});

describe('reticleBitmapFor (issue #55 vehicle reticles)', () => {
  it("gives the Tank its own reticle from hud.cs's table rather than the on-foot crosshair", () => {
    expect(reticleBitmapFor(VehicleKind.Tank, WeaponId.Chaingun)).toBe('hud_ret_tankchaingun.png');
    expect(reticleBitmapFor(VehicleKind.Tank, WeaponId.Mortar)).toBe('hud_ret_tankchaingun.png');
  });

  it('gives the Bomber the shrike art the table assigns to BomberFlyer, and the Shrike the same', () => {
    expect(reticleBitmapFor(VehicleKind.Bomber, WeaponId.Blaster)).toBe('hud_ret_shrike.png');
    expect(reticleBitmapFor(VehicleKind.Shrike, WeaponId.Blaster)).toBe('hud_ret_shrike.png');
  });

  it('falls back to the weapon crosshair for a vehicle the table does not cover', () => {
    expect(reticleBitmapFor(VehicleKind.Wildcat, WeaponId.Chaingun)).toBe('RET_chaingun.png');
    expect(reticleBitmapFor(VehicleKind.Wildcat, WeaponId.Spinfusor)).toBe('RET_disc.png');
  });

  it('uses the weapon crosshair on foot, and the blaster art for a weapon with none of its own', () => {
    expect(reticleBitmapFor(undefined, WeaponId.Spinfusor)).toBe('RET_disc.png');
    expect(reticleBitmapFor(undefined, WeaponId.LaserRifle)).toBe('hud_ret_sniper.png');
  });
});

describe('reticle sizing', () => {
  const REFERENCE = { width: 1024, height: 768 };
  // Explicit lists rather than Object.values on the numeric enums, which also yields their
  // reverse-mapped names (weapons.ts's own note on ALL_WEAPONS).
  const KINDS: readonly (VehicleKind | undefined)[] = [
    undefined,
    VehicleKind.Shrike,
    VehicleKind.Wildcat,
    VehicleKind.Bomber,
    VehicleKind.Havoc,
    VehicleKind.Tank,
    VehicleKind.MobilePointBase,
  ];
  const WEAPONS: readonly WeaponId[] = [
    WeaponId.Spinfusor,
    WeaponId.Chaingun,
    WeaponId.Mortar,
    WeaponId.LaserRifle,
    WeaponId.Blaster,
  ];

  it('has a measured native size for every reticle the weapon and vehicle tables can return', () => {
    // The sizing table is hand-copied from the bitmaps, so the thing worth pinning is that
    // nothing reticleBitmapFor can return is missing from it -- a missing row would fall back
    // to 32x32 and shrink that reticle exactly the way the fixed 30 px box did.
    for (const kind of KINDS) {
      for (const weapon of WEAPONS) {
        expect(RETICLE_NATIVE_SIZE[reticleBitmapFor(kind, weapon)]).toBeDefined();
      }
    }
  });

  it('carries the bitmaps their own pixel sizes', () => {
    expect(RETICLE_NATIVE_SIZE['hud_ret_sniper.png']).toEqual({ width: 256, height: 256 });
    expect(RETICLE_NATIVE_SIZE['hud_ret_shrike.png']).toEqual({ width: 64, height: 64 });
    expect(RETICLE_NATIVE_SIZE['RET_chaingun.png']).toEqual({ width: 32, height: 32 });
    // The one non-square reticle: its 42x16 disc mark sits in a 64x16 canvas.
    expect(RETICLE_NATIVE_SIZE['RET_disc.png']).toEqual({ width: 64, height: 16 });
  });

  it('draws a reticle at its native size on the reference screen and on anything smaller', () => {
    expect(reticleScale(REFERENCE)).toBe(1);
    expect(reticleScale({ width: 800, height: 600 })).toBe(1);
    expect(reticleBox('hud_ret_sniper.png', REFERENCE)).toEqual({ width: 256, height: 256 });
    expect(reticleBox('RET_disc.png', { width: 800, height: 600 })).toEqual({
      width: 64,
      height: 16,
    });
  });

  it('scales up on a large viewport, deciding on the smaller axis, and stops at 1.5x', () => {
    // 1080p is 1.40625x the reference height, and the height is what decides here: the width
    // on its own would ask for 1.875x.
    expect(reticleScale({ width: 1920, height: 1080 })).toBe(1.40625);
    expect(reticleBox('RET_chaingun.png', { width: 1920, height: 1080 })).toEqual({
      width: 45,
      height: 45,
    });
    // 4K is 2.8125x on its smaller axis: clamped to the cap.
    expect(reticleScale({ width: 3840, height: 2160 })).toBe(1.5);
    expect(reticleBox('hud_ret_sniper.png', { width: 3840, height: 2160 })).toEqual({
      width: 384,
      height: 384,
    });
    // A wide, short window keeps the authored size rather than stretching to its width.
    expect(reticleScale({ width: 2560, height: 720 })).toBe(1);
  });

  it('rounds a scaled box to whole pixels so the bitmap is never resampled', () => {
    // 32 x (900/768) = 37.5 px, and 16 x 1.171875 = 18.75 px for the disc's own height.
    expect(reticleBox('RET_blaster.png', { width: 1366, height: 900 })).toEqual({
      width: 38,
      height: 38,
    });
    expect(reticleBox('RET_disc.png', { width: 1366, height: 900 })).toEqual({
      width: 75,
      height: 19,
    });
  });

  it('falls back to 32x32 for a name the table does not carry', () => {
    expect(reticleBox('nonexistent.png', REFERENCE)).toEqual({ width: 32, height: 32 });
  });
});

// User report 2026-09-16 (hit feedback), shooter side: T2's base scripts have no shooter-side hit feedback at all, so the
// reticle's marker is ours. What it owes the frame loop is a window: shown from the confirmed
// hit's own timestamp, gone HIT_MARKER_MS later, and re-armed rather than restarted by a hit
// that lands inside it (a Chaingun burst).
describe('hit marker window', () => {
  it('shows the marker for HIT_MARKER_MS after a hit and expires it on time', () => {
    const marker: HitMarker = { untilMs: 0 };
    expect(hitMarkerIsShown(marker, 1_000)).toBe(false);
    armHitMarker(marker, 1_000);
    expect(hitMarkerIsShown(marker, 1_000)).toBe(true);
    expect(hitMarkerIsShown(marker, 1_000 + HIT_MARKER_MS - 1)).toBe(true);
    expect(hitMarkerIsShown(marker, 1_000 + HIT_MARKER_MS)).toBe(false);
  });

  it('re-arms the window for a hit that lands while the marker is still up', () => {
    const marker: HitMarker = { untilMs: 0 };
    armHitMarker(marker, 1_000);
    armHitMarker(marker, 1_050);
    expect(hitMarkerIsShown(marker, 1_000 + HIT_MARKER_MS)).toBe(true);
    expect(hitMarkerIsShown(marker, 1_050 + HIT_MARKER_MS)).toBe(false);
  });
});
