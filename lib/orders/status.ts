import type { OrderStatus } from "@prisma/client";

/**
 * The only legal order status transitions, shared by the server action and the
 * admin UI.
 *
 * This module is imported by client components (`order-status-select.tsx`), so
 * it must stay client-safe: the Prisma import is type-only and nothing here may
 * pull in `server-only`, Node built-ins, or database code.
 *
 * Stock is decremented only on `pending -> confirmed`, so stock is restored
 * only on `confirmed -> cancelled | refunded`. `shipped`/`delivered` orders
 * have already left the warehouse and are intentionally not restored; both
 * `cancelled` and `refunded` are terminal.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled", "refunded"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ORDER_TRANSITIONS[from]?.includes(to) ?? false;
