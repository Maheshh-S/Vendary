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

export function computeOrderTotals(lines: PricedLine[]): OrderTotals {
  const subtotalPaise = lines.reduce(
    (acc, line) => acc + line.unitPaise * line.quantity,
    0
  );
  const taxPaise = Math.round(subtotalPaise * GST_RATE);

  return {
    subtotalPaise,
    taxPaise,
    totalPaise: subtotalPaise + taxPaise,
  };
}
