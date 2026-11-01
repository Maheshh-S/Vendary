import { describe, expect, it } from "vitest";

import { refundReasonLabel } from "@/lib/orders/refund-labels";

/**
 * The order detail "Refunds" section renders `refundReasonLabel(refund.reason)`
 * for every ledger row, including the automatic (AMOUNT_MISMATCH /
 * OUT_OF_STOCK / PRICE_CHANGED) refunds written by `refundAndClose`.
 */
describe("refundReasonLabel", () => {
  it.each([
    ["CUSTOMER_CANCEL", "Customer cancelled"],
    ["ADMIN_REFUND", "Admin refund"],
    ["AMOUNT_MISMATCH", "Amount mismatch"],
    ["OUT_OF_STOCK", "Out of stock"],
    ["PRICE_CHANGED", "Price changed"],
    ["LATE_CAPTURE", "Late capture"],
  ])("renders %s as %j", (reason, label) => {
    expect(refundReasonLabel(reason)).toBe(label);
  });

  it("falls back to the raw constant for an unknown reason", () => {
    expect(refundReasonLabel("FUTURE_REASON")).toBe("FUTURE_REASON");
  });
});
