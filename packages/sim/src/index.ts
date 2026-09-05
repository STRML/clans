export * from './armor.js';
// movement.ts is internal: stepWorld is the only entry point, so the fixed-tick guard
// cannot be bypassed. GRAVITY is re-exported for tests and tuning tools.
export { GRAVITY } from './movement.js';
export * from './random.js';
export * from './terrain.js';
export * from './types.js';
export * from './world.js';
