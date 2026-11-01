/**
 * Presentational order timeline. Client-safe: no server-only imports and no
 * hooks, so it can render inside a server page today and a client component
 * after Phase 1B adds cancel/refund controls.
 */

export type OrderTimelineEvent = {
  id?: string;
  type: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  createdAt: string | Date;
};

export type OrderTimelineFallback = {
  createdAt: string | Date;
  status: string;
};

type Props = {
  events: readonly OrderTimelineEvent[];
  /** Rendered when the order predates the event trail (or has no events yet). */
  fallback: OrderTimelineFallback;
};

const EVENT_LABELS: Record<string, string> = {
  order_placed: "Order placed",
  order_created: "Order placed",
  payment_confirmed: "Payment confirmed",
  order_confirmed: "Payment confirmed",
  status_changed: "Status updated",
  order_shipped: "Order shipped",
  order_delivered: "Order delivered",
  order_cancelled: "Order cancelled",
  refund_initiated: "Refund initiated",
  refund_processed: "Refund processed",
  refund_failed: "Refund failed",
};

const humanize = (value: string): string =>
  value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());

const statusLabel = (status: string): string =>
  status.charAt(0).toUpperCase() + status.slice(1);

const formatTimestamp = (value: string | Date): string =>
  new Date(value).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

export default function OrderTimeline({ events, fallback }: Props) {
  const items =
    events.length > 0
      ? events
      : [
          {
            id: "fallback",
            type: "order_placed",
            fromStatus: null,
            toStatus: fallback.status,
            createdAt: fallback.createdAt,
          } satisfies OrderTimelineEvent,
        ];

  return (
    <ol className="space-y-4">
      {items.map((event, index) => {
        const title = EVENT_LABELS[event.type] ?? humanize(event.type);
        const isLast = index === items.length - 1;
        return (
          <li key={event.id ?? `${event.type}-${index}`} className="relative flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={
                  isLast
                    ? "mt-1 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-100 dark:ring-emerald-950"
                    : "mt-1 h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600"
                }
              />
              {!isLast && (
                <span className="mt-1 w-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
              )}
            </div>
            <div className={isLast ? "pb-0" : "pb-4"}>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {title}
                {event.toStatus && (
                  <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal capitalize text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {statusLabel(event.toStatus)}
                  </span>
                )}
              </p>
              {event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {statusLabel(event.fromStatus)} → {statusLabel(event.toStatus)}
                </p>
              )}
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {formatTimestamp(event.createdAt)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
