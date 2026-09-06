export * from './armor.js';
// damage.js and weapons.js both export a function named `respawnPlayer` (weapons.ts's
// version wraps damage.ts's to also reset the weapon loadout on respawn), so two
// unqualified `export *`s here would be an ambiguous re-export TypeScript rejects.
// Re-exporting damage.js's other members by name, then star-exporting weapons.js,
// makes weapons.ts's respawnPlayer the one every caller of the barrel gets.
export {
  applyDamage,
  applyFallDamage,
  applyKickback,
  dueForRespawn,
  playerHitbox,
  radiusFalloff,
  raySphereDistance,
  RESPAWN_SECONDS,
  RESPAWN_TICKS,
  type PlayerHitbox,
} from './damage.js';
// movement.ts is internal: stepWorld is the only entry point, so the fixed-tick guard
// cannot be bypassed. GRAVITY is re-exported for tests and tuning tools.
export { GRAVITY } from './movement.js';
export * from './hash.js';
export * from './random.js';
export * from './snapshot.js';
export * from './terrain.js';
export * from './types.js';
export * from './weapons.js';
export * from './world.js';
