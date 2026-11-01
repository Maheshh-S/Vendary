import { z } from "zod";

import type { OrderTotals } from "@/lib/money";
import { checkoutLineItemSchema } from "@/schemas/checkout/place-order-schema";

/** Upper bound mirrors the checkout boundary so quote and charge agree. */
export const CART_MAX_LINES = 50;

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
export type CartQuoteIssue =
  | "MISSING"
  | "OUT_OF_STOCK"
  | "INSUFFICIENT_STOCK"
  | null;

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
};

/** True when paying now would be refused by the server charge path. */
export const hasBlockingQuoteIssue = (
  quote: CartQuote | null | undefined
): boolean => quote?.lines.some((line) => line.issue !== null) ?? false;

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
