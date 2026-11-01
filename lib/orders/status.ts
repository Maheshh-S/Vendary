import type { OrderStatus } from "@prisma/client";

/**
 * The full system order status transitions, shared by the server actions and
 * the admin UI.
 *
 * This module is imported by client components (`order-status-select.tsx`), so
 * it must stay client-safe: the Prisma import is type-only and nothing here may
 * pull in `server-only`, Node built-ins, or database code.
 *
 * `pending -> confirmed` is deliberate: only `confirmOrder` performs it, and
 * only after the Razorpay signature and captured amount are verified.
 *
 * `pending -> cancelled` is the customer cancel of an unpaid order (claimed
 * with an empty payment proof). A capture that lands after that cancel is
 * refunded by the webhook late-capture backstop, which keeps the order
 * `cancelled`. Admins must use `ADMIN_TRANSITIONS`, which omits both edges.
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

/**
 * Transitions an admin may perform, derived from `ORDER_TRANSITIONS` with both
 * pending edges removed:
 *
 * - `pending -> confirmed` is owned by `confirmOrder` (payment verification).
 * - `pending -> cancelled` is owned by the customer cancel action, which only
 *   claims orders with no recorded payment proof. A capture that lands after
 *   the cancel is refunded by the webhook late-capture backstop, so an admin
 *   override would only race the customer path.
 *
 * Consequently a pending order has no admin options at all.
 */
export const ADMIN_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  ...ORDER_TRANSITIONS,
  pending: ORDER_TRANSITIONS.pending.filter(
    (to) => to !== "confirmed" && to !== "cancelled"
  ),
};

export const canAdminTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ADMIN_TRANSITIONS[from]?.includes(to) ?? false;
