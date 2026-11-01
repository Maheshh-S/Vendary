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
export default function QuoteBanner({ quote, localLines, errorMessage }: Props) {
  if (errorMessage) {
    return (
      <div
        role="status"
        className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      >
        We couldn&apos;t verify current prices. Please refresh the page before
        paying.
      </div>
    );
  }

  if (!quote) return null;

  const issues = quote.lines
    .map(issueMessage)
    .filter((message): message is string => message !== null);
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
      {blocking && (
        <p className="font-medium">
          Some items need attention before you can pay.
        </p>
      )}
      {issues.length > 0 && (
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {issues.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {drifted && (
        <p className={issues.length > 0 ? "mt-2" : "font-medium"}>
          Prices have changed since you added these items. The totals show the
          current price.
        </p>
      )}
    </div>
  );
}
