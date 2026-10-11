/**
 * Formats a major-unit INR amount (rupees, as stored) for display.
 * Amounts are rupees, NOT paise — divide paise by 100 before calling.
 * Uses the en-IN locale: lakh/crore grouping (e.g. ₹1,00,000.00).
 */
export function formatINR(amount: number | string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}
