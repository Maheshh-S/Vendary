import { orderEmailLayout } from "./order-layout";
import type { OrderStatusEmailKind, OrderEmailView } from "./types";

type StatusCopy = {
  heading: string;
  intro: string;
  note?: string;
};

const STATUS_COPY: Record<OrderStatusEmailKind, StatusCopy> = {
  shipped: {
    heading: "Your order has shipped",
    intro: "Good news — your order is on its way. The items and totals below match what you paid.",
    note: "Delivery timelines depend on the shipping option shown at checkout.",
  },
  delivered: {
    heading: "Your order was delivered",
    intro: "Your order has been delivered. We hope you love it.",
    note: "If something is not right, contact support with your order number.",
  },
  cancelled: {
    heading: "Your order was cancelled",
    intro:
      "This order has been cancelled. If a payment was captured, the refund is recorded against the same order.",
    note: "No further action is needed unless you were expecting this order.",
  },
  refunded: {
    heading: "Your refund was processed",
    intro:
      "We've processed a refund for this order. Your bank or card issuer may take a few business days to post it.",
    note: "The refund reference is available from support if you need it.",
  },
};

/** Status-change email for shipped/delivered/cancelled/refunded transitions. */
export const orderStatusEmail = (kind: OrderStatusEmailKind, view: OrderEmailView): string => {
  const copy = STATUS_COPY[kind];
  return orderEmailLayout({
    heading: copy.heading,
    intro: copy.intro,
    note: copy.note,
    view,
  });
};
