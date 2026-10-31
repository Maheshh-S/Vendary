import "server-only";

import type { OrderStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";

export type ConfirmOrderResult =
  | { status: "confirmed" }
  | { status: "already"; current: OrderStatus; paymentId: string };

/**
 * Claims a pending order and decrements stock in one transaction.
 *
 * The `pending → confirmed` claim is the idempotency gate: of two concurrent
 * confirmations exactly one `updateMany` matches, so stock is decremented
 * exactly once. A loser observes the winner's state instead of retrying.
 *
 * The claim also requires `paymentId: ""`, so it is mutually exclusive with
 * the refund claim (`pending` + empty proof → record proof). Whichever path
 * writes first owns the order; the other backs off.
 *
 * Every line is decremented conditionally (`stockQty >= quantity`). A single
 * failure — including a line whose product was deleted after checkout started
 * (`productId === null`) — throws, rolling back the claim and every earlier
 * decrement. The caller is responsible for refunding the captured payment.
 */
export const confirmOrder = async (
  orderId: string,
  paymentId: string
): Promise<ConfirmOrderResult> =>
  prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: "pending", paymentId: "" },
      data: { status: "confirmed", paymentId },
    });

    if (claimed.count === 0) {
      const current = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { status: true, paymentId: true },
      });
      return { status: "already", current: current.status, paymentId: current.paymentId };
    }

    const items = await tx.orderItem.findMany({ where: { orderId } });

    for (const item of items) {
      if (!item.productId) {
        throw new AppError(
          "OUT_OF_STOCK",
          `"${item.productName}" is no longer available. Your payment will be refunded.`
        );
      }

      const decremented = await tx.product.updateMany({
        where: {
          id: item.productId,
          availability: "IN_STOCK",
          stockQty: { gte: item.quantity },
        },
        data: { stockQty: { decrement: item.quantity } },
      });
      if (decremented.count !== 1) {
        throw new AppError(
          "OUT_OF_STOCK",
          `"${item.productName}" just sold out. Your payment will be refunded.`
        );
      }

      await tx.product.updateMany({
        where: { id: item.productId, stockQty: { lte: 0 } },
        data: { availability: "OUT_OF_STOCK" },
      });
    }

    return { status: "confirmed" };
  });
