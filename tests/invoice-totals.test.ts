import { describe, expect, it } from "vitest";

import {
  computeInvoiceTotals,
  invoiceNumber,
  invoiceYear,
  toPaise,
} from "@/lib/orders/invoice";

/**
 * Invoice math (Task 2.5): subtotal comes from the order item snapshots, tax
 * and total come from the stored order, and everything is rendered from
 * integer paise so no floating-point rupee drift reaches the page.
 */

const ORDER = {
  items: [
    { price: "1234.00", quantity: 1 },
    { price: "99.99", quantity: 2 },
  ],
  taxAmount: "114.72",
  total: "1548.70",
};

describe("computeInvoiceTotals", () => {
  it("sums snapshot lines, uses stored tax/total and balances", () => {
    expect(computeInvoiceTotals(ORDER)).toEqual({
      subtotalPaise: 123400 + 9999 * 2,
      taxPaise: 11472,
      totalPaise: 154870,
      balanced: true,
    });
  });

  it("accepts numbers and Decimal-like values", () => {
    const decimalLike = { toString: () => "49.50" };
    expect(
      computeInvoiceTotals({
        items: [{ price: decimalLike, quantity: 2 }],
        taxAmount: 7.92,
        total: { toString: () => "106.92" },
      })
    ).toEqual({
      subtotalPaise: 9900,
      taxPaise: 792,
      totalPaise: 10692,
      balanced: true,
    });
  });

  it("flags drift between line snapshots and the stored total", () => {
    expect(
      computeInvoiceTotals({ ...ORDER, total: "1500.00" }).balanced
    ).toBe(false);
  });

  it("rounds to the nearest paise", () => {
    expect(toPaise("0.333")).toBe(33);
    expect(toPaise(0.335)).toBe(34);
    expect(toPaise("1234.00")).toBe(123400);
  });
});

describe("invoiceNumber", () => {
  it("uses INV-{YYYY}-{first 8 characters of the order id}", () => {
    expect(invoiceNumber("cm9x1y2z3a4b5c6d7e8f", 2026)).toBe("INV-2026-cm9x1y2z");
  });

  it("handles ids shorter than eight characters", () => {
    expect(invoiceNumber("abc", 2026)).toBe("INV-2026-abc");
  });

  it("derives the year from the order timestamp", () => {
    expect(invoiceYear("2025-06-15T10:00:00.000Z")).toBe(2025);
    expect(invoiceYear(new Date("2026-06-15T10:00:00.000Z"))).toBe(2026);
  });
});
