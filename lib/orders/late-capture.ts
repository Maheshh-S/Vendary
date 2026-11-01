import "server-only";

import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  claimRefundInTransaction,
  failOrderRefund,
  finalizeOrderRefund,
} from "@/lib/orders/refund";
import { refundPayment } from "@/lib/razorpay-client";

export type LateCaptureOutcome =
  | { outcome: "refunded"; refundId: string }
  | { outcome: "already_handled" }
  | { outcome: "refund_failed"; error: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Late-capture backstop for a cancelled pending order: the customer cancelled
 * before paying, but Razorpay captured a payment anyway (e.g. a delayed UPI
 * capture), or the capture beat the cancel to the confirm claim.
 *
 * The proof claim and the refund-ledger claim commit in one transaction, so a
 * DB failure leaves the order claimable on the next delivery. The refund call
 * then moves the captured amount back and the ledger row is finalized
 * (`processed` + `refund_processed`); the order stays `cancelled`.
 *
 * Shared by the webhook's `payment.captured` branch and `PlaceOrder`'s lost
 * confirm claim, so both entry points refund exactly once. Replays see the
 * recorded proof and no-op. A failed refund records `refund_failed` and is
 * returned as a support outcome instead of thrown: the proof is already
 * recorded, so a retried delivery could not restart the refund anyway.
 */
export const refundLateCapture = async (input: {
  orderId: string;
  paymentId: string;
  amountPaise: number;
}): Promise<LateCaptureOutcome> => {
  const { orderId, paymentId, amountPaise } = input;

  let claim: Awaited<ReturnType<typeof claimRefundInTransaction>> | null;
  try {
    claim = await prisma.$transaction(async (tx) => {
      const proof = await tx.order.updateMany({
        where: { id: orderId, status: "cancelled", paymentId: "" },
        data: { paymentId },
      });
      if (proof.count === 0) {
        return null;
      }

      return claimRefundInTransaction(tx, {
        orderId,
        amountPaise,
        reason: "LATE_CAPTURE",
        allowedFrom: ["cancelled"],
        actorId: null,
      });
    });
  } catch (error) {
    if (error instanceof AppError) {
      // An existing refund row owns this order (processed or in flight); never
      // issue a second refund. The transaction rolled back, so a duplicate
      // capture is support-led.
      logger.error("late_capture_claim_rejected", {
        event: "late_capture_claim_rejected",
        orderId,
        paymentId,
        code: error.code,
        error: errorMessage(error),
      });
      return { outcome: "already_handled" };
    }
    throw error;
  }

  if (!claim) {
    // Replay: this capture's proof is already recorded, so the refund it
    // started already ran (or is support-led).
    logger.warn("late_capture_already_claimed", {
      event: "late_capture_already_claimed",
      orderId,
      paymentId,
    });
    return { outcome: "already_handled" };
  }

  let refundId: string;
  try {
    ({ refundId } = await refundPayment({
      paymentId,
      amountPaise,
      orderId,
      reason: "LATE_CAPTURE",
    }));
  } catch (error) {
    const errorText = errorMessage(error);
    logger.error("late_capture_refund_failed", {
      event: "late_capture_refund_failed",
      orderId,
      capturedPaise: amountPaise,
      error: errorText,
    });
    // Record the failure for support; the order keeps its `cancelled` status.
    try {
      await failOrderRefund({
        orderId,
        refundRowId: claim.refundRowId,
        reason: "LATE_CAPTURE",
        error: errorText,
        actorId: null,
      });
    } catch (ledgerError) {
      logger.error("late_capture_ledger_failed", {
        event: "late_capture_ledger_failed",
        orderId,
        error: errorMessage(ledgerError),
      });
    }
    return { outcome: "refund_failed", error: errorText };
  }

  try {
    await finalizeOrderRefund({
      orderId,
      refundRowId: claim.refundRowId,
      razorpayRefundId: refundId,
      amountPaise,
      reason: "LATE_CAPTURE",
      // The order already moved to `cancelled`; the backstop must not move it.
      allowedFrom: [],
      finalStatus: "cancelled",
      actorId: null,
    });
  } catch (error) {
    // The money is back. `refund.processed` will reconcile the ledger row; a
    // retried delivery would no-op on the recorded proof, so alert and report
    // the refund as done.
    logger.error("late_capture_ledger_failed", {
      event: "late_capture_ledger_failed",
      orderId,
      refundId,
      error: errorMessage(error),
    });
  }

  return { outcome: "refunded", refundId };
};
