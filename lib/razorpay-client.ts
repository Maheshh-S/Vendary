import "server-only";

import Razorpay from "razorpay";

/**
 * Lazily constructed Razorpay client. Kept out of the server action so the
 * money path can be unit-tested with a mocked client, and so importing the
 * action never requires payment credentials at module load.
 */
let client: Razorpay | null = null;

export const getRazorpayClient = (): Razorpay => {
  const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    // Fixed message only: the env values themselves are never logged.
    console.error(
      "[razorpay] client is not configured (NEXT_PUBLIC_RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)"
    );
    throw new Error("Razorpay client is not configured");
  }
  if (!client) {
    client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return client;
};

/**
 * Stable refund reasons. The first three are automatic checkout refunds; the
 * rest are customer/admin-initiated refunds or the cancelled-order
 * late-capture backstop. They are stored on the `Refund` ledger and passed as
 * Razorpay notes (never as free-form customer input).
 */
export type RefundReason =
  | "AMOUNT_MISMATCH"
  | "PRICE_CHANGED"
  | "OUT_OF_STOCK"
  | "CUSTOMER_CANCEL"
  | "ADMIN_REFUND"
  | "LATE_CAPTURE";

/**
 * Refunds a captured payment in full. Throws on any Razorpay failure so the
 * caller can decide whether the order stays pending (never marked refunded
 * without a successful refund call).
 */
export const refundPayment = async ({
  paymentId,
  amountPaise,
  orderId,
  reason,
}: {
  paymentId: string;
  amountPaise: number;
  orderId: string;
  reason: RefundReason;
}): Promise<{ refundId: string }> => {
  const refund = await getRazorpayClient().payments.refund(paymentId, {
    amount: amountPaise,
    notes: { orderId, reason },
  });
  return { refundId: refund.id };
};
