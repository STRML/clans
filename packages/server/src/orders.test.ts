import { OrderKind } from '@clans/protocol';
import { FIXED_DT } from '@clans/sim';
import { describe, expect, it } from 'vitest';
import { createOrderBoard, currentOrder, issueOrder, ORDER_TTL_S } from './orders.js';

describe('OrderBoard', () => {
  it('has no order for any team when created', () => {
    const board = createOrderBoard();
    expect(currentOrder(board, 1, 0)).toBeNull();
  });

  it('issueOrder then currentOrder returns the issued order before it expires', () => {
    const board = createOrderBoard();
    issueOrder(board, 1, OrderKind.Attack, 10, -5, 0);
    expect(currentOrder(board, 1, 0)).toEqual({
      team: 1,
      kind: OrderKind.Attack,
      x: 10,
      z: -5,
      expiresAtTick: Math.round(ORDER_TTL_S / FIXED_DT),
    });
  });

  it('a second order for the same team replaces the first, not queues behind it', () => {
    const board = createOrderBoard();
    issueOrder(board, 1, OrderKind.Attack, 10, -5, 0);
    issueOrder(board, 1, OrderKind.Defend, 0, 0, 0);
    const order = currentOrder(board, 1, 0);
    expect(order?.kind).toBe(OrderKind.Defend);
  });

  it('an expired order returns null', () => {
    const board = createOrderBoard();
    issueOrder(board, 1, OrderKind.Attack, 10, -5, 0);
    const ticksPastTtl = Math.round(ORDER_TTL_S / FIXED_DT) + 1;
    expect(currentOrder(board, 1, ticksPastTtl)).toBeNull();
  });

  it('an order for team 2 never affects team 1', () => {
    const board = createOrderBoard();
    issueOrder(board, 2, OrderKind.Repair, 0, 0, 0);
    expect(currentOrder(board, 1, 0)).toBeNull();
  });
});
