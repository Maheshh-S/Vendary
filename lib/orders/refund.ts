import "server-only";

import crypto from "node:crypto";

import type { OrderStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { writeOrderEvent } from "@/lib/orders/events";
import { refundPayment, type RefundReason } from "@/lib/razorpay-client";

export type RefundOutcome =
  | { outcome: "refunded" }
  | { outcome: "already_handled"; status: OrderStatus };

type StockRestoreItem = {
  productId: string | null;
  quantity: number;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toRupees = (paise: number): string => (paise / 100).toFixed(2);

/** Prisma unique-constraint violation (concurrent refund claim). */
const isUniqueConstraintViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "P2002";

/**
 * Records an automatic (Phase 0) refund on the shared ledger.
 *
 * `Refund.orderId` is unique, so this converges on the single row for the
 * order: a row created by the webhook or an earlier attempt is updated to
 * `processed` with the real Razorpay id instead of inserting a duplicate. A
 * concurrent insert that loses the unique race is retried as an update.
 *
 * The `refund_processed` event is written here (once, guarded by a lookup)
 * because the ledger row now marks the refund as settled before Razorpay's
 * `refund.processed` delivery arrives — the webhook then skips the event as
 * already reconciled.
 */
const recordAutomaticRefund = async (input: {
  orderId: string;
  paymentId: string;
  razorpayRefundId: string;
  amountPaise: number;
  reason: RefundReason;
}): Promise<void> => {
  const write = async (): Promise<void> =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.refund.findUnique({ where: { orderId: input.orderId } });
      const data = {
        razorpayRefundId: input.razorpayRefundId,
        paymentId: input.paymentId,
        amount: toRupees(input.amountPaise),
        reason: input.reason,
        status: "processed",
      };

      if (existing) {
        await tx.refund.update({ where: { id: existing.id }, data });
      } else {
        await tx.refund.create({
          data: { orderId: input.orderId, ...data },
        });
      }

      const processedEvent = await tx.orderEvent.findFirst({
        where: { orderId: input.orderId, type: "refund_processed" },
        select: { id: true },
      });
      if (!processedEvent) {
        await writeOrderEvent(tx, {
          orderId: input.orderId,
          type: "refund_processed",
          actorId: null,
          metadata: {
            refundId: input.razorpayRefundId,
            amountPaise: input.amountPaise,
            reason: input.reason,
          },
        });
      }
    });

  try {
    await write();
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    // A concurrent path inserted the row between the read and the insert;
    // converge on that row.
    await write();
  }
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
 * support, never mark it refunded. Callers decide how loud that is: the
 * checkout action returns `PAYMENT_FAILED`; the webhook acknowledges the event
 * and alerts support, because the recorded proof makes a retry a no-op.
 *
 * A successful call also writes the `Refund` ledger row, so automatic refunds
 * are visible to support and on the order detail page like every other refund.
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

  let refundId: string;
  try {
    ({ refundId } = await refundPayment({ paymentId, amountPaise, orderId, reason }));
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "order_refund_failed",
        orderId,
        paymentId,
        reason,
        error: errorMessage(error),
      })
    );
    throw new AppError(
      "PAYMENT_FAILED",
      "Your payment was captured but we couldn't complete your order. Please contact support with your payment reference.",
      undefined,
      error
    );
  }

  // The money is back: record it on the shared ledger before closing the
  // order. A ledger failure is loud but must not stop the close — the refund
  // itself already succeeded and `refund.processed` reconciles the row.
  try {
    await recordAutomaticRefund({
      orderId,
      paymentId,
      razorpayRefundId: refundId,
      amountPaise,
      reason,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "order_refund_ledger_failed",
        orderId,
        paymentId,
        reason,
        refundId,
        error: errorMessage(error),
      })
    );
  }

  const closed = await prisma.order.updateMany({
    where: { id: orderId, status: "pending" },
    data: { status: "refunded" },
  });
  if (closed.count === 0) {
    // The money is back (the Razorpay refund succeeded), but the order moved
    // off `pending` between the claim and this close. Never silent: support
    // must reconcile an order whose status does not reflect the refund.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "order_refund_close_race",
        orderId,
      })
    );
  }

  return { outcome: "refunded" };
};

/**
 * Puts every ordered line back on the shelf. Only call this for a refund that
 * wins the `confirmed → refunded | cancelled` transition: pending orders never
 * decremented stock, and shipped/delivered stock has already left the
 * warehouse.
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

// ---------------------------------------------------------------------------
// Refund ledger: claim → Razorpay call → finalize/fail
// ---------------------------------------------------------------------------

export type ClaimRefundOptions = {
  orderId: string;
  amountPaise: number;
  reason: RefundReason;
  /** Order statuses a refund may be started from. */
  allowedFrom: readonly OrderStatus[];
  actorId: string | null;
};

export type ClaimedRefund = {
  orderId: string;
  refundRowId: string;
  orderStatus: OrderStatus;
  paymentId: string;
  items: StockRestoreItem[];
};

/**
 * Claims the single refund row for an order inside the caller's transaction.
 *
 * `Refund.orderId` is unique, so this is the race guard: of two concurrent
 * cancels exactly one creates the row (the loser gets a mapped CONFLICT), and
 * a later retry of a `failed` row compare-and-sets it back to `requested`
 * instead of creating a second — exactly one concurrent retry wins.
 * The placeholder Razorpay id keeps the unique column populated until the
 * `payments.refund` call returns the real id.
 */
export const claimRefundInTransaction = async (
  tx: Prisma.TransactionClient,
  options: ClaimRefundOptions
): Promise<ClaimedRefund> => {
  const order = await tx.order.findUnique({
    where: { id: options.orderId },
    select: {
      status: true,
      paymentId: true,
      items: { select: { productId: true, quantity: true } },
    },
  });
  if (!order) {
    throw new AppError("NOT_FOUND", "Order not found.");
  }
  if (!options.allowedFrom.includes(order.status)) {
    throw new AppError("CONFLICT", `Cannot refund an order that is ${order.status}.`);
  }
  if (order.paymentId === "") {
    throw new AppError("CONFLICT", "No captured payment is recorded for this order.");
  }

  const placeholderId = `pending:${crypto.randomUUID()}`;
  const existing = await tx.refund.findUnique({ where: { orderId: options.orderId } });

  let refundRowId: string;
  if (existing) {
    if (existing.status === "processed") {
      throw new AppError("CONFLICT", "This order has already been refunded.");
    }
    if (existing.status === "requested") {
      throw new AppError("CONFLICT", "A refund for this order is already in progress.");
    }
    // A failed attempt may be retried against the same ledger row, but only
    // through a compare-and-set: of two concurrent retries exactly one flips
    // `failed → requested`, so only one can issue a Razorpay refund.
    const retried = await tx.refund.updateMany({
      where: { id: existing.id, status: "failed" },
      data: {
        razorpayRefundId: placeholderId,
        paymentId: order.paymentId,
        amount: toRupees(options.amountPaise),
        reason: options.reason,
        status: "requested",
      },
    });
    if (retried.count === 0) {
      throw new AppError("CONFLICT", "A refund is already being processed.");
    }
    refundRowId = existing.id;
  } else {
    const created = await tx.refund.create({
      data: {
        orderId: options.orderId,
        razorpayRefundId: placeholderId,
        paymentId: order.paymentId,
        amount: toRupees(options.amountPaise),
        reason: options.reason,
        status: "requested",
      },
      select: { id: true },
    });
    refundRowId = created.id;
  }

  await writeOrderEvent(tx, {
    orderId: options.orderId,
    type: "refund_requested",
    fromStatus: order.status,
    actorId: options.actorId,
    metadata: { amountPaise: options.amountPaise, reason: options.reason },
  });

  return {
    orderId: options.orderId,
    refundRowId,
    orderStatus: order.status,
    paymentId: order.paymentId,
    items: order.items,
  };
};

/** Transactional wrapper that maps the unique-race loser to a CONFLICT. */
export const claimOrderRefund = async (
  options: ClaimRefundOptions
): Promise<ClaimedRefund> => {
  try {
    return await prisma.$transaction((tx) => claimRefundInTransaction(tx, options));
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError("CONFLICT", "A refund for this order is already in progress.");
    }
    throw error;
  }
};

export type FinalizeRefundOptions = {
  orderId: string;
  refundRowId: string;
  razorpayRefundId: string;
  amountPaise: number;
  reason: RefundReason;
  /** Order statuses the successful refund may move from. */
  allowedFrom: readonly OrderStatus[];
  finalStatus: OrderStatus;
  /**
   * Status transition event written when the order actually moved. Omitted by
   * the late-capture backstop, which must leave the order `cancelled`.
   */
  successEvent?: "order_cancelled" | "status_changed";
  actorId: string | null;
};

export type RefundFinalization = {
  orderId: string;
  refundId: string;
  /** null when the order had already moved off the allowed statuses. */
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  restoredProductIds: string[];
};

/**
 * Records a successful Razorpay refund: marks the ledger row processed with
 * the real id, moves the order when it is still in an allowed status, restores
 * stock for the `confirmed` transition and appends the audit events.
 *
 * Idempotent: a `refund.processed` webhook may have already completed the same
 * transition and written `refund_processed`; this then only re-confirms the
 * ledger row and never restores stock twice.
 */
export const finalizeOrderRefund = async (
  options: FinalizeRefundOptions
): Promise<RefundFinalization> =>
  prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: options.orderId },
      select: {
        status: true,
        items: { select: { productId: true, quantity: true } },
      },
    });
    if (!order) {
      throw new AppError("NOT_FOUND", "Order not found.");
    }

    await tx.refund.update({
      where: { id: options.refundRowId },
      data: { razorpayRefundId: options.razorpayRefundId, status: "processed" },
    });

    const fromStatus = order.status;
    let toStatus: OrderStatus | null = null;
    let restoredProductIds: string[] = [];

    if (options.allowedFrom.includes(fromStatus)) {
      // Compare-and-set on the status we just read: a concurrent transition
      // (e.g. the same refund's webhook) wins at most once.
      const moved = await tx.order.updateMany({
        where: { id: options.orderId, status: fromStatus },
        data: { status: options.finalStatus },
      });
      if (moved.count === 1) {
        toStatus = options.finalStatus;
        if (fromStatus === "confirmed") {
          await restoreOrderStock(tx, order.items);
          restoredProductIds = order.items.flatMap((item) =>
            item.productId ? [item.productId] : []
          );
        }
        if (options.successEvent) {
          await writeOrderEvent(tx, {
            orderId: options.orderId,
            type: options.successEvent,
            fromStatus,
            toStatus,
            actorId: options.actorId,
          });
        }
      }
    }

    const existingProcessedEvent = await tx.orderEvent.findFirst({
      where: { orderId: options.orderId, type: "refund_processed" },
      select: { id: true },
    });
    if (!existingProcessedEvent) {
      await writeOrderEvent(tx, {
        orderId: options.orderId,
        type: "refund_processed",
        fromStatus: toStatus ? fromStatus : null,
        toStatus,
        actorId: options.actorId,
        metadata: {
          refundId: options.razorpayRefundId,
          amountPaise: options.amountPaise,
          reason: options.reason,
        },
      });
    }

    return {
      orderId: options.orderId,
      refundId: options.razorpayRefundId,
      fromStatus: toStatus ? fromStatus : null,
      toStatus,
      restoredProductIds,
    };
  });

/**
 * Records a failed refund attempt without touching the order status.
 *
 * Compare-and-set on `requested → failed`: a failure that surfaces after the
 * refund was already finalized (an ambiguous Razorpay timeout whose
 * `refund.processed` arrived first) must not clobber the `processed` row, and
 * writes no `refund_failed` event.
 */
export const failOrderRefund = async (options: {
  orderId: string;
  refundRowId: string;
  reason: RefundReason;
  error: string;
  actorId: string | null;
}): Promise<void> =>
  prisma.$transaction(async (tx) => {
    const failed = await tx.refund.updateMany({
      where: { id: options.refundRowId, status: "requested" },
      data: { status: "failed" },
    });
    if (failed.count === 0) {
      return;
    }

    await writeOrderEvent(tx, {
      orderId: options.orderId,
      type: "refund_failed",
      actorId: options.actorId,
      metadata: { reason: options.reason, error: options.error.slice(0, 500) },
    });
  });

export type StartRefundOptions = Omit<
  FinalizeRefundOptions,
  "refundRowId" | "razorpayRefundId"
> & {
  /** User-facing AppError copy when the Razorpay call fails. */
  failureMessage: string;
};

/**
 * Full refund flow for cancel/admin refund: claim the ledger row, call
 * Razorpay for the full amount, then finalize (status + stock + events) or
 * record the failure. A failed Razorpay call leaves the order untouched and
 * surfaces `PAYMENT_FAILED` so the caller points the user at support.
 */
export const startOrderRefund = async (
  options: StartRefundOptions
): Promise<RefundFinalization> => {
  const claimed = await claimOrderRefund({
    orderId: options.orderId,
    amountPaise: options.amountPaise,
    reason: options.reason,
    allowedFrom: options.allowedFrom,
    actorId: options.actorId,
  });

  let refundId: string;
  try {
    ({ refundId } = await refundPayment({
      paymentId: claimed.paymentId,
      amountPaise: options.amountPaise,
      orderId: options.orderId,
      reason: options.reason,
    }));
  } catch (error) {
    const errorText = errorMessage(error);
    try {
      await failOrderRefund({
        orderId: options.orderId,
        refundRowId: claimed.refundRowId,
        reason: options.reason,
        error: errorText,
        actorId: options.actorId,
      });
    } catch (ledgerError) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "refund_failed_ledger_write_failed",
          orderId: options.orderId,
          reason: options.reason,
          error: errorMessage(ledgerError),
        })
      );
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "order_refund_failed",
        orderId: options.orderId,
        reason: options.reason,
        error: errorText,
      })
    );
    throw new AppError("PAYMENT_FAILED", options.failureMessage, undefined, error);
  }

  const result = await finalizeOrderRefund({
    ...options,
    refundRowId: claimed.refundRowId,
    razorpayRefundId: refundId,
  });

  if (result.toStatus === null) {
    // The money is back, but the order moved off the refundable statuses while
    // the Razorpay call was in flight. Support must reconcile the status.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "refund_order_status_race",
        orderId: options.orderId,
        reason: options.reason,
      })
    );
  }

  return result;
};
