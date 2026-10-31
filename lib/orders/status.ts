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
 * only after the Razorpay signature and captured amount are verified. Admins
 * must use `ADMIN_TRANSITIONS`, which omits that edge — they cannot manually
 * confirm an unpaid pending order.
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
 * Transitions an admin may perform, derived from `ORDER_TRANSITIONS` with the
 * payment-verified `pending -> confirmed` edge removed. `confirmOrder` owns
 * that edge so a pending order can never be confirmed without a captured
 * payment.
 */
export const ADMIN_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  ...ORDER_TRANSITIONS,
  pending: ORDER_TRANSITIONS.pending.filter((to) => to !== "confirmed"),
};

export const canAdminTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ADMIN_TRANSITIONS[from]?.includes(to) ?? false;
