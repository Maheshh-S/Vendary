"use server";

import crypto from "node:crypto";

import { OrderStatus, type Coupon } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin, requireUser } from "@/lib/auth-guards";
import {
  computeCouponDiscount,
  couponRejectionMessage,
  INVALID_COUPON_MESSAGE,
  MIN_PAYABLE_AMOUNT_PAISE,
  minPayableAmountMessage,
} from "@/lib/coupons";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendOrderEmail } from "@/lib/mail";
import { computeTotalsWithDiscount } from "@/lib/money";
import { confirmOrder } from "@/lib/orders/confirm-order";
import {
  callerHoldsAbandonedRedemption,
  releaseCouponForOrder,
} from "@/lib/orders/coupon-redemption";
import { writeOrderEvent } from "@/lib/orders/events";
import { refundLateCapture } from "@/lib/orders/late-capture";
import { refundAndClose, restoreOrderStock, type RefundOutcome } from "@/lib/orders/refund";
import { canAdminTransition } from "@/lib/orders/status";
import { invalidateProductCache } from "@/lib/product-cache";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { verifyRazorpayPaymentSignature } from "@/lib/razorpay";
import { getRazorpayClient, type RefundReason } from "@/lib/razorpay-client";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";
import {
  confirmPaymentSchema,
  type ConfirmPaymentSchema,
} from "@/schemas/checkout/confirm-payment-schema";
import {
  checkoutSessionSchema,
  placeOrderSchema,
  type PlaceOrderSchema,
} from "@/schemas/checkout/place-order-schema";
import { couponCodeSchema } from "@/schemas/checkout/coupon-code-schema";
import type { CheckoutLineItems } from "@/modules/products/types/checkout";

const CREATE_ORDER_BUCKET = "createRazorpayOrder";
const COUPON_CONFLICT_MESSAGE = "This coupon is no longer available.";
const COUPON_ALREADY_USED_MESSAGE = "You have already used this coupon.";

/** Prisma unique-constraint violation (one redemption per coupon+user). */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/**
 * Record-only status transitions that email the customer (after commit).
 * `cancelled` and `refunded` are deliberately absent: the paths that actually
 * move money (customer cancel, admin refund, automatic refunds and the
 * webhook) send those emails themselves, so a record-only override must never
 * tell the customer a refund was processed.
 */
const STATUS_EMAIL_KINDS: Partial<Record<OrderStatus, "shipped" | "delivered">> = {
  shipped: "shipped",
  delivered: "delivered",
};

const toRupees = (paise: number): string => (paise / 100).toFixed(2);

/** Statuses a concurrent successful confirmation can leave the order in. */
const isFulfilledStatus = (status: OrderStatus): boolean =>
  status === "confirmed" || status === "shipped" || status === "delivered";

type VerifiedLine = {
  productId: string;
  productName: string;
  productImage: string | null;
  quantity: number;
  unitPaise: number;
};

/**
 * Re-prices a validated checkout session from the database. Client-supplied
 * prices are ignored entirely — this is the single source of truth for every
 * amount charged and persisted. Throws an AppError when a product is missing,
 * unavailable, or under-stocked, so the shopper sees a verbatim explanation.
 */
const verifyAndPriceLines = async (checkoutSession: {
  line_items: { productId: string; quantity: number }[];
}): Promise<{ lines: VerifiedLine[]; subtotalPaise: number }> => {
  const products = await prisma.product.findMany({
    where: { id: { in: checkoutSession.line_items.map((item) => item.productId) } },
    select: {
      id: true,
      name: true,
      price: true,
      availability: true,
      stockQty: true,
      thumbnail: true,
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const lines: VerifiedLine[] = [];
  for (const item of checkoutSession.line_items) {
    const product = productById.get(item.productId);
    if (!product) {
      throw new AppError(
        "OUT_OF_STOCK",
        "Some items in your cart are no longer available. Please refresh your cart."
      );
    }
    if (product.availability !== "IN_STOCK") {
      throw new AppError("OUT_OF_STOCK", `"${product.name}" is currently unavailable.`);
    }
    if (product.stockQty < item.quantity) {
      throw new AppError(
        "OUT_OF_STOCK",
        `Only ${product.stockQty} left of "${product.name}". Please update your cart.`
      );
    }
    lines.push({
      productId: product.id,
      productName: product.name,
      productImage: product.thumbnail,
      quantity: item.quantity,
      // Stored prices are rupees; paise conversion rounded to stay integral.
      unitPaise: Math.round(Number(product.price) * 100),
    });
  }

  return {
    lines,
    subtotalPaise: lines.reduce((sum, line) => sum + line.unitPaise * line.quantity, 0),
  };
};

/**
 * Re-prices the durable order's lines at current DB prices. The snapshot name
 * is used only for the user-facing error. A missing product (deleted after
 * init) or a null productId is unfulfillable, so it surfaces as OUT_OF_STOCK.
 *
 * The stored discount is re-applied before GST: `order.total` was charged net
 * of it, so a coupon order must not look "price changed" on confirmation.
 */
const priceOrderItemsFromDb = async (
  items: { productId: string | null; productName: string; quantity: number }[],
  discountAmount: { toString(): string } | number | string
): Promise<ReturnType<typeof computeTotalsWithDiscount>> => {
  const productIds = items
    .map((item) => item.productId)
    .filter((productId): productId is string => productId !== null);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, price: true },
  });
  const priceById = new Map(products.map((product) => [product.id, product]));

  let subtotalPaise = 0;
  for (const item of items) {
    const product = item.productId ? priceById.get(item.productId) : undefined;
    if (!product) {
      throw new AppError(
        "OUT_OF_STOCK",
        `"${item.productName}" is no longer available. Your payment will be refunded.`
      );
    }
    subtotalPaise += Math.round(Number(product.price) * 100) * item.quantity;
  }

  return computeTotalsWithDiscount(subtotalPaise, Math.round(Number(discountAmount) * 100));
};

const SUPPORT_REFUND_MESSAGE =
  "We couldn't complete or refund this payment yet. Please contact support with your payment reference.";

/**
 * Refunds through the shared claim helper and maps the outcome the shopper
 * must never see as a conflict: a pending order already owned by a refund
 * (in flight, or a refund call that failed and recorded the proof) belongs
 * with support. A successful refund also refreshes both order views;
 * `already_handled` with a fulfilled status is returned so each caller can
 * treat a concurrent confirmation as success.
 */
const refundAndCloseForAction = async (
  orderId: string,
  paymentId: string,
  amountPaise: number,
  reason: RefundReason
): Promise<RefundOutcome> => {
  const refund = await refundAndClose(orderId, paymentId, amountPaise, reason);
  if (refund.outcome === "already_handled") {
    if (refund.status === "pending") {
      throw new AppError("PAYMENT_FAILED", SUPPORT_REFUND_MESSAGE);
    }
    return refund;
  }

  revalidatePath("/my-orders");
  revalidatePath("/admin");
  return refund;
};

/**
 * Creates the Razorpay order first, then the durable `pending` order + item
 * snapshots that carry its id. The client never sees a payable order without a
 * matching row, so a captured payment can always be reconciled to an order.
 *
 * A coupon is revalidated here from the database before Razorpay is called; the
 * quote the client saw is advisory only. The redemption and the conditional
 * usage increment commit in the same transaction as the order: if another
 * checkout consumed the last use in between, the whole init rolls back and the
 * customer never receives a discounted Razorpay order id.
 */
export const createRazorpayOrder = async ({
  checkoutSession,
  orderData,
  couponCode,
}: {
  // Ids and quantities only: display prices must never reach the charge path.
  checkoutSession: CheckoutLineItems;
  orderData: PlaceOrderSchema;
  couponCode?: string | null;
}) =>
  runAction("orders.createRazorpayOrder", async () => {
    const session = await requireUser();

    await enforceRateLimit({
      bucket: CREATE_ORDER_BUCKET,
      subject: session.user.id,
      ...RATE_LIMITS.createRazorpayOrder,
    });

    const data = parseInput(placeOrderSchema, orderData);
    const cart = parseInput(checkoutSessionSchema, checkoutSession);
    const code = parseInput(couponCodeSchema, couponCode ?? undefined);

    // Price from the database, never from the client session.
    const { lines, subtotalPaise } = await verifyAndPriceLines(cart);

    let coupon: Coupon | null = null;
    let discountPaise = 0;
    if (code) {
      coupon = await prisma.coupon.findUnique({ where: { code } });
      if (!coupon) {
        throw new AppError("VALIDATION", INVALID_COUPON_MESSAGE);
      }
      let discount = computeCouponDiscount(coupon, subtotalPaise, new Date());
      if (!discount.ok && discount.reason === "USAGE_LIMIT") {
        // The last use may be held by this customer's own abandoned checkout.
        // The transaction below still releases it under a guarded cancel before
        // claiming a new use, so a paid/confirmed order keeps the rejection.
        if (await callerHoldsAbandonedRedemption(prisma, coupon.id, session.user.id)) {
          discount = computeCouponDiscount({ ...coupon, usedCount: 0 }, subtotalPaise, new Date());
        }
      }
      if (!discount.ok) {
        throw new AppError("VALIDATION", couponRejectionMessage(discount.reason));
      }
      discountPaise = discount.discountPaise;
    }

    // GST is charged on the discounted subtotal, never on the listed price.
    const totals = computeTotalsWithDiscount(subtotalPaise, discountPaise);
    if (totals.totalPaise < MIN_PAYABLE_AMOUNT_PAISE) {
      throw new AppError("VALIDATION", minPayableAmountMessage(Boolean(code)));
    }

    const razorpay = getRazorpayClient();
    const razorpayOrder = await razorpay.orders.create({
      amount: totals.totalPaise,
      currency: "INR",
      receipt: `rcpt_${crypto.randomUUID().slice(0, 18)}`,
      notes: { userId: session.user.id },
    });

    let orderId: string;
    try {
      const order = await prisma.$transaction(async (tx) => {
        const address = await tx.address.create({
          data: {
            firstName: data.fName,
            lastName: data.lName ?? "",
            phone: data.mobile,
            address: data.address,
            area: data.area,
            landmark: data.landmark,
            postalCode: data.pinCode,
            country: data.country[0],
            state: data.country[1] ?? "",
          },
        });

        const created = await tx.order.create({
          data: {
            total: toRupees(totals.totalPaise),
            taxAmount: toRupees(totals.taxPaise),
            discountAmount: toRupees(totals.discountPaise),
            couponCode: coupon?.code ?? null,
            status: "pending",
            userId: session.user.id,
            addressId: address.id,
            paymentMethod: "RAZORPAY",
            // The payment proof arrives at confirm; the row exists first.
            paymentId: "",
            transactionId: razorpayOrder.id,
          },
        });

        await tx.orderItem.createMany({
          data: lines.map((line) => ({
            orderId: created.id,
            productId: line.productId,
            productName: line.productName,
            productImage: line.productImage,
            quantity: line.quantity,
            price: toRupees(line.unitPaise),
          })),
        });

        // The timeline is complete from the first render of the order page.
        await writeOrderEvent(tx, {
          orderId: created.id,
          type: "order_placed",
          toStatus: "pending",
          actorId: session.user.id,
        });

        if (coupon) {
          // Initializing a checkout already claimed one redemption for this
          // (coupon, user). If that previous checkout was abandoned — the
          // Razorpay modal was closed and nothing was captured — release it
          // exactly like a customer cancel/cleanup would, so retrying is not
          // a permanent lockout. A paid/confirmed order, or one with a
          // recorded payment proof, keeps the one-per-customer redemption.
          const previous = await tx.couponRedemption.findUnique({
            where: { couponId_userId: { couponId: coupon.id, userId: session.user.id } },
            select: { orderId: true },
          });
          if (previous) {
            const previousOrder = await tx.order.findUnique({
              where: { id: previous.orderId },
              select: { status: true, paymentId: true },
            });
            if (
              !previousOrder ||
              previousOrder.status !== "pending" ||
              previousOrder.paymentId !== ""
            ) {
              throw new AppError("CONFLICT", COUPON_ALREADY_USED_MESSAGE);
            }

            // Guarded on the same condition just read: if a capture or cancel
            // moved the order in between, this attempt must not release it.
            const released = await tx.order.updateMany({
              where: { id: previous.orderId, status: "pending", paymentId: "" },
              data: { status: "cancelled" },
            });
            if (released.count === 0) {
              throw new AppError("CONFLICT", COUPON_ALREADY_USED_MESSAGE);
            }

            await writeOrderEvent(tx, {
              orderId: previous.orderId,
              type: "order_cancelled",
              fromStatus: "pending",
              toStatus: "cancelled",
              actorId: session.user.id,
              metadata: { source: "coupon_reuse" },
            });
            await releaseCouponForOrder(tx, previous.orderId);
          }

          // Compare-and-increment: only a checkout that sees a remaining use
          // may redeem. A zero count means another customer won the last one.
          const claimed = await tx.coupon.updateMany({
            where: {
              id: coupon.id,
              ...(coupon.usageLimit !== null ? { usedCount: { lt: coupon.usageLimit } } : {}),
            },
            data: { usedCount: { increment: 1 } },
          });
          if (claimed.count === 0) {
            throw new AppError("CONFLICT", COUPON_CONFLICT_MESSAGE);
          }

          try {
            await tx.couponRedemption.create({
              data: {
                couponId: coupon.id,
                orderId: created.id,
                userId: session.user.id,
                amount: toRupees(totals.discountPaise),
              },
            });
          } catch (error) {
            // (couponId, userId) is unique: one redemption per customer.
            if (isUniqueViolation(error)) {
              throw new AppError("CONFLICT", COUPON_ALREADY_USED_MESSAGE);
            }
            throw error;
          }
        }

        return created;
      });
      orderId = order.id;
    } catch (error) {
      // Coupon conflicts are expected and already carry user-facing copy; they
      // must not be masked as an internal failure.
      if (error instanceof AppError) {
        throw error;
      }
      // The customer can never pay this Razorpay order (no client-side id was
      // returned), but it stays in the dashboard — keep its reference for
      // reconciliation. A `razorpay`-named key would be redacted by the
      // logger's Razorpay-scoped rule, so the field names the role instead.
      logger.error("order_persist_failed", {
        event: "order_persist_failed",
        orderReference: razorpayOrder.id,
        error,
      });
      throw new AppError("INTERNAL", "We couldn't start your checkout. Please try again.");
    }

    return {
      orderId,
      razorpayOrderId: razorpayOrder.id,
      amountPaise: totals.totalPaise,
      currency: "INR",
    };
  });

/**
 * Confirms a pending order using payment proof only. The cart and address were
 * snapshotted at init and are re-priced from current DB rows; nothing the
 * client sends here can change what was bought or where it ships.
 */
export const PlaceOrder = async (input: ConfirmPaymentSchema) =>
  runAction("orders.place", async () => {
    const session = await requireUser();
    const proof = parseInput(confirmPaymentSchema, input);

    const order = await prisma.order.findUnique({
      where: { transactionId: proof.razorpayOrderId },
      include: { items: true },
    });
    if (!order) {
      throw new AppError("NOT_FOUND", "We couldn't find this order. Please contact support.");
    }
    if (order.userId !== session.user.id) {
      throw new AppError("FORBIDDEN", "You do not have permission to do that.");
    }

    if (order.status !== "pending") {
      // A replay of a successful confirmation is a success, not an error.
      if (
        order.status === "confirmed" ||
        order.status === "shipped" ||
        order.status === "delivered"
      ) {
        return { orderId: order.id };
      }
      throw new AppError("CONFLICT", "This order can no longer be confirmed.");
    }

    // A recorded proof on a still-pending order means a refund is in flight or
    // failed. Confirming now would race that refund into a confirmed order
    // whose money was already returned, so hand it to support instead.
    if (order.paymentId !== "") {
      throw new AppError(
        "PAYMENT_FAILED",
        "We're still processing this payment. Please contact support with your payment reference."
      );
    }

    if (
      !verifyRazorpayPaymentSignature(
        proof.razorpayOrderId,
        proof.razorpayPaymentId,
        proof.razorpaySignature,
        process.env.RAZORPAY_KEY_SECRET
      )
    ) {
      throw new AppError(
        "PAYMENT_FAILED",
        "We couldn't verify this payment. Please contact support."
      );
    }

    const paidOrder = await getRazorpayClient().orders.fetch(order.transactionId);
    const paidAmountPaise = Number(paidOrder.amount);

    // Razorpay typings cap the status at created|attempted|paid; the live API
    // reports paid once captured. "attempted" means no money moved.
    if (String(paidOrder.status) === "attempted") {
      throw new AppError("PAYMENT_FAILED", "Payment was not completed. No order was placed.");
    }

    // Never hand a non-integer amount to the refund API; persist the proof and
    // let support reconcile the capture instead.
    if (!Number.isInteger(paidAmountPaise) || paidAmountPaise <= 0) {
      await prisma.order.updateMany({
        where: { id: order.id, status: "pending" },
        data: { paymentId: proof.razorpayPaymentId },
      });
      throw new AppError(
        "PAYMENT_FAILED",
        "We couldn't verify the captured amount. Please contact support."
      );
    }

    const orderTotalPaise = Math.round(Number(order.total) * 100);
    if (paidAmountPaise !== orderTotalPaise) {
      const refund = await refundAndCloseForAction(
        order.id,
        proof.razorpayPaymentId,
        paidAmountPaise,
        "AMOUNT_MISMATCH"
      );
      if (refund.outcome === "already_handled") {
        // The concurrent confirm won and already decremented stock.
        if (isFulfilledStatus(refund.status)) {
          return { orderId: order.id };
        }
        throw new AppError("CONFLICT", "This order can no longer be confirmed.");
      }
      throw new AppError(
        "AMOUNT_MISMATCH",
        "The paid amount does not match this order. Your payment has been refunded."
      );
    }

    // Re-price from current DB rows: a price change after init means the paid
    // amount no longer buys this cart, so refund instead of confirming. The
    // stored coupon discount is re-applied so the comparison stays exact.
    let currentTotals: ReturnType<typeof computeTotalsWithDiscount>;
    try {
      currentTotals = await priceOrderItemsFromDb(order.items, order.discountAmount);
    } catch (error) {
      if (error instanceof AppError && error.code === "OUT_OF_STOCK") {
        const refund = await refundAndCloseForAction(
          order.id,
          proof.razorpayPaymentId,
          paidAmountPaise,
          "OUT_OF_STOCK"
        );
        if (refund.outcome === "already_handled") {
          if (isFulfilledStatus(refund.status)) {
            return { orderId: order.id };
          }
          throw new AppError("CONFLICT", "This order can no longer be confirmed.");
        }
      }
      throw error;
    }

    if (currentTotals.totalPaise !== paidAmountPaise) {
      const refund = await refundAndCloseForAction(
        order.id,
        proof.razorpayPaymentId,
        paidAmountPaise,
        "PRICE_CHANGED"
      );
      if (refund.outcome === "already_handled") {
        if (isFulfilledStatus(refund.status)) {
          return { orderId: order.id };
        }
        throw new AppError("CONFLICT", "This order can no longer be confirmed.");
      }
      throw new AppError(
        "PRICE_CHANGED",
        "Prices changed while you were checking out. Your payment has been refunded."
      );
    }

    let confirmation: Awaited<ReturnType<typeof confirmOrder>>;
    try {
      confirmation = await confirmOrder(order.id, proof.razorpayPaymentId, session.user.id);
    } catch (error) {
      if (error instanceof AppError && error.code === "OUT_OF_STOCK") {
        const refund = await refundAndCloseForAction(
          order.id,
          proof.razorpayPaymentId,
          paidAmountPaise,
          "OUT_OF_STOCK"
        );
        if (refund.outcome === "already_handled") {
          if (isFulfilledStatus(refund.status)) {
            return { orderId: order.id };
          }
          throw new AppError("CONFLICT", "This order can no longer be confirmed.");
        }
      }
      throw error;
    }

    if (confirmation.status === "already") {
      // Losing the claim to an in-flight refund means the proof is recorded and
      // money is (being) returned; never report this as a successful confirm.
      if (confirmation.current === "pending") {
        throw new AppError(
          "PAYMENT_FAILED",
          "We're still processing this payment. Please contact support with your payment reference."
        );
      }
      if (confirmation.current === "cancelled" && confirmation.paymentId === "") {
        // A concurrent cancel won the claim between our read and the confirm
        // transaction: the capture belongs to the late-capture backstop, not
        // to this checkout. Refund it once through the shared helper.
        const lateCapture = await refundLateCapture({
          orderId: order.id,
          paymentId: proof.razorpayPaymentId,
          amountPaise: paidAmountPaise,
        });
        if (lateCapture.outcome === "refunded") {
          revalidatePath("/my-orders");
          revalidatePath("/admin");
          throw new AppError(
            "PAYMENT_FAILED",
            "Your order was cancelled, so the payment has been refunded. Please contact support if you need help."
          );
        }
        if (lateCapture.outcome === "refund_failed") {
          revalidatePath("/my-orders");
          revalidatePath("/admin");
          throw new AppError(
            "PAYMENT_FAILED",
            "Your order was cancelled. We couldn't refund this payment automatically — please contact support with your payment reference."
          );
        }
        throw new AppError("CONFLICT", "This order can no longer be confirmed.");
      }
      if (confirmation.current === "cancelled" || confirmation.current === "refunded") {
        throw new AppError("CONFLICT", "This order can no longer be confirmed.");
      }
      return { orderId: order.id };
    }

    for (const item of order.items) {
      if (item.productId) {
        await invalidateProductCache(item.productId);
      }
    }
    revalidatePath("/my-orders");
    revalidatePath("/admin");

    // Post-commit only: the email helper writes its idempotency event and
    // never throws, so a mail outage cannot fail a paid order.
    await sendOrderEmail(order.id, "confirmation");

    return { orderId: order.id };
  });

// NOTE: kept module-private (not exported) — "use server" modules may only
// export async functions.
const ORDER_STATUS_INPUT = z.object({
  orderId: z.string().min(1).max(64),
  status: z.nativeEnum(OrderStatus),
});

/**
 * Moves an order along the admin state machine. `pending -> confirmed` is not
 * an admin edge: only `confirmOrder`, after payment verification, may confirm.
 * The status predicate on the claim is what makes the stock restore
 * idempotent: of two concurrent admins exactly one `updateMany` matches, so
 * `restoreOrderStock` runs at most once.
 *
 * Phase 0 note: `cancelled`/`refunded` from the admin are record-only
 * overrides — no Razorpay refund is issued here. Money-moving refunds go
 * through `actions/(admin)/orders/refund.ts` (Phase 1 Task 1.4).
 */
export const updateOrderStatus = async (orderId: string, status: string) =>
  runAction("orders.updateStatus", async () => {
    const session = await requireAdmin();

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    });

    const input = parseInput(ORDER_STATUS_INPUT, { orderId, status });

    const outcome = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        select: {
          status: true,
          paymentId: true,
          items: { select: { productId: true, quantity: true } },
        },
      });
      if (!order) {
        throw new AppError("NOT_FOUND", "Order not found.");
      }

      const from = order.status;
      const to = input.status;

      // Unreachable through `canAdminTransition` below, but a direct caller
      // deserves the actual reason instead of a generic transition conflict.
      if (from === "pending" && to === "confirmed") {
        throw new AppError(
          "CONFLICT",
          "Orders are confirmed automatically after payment verification. You cannot confirm a pending order manually."
        );
      }

      if (!canAdminTransition(from, to)) {
        throw new AppError("CONFLICT", `Cannot change an order from ${from} to ${to}.`);
      }

      // Compare-and-set claim: only the caller that observed `from` may move
      // the order, and only that caller reaches the stock restore below.
      const claimed = await tx.order.updateMany({
        where: { id: input.orderId, status: from },
        data: { status: to },
      });
      if (claimed.count === 0) {
        throw new AppError(
          "CONFLICT",
          "The order changed while you were updating it. Please refresh."
        );
      }

      // Only `pending -> confirmed` ever decremented stock; pending orders
      // never did, and shipped/delivered goods have left the warehouse. Only
      // the confirmed -> cancelled/refunded transition puts units back, and
      // only when a payment was actually verified (`paymentId` present).
      // Legacy/admin-confirmed rows have no proof, so restoring would inflate
      // stock that was never decremented.
      const wantsRestore = from === "confirmed" && (to === "cancelled" || to === "refunded");
      const restoreStock = wantsRestore && order.paymentId !== "";
      if (restoreStock) {
        await restoreOrderStock(tx, order.items);
      }

      await writeOrderEvent(tx, {
        orderId: input.orderId,
        type: "status_changed",
        fromStatus: from,
        toStatus: to,
        actorId: session.user.id,
      });

      return {
        orderId: input.orderId,
        from,
        to,
        restoreSkipped: wantsRestore && !restoreStock,
        restoredProductIds: restoreStock
          ? order.items.flatMap((item) => (item.productId ? [item.productId] : []))
          : [],
      };
    });

    if (outcome.restoreSkipped) {
      logger.warn("order_restore_skipped_no_payment", {
        event: "order_restore_skipped_no_payment",
        orderId: outcome.orderId,
      });
    }

    // Post-commit: only the winner changed stock, so only it drops the stale
    // product views. Cache outages stay non-fatal inside the helper.
    for (const productId of outcome.restoredProductIds) {
      await invalidateProductCache(productId);
    }

    revalidatePath("/admin");
    revalidatePath("/my-orders");

    // Post-commit notification. The helper's event marker makes a duplicate
    // send impossible when the refund action also notified the customer.
    const emailKind = STATUS_EMAIL_KINDS[outcome.to];
    if (emailKind) {
      await sendOrderEmail(outcome.orderId, emailKind);
    }

    return { orderId: outcome.orderId, from: outcome.from, to: outcome.to };
  });
