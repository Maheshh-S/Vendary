"use server";

import crypto from "node:crypto";

import { OrderStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { serializePrismaObject } from "@/lib/db/serializer";
import { AppError } from "@/lib/errors";
import { computeOrderTotals } from "@/lib/money";
import { confirmOrder } from "@/lib/orders/confirm-order";
import { invalidateProductCache } from "@/lib/product-cache";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { verifyRazorpayPaymentSignature } from "@/lib/razorpay";
import { getRazorpayClient, refundPayment, type RefundReason } from "@/lib/razorpay-client";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";
import { confirmPaymentSchema, type ConfirmPaymentSchema } from "@/schemas/checkout/confirm-payment-schema";
import {
  checkoutSessionSchema,
  placeOrderSchema,
  type PlaceOrderSchema,
} from "@/schemas/checkout/place-order-schema";
import { CheckoutSession } from "@/modules/products/types/checkout";

// Razorpay rejects order amounts below 100 paise (₹1).
const MIN_RAZORPAY_AMOUNT_PAISE = 100;
const CREATE_ORDER_BUCKET = "createRazorpayOrder";

const toRupees = (paise: number): string => (paise / 100).toFixed(2);

/** Statuses a concurrent successful confirmation can leave the order in. */
const isFulfilledStatus = (status: OrderStatus): boolean =>
  status === "confirmed" || status === "shipped" || status === "delivered";

type RefundOutcome =
  | { outcome: "refunded" }
  | { outcome: "already_handled"; status: OrderStatus };

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
}): Promise<{ lines: VerifiedLine[]; totals: ReturnType<typeof computeOrderTotals> }> => {
  const products = await prisma.product.findMany({
    where: { id: { in: checkoutSession.line_items.map((item) => item.productId) } },
    select: { id: true, name: true, price: true, availability: true, stockQty: true, thumbnail: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const lines: VerifiedLine[] = [];
  for (const item of checkoutSession.line_items) {
    const product = productById.get(item.productId);
    if (!product) {
      throw new AppError("OUT_OF_STOCK", "Some items in your cart are no longer available. Please refresh your cart.");
    }
    if (product.availability !== "IN_STOCK") {
      throw new AppError("OUT_OF_STOCK", `"${product.name}" is currently unavailable.`);
    }
    if (product.stockQty < item.quantity) {
      throw new AppError("OUT_OF_STOCK", `Only ${product.stockQty} left of "${product.name}". Please update your cart.`);
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

  return { lines, totals: computeOrderTotals(lines) };
};

/**
 * Re-prices the durable order's lines at current DB prices. The snapshot name
 * is used only for the user-facing error. A missing product (deleted after
 * init) or a null productId is unfulfillable, so it surfaces as OUT_OF_STOCK.
 */
const priceOrderItemsFromDb = async (
  items: { productId: string | null; productName: string; quantity: number }[]
): Promise<ReturnType<typeof computeOrderTotals>> => {
  const productIds = items
    .map((item) => item.productId)
    .filter((productId): productId is string => productId !== null);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, price: true },
  });
  const priceById = new Map(products.map((product) => [product.id, product]));

  return computeOrderTotals(
    items.map((item) => {
      const product = item.productId ? priceById.get(item.productId) : undefined;
      if (!product) {
        throw new AppError(
          "OUT_OF_STOCK",
          `"${item.productName}" is no longer available. Your payment will be refunded.`
        );
      }
      return { unitPaise: Math.round(Number(product.price) * 100), quantity: item.quantity };
    })
  );
};

/**
 * Refunds a capture we cannot fulfil and closes the order.
 *
 * The claim (`pending` + empty proof → record proof) is what makes refund and
 * confirm mutually exclusive: whichever path writes `paymentId` first owns the
 * order. A `count` of 0 means the confirm path won, or an earlier refund
 * attempt already recorded the proof. In both cases we must not refund again
 * and must report what actually happened instead of claiming a refund.
 */
const refundAndClose = async (
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
      select: { status: true, paymentId: true },
    });
    if (current?.status === "pending" && current.paymentId !== "") {
      throw new AppError(
        "PAYMENT_FAILED",
        "We couldn't complete or refund this payment yet. Please contact support with your payment reference."
      );
    }
    if (!current) {
      throw new AppError("CONFLICT", "This order can no longer be confirmed.");
    }
    // Another path already moved the order on (e.g. a concurrent confirm).
    // Never report a refund we did not perform.
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
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new AppError(
      "PAYMENT_FAILED",
      "Your payment was captured but we couldn't complete your order. Please contact support with your payment reference."
    );
  }

  await prisma.order.updateMany({
    where: { id: orderId, status: "pending" },
    data: { status: "refunded" },
  });
  revalidatePath("/my-orders");
  revalidatePath("/admin");

  return { outcome: "refunded" };
};

/**
 * Creates the Razorpay order first, then the durable `pending` order + item
 * snapshots that carry its id. The client never sees a payable order without a
 * matching row, so a captured payment can always be reconciled to an order.
 */
export const createRazorpayOrder = async ({
  checkoutSession,
  orderData,
}: {
  checkoutSession: CheckoutSession;
  orderData: PlaceOrderSchema;
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

    // Price from the database, never from the client session.
    const { lines, totals } = await verifyAndPriceLines(cart);
    if (totals.totalPaise < MIN_RAZORPAY_AMOUNT_PAISE) {
      throw new AppError("VALIDATION", "Order total must be at least ₹1.");
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

        return created;
      });
      orderId = order.id;
    } catch (error) {
      // The customer can never pay this Razorpay order (no client-side id was
      // returned), but it stays in the dashboard — log its id for reconciliation.
      console.error(
        JSON.stringify({
          level: "error",
          event: "order_persist_failed",
          razorpayOrderId: razorpayOrder.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
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
      if (order.status === "confirmed" || order.status === "shipped" || order.status === "delivered") {
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
      throw new AppError("PAYMENT_FAILED", "We couldn't verify this payment. Please contact support.");
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
      throw new AppError("PAYMENT_FAILED", "We couldn't verify the captured amount. Please contact support.");
    }

    const orderTotalPaise = Math.round(Number(order.total) * 100);
    if (paidAmountPaise !== orderTotalPaise) {
      const refund = await refundAndClose(order.id, proof.razorpayPaymentId, paidAmountPaise, "AMOUNT_MISMATCH");
      if (refund.outcome === "already_handled") {
        // The concurrent confirm won and already decremented stock.
        if (isFulfilledStatus(refund.status)) {
          return { orderId: order.id };
        }
        throw new AppError("CONFLICT", "This order can no longer be confirmed.");
      }
      throw new AppError("AMOUNT_MISMATCH", "The paid amount does not match this order. Your payment has been refunded.");
    }

    // Re-price from current DB rows: a price change after init means the paid
    // amount no longer buys this cart, so refund instead of confirming.
    let currentTotals: ReturnType<typeof computeOrderTotals>;
    try {
      currentTotals = await priceOrderItemsFromDb(order.items);
    } catch (error) {
      if (error instanceof AppError && error.code === "OUT_OF_STOCK") {
        const refund = await refundAndClose(order.id, proof.razorpayPaymentId, paidAmountPaise, "OUT_OF_STOCK");
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
      const refund = await refundAndClose(order.id, proof.razorpayPaymentId, paidAmountPaise, "PRICE_CHANGED");
      if (refund.outcome === "already_handled") {
        if (isFulfilledStatus(refund.status)) {
          return { orderId: order.id };
        }
        throw new AppError("CONFLICT", "This order can no longer be confirmed.");
      }
      throw new AppError("PRICE_CHANGED", "Prices changed while you were checking out. Your payment has been refunded.");
    }

    let confirmation: Awaited<ReturnType<typeof confirmOrder>>;
    try {
      confirmation = await confirmOrder(order.id, proof.razorpayPaymentId);
    } catch (error) {
      if (error instanceof AppError && error.code === "OUT_OF_STOCK") {
        const refund = await refundAndClose(order.id, proof.razorpayPaymentId, paidAmountPaise, "OUT_OF_STOCK");
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

    return { orderId: order.id };
  });

// NOTE: kept module-private (not exported) — "use server" modules may only
// export async functions.
const ORDER_STATUS_INPUT = z.object({
  orderId: z.string().min(1).max(64),
  status: z.nativeEnum(OrderStatus),
});

export const updateOrderStatus = async (orderId: string, status: string) => {
    const session = await requireUser();
    if (session.user.role !== "ADMIN") {
        throw new AppError("FORBIDDEN", "You do not have permission to do that.");
    }

    const input = parseInput(ORDER_STATUS_INPUT, { orderId, status });

    const updated = await prisma.order.update({
        where: { id: input.orderId },
        data: { status: input.status },
    });

    revalidatePath("/admin");
    return serializePrismaObject(updated);
};
