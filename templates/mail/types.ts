/**
 * Shared view model for the order email templates. Built from the order's
 * snapshot rows only (no live product joins), so a deleted product still
 * renders with the name/price the customer saw at checkout.
 */

export const ORDER_EMAIL_KINDS = [
  "confirmation",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const;

export type OrderEmailKind = (typeof ORDER_EMAIL_KINDS)[number];

export type OrderStatusEmailKind = Exclude<OrderEmailKind, "confirmation">;

export type OrderEmailItem = {
  name: string;
  quantity: number;
  /** Integer paise, derived from the stored rupee Decimal. */
  unitPaise: number;
};

export type OrderEmailAddress = {
  name: string;
  address: string;
  area: string;
  landmark: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
};

export type OrderEmailView = {
  orderId: string;
  status: string;
  placedAt: string;
  items: readonly OrderEmailItem[];
  subtotalPaise: number;
  /** Coupon discount already reflected in `totalPaise`; zero when none. */
  discountPaise: number;
  couponCode: string | null;
  taxPaise: number;
  totalPaise: number;
  address: OrderEmailAddress | null;
};
