import { OrderKind, type TeamOrder } from '@clans/protocol';
import { FIXED_DT } from '@clans/sim';

export const ORDER_TTL_S = 90; // Ours -- see M7 plan's "ours" numbers table.

export type { TeamOrder };

export interface OrderBoard {
  byTeam: Map<number, TeamOrder>;
}

export function createOrderBoard(): OrderBoard {
  return { byTeam: new Map() };
}

/** A second order for a team that already has one replaces it -- never queues (Global
 *  Constraints: "one active order per team, no queue"). */
export function issueOrder(
  board: OrderBoard,
  team: number,
  kind: OrderKind,
  x: number,
  z: number,
  tick: number,
): void {
  board.byTeam.set(team, {
    team,
    kind,
    x,
    z,
    expiresAtTick: tick + Math.round(ORDER_TTL_S / FIXED_DT),
  });
}

/** Re-checks expiry fresh on every call rather than caching the result on the caller's own
 *  state -- failure matrix row 21: an order's TTL expiring mid-travel must fall back to the
 *  normal goal the same tick it expires, not the next one. */
export function currentOrder(board: OrderBoard, team: number, tick: number): TeamOrder | null {
  const order = board.byTeam.get(team);
  if (!order || tick > order.expiresAtTick) return null;
  return order;
}
