import { describe, expect, it } from "vitest";
import { computeOrderTotals, GST_RATE } from "@/lib/money";

describe("computeOrderTotals", () => {
  it("returns zeros for an empty cart", () => {
    expect(computeOrderTotals([])).toEqual({
      subtotalPaise: 0,
      taxPaise: 0,
      totalPaise: 0,
    });
  });

  it("sums multiple lines with quantities", () => {
    const totals = computeOrderTotals([
      { unitPaise: 249900, quantity: 1 },
      { unitPaise: 34900, quantity: 3 },
    ]);
    expect(totals.subtotalPaise).toBe(249900 + 3 * 34900);
    expect(totals.taxPaise).toBe(Math.round(totals.subtotalPaise * GST_RATE));
    expect(totals.totalPaise).toBe(totals.subtotalPaise + totals.taxPaise);
  });

  it("rounds tax to whole paise (no fractional paisa can be charged)", () => {
    // 333 paise subtotal → 8% = 26.64 paise → 27 paise
    const totals = computeOrderTotals([{ unitPaise: 333, quantity: 1 }]);
    expect(totals.taxPaise).toBe(27);
    expect(totals.totalPaise).toBe(360);
  });

  it("rounds down at the .5 boundary consistently (banker-agnostic, deterministic)", () => {
    // 250 paise → 8% = 20 exactly; 251 → 20.08 → 20
    expect(computeOrderTotals([{ unitPaise: 251, quantity: 1 }]).taxPaise).toBe(20);
  });

  it("matches rupee expectations for a realistic cart (₹2,499 + ₹1,199)", () => {
    const totals = computeOrderTotals([
      { unitPaise: 249900, quantity: 1 },
      { unitPaise: 119900, quantity: 1 },
    ]);
    // subtotal ₹3,698 → GST ₹295.84 → rounded ₹295.84 (29584 paise)
    expect(totals.subtotalPaise).toBe(369800);
    expect(totals.taxPaise).toBe(29584);
    expect(totals.totalPaise).toBe(399384);
  });
});
