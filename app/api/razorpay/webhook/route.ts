import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import type { OrderStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { confirmOrder } from "@/lib/orders/confirm-order";
import { refundAndClose, restoreOrderStock } from "@/lib/orders/refund";
import type { RefundReason } from "@/lib/razorpay-client";
import { verifyRazorpayWebhookSignature } from "@/lib/razorpay";
import {
  webhookSchema,
  type PaymentWebhookEntity,
  type RefundWebhookEntity,
} from "@/schemas/razorpay/webhook-schema";

/**
 * Razorpay webhook backstop. The client success callback (`PlaceOrder`) is the
 * primary status driver, but a missed callback (tab closed, network drop) is
 * reconciled here:
 *
 * - `payment.captured` confirms a pending order through the same stock-safe
 *   claim as the client path, refunding any capture we cannot fulfil.
 * - `payment.failed` is log-only: another attempt may still succeed.
 * - `refund.processed` is the authoritative refund signal and restores stock
 *   exactly once for a confirmed order.
 *
 * The HMAC is verified over the raw body before parsing; the parsed body is
 * schema-validated before any DB access. Invalid trust-boundary input is 400
 * with no side effects, unknown events are acknowledged with 200, and DB or
 * refund failures are 500 so Razorpay retries.
 */

const acknowledgment = () => NextResponse.json({ received: true });

const logWarn = (entry: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ level: "warn", ...entry }));
};

const logError = (entry: Record<string, unknown>): void => {
  console.error(JSON.stringify({ level: "error", ...entry }));
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const revalidateOrderViews = (): void => {
  revalidatePath("/admin");
  revalidatePath("/my-orders");
};

/**
 * Refunds a capture the webhook could not turn into an order.
 * `already_handled` means another path (client callback or an earlier refund)
 * already owns the order: never refund twice. A failed Razorpay call is a 500
 * so the event is retried; the order stays `pending` with the payment id.
 */
const refundCapture = async (
  orderId: string,
  paymentId: string,
  amountPaise: number,
  reason: RefundReason,
  context: Record<string, unknown>
): Promise<NextResponse> => {
  try {
    const refund = await refundAndClose(orderId, paymentId, amountPaise, reason);
    if (refund.outcome === "already_handled") {
      logWarn({
        event: "webhook_refund_skipped",
        orderId,
        paymentId,
        reason,
        orderStatus: refund.status,
        ...context,
      });
      return acknowledgment();
    }

    revalidateOrderViews();
    return acknowledgment();
  } catch (error) {
    logError({
      event: "webhook_refund_failed",
      orderId,
      paymentId,
      reason,
      error: errorMessage(error),
      ...context,
    });
    return NextResponse.json({ error: "Refund failed" }, { status: 500 });
  }
};

const handlePaymentCaptured = async (payment: PaymentWebhookEntity): Promise<NextResponse> => {
  const order = await prisma.order.findUnique({
    where: { transactionId: payment.order_id },
    select: { id: true, status: true, total: true },
  });

  if (!order) {
    // An order cannot be conjured from a payment; init always commits the row
    // before the client sees a payable Razorpay order id.
    logWarn({
      event: "webhook_order_not_found",
      razorpayOrderId: payment.order_id,
      paymentId: payment.id,
      capturedPaise: payment.amount,
    });
    return acknowledgment();
  }

  if (order.status !== "pending") {
    // confirmed/shipped/delivered/refunded/cancelled: the client callback or a
    // previous delivery already handled this capture.
    return acknowledgment();
  }

  const expectedPaise = Math.round(Number(order.total) * 100);
  if (payment.amount !== expectedPaise) {
    return refundCapture(order.id, payment.id, payment.amount, "AMOUNT_MISMATCH", {
      razorpayOrderId: payment.order_id,
      expectedPaise,
      capturedPaise: payment.amount,
    });
  }

  try {
    const confirmation = await confirmOrder(order.id, payment.id);
    if (confirmation.status === "already") {
      // A refund owns the pending order (proof already recorded) or another
      // path already confirmed it. Either way, do not refund a second time.
      logWarn({
        event: "webhook_confirm_lost_claim",
        orderId: order.id,
        paymentId: payment.id,
        orderStatus: confirmation.current,
        claimedPaymentId: confirmation.paymentId,
      });
      return acknowledgment();
    }

    revalidateOrderViews();
    return acknowledgment();
  } catch (error) {
    if (error instanceof AppError && error.code === "OUT_OF_STOCK") {
      return refundCapture(order.id, payment.id, payment.amount, "OUT_OF_STOCK", {
        razorpayOrderId: payment.order_id,
      });
    }
    throw error;
  }
};

type RefundTransition =
  | { kind: "not_found" }
  | { kind: "partial"; orderId: string; refundedPaise: number; orderTotalPaise: number }
  | { kind: "terminal"; orderId: string; status: OrderStatus }
  | { kind: "raced"; orderId: string; status: OrderStatus }
  | { kind: "refunded"; orderId: string };

const handleRefundProcessed = async (refund: RefundWebhookEntity): Promise<NextResponse> => {
  const transition = await prisma.$transaction<RefundTransition>(async (tx) => {
    // Payment ids are not unique in the schema; the order that owns the
    // capture is found through the proof recorded at confirm/refund time.
    const order = await tx.order.findFirst({
      where: { paymentId: refund.payment_id },
      include: { items: true },
    });
    if (!order) {
      return { kind: "not_found" };
    }

    const orderTotalPaise = Math.round(Number(order.total) * 100);
    if (refund.amount < orderTotalPaise) {
      // Partial refunds are out of scope in Phase 0: acknowledge (so Razorpay
      // stops retrying) but never change the order or the stock.
      return {
        kind: "partial",
        orderId: order.id,
        refundedPaise: refund.amount,
        orderTotalPaise,
      };
    }

    switch (order.status) {
      case "refunded":
      case "cancelled":
        // Never overwrite a terminal state (in particular, never turn a
        // `refunded` order into `cancelled`).
        return { kind: "terminal", orderId: order.id, status: order.status };

      case "confirmed": {
        // The status guard makes exactly one delivery the stock restorer.
        const updated = await tx.order.updateMany({
          where: { id: order.id, status: "confirmed" },
          data: { status: "refunded" },
        });
        if (updated.count === 0) {
          return { kind: "raced", orderId: order.id, status: order.status };
        }

        await restoreOrderStock(tx, order.items);
        return { kind: "refunded", orderId: order.id };
      }

      case "pending":
      case "shipped":
      case "delivered": {
        // pending never decremented stock; shipped/delivered stock has left
        // the warehouse. Neither is restored.
        const updated = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: { status: "refunded" },
        });
        if (updated.count === 0) {
          return { kind: "raced", orderId: order.id, status: order.status };
        }

        return { kind: "refunded", orderId: order.id };
      }
    }
  });

  switch (transition.kind) {
    case "not_found":
      logWarn({
        event: "webhook_refund_order_not_found",
        paymentId: refund.payment_id,
        refundId: refund.id,
        refundedPaise: refund.amount,
      });
      return acknowledgment();

    case "partial":
      logWarn({
        event: "webhook_refund_partial",
        orderId: transition.orderId,
        refundId: refund.id,
        refundedPaise: transition.refundedPaise,
        orderTotalPaise: transition.orderTotalPaise,
      });
      return acknowledgment();

    case "terminal":
      logWarn({
        event: "webhook_refund_ignored",
        orderId: transition.orderId,
        orderStatus: transition.status,
        refundId: refund.id,
      });
      return acknowledgment();

    case "raced":
      logWarn({
        event: "webhook_refund_raced",
        orderId: transition.orderId,
        orderStatus: transition.status,
        refundId: refund.id,
      });
      return acknowledgment();

    case "refunded":
      revalidateOrderViews();
      return acknowledgment();
  }
};

export async function POST(req: Request) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "Webhook is not configured (RAZORPAY_WEBHOOK_SECRET missing)" },
      { status: 501 }
    );
  }

  const rawBody = await req.text();
  if (
    !verifyRazorpayWebhookSignature(rawBody, req.headers.get("x-razorpay-signature"), webhookSecret)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const parsed = webhookSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { event, payload } = parsed.data;

  try {
    switch (event) {
      case "payment.captured":
      case "payment.failed": {
        if (!payload.payment) {
          return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }
        const payment = payload.payment.entity;

        if (event === "payment.failed") {
          // Log-only: a retried payment on the same order may still succeed,
          // so the order must stay pending.
          logWarn({
            event: "payment_failed",
            orderId: payment.order_id,
            paymentId: payment.id,
            paymentStatus: payment.status,
            errorCode: payment.error_code ?? null,
          });
          return acknowledgment();
        }

        return await handlePaymentCaptured(payment);
      }

      case "refund.processed": {
        if (!payload.refund) {
          return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }
        return await handleRefundProcessed(payload.refund.entity);
      }

      default:
        // Unhandled events are acknowledged so Razorpay stops retrying them.
        return acknowledgment();
    }
  } catch (error) {
    // Non-2xx makes Razorpay retry with backoff — right answer for DB outages
    // and failed refunds.
    logError({
      event: "webhook_processing_failed",
      eventType: event,
      error: errorMessage(error),
    });
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
