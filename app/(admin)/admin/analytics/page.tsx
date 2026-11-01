import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import {
  ANALYTICS_MAX_RANGE_DAYS,
  defaultAnalyticsRange,
  loadAnalyticsDashboard,
  parseAnalyticsRange,
  type AnalyticsDashboard,
  type StatusBreakdownRow,
  type TopProduct,
} from "@/lib/analytics/queries";
import { formatINR } from "@/lib/format-inr";
import RevenueChart from "@/modules/admin/components/revenue-chart";

export const metadata = { title: "Analytics | Vendary" };

type SearchParams = {
  from?: string | string[];
  to?: string | string[];
};

type Props = {
  searchParams: Promise<SearchParams>;
};

/** Analytics amounts are integer paise; display is rupees. */
const rupees = (paise: number): string => formatINR(paise / 100);

const statusTone = (status: StatusBreakdownRow["status"]): string => {
  switch (status) {
    case "confirmed":
    case "shipped":
    case "delivered":
      return "text-emerald-700 dark:text-emerald-400";
    case "pending":
      return "text-amber-700 dark:text-amber-400";
    default:
      return "text-gray-500 dark:text-gray-400";
  }
};

const Kpi = ({ label, value, hint }: { label: string; value: string; hint: string }) => (
  <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
    <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {label}
    </dt>
    <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{value}</dd>
    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
  </div>
);

const TopProductTable = ({
  title,
  metric,
  products,
}: {
  title: string;
  metric: "quantity" | "revenue";
  products: TopProduct[];
}) => (
  <div>
    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
    <div className="mt-2 overflow-x-auto">
      <table className="min-w-full" data-testid={`top-products-${metric}`}>
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-800">
            <th className="py-2 pr-3 text-left text-xs font-semibold uppercase text-gray-500">
              Product
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-gray-500">
              Qty
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-gray-500">
              Gross item revenue
            </th>
          </tr>
        </thead>
        <tbody>
          {products.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-3 text-sm text-gray-500">
                No paid orders in this range
              </td>
            </tr>
          ) : (
            products.map((product) => (
              <tr key={`${product.productId ?? "deleted"}-${product.productName}`}>
                <td className="py-2 pr-3 text-sm text-gray-900 dark:text-gray-100">
                  {product.productName}
                  {product.productId ? null : (
                    <span className="ml-1 text-xs text-gray-400">(deleted)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-gray-700 dark:text-gray-300">
                  {product.quantity}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-gray-700 dark:text-gray-300">
                  {rupees(product.revenuePaise)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  </div>
);

const AnalyticsTables = ({ data }: { data: AnalyticsDashboard }) => (
  <>
    <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Orders by status · {data.range.fromDay} → {data.range.toDay}
      </h2>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {data.ordersByStatus.map((row) => (
          <li
            key={row.status}
            className="rounded-md border border-gray-100 px-3 py-2 dark:border-gray-800"
          >
            <span className={`text-xs font-medium capitalize ${statusTone(row.status)}`}>
              {row.status}
            </span>
            <p className="text-lg font-semibold tabular-nums text-gray-900 dark:text-white">
              {row.orders}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        Revenue, AOV and product rankings count only confirmed, shipped and delivered orders.
      </p>
    </section>

    <div className="mt-8 grid gap-8 lg:grid-cols-2">
      <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <TopProductTable
          title="Top products by revenue"
          metric="revenue"
          products={data.topProductsByRevenue}
        />
      </section>
      <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <TopProductTable
          title="Top products by quantity"
          metric="quantity"
          products={data.topProductsByQuantity}
        />
      </section>
    </div>
    <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
      Product money is gross item revenue (price × quantity, pre-tax, before coupon allocation). It
      is a different lens from post-tax order revenue above and the two do not reconcile.
    </p>

    <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Low stock (≤ 5 units, in stock)
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full" data-testid="low-stock-table">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className="py-2 pr-3 text-left text-xs font-semibold uppercase text-gray-500">
                Product
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-gray-500">
                Stock
              </th>
            </tr>
          </thead>
          <tbody>
            {data.lowStock.length === 0 ? (
              <tr>
                <td colSpan={2} className="py-3 text-sm text-gray-500">
                  Every in-stock product has more than 5 units.
                </td>
              </tr>
            ) : (
              data.lowStock.map((product) => (
                <tr key={product.id}>
                  <td className="py-2 pr-3 text-sm text-gray-900 dark:text-gray-100">
                    <Link
                      href={`/products/${product.id}`}
                      className="text-blue-700 hover:underline dark:text-blue-400"
                    >
                      {product.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-medium tabular-nums text-red-700 dark:text-red-400">
                    {product.stockQty}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  </>
);

export default async function AdminAnalyticsPage({ searchParams }: Props) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    redirect("/");
  }

  const params = await searchParams;
  const parsed = parseAnalyticsRange(params);
  const range = parsed.ok ? parsed.range : defaultAnalyticsRange();
  const data = await loadAnalyticsDashboard(range);

  const pendingOrders = data.ordersByStatus.find((row) => row.status === "pending")?.orders ?? 0;

  return (
    <div className="mx-auto my-8 min-h-screen max-w-7xl px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Analytics</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Revenue excludes cancelled and refunded orders. Range is capped at{" "}
            {ANALYTICS_MAX_RANGE_DAYS} days.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm font-medium">
          <Link
            href="/admin/coupons"
            className="text-blue-600 hover:text-blue-700 dark:text-blue-400"
          >
            Coupons
          </Link>
          <Link href="/admin" className="text-blue-600 hover:text-blue-700 dark:text-blue-400">
            ← Admin
          </Link>
        </div>
      </div>

      {!parsed.ok ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {parsed.message} Showing the last 30 days instead.
        </p>
      ) : null}

      <form
        method="get"
        className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800"
      >
        <label className="text-sm text-gray-700 dark:text-gray-300">
          <span className="block text-xs font-medium uppercase tracking-wide text-gray-500">
            From
          </span>
          <input
            type="date"
            name="from"
            defaultValue={range.fromDay}
            max={range.toDay}
            className="mt-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-300">
          <span className="block text-xs font-medium uppercase tracking-wide text-gray-500">
            To
          </span>
          <input
            type="date"
            name="to"
            defaultValue={range.toDay}
            className="mt-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-700 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-600"
        >
          Apply range
        </button>
        <Link
          href="/admin/analytics"
          className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          Last 30 days
        </Link>
        <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
          {data.range.days} day{data.range.days === 1 ? "" : "s"} shown
        </span>
      </form>

      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Revenue"
          value={rupees(data.revenue.revenuePaise)}
          hint="Confirmed, shipped, delivered"
        />
        <Kpi
          label="Paid orders"
          value={String(data.revenue.orderCount)}
          hint="Same statuses as revenue"
        />
        <Kpi
          label="Average order value"
          value={rupees(data.revenue.aovPaise)}
          hint="Revenue ÷ paid orders"
        />
        <Kpi
          label="Pending orders"
          value={String(pendingOrders)}
          hint="Awaiting payment or confirmation"
        />
      </dl>

      <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Daily trend
        </h2>
        <div className="mt-4">
          <RevenueChart data={data.revenueByDay} />
        </div>
      </section>

      <AnalyticsTables data={data} />
    </div>
  );
}
