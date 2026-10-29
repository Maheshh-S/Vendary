"use server"

import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import { serializePrismaObject } from "@/lib/db/serializer";
import {
  checkoutSessionSchema,
  placeOrderSchema,
  PlaceOrderSchema,
} from "@/schemas/checkout/place-order-schema";
import { CheckoutSession } from "@/modules/products/types/checkout";
import { computeOrderTotals } from "@/lib/money";
import { invalidateProductCache } from "@/lib/product-cache";
import { revalidatePath } from "next/cache";
import Razorpay from "razorpay";
import crypto from "crypto";

// Razorpay rejects order amounts below 100 paise (₹1).
const MIN_RAZORPAY_AMOUNT_PAISE = 100;

/**
 * Rejections that are safe (and necessary) to show the shopper verbatim:
 * stock changes, unavailable products, amount mismatches. Everything else is
 * masked behind a generic message so internals never leak.
 */
class OrderRejectionError extends Error {}

const getRazorpayClient = () => {
  const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.error("Razorpay keys are not configured (NEXT_PUBLIC_RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
    throw new Error("Payment initialization failed");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

type VerifiedLine = {
  product: {
    id: string;
    name: string;
    stockQty: number;
  };
  quantity: number;
  unitPaise: number;
};

/**
 * Re-prices a client checkout session from the database. Client-supplied
 * prices are ignored entirely — this is the single source of truth for every
 * amount charged or persisted. Throws OrderRejectionError (with the product
 * name) when a product is missing, not in stock, or under-stocked for the
 * requested quantity.
 */
const verifyAndPriceLines = async (
  checkoutSession: { line_items: { productId: string; quantity: number }[] }
): Promise<{ lines: VerifiedLine[]; totals: ReturnType<typeof computeOrderTotals> }> => {
  const { data, error } = checkoutSessionSchema.safeParse(checkoutSession);
  if (error) {
    throw new OrderRejectionError("Your cart is invalid or empty. Please refresh your cart.");
  }

  const products = await prisma.product.findMany({
    where: { id: { in: data.line_items.map((item) => item.productId) } },
    select: { id: true, name: true, price: true, availability: true, stockQty: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const lines: VerifiedLine[] = [];
  for (const item of data.line_items) {
    const product = productById.get(item.productId);
    if (!product) {
      throw new OrderRejectionError("Some items in your cart are no longer available. Please refresh your cart.");
    }
    if (product.availability !== "IN_STOCK") {
      throw new OrderRejectionError(`"${product.name}" is currently unavailable.`);
    }
    if (product.stockQty < item.quantity) {
      throw new OrderRejectionError(`Only ${product.stockQty} left of "${product.name}". Please update your cart.`);
    }
    lines.push({
      product: { id: product.id, name: product.name, stockQty: product.stockQty },
      quantity: item.quantity,
      // Stored prices are rupees; paise conversion rounded to stay integral.
      unitPaise: Math.round(Number(product.price) * 100),
    });
  }

  return { lines, totals: computeOrderTotals(lines) };
};

// Function to create Razorpay order
export const createRazorpayOrder = async ({
  checkoutSession,
  orderData
}: {
  checkoutSession: CheckoutSession;
  orderData: PlaceOrderSchema
}) => {
  // Pricing/stock validation happens outside the try: its rejections reach
  // the shopper verbatim and must not be masked.
  const { error } = placeOrderSchema.safeParse(orderData);
  if (error) {
    throw new Error("Invalid order data");
  }

  // Price from the database, never from the client session.
  const { totals } = await verifyAndPriceLines(checkoutSession);
  if (totals.totalPaise < MIN_RAZORPAY_AMOUNT_PAISE) {
    throw new OrderRejectionError("Order total must be at least ₹1");
  }

  try {
    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: totals.totalPaise,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: {
        customerName: `${orderData.fName} ${orderData.lName || ''}`,
        shippingAddress: orderData.address,
        phone: orderData.mobile
      }
    });

    return order;
  } catch (error) {
    if (error instanceof OrderRejectionError) {
      throw error;
    }
    console.error("Failed to create Razorpay order:", error);
    throw new Error("Payment initialization failed");
  }
};

// Function to verify Razorpay payment
const verifyRazorpayPayment = (
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string
) => {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  // Fail closed: without the secret no signature can be trusted.
  if (!secret) {
    return false;
  }
  const text = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(text)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(razorpaySignature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Main order placement function
export const PlaceOrder = async ({
  orderData,
  checkoutSession,
  paymentDetails
}: {
  orderData: PlaceOrderSchema;
  checkoutSession: CheckoutSession;
  paymentDetails: {
    razorpayPaymentId: string;
    razorpayOrderId: string;
    razorpaySignature: string;
  }
}) => {
    const session = await auth();
    if (!session?.user?.id) {
        throw new Error("Unauthorized");
    }

    const {
        data,
        error
    } = placeOrderSchema.safeParse(orderData);

    if (error) {
        throw new Error("Invalid order data");
    }

    if (!paymentDetails?.razorpayPaymentId || !paymentDetails?.razorpayOrderId || !paymentDetails?.razorpaySignature) {
        throw new Error("Payment verification failed");
    }

    // Idempotency: a replayed success callback must not create a second order.
    const existingOrder = await prisma.order.findFirst({
        where: { transactionId: paymentDetails.razorpayOrderId },
        select: { id: true },
    });
    if (existingOrder) {
        return { success: true, orderId: existingOrder.id };
    }

    // Verify the payment signature, then confirm the paid amount equals the
    // server-computed total (protects against paying for a cheap session and
    // replaying its signature against an expensive cart).
    if (!verifyRazorpayPayment(
      paymentDetails.razorpayOrderId,
      paymentDetails.razorpayPaymentId,
      paymentDetails.razorpaySignature
    )) {
      throw new Error("Payment verification failed");
    }

    // Price from the database, never from the client session.
    const { lines, totals } = await verifyAndPriceLines(checkoutSession);
    if (totals.totalPaise < MIN_RAZORPAY_AMOUNT_PAISE) {
        throw new OrderRejectionError("Order total must be at least ₹1");
    }

    const razorpay = getRazorpayClient();
    const paidOrder = await razorpay.orders.fetch(paymentDetails.razorpayOrderId);
    // Razorpay typings cap Order.status at created|attempted, but the live API
    // reports paid|authorized once a payment succeeds on the order.
    const paidStatus = String(paidOrder.status);
    if (paidOrder.amount !== totals.totalPaise) {
        throw new OrderRejectionError("Payment amount does not match your cart. No order was recorded — please contact support for a refund.");
    }
    if (paidStatus !== "paid" && paidStatus !== "authorized") {
        throw new OrderRejectionError("Payment was not completed. No order was placed.");
    }

    const userId = session.user.id;

    try {
        const order = await prisma.$transaction(async (tx) => {
            // Create Address
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
                }
            });

            // Create Order — payment already verified above.
            const order = await tx.order.create({
                data: {
                    total: (totals.totalPaise / 100).toFixed(2),
                    taxAmount: (totals.taxPaise / 100).toFixed(2),
                    status: "confirmed",
                    userId,
                    addressId: address.id,
                    paymentMethod: "RAZORPAY",
                    paymentId: paymentDetails.razorpayPaymentId,
                    transactionId: paymentDetails.razorpayOrderId,
                }
            });

            // Create OrderItems at DB prices and decrement stock atomically.
            for (const line of lines) {
                await tx.orderItem.create({
                    data: {
                        orderId: order.id,
                        productId: line.product.id,
                        quantity: line.quantity,
                        price: (line.unitPaise / 100).toFixed(2),
                    }
                });

                const decremented = await tx.product.updateMany({
                    where: {
                        id: line.product.id,
                        availability: "IN_STOCK",
                        stockQty: { gte: line.quantity },
                    },
                    data: { stockQty: { decrement: line.quantity } },
                });
                if (decremented.count !== 1) {
                    throw new OrderRejectionError(`"${line.product.name}" just sold out. Your payment can be refunded — please contact support.`);
                }

                if (line.product.stockQty - line.quantity <= 0) {
                    await tx.product.update({
                        where: { id: line.product.id },
                        data: { availability: "OUT_OF_STOCK" },
                    });
                }
            }

            return order;
        });

        for (const line of lines) {
            await invalidateProductCache(line.product.id);
        }

        revalidatePath("/my-orders");
        revalidatePath("/admin");

        return { success: true, orderId: order.id };

    } catch (error) {
        if (error instanceof OrderRejectionError) {
            throw error;
        }
        console.error("Failed to place order:", error);
        throw new Error("Something went wrong while placing the order");
    }
};

export type OrderStatus = "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";

// NOTE: kept module-private (not exported) — "use server" modules may only
// export async functions.
const ORDER_STATUSES: OrderStatus[] = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

export const updateOrderStatus = async (orderId: string, status: string) => {
    const session = await auth();
    if (!session?.user?.id || session.user.role !== "ADMIN") {
        throw new Error("Unauthorized");
    }

    if (!ORDER_STATUSES.includes(status as OrderStatus)) {
        throw new Error("Invalid order status");
    }

    const updated = await prisma.order.update({
        where: { id: orderId },
        data: { status },
    });

    revalidatePath("/admin");
    return serializePrismaObject(updated);
};
