import { z } from "zod";

/**
 * Zod schemas for the Razorpay webhook entities this app consumes.
 *
 * The HMAC proves the body came from Razorpay, but the shape still has to be
 * validated before any DB read or write. Amounts are integer paise on the
 * wire; `Order.total` is Decimal rupees and must be converted before compare.
 */

export const paymentEntitySchema = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  status: z.string(),
  error_code: z.string().optional(),
});

export const refundEntitySchema = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  status: z.string(),
});

export const webhookSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: paymentEntitySchema }).optional(),
    refund: z.object({ entity: refundEntitySchema }).optional(),
  }),
});

export type PaymentWebhookEntity = z.infer<typeof paymentEntitySchema>;
export type RefundWebhookEntity = z.infer<typeof refundEntitySchema>;
export type RazorpayWebhook = z.infer<typeof webhookSchema>;
