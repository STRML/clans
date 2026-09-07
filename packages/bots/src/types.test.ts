import { describe, expect, it } from 'vitest';
import { assignRoles, BotRole, createBotRuntimeState } from './types.js';

describe('assignRoles', () => {
  it('assigns roughly one in four bots as Defender on a full team', () => {
    const ids = Array.from({ length: 16 }, (_, i) => i);
    const roles = assignRoles(ids);
    const defenders = ids.filter((id) => roles.get(id) === BotRole.Defender);
    expect(defenders.length).toBe(4);
  });

  it('a team of one bot assigns zero defenders, not a crash', () => {
    const roles = assignRoles([7]);
    expect(roles.get(7)).toBe(BotRole.Attacker);
  });

  it('a team of zero bots returns an empty role map', () => {
    expect(assignRoles([]).size).toBe(0);
  });

  it('is stable: the same input ids always produce the same assignment', () => {
    const ids = [3, 1, 4, 1_5, 9];
    expect(assignRoles(ids)).toEqual(assignRoles(ids));
  });
});

describe('createBotRuntimeState', () => {
  it('starts with an empty path and Idle state', () => {
    const state = createBotRuntimeState(5, BotRole.Attacker, 42);
    expect(state.path).toEqual([]);
    expect(state.state).toBe(0); // BotState.Idle
    expect(state.engagedTargetId).toBe(-1);
  });
});
