import { z } from "zod";

/**
 * The only input the confirm step trusts. Address and cart are loaded from the
 * pending order created before payment; a replayed success callback can never
 * substitute a cheaper cart or a different shipping address.
 *
 * Bounds are generous for Razorpay identifiers (`order_...` / `pay_...` are
 * ~20 chars) and the signature (64 hex chars), but finite so an oversized
 * payload is rejected at the boundary.
 */
export const confirmPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1, "Payment order is required").max(64, "Invalid payment order"),
  razorpayPaymentId: z.string().min(1, "Payment id is required").max(64, "Invalid payment id"),
  razorpaySignature: z.string().min(1, "Payment signature is required").max(128, "Invalid payment signature"),
});

export type ConfirmPaymentSchema = z.infer<typeof confirmPaymentSchema>;
