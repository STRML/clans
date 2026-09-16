import { describe, expect, it, vi } from 'vitest';
import {
  GRAVITY,
  ProjectileImpactReason,
  ProjectileType,
  WeaponId,
  WEAPON_DATA,
  type FireEvent,
  type ProjectileImpact,
} from '@clans/sim';
import {
  addedDamageFlash,
  createDamageFlash,
  createHitFeedback,
  DAMAGE_FLASH_DECAY_PER_S,
  DAMAGE_FLASH_MAX,
  DAMAGE_FLASH_PER_DAMAGE,
  decayedDamageFlash,
  HIT_ATTRIBUTION_MARGIN_MS,
} from './hit-feedback.js';

/** A fire event as weapons.ts builds one: everything the sim resolved same-tick (hitPlayerId /
 *  hitPoint / resolved) is left at its own unresolved defaults, because a shot that travels is
 *  what these tests are about. */
function fireEvent(overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    playerId: 0,
    weaponId: WeaponId.Spinfusor,
    isAltFire: false,
    origin: { x: 0, y: 1.6, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    shooterVelocity: { x: 0, y: 0, z: 0 },
    energyScale: 1,
    hitPlayerId: -1,
    hitPoint: null,
    projectileId: 3,
    resolved: false,
    ...overrides,
  };
}

function directImpact(x: number, y: number, z: number, overrides: Partial<ProjectileImpact> = {}) {
  return {
    x,
    y,
    z,
    weaponId: WeaponId.Spinfusor,
    type: ProjectileType.Linear,
    reason: ProjectileImpactReason.Direct,
    seq: 7,
    ...overrides,
  } satisfies ProjectileImpact;
}

function confirmerWithSpy() {
  const hitSound = vi.fn();
  const hitMarker = vi.fn();
  return { hitSound, hitMarker, feedback: createHitFeedback({ hitSound, hitMarker }) };
}

describe('T2 damage flash', () => {
  it('raises the flash by twice the damage taken, T2 own arithmetic (player.cs:2790-2795)', () => {
    expect(addedDamageFlash(0, 0.0825)).toBeCloseTo(0.0825 * DAMAGE_FLASH_PER_DAMAGE, 12);
    expect(addedDamageFlash(0.2, 0.1)).toBeCloseTo(0.4, 12);
  });

  it('caps the flash at 0.75 however hard the hit landed', () => {
    // weapons.ts's Spinfusor hits for 0.5 -- more than enough to max the flash on its own.
    expect(addedDamageFlash(0, WEAPON_DATA[WeaponId.Spinfusor].radiusDamage)).toBe(
      DAMAGE_FLASH_MAX,
    );
    expect(addedDamageFlash(0.7, 0.5)).toBe(DAMAGE_FLASH_MAX);
  });

  it('bleeds T2 own 0.007 per 32 ms player update off the flash, and floors at zero', () => {
    expect(decayedDamageFlash(DAMAGE_FLASH_MAX, 32 / 1000)).toBeCloseTo(
      DAMAGE_FLASH_MAX - 0.007,
      12,
    );
    expect(decayedDamageFlash(DAMAGE_FLASH_MAX, 1)).toBeCloseTo(
      Math.max(0, DAMAGE_FLASH_MAX - DAMAGE_FLASH_DECAY_PER_S),
      12,
    );
    expect(decayedDamageFlash(0.001, 1)).toBe(0);
  });

  it('reads a health drop as damage, and ignores healing or a first-ever sample', () => {
    const flash = createDamageFlash();
    // No previous health: a client that just spawned has nothing to flash about.
    expect(flash.sample(0.66, 0)).toBe(0);
    // A Chaingun round's worth of health gone.
    expect(flash.sample(0.66 - 0.0825, 0)).toBeCloseTo(0.165, 12);
    // Health coming back -- a respawn at full, here -- never lowers the flash: T2 does not
    // reduce it either, it merely stops adding to it.
    expect(flash.sample(0.66, 0)).toBeCloseTo(0.165, 12);
    // ...and it bleeds off on its own: a second of frames clears it.
    expect(flash.sample(0.66, 1)).toBe(0);
  });
});

describe('shooter hit confirmation', () => {
  it('confirms a Direct impact that lands on the flight line of the player own shot', () => {
    const { feedback, hitSound, hitMarker } = confirmerWithSpy();
    feedback.shot(fireEvent(), 1_000);
    // A Spinfusor disc from (0, 1.6, 0) travels 90 m/s along +x; a player struck 30 m out is
    // exactly on that line.
    feedback.confirm([directImpact(30, 1.6, 0)], 1_200);
    expect(hitSound).toHaveBeenCalledTimes(1);
    expect(hitMarker).toHaveBeenCalledWith(1_200);
  });

  it('ignores an impact that no live shot of this player accounts for', () => {
    const { feedback, hitSound, hitMarker } = confirmerWithSpy();
    // 5 m off the disc's own line: somebody else's shot, or a hit this client never fired.
    feedback.shot(fireEvent(), 1_000);
    feedback.confirm([directImpact(30, 6.6, 0)], 1_200);
    expect(hitSound).not.toHaveBeenCalled();
    expect(hitMarker).not.toHaveBeenCalled();
  });

  it('ignores every impact reason that is not a hit on a player', () => {
    const { feedback, hitSound } = confirmerWithSpy();
    feedback.shot(fireEvent(), 1_000);
    for (const reason of [
      ProjectileImpactReason.World,
      ProjectileImpactReason.Bounce,
      ProjectileImpactReason.Timeout,
    ]) {
      feedback.confirm([directImpact(30, 1.6, 0, { reason, seq: reason + 1 })], 1_200);
    }
    expect(hitSound).not.toHaveBeenCalled();
  });

  it('ignores an impact of a different weapon or body type, even on the same line', () => {
    const { feedback, hitSound } = confirmerWithSpy();
    feedback.shot(fireEvent(), 1_000);
    feedback.confirm(
      [
        directImpact(30, 1.6, 0, { weaponId: WeaponId.Chaingun, type: ProjectileType.Tracer }),
        directImpact(30, 1.6, 0, { type: ProjectileType.Grenade, seq: 8 }),
      ],
      1_200,
    );
    expect(hitSound).not.toHaveBeenCalled();
  });

  it('never reuses a shot: one confirmation per shot fired', () => {
    const { feedback, hitSound } = confirmerWithSpy();
    feedback.shot(fireEvent(), 1_000);
    const hit = directImpact(30, 1.6, 0);
    feedback.confirm([hit], 1_200);
    // The same record again -- the exactly-once contract's own failure mode -- and a second
    // record on the same line, as if this shot had hit twice.
    feedback.confirm([hit], 1_300);
    feedback.confirm([directImpact(30, 1.6, 0, { seq: 8 })], 1_400);
    expect(hitSound).toHaveBeenCalledTimes(1);
  });

  it('keeps a shot attributable until its own lifetime is up, and no longer', () => {
    const { feedback, hitSound } = confirmerWithSpy();
    const lifetimeMs = WEAPON_DATA[WeaponId.Spinfusor].lifetime * 1000;
    feedback.shot(fireEvent(), 1_000);
    feedback.confirm(
      [directImpact(30, 1.6, 0)],
      1_000 + lifetimeMs + HIT_ATTRIBUTION_MARGIN_MS + 1,
    );
    expect(hitSound).not.toHaveBeenCalled();
  });

  it('does not spend the shot on an impact that only looked like it', () => {
    const { feedback, hitSound } = confirmerWithSpy();
    feedback.shot(fireEvent(), 1_000);
    feedback.confirm([directImpact(30, 6.6, 0)], 1_100);
    // The real hit arrives a frame later, off the same still-unconsumed shot.
    feedback.confirm([directImpact(30, 1.6, 0, { seq: 9 })], 1_200);
    expect(hitSound).toHaveBeenCalledTimes(1);
  });

  it('follows a grenade own drop instead of the straight line it was fired along', () => {
    // A Mortar shell is Grenade-type: projectiles.ts integrates GRAVITY into it and into
    // nothing else, so a shell fired dead level lands below the line it left on. 0.32 s of
    // flight from y = 2 drops it 0.5 * GRAVITY * 0.32^2 = 1.024 m.
    const { feedback, hitSound } = confirmerWithSpy();
    const flightS = 0.32;
    const speed = WEAPON_DATA[WeaponId.Mortar].speed;
    const drop = 0.5 * GRAVITY * flightS * flightS;
    feedback.shot(
      fireEvent({
        weaponId: WeaponId.Mortar,
        origin: { x: 0, y: 2, z: 0 },
      }),
      1_000,
    );
    feedback.confirm(
      [
        directImpact(speed * flightS, 2 - drop, 0, {
          weaponId: WeaponId.Mortar,
          type: ProjectileType.Grenade,
        }),
      ],
      1_200,
    );
    expect(hitSound).toHaveBeenCalledTimes(1);
  });

  it('does not credit a straight-flying shot with an impact that fell away from its line', () => {
    // The same geometry one weapon over: a disc flies the line it was fired along, so a
    // contact 2.5 m below that line at 45 m is not its hit -- the disc would have to have
    // dropped, and a Linear body never does.
    const { feedback, hitSound } = confirmerWithSpy();
    feedback.shot(fireEvent({ origin: { x: 0, y: 2, z: 0 } }), 1_000);
    feedback.confirm([directImpact(45, 2 - 2.5, 0)], 1_200);
    expect(hitSound).not.toHaveBeenCalled();
  });

  it('records no shot for a hitscan weapon, which can never leave an impact record', () => {
    const { feedback, hitSound } = confirmerWithSpy();
    feedback.shot(fireEvent({ weaponId: WeaponId.LaserRifle }), 1_000);
    feedback.confirm(
      [directImpact(30, 1.6, 0, { weaponId: WeaponId.LaserRifle, type: ProjectileType.Linear })],
      1_200,
    );
    expect(hitSound).not.toHaveBeenCalled();
  });
});
