import "server-only";

import type { OrderStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { refundPayment, type RefundReason } from "@/lib/razorpay-client";

export type RefundOutcome =
  | { outcome: "refunded" }
  | { outcome: "already_handled"; status: OrderStatus };

type StockRestoreItem = {
  productId: string | null;
  quantity: number;
};

/**
 * Refunds a capture we cannot fulfil and closes the order.
 *
 * The claim (`pending` + empty proof → record proof) is what makes refund and
 * confirm mutually exclusive: whichever path writes `paymentId` first owns the
 * order. A `count` of 0 means the confirm path won, or an earlier refund
 * attempt already recorded the proof. In both cases we must not refund again
 * and must report what actually happened instead of claiming a refund.
 *
 * The Razorpay call is the one failure that is thrown: a refund without a
 * successful API call must leave the order `pending` with the payment id for
 * support, never mark it refunded. Callers decide how loud that is (the
 * checkout action returns `PAYMENT_FAILED`; the webhook returns 500 so
 * Razorpay retries).
 */
export const refundAndClose = async (
  orderId: string,
  paymentId: string,
  amountPaise: number,
  reason: RefundReason
): Promise<RefundOutcome> => {
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: "pending", paymentId: "" },
    data: { paymentId },
  });
  if (claimed.count === 0) {
    const current = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!current) {
      throw new AppError("CONFLICT", "This order can no longer be confirmed.");
    }
    // Another path already moved the order on (e.g. a concurrent confirm), or
    // an earlier refund attempt owns the proof. Never refund twice.
    return { outcome: "already_handled", status: current.status };
  }

  try {
    await refundPayment({ paymentId, amountPaise, orderId, reason });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "order_refund_failed",
        orderId,
        paymentId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new AppError(
      "PAYMENT_FAILED",
      "Your payment was captured but we couldn't complete your order. Please contact support with your payment reference.",
      undefined,
      error
    );
  }

  await prisma.order.updateMany({
    where: { id: orderId, status: "pending" },
    data: { status: "refunded" },
  });

  return { outcome: "refunded" };
};

/**
 * Puts every ordered line back on the shelf. Only call this for a refund that
 * wins the `confirmed → refunded` transition: pending orders never decremented
 * stock, and shipped/delivered stock has already left the warehouse.
 *
 * Runs inside the caller's transaction so the status guard and the increments
 * commit together. A line whose product was deleted (`productId === null`) has
 * nowhere to go and is skipped.
 */
export const restoreOrderStock = async (
  tx: Prisma.TransactionClient,
  items: StockRestoreItem[]
): Promise<void> => {
  for (const item of items) {
    if (!item.productId) {
      continue;
    }

    await tx.product.updateMany({
      where: { id: item.productId },
      data: { stockQty: { increment: item.quantity }, availability: "IN_STOCK" },
    });
  }
};
