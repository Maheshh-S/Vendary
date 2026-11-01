/**
 * Customer-facing labels for the stored `Refund.reason` constants.
 *
 * `Refund.reason` is a stable string column (no DB enum), so the order detail
 * page renders through this map instead of leaking raw constants. Kept
 * client-safe: no server-only imports, no database code.
 */
const REFUND_REASON_LABELS: Record<string, string> = {
  CUSTOMER_CANCEL: "Customer cancelled",
  ADMIN_REFUND: "Admin refund",
  AMOUNT_MISMATCH: "Amount mismatch",
  OUT_OF_STOCK: "Out of stock",
  PRICE_CHANGED: "Price changed",
  LATE_CAPTURE: "Late capture",
};

/** Unknown reasons fall back to the raw constant so nothing renders blank. */
export const refundReasonLabel = (reason: string): string => REFUND_REASON_LABELS[reason] ?? reason;
