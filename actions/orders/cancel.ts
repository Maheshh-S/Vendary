"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { sendOrderEmail } from "@/lib/mail";
import { writeOrderEvent } from "@/lib/orders/events";
import { startOrderRefund } from "@/lib/orders/refund";
import { invalidateProductCache } from "@/lib/product-cache";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";

// NOTE: kept module-private (not exported) — "use server" modules may only
// export async functions.
const CANCEL_ORDER_INPUT = z.object({
  orderId: z.string().min(1).max(64),
});

const SUPPORT_REFUND_MESSAGE =
  "Your payment was captured, but we couldn't cancel and refund the order automatically. Please contact support with your payment reference.";

const revalidateOrderViews = (orderId: string): void => {
  revalidatePath("/my-orders");
  revalidatePath(`/my-orders/${orderId}`);
  revalidatePath("/admin");
};

/**
 * Customer-initiated cancel.
 *
 * - `pending` (nothing captured): flip to `cancelled` and record the event.
 *   No stock was ever decremented, so nothing is restored. A pending order
 *   with a recorded payment proof belongs to the money path (confirm or the
 *   webhook late-capture backstop): it returns `PAYMENT_FAILED` for support.
 * - `confirmed` (money captured): issue a full Razorpay refund through the
 *   shared claim/call/finalize flow, then move the order to `cancelled` and
 *   restore the stock that confirmation decremented. A refund API failure
 *   leaves the order `confirmed`, records `refund_failed` and points the
 *   customer at support.
 *
 * The refund ledger row is unique per order, so a replay/concurrent cancel
 * cannot move money twice.
 */
export const cancelOrder = async (orderId: string) =>
  runAction("orders.cancel", async () => {
    const session = await requireUser();
    const input = parseInput(CANCEL_ORDER_INPUT, { orderId });

    // Ownership is part of the query: a foreign id is indistinguishable from a
    // missing one.
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, userId: session.user.id },
      select: { id: true, status: true, total: true, paymentId: true },
    });
    if (!order) {
      throw new AppError("NOT_FOUND", "Order not found.");
    }

    if (order.status === "pending") {
      // A recorded proof means a capture (or an earlier refund attempt) owns
      // this order. Cancelling now would race the money path; hand it to
      // support with a precise reason instead of the generic claim race.
      if (order.paymentId !== "") {
        throw new AppError("PAYMENT_FAILED", "A payment is already being processed.");
      }

      const cancelled = await prisma.$transaction(async (tx) => {
        // `paymentId: ""` means no capture owns this order. If a capture is in
        // flight (or a refund already recorded the proof), leave it to support.
        const claimed = await tx.order.updateMany({
          where: {
            id: order.id,
            userId: session.user.id,
            status: "pending",
            paymentId: "",
          },
          data: { status: "cancelled" },
        });
        if (claimed.count === 0) {
          return false;
        }

        await writeOrderEvent(tx, {
          orderId: order.id,
          type: "order_cancelled",
          fromStatus: "pending",
          toStatus: "cancelled",
          actorId: session.user.id,
        });
        return true;
      });

      if (!cancelled) {
        throw new AppError(
          "CONFLICT",
          "The order changed while you were cancelling it. Please refresh."
        );
      }

      revalidateOrderViews(order.id);
      await sendOrderEmail(order.id, "cancelled");
      return { orderId: order.id, status: "cancelled" as const };
    }

    if (order.status !== "confirmed") {
      throw new AppError("CONFLICT", "This order can no longer be cancelled.");
    }

    const result = await startOrderRefund({
      orderId: order.id,
      amountPaise: Math.round(Number(order.total) * 100),
      reason: "CUSTOMER_CANCEL",
      allowedFrom: ["confirmed"],
      finalStatus: "cancelled",
      successEvent: "order_cancelled",
      actorId: session.user.id,
      failureMessage: SUPPORT_REFUND_MESSAGE,
    });

    for (const productId of result.restoredProductIds) {
      await invalidateProductCache(productId);
    }
    revalidateOrderViews(order.id);
    await sendOrderEmail(order.id, "cancelled");

    return {
      orderId: order.id,
      // `status` stays `confirmed` only for the rare race where the order moved
      // while Razorpay was refunding; the refund itself still succeeded.
      status: result.toStatus ?? order.status,
      refundId: result.refundId,
    };
  });
