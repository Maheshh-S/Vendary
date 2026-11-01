/**
 * Shared money math for the order path. Client-safe (no server-only imports)
 * so the cart, checkout summary, and server actions all compute identical
 * totals from one source of truth.
 *
 * Conventions: stored/product prices are rupees; amounts on the payment wire
 * are paise (₹1 = 100p).
 */

export const GST_RATE = 0.08;

export type PricedLine = {
  unitPaise: number;
  quantity: number;
};

export type OrderTotals = {
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
};

export type DiscountedTotals = OrderTotals & {
  /** Clamped to [0, subtotalPaise]; never charged as a negative line. */
  discountPaise: number;
  /** Subtotal after the discount, before GST. */
  taxablePaise: number;
};

/** Decimal-string rupees (for Prisma Decimal filters); paise are integral. */
export const paiseToRupees = (paise: number): string => (paise / 100).toFixed(2);

export function computeOrderTotals(lines: PricedLine[]): OrderTotals {
  const subtotalPaise = lines.reduce((acc, line) => acc + line.unitPaise * line.quantity, 0);
  const taxPaise = Math.round(subtotalPaise * GST_RATE);

  return {
    subtotalPaise,
    taxPaise,
    totalPaise: subtotalPaise + taxPaise,
  };
}

/**
 * Coupon totals: GST is charged on the discounted subtotal, not on the listed
 * price. `computeTotalsWithDiscount(subtotal, 0)` is exactly
 * `computeOrderTotals` for a single-line cart, so the coupon path cannot drift
 * from the plain path by a rounding paisa.
 */
export function computeTotalsWithDiscount(
  subtotalPaise: number,
  discountPaise: number
): DiscountedTotals {
  const subtotal = Number.isFinite(subtotalPaise) ? Math.max(0, Math.round(subtotalPaise)) : 0;
  const requested = Number.isFinite(discountPaise) ? Math.round(discountPaise) : 0;
  const discount = Math.min(Math.max(0, requested), subtotal);
  const taxablePaise = subtotal - discount;
  const taxPaise = Math.round(taxablePaise * GST_RATE);

  return {
    subtotalPaise: subtotal,
    discountPaise: discount,
    taxablePaise,
    taxPaise,
    totalPaise: taxablePaise + taxPaise,
  };
}
