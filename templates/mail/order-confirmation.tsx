import { orderEmailLayout } from "./order-layout";
import type { OrderEmailView } from "./types";

/**
 * Order confirmation email, sent once after the payment is confirmed (client
 * callback or webhook), never from inside a DB transaction.
 */
export const orderConfirmationEmail = (view: OrderEmailView): string =>
  orderEmailLayout({
    heading: "Order confirmed",
    intro:
      "Thank you! We've received your payment and your order is confirmed. We'll email you again when it ships.",
    note: "Keep this email for your records. If anything looks wrong, reply with your order number and we'll help.",
    view,
  });
