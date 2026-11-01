import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { formatINR } from "@/lib/format-inr";
import { isAllowedImageUrl } from "@/lib/images";
import { ORDER_EMAIL_EVENT_TYPE } from "@/lib/orders/events";
import { refundReasonLabel } from "@/lib/orders/refund-labels";
import CancelOrderButton from "@/modules/orders/components/cancel-order-button";
import OrderTimeline from "@/modules/orders/components/order-timeline";

type Props = {
  params: Promise<{ id: string }>;
};

const formatCurrencyPaise = (paise: number): string => formatINR(paise / 100);

const formatTimestamp = (value: Date | string): string =>
  new Date(value).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

/**
 * Shows only the last four characters of a payment id; the full reference is
 * intentionally absent from the page (support looks it up server-side).
 */
const maskPaymentId = (paymentId: string): string | null => {
  if (!paymentId) return null;
  if (paymentId.length <= 8) return "••••••";
  return `${paymentId.slice(0, 5)}…${paymentId.slice(-4)}`;
};

const statusPillClass = (status: string): string => {
  switch (status) {
    case "confirmed":
    case "delivered":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
    case "shipped":
      return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
    case "cancelled":
    case "refunded":
      return "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    default:
      return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  }
};

export default async function OrderDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await requireUser();

  // Ownership is part of the query: a foreign id is indistinguishable from a
  // missing one, so both end in notFound() (no enumeration signal).
  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
    include: {
      items: true,
      address: true,
      // `id` breaks same-millisecond ties: one finalize transaction can write
      // several events at the same instant, and the timeline must be stable.
      // Email delivery markers are internal idempotency keys, not customer
      // events, so they are excluded from the timeline.
      events: {
        where: { type: { not: ORDER_EMAIL_EVENT_TYPE } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      refunds: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!order) {
    notFound();
  }

  const subtotalPaise = order.items.reduce(
    (total, item) => total + Math.round(Number(item.price) * 100) * item.quantity,
    0
  );
  // Stored rupee Decimals are the charged amount; render from paise so the
  // customer sees exactly what was charged.
  const taxPaise = Math.round(Number(order.taxAmount) * 100);
  const totalPaise = Math.round(Number(order.total) * 100);
  const maskedPaymentId = maskPaymentId(order.paymentId);
  const address =
    order.address?.firstName || order.address?.address ? order.address : null;

  return (
    <div className="mx-auto my-8 min-h-screen max-w-4xl px-4 sm:px-6 lg:px-8">
      <Link
        href="/my-orders"
        className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
      >
        ← Back to orders
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
            Order #{String(order.id).slice(0, 8)}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Placed {formatTimestamp(order.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/my-orders/${order.id}/invoice`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
          >
            Invoice
          </Link>
          <CancelOrderButton orderId={order.id} status={order.status} />
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium capitalize ${statusPillClass(order.status)}`}
          >
            {order.status}
          </span>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Items
          </h2>
          <ul className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {order.items.map((item) => {
              const unitPaise = Math.round(Number(item.price) * 100);
              // Snapshot URLs can outlive the allowlist; never hand next/image
              // a host it cannot render.
              const imageSrc =
                item.productImage && isAllowedImageUrl(item.productImage)
                  ? item.productImage
                  : null;
              return (
                <li key={item.id} className="flex items-center gap-4 p-4">
                  {imageSrc ? (
                    <Image
                      src={imageSrc}
                      alt={item.productName}
                      width={64}
                      height={64}
                      className="h-16 w-16 rounded-md object-cover"
                    />
                  ) : (
                    <div className="h-16 w-16 rounded-md bg-gray-100 dark:bg-gray-800" />
                  )}
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {item.productName}
                    </p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {formatCurrencyPaise(unitPaise)} × {item.quantity}
                    </p>
                  </div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {formatCurrencyPaise(unitPaise * item.quantity)}
                  </p>
                </li>
              );
            })}
          </ul>

          <dl className="mt-4 space-y-2 rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-800">
            <div className="flex justify-between">
              <dt className="text-gray-600 dark:text-gray-400">Subtotal</dt>
              <dd className="text-gray-900 dark:text-white">
                {formatCurrencyPaise(subtotalPaise)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-600 dark:text-gray-400">Tax (GST)</dt>
              <dd className="text-gray-900 dark:text-white">
                {formatCurrencyPaise(taxPaise)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-gray-200 pt-2 text-base font-semibold dark:border-gray-800">
              <dt className="text-gray-900 dark:text-white">Total</dt>
              <dd className="text-gray-900 dark:text-white">
                {formatCurrencyPaise(totalPaise)}
              </dd>
            </div>
          </dl>
        </section>

        <aside className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Delivery address
            </h2>
            {address ? (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                {address.firstName} {address.lastName}
                <br />
                {address.address}
                <br />
                {address.area}, {address.landmark}
                <br />
                {address.state} {address.postalCode}
                <br />
                {address.country}
                <br />
                {address.phone}
              </p>
            ) : (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                No address on file.
              </p>
            )}
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Payment
            </h2>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {order.paymentMethod}
            </p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {maskedPaymentId
                ? `Payment ${maskedPaymentId}`
                : "Payment not captured yet."}
            </p>
          </section>

          {order.refunds.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Refunds
              </h2>
              <ul className="mt-2 space-y-2">
                {order.refunds.map((refund) => (
                  <li
                    key={refund.id}
                    className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800"
                  >
                    <div className="flex justify-between">
                      <span className="font-medium text-gray-900 dark:text-white">
                        {formatINR(Number(refund.amount))}
                      </span>
                      <span className="capitalize text-gray-500 dark:text-gray-400">
                        {refund.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {refundReasonLabel(refund.reason)} · {formatTimestamp(refund.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Timeline
            </h2>
            <div className="mt-3">
              <OrderTimeline
                events={order.events}
                fallback={{ createdAt: order.createdAt, status: order.status }}
              />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
