import {
  hasBlockingQuoteIssue,
  hasPriceDrift,
  type CartQuote,
  type CartQuoteLine,
} from "@/schemas/cart/quote-schema";

type Props = {
  quote: CartQuote | null;
  /** What localStorage believes each line costs, for drift detection. */
  localLines: readonly { productId: string; unitPaise: number }[];
  /** Set when the quote request itself failed (validation/network). */
  errorMessage?: string | null;
  /** True while the server quote is in flight. */
  isLoading?: boolean;
  /** Re-runs the quote request; shown with the error banner. */
  onRetry?: () => void;
};

const issueMessage = (line: CartQuoteLine): string | null => {
  switch (line.issue) {
    case "MISSING":
      return "An item in your cart is no longer available. Remove it to continue.";
    case "OUT_OF_STOCK":
      return `"${line.name}" is out of stock. Remove it to continue.`;
    case "INSUFFICIENT_STOCK":
      return `Only ${line.stockQty} left of "${line.name}". Reduce the quantity to continue.`;
    default:
      return null;
  }
};

/**
 * Single source of cart-truth messaging for the cart and checkout pages.
 * Renders nothing when the quote agrees with the local cart and every line is
 * purchasable, so the happy path stays visually quiet.
 */
export default function QuoteBanner({
  quote,
  localLines,
  errorMessage,
  isLoading = false,
  onRetry,
}: Props) {
  if (errorMessage) {
    return (
      <div
        role="status"
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <p>We couldn&apos;t verify current prices. Please retry before paying.</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-amber-300 px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-900/40"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div
        role="status"
        className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
      >
        Checking current prices…
      </div>
    );
  }

  if (!quote) return null;

  // Key by line, not message: two lines can produce identical copy.
  const issues = quote.lines.flatMap((line, index) => {
    const message = issueMessage(line);
    return message ? [{ key: `${line.productId}-${index}`, message }] : [];
  });
  const blocking = hasBlockingQuoteIssue(quote);
  const drifted = hasPriceDrift(quote, localLines);

  if (issues.length === 0 && !drifted) return null;

  return (
    <div
      role="status"
      className={
        blocking
          ? "mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      }
    >
      {blocking && <p className="font-medium">Some items need attention before you can pay.</p>}
      {issues.length > 0 && (
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {issues.map((issue) => (
            <li key={issue.key}>{issue.message}</li>
          ))}
        </ul>
      )}
      {drifted && (
        <p className={issues.length > 0 ? "mt-2" : "font-medium"}>
          Prices have changed since you added these items. The totals show the current price.
        </p>
      )}
    </div>
  );
}
