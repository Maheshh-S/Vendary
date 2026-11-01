import "server-only";

import type { OrderStatus, Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Stable, typed order-event kinds. The database stores `type` as a string so
 * new kinds do not need a migration; this union is the runtime/compile-time
 * allowlist the actions and webhook write through.
 */
export const ORDER_EVENT_TYPES = [
  "order_placed",
  "payment_confirmed",
  "status_changed",
  "order_cancelled",
  "refund_requested",
  "refund_processed",
  "refund_failed",
] as const;

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/** Boundary validator for event kinds that ever arrive as untrusted input. */
export const orderEventTypeSchema = z.enum(ORDER_EVENT_TYPES);

export type OrderEventWrite = {
  orderId: string;
  type: OrderEventType;
  fromStatus?: OrderStatus | null;
  toStatus?: OrderStatus | null;
  /** The customer/admin who caused the event; null for webhook/system events. */
  actorId?: string | null;
  /** Reconciliation notes only — never payment credentials or PII. */
  metadata?: Prisma.InputJsonValue;
};

/**
 * Appends one event to the order's audit trail. Always runs inside the
 * caller's transaction so the event commits with the state change it
 * describes (or rolls back with it).
 */
export const writeOrderEvent = async (
  tx: Prisma.TransactionClient,
  event: OrderEventWrite
): Promise<void> => {
  await tx.orderEvent.create({
    data: {
      orderId: event.orderId,
      type: event.type,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      actorId: event.actorId ?? null,
      metadata: event.metadata,
    },
  });
};
