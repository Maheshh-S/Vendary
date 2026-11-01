import { z } from "zod";

import { MAX_CART_LINES } from "@/lib/cart";
import type { OrderTotals } from "@/lib/money";
import { checkoutLineItemSchema } from "@/schemas/checkout/place-order-schema";

/**
 * Upper bound shared with the checkout session schema and the cart provider;
 * re-exported under the historical name for the quote tests.
 */
export const CART_MAX_LINES = MAX_CART_LINES;

/**
 * Server cart-quote input: product ids and quantities only. Prices are always
 * re-derived from the database — the client cannot send one.
 */
export const cartQuoteSchema = z
  .array(checkoutLineItemSchema)
  .min(1, "Cart is empty")
  .max(CART_MAX_LINES, "Too many items in cart");

export type CartQuoteInput = z.infer<typeof cartQuoteSchema>;

export type CartQuoteAvailability = "IN_STOCK" | "OUT_OF_STOCK" | "PRE_ORDER";

/**
 * Why a line cannot be paid for as-is:
 * - MISSING: the product row no longer exists.
 * - OUT_OF_STOCK: the product is not IN_STOCK (incl. PRE_ORDER — checkout
 *   only sells IN_STOCK).
 * - INSUFFICIENT_STOCK: fewer units on hand than the requested quantity.
 */
export type CartQuoteIssue = "MISSING" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK" | null;

export type CartQuoteLine = {
  productId: string;
  /** Empty when the product is missing. */
  name: string;
  image: string | null;
  /** Authoritative integer paise as of this quote. */
  unitPaise: number;
  quantity: number;
  availability: CartQuoteAvailability;
  stockQty: number;
  issue: CartQuoteIssue;
};

export type CartQuote = OrderTotals & {
  lines: CartQuoteLine[];
  /** Subtotal is pre-discount; `taxPaise`/`totalPaise` are net of it. */
  discountPaise: number;
  /** Normalized (uppercase) code echoed back, or null when none was sent. */
  couponCode: string | null;
  /** Non-blocking quote warning that must disable payment until corrected. */
  couponError: string | null;
};

// The coupon-code boundary schema is shared with the charge path:
// `schemas/checkout/coupon-code-schema.ts`.

/** True when paying now would be refused by the server charge path. */
export const hasBlockingQuoteIssue = (quote: CartQuote | null | undefined): boolean =>
  quote?.lines.some((line) => line.issue !== null) ?? false;

/** An invalid/expired/over-limit coupon blocks payment just like a bad line. */
export const hasBlockingCouponIssue = (quote: CartQuote | null | undefined): boolean =>
  Boolean(quote?.couponError);

/**
 * Checkout gate shared by the cart and checkout pages: a missing quote (still
 * loading, failed, or never fetched) is as blocking as an unavailable line.
 * Never let the payment button look ready while the server has not confirmed
 * the cart's current prices and stock.
 */
export const shouldBlockCheckout = (state: {
  quote: CartQuote | null | undefined;
  isLoading: boolean;
  errorMessage?: string | null;
}): boolean =>
  state.isLoading ||
  Boolean(state.errorMessage) ||
  !state.quote ||
  hasBlockingQuoteIssue(state.quote) ||
  hasBlockingCouponIssue(state.quote);

/** Short per-line label for the cart/checkout issue lists. */
export const quoteLineIssueLabel = (
  line: Pick<CartQuoteLine, "issue" | "stockQty">
): string | null => {
  switch (line.issue) {
    case "MISSING":
      return "No longer available";
    case "OUT_OF_STOCK":
      return "Out of stock";
    case "INSUFFICIENT_STOCK":
      return line.stockQty > 0 ? `Only ${line.stockQty} left` : "Not enough stock";
    default:
      return null;
  }
};

/**
 * True when at least one authoritative line price differs from what the cart
 * stored. Missing lines have no price to compare and are reported as issues
 * instead of drift.
 */
export const hasPriceDrift = (
  quote: CartQuote | null | undefined,
  localLines: readonly { productId: string; unitPaise: number }[]
): boolean => {
  if (!quote) return false;
  const localById = new Map(localLines.map((line) => [line.productId, line.unitPaise]));
  return quote.lines.some(
    (line) =>
      line.issue !== "MISSING" &&
      localById.has(line.productId) &&
      localById.get(line.productId) !== line.unitPaise
  );
};
