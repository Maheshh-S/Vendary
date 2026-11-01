"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { startOrderRefund } from "@/lib/orders/refund";
import { invalidateProductCache } from "@/lib/product-cache";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";

// NOTE: kept module-private (not exported) — "use server" modules may only
// export async functions.
const REFUND_ORDER_INPUT = z.object({
  orderId: z.string().min(1).max(64),
});

const SUPPORT_REFUND_MESSAGE =
  "The refund could not be completed. The order status is unchanged — retry, or reconcile the refund in the Razorpay dashboard.";

const REFUNDABLE_STATUSES = ["confirmed", "shipped", "delivered"] as const;

/**
 * Admin-initiated full refund for a paid order.
 *
 * Uses the same ledger claim → Razorpay call → finalize flow as the customer
 * cancel: `Refund.orderId` is unique, so two admins cannot refund the same
 * order twice. The order moves to `refunded` when the refund succeeds; stock
 * is restored only for `confirmed` orders (shipped/delivered goods have left
 * the warehouse). A failed Razorpay call records `refund_failed` and leaves
 * the order status untouched.
 */
export const refundOrder = async (orderId: string) =>
  runAction("orders.refund", async () => {
    const session = await requireAdmin();

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    });

    const input = parseInput(REFUND_ORDER_INPUT, { orderId });

    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, status: true, total: true, paymentId: true },
    });
    if (!order) {
      throw new AppError("NOT_FOUND", "Order not found.");
    }
    if (!REFUNDABLE_STATUSES.includes(order.status as (typeof REFUNDABLE_STATUSES)[number])) {
      throw new AppError("CONFLICT", `Cannot refund an order that is ${order.status}.`);
    }
    if (order.paymentId === "") {
      throw new AppError("CONFLICT", "No captured payment is recorded for this order.");
    }

    const result = await startOrderRefund({
      orderId: order.id,
      amountPaise: Math.round(Number(order.total) * 100),
      reason: "ADMIN_REFUND",
      allowedFrom: REFUNDABLE_STATUSES,
      finalStatus: "refunded",
      successEvent: "status_changed",
      actorId: session.user.id,
      failureMessage: SUPPORT_REFUND_MESSAGE,
    });

    for (const productId of result.restoredProductIds) {
      await invalidateProductCache(productId);
    }

    revalidatePath("/admin");
    revalidatePath("/my-orders");
    revalidatePath(`/my-orders/${order.id}`);

    return {
      orderId: order.id,
      // `status` only differs from `refunded` in the rare race where another
      // path moved the order while Razorpay was refunding.
      status: result.toStatus ?? order.status,
      refundId: result.refundId,
    };
  });
