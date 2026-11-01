import "server-only";

import { Prisma, type OrderStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

/**
 * Admin analytics queries (Task 4.3). All money leaves this module as integer
 * paise; Prisma `Decimal` sums are converted exactly once. Revenue means money
 * the store kept, so `cancelled` and `refunded` orders are excluded from every
 * revenue/AOV/top-product aggregate. `pending` orders were never charged.
 *
 * Top-product money is gross item revenue (`OrderItem.price * quantity`): the
 * pre-tax line value before coupon allocation. It is deliberately a different
 * lens from post-discount, GST-inclusive `Order.total` and the two do not sum
 * to each other.
 *
 * Days are UTC day buckets matching the UTC range bounds, written as a double
 * `AT TIME ZONE 'UTC'` so the rendered wall clock is UTC regardless of the
 * session `TimeZone`. The range is `[from, toExclusive)`, which lets the
 * queries use the existing `Order(status, createdAt)` index. Every list is
 * capped.
 */

export const ANALYTICS_DEFAULT_RANGE_DAYS = 30;
export const ANALYTICS_MAX_RANGE_DAYS = 365;
/** Top-product lists are derived from this many revenue-ranked groups. */
export const TOP_PRODUCT_SCAN_LIMIT = 50;
export const TOP_PRODUCT_LIMIT = 5;
export const LOW_STOCK_THRESHOLD = 5;
export const LOW_STOCK_LIMIT = 10;

/** Statuses whose totals represent collected revenue. */
export const REVENUE_STATUSES = [
  "confirmed",
  "shipped",
  "delivered",
] as const satisfies readonly OrderStatus[];

/** Every status, in the order the dashboard lists them. */
export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const satisfies readonly OrderStatus[];

export type RevenueStatus = (typeof REVENUE_STATUSES)[number];

export const isRevenueStatus = (status: OrderStatus): status is RevenueStatus =>
  (REVENUE_STATUSES as readonly OrderStatus[]).includes(status);

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type AnalyticsRange = {
  /** UTC midnight of the first day, inclusive. */
  from: Date;
  /** UTC midnight of the last day, inclusive. */
  to: Date;
  /** UTC midnight of the day after `to`; every query filter uses `< toExclusive`. */
  toExclusive: Date;
  fromDay: string;
  toDay: string;
  /** Inclusive day count. */
  days: number;
};

export type AnalyticsRangeParseResult =
  { ok: true; range: AnalyticsRange } | { ok: false; message: string };

export const toDayKey = (date: Date): string => date.toISOString().slice(0, 10);

/** Strict `YYYY-MM-DD`; calendar overflow such as 2026-02-31 is rejected. */
const parseDay = (value: string): Date | null => {
  if (!DATE_PATTERN.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || toDayKey(date) !== value) {
    return null;
  }
  return date;
};

const utcToday = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const buildRange = (from: Date, to: Date): AnalyticsRange => {
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  return {
    from,
    to,
    toExclusive: new Date(to.getTime() + DAY_MS),
    fromDay: toDayKey(from),
    toDay: toDayKey(to),
    days,
  };
};

/** Last 30 days including today, in UTC. */
export const defaultAnalyticsRange = (now: Date = new Date()): AnalyticsRange => {
  const to = utcToday(now);
  const from = new Date(to.getTime() - (ANALYTICS_DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  return buildRange(from, to);
};

const searchParamValue = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * Validates `from`/`to` search params. Missing bounds default to the last 30
 * days (only `to` supplied means the 30 days ending on that day); the span is
 * capped at 365 inclusive days so a crafted URL cannot scan the whole table.
 */
export const parseAnalyticsRange = (
  params: { from?: string | string[]; to?: string | string[] },
  now: Date = new Date()
): AnalyticsRangeParseResult => {
  const defaults = defaultAnalyticsRange(now);
  const rawFrom = searchParamValue(params.from);
  const rawTo = searchParamValue(params.to);

  const to = rawTo ? parseDay(rawTo) : defaults.to;
  if (!to) {
    return { ok: false, message: "The end date must be a valid YYYY-MM-DD date." };
  }

  const from = rawFrom
    ? parseDay(rawFrom)
    : rawTo
      ? new Date(to.getTime() - (ANALYTICS_DEFAULT_RANGE_DAYS - 1) * DAY_MS)
      : defaults.from;
  if (!from) {
    return { ok: false, message: "The start date must be a valid YYYY-MM-DD date." };
  }
  if (from.getTime() > to.getTime()) {
    return { ok: false, message: "The start date must be on or before the end date." };
  }

  const range = buildRange(from, to);
  if (range.days > ANALYTICS_MAX_RANGE_DAYS) {
    return {
      ok: false,
      message: `The date range cannot exceed ${ANALYTICS_MAX_RANGE_DAYS} days.`,
    };
  }
  return { ok: true, range };
};

export type RevenueTrendPoint = {
  /** YYYY-MM-DD (UTC). */
  day: string;
  revenuePaise: number;
  orders: number;
};

export type RawRevenueDay = {
  day: string;
  /** Prisma Decimal/string/number from `SUM(total)`. */
  revenue: unknown;
  orders: number | bigint;
};

/** Decimal/string/number rupees to integral paise; never NaN. */
const rupeesToPaise = (value: unknown): number => {
  let rupees = 0;
  if (typeof value === "number") {
    rupees = value;
  } else if (typeof value === "string") {
    rupees = Number(value);
  } else if (value !== null && value !== undefined) {
    rupees = Number(String(value));
  }
  return Number.isFinite(rupees) ? Math.round(rupees * 100) : 0;
};

const toCount = (value: number | bigint): number => {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
};

/**
 * Builds a dense series: every day in the range is present, with zeroes where
 * no paid order exists, so the chart's x-axis is stable.
 */
export function buildRevenueSeries(
  rows: readonly RawRevenueDay[],
  range: AnalyticsRange
): RevenueTrendPoint[] {
  const byDay = new Map<string, RevenueTrendPoint>();
  for (const row of rows) {
    const day = String(row.day).slice(0, 10);
    const revenuePaise = rupeesToPaise(row.revenue);
    const orders = toCount(row.orders);
    const existing = byDay.get(day);
    if (existing) {
      existing.revenuePaise += revenuePaise;
      existing.orders += orders;
    } else {
      byDay.set(day, { day, revenuePaise, orders });
    }
  }

  const series: RevenueTrendPoint[] = [];
  for (let cursor = range.from.getTime(); cursor <= range.to.getTime(); cursor += DAY_MS) {
    const day = toDayKey(new Date(cursor));
    series.push(byDay.get(day) ?? { day, revenuePaise: 0, orders: 0 });
  }
  return series;
}

export type RevenueSummary = {
  revenuePaise: number;
  orderCount: number;
  /** Integer paise; 0 when there were no paid orders. */
  aovPaise: number;
};

export function summarizeRevenue(series: readonly RevenueTrendPoint[]): RevenueSummary {
  let revenuePaise = 0;
  let orderCount = 0;
  for (const point of series) {
    revenuePaise += point.revenuePaise;
    orderCount += point.orders;
  }
  return {
    revenuePaise,
    orderCount,
    aovPaise: orderCount > 0 ? Math.round(revenuePaise / orderCount) : 0,
  };
}

export type StatusBreakdownRow = { status: OrderStatus; orders: number };

/** Includes every status, zero-filled, regardless of which ones occurred. */
export function buildStatusBreakdown(
  rows: readonly { status: OrderStatus; orders: number | bigint }[]
): StatusBreakdownRow[] {
  const counts = new Map<OrderStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + toCount(row.orders));
  }
  return ORDER_STATUSES.map((status) => ({ status, orders: counts.get(status) ?? 0 }));
}

export type TopProduct = {
  productId: string | null;
  productName: string;
  quantity: number;
  revenuePaise: number;
};

export type RawTopProduct = {
  productId: string | null;
  productName: string;
  quantity: number | bigint;
  revenue: unknown;
};

export function normalizeTopProducts(rows: readonly RawTopProduct[]): TopProduct[] {
  return rows.map((row) => ({
    productId: row.productId,
    productName: row.productName,
    quantity: toCount(row.quantity),
    revenuePaise: rupeesToPaise(row.revenue),
  }));
}

/** Stable ranking with the other metric as tie-breaker, then name. */
export function rankTopProducts(
  products: readonly TopProduct[],
  metric: "quantity" | "revenue",
  limit: number = TOP_PRODUCT_LIMIT
): TopProduct[] {
  const sorted = [...products].sort((a, b) => {
    const primary =
      metric === "quantity"
        ? b.quantity - a.quantity || b.revenuePaise - a.revenuePaise
        : b.revenuePaise - a.revenuePaise || b.quantity - a.quantity;
    return primary || a.productName.localeCompare(b.productName);
  });
  return sorted.slice(0, Math.max(0, limit));
}

export type LowStockProduct = {
  id: string;
  name: string;
  stockQty: number;
  thumbnail: string | null;
};

/** In-stock-only, lowest first, capped; the SQL query applies the same filter. */
export function rankLowStock(
  products: readonly LowStockProduct[],
  threshold: number = LOW_STOCK_THRESHOLD,
  limit: number = LOW_STOCK_LIMIT
): LowStockProduct[] {
  return products
    .filter((product) => product.stockQty <= threshold)
    .sort((a, b) => a.stockQty - b.stockQty || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}

export type AnalyticsDashboard = {
  range: { fromDay: string; toDay: string; days: number };
  revenue: RevenueSummary;
  revenueByDay: RevenueTrendPoint[];
  ordersByStatus: StatusBreakdownRow[];
  topProductsByQuantity: TopProduct[];
  topProductsByRevenue: TopProduct[];
  lowStock: LowStockProduct[];
};

/**
 * One dashboard load, four bounded queries in parallel:
 * - daily paid revenue (raw SQL aggregate, `Order(status, createdAt)` index),
 * - top product groups (join through `OrderItem.orderId`, capped scan),
 * - all-status order counts for the range,
 * - low-stock in-stock products.
 */
export const loadAnalyticsDashboard = async (
  range: AnalyticsRange
): Promise<AnalyticsDashboard> => {
  const revenueStatusFilter = Prisma.sql`o.status::text IN (${Prisma.join([...REVENUE_STATUSES])})`;

  const [dailyRows, productRows, statusRows, lowStockRows] = await Promise.all([
    prisma.$queryRaw<RawRevenueDay[]>`
      SELECT to_char(
               o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'UTC',
               'YYYY-MM-DD'
             ) AS "day",
             COALESCE(SUM(o."total"), 0) AS "revenue",
             COUNT(*)::int AS "orders"
      FROM "Order" o
      WHERE o."status"::text IN (${Prisma.join([...REVENUE_STATUSES])})
        AND o."createdAt" >= ${range.from}
        AND o."createdAt" < ${range.toExclusive}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.$queryRaw<RawTopProduct[]>`
      SELECT oi."productId" AS "productId",
             oi."productName" AS "productName",
             SUM(oi."quantity")::int AS "quantity",
             SUM(oi."price" * oi."quantity") AS "revenue"
      FROM "OrderItem" oi
      JOIN "Order" o ON o."id" = oi."orderId"
      WHERE ${revenueStatusFilter}
        AND o."createdAt" >= ${range.from}
        AND o."createdAt" < ${range.toExclusive}
      GROUP BY oi."productId", oi."productName"
      ORDER BY "revenue" DESC
      LIMIT ${TOP_PRODUCT_SCAN_LIMIT}
    `,
    prisma.order.groupBy({
      by: ["status"],
      where: { createdAt: { gte: range.from, lt: range.toExclusive } },
      _count: { _all: true },
    }),
    prisma.product.findMany({
      where: { availability: "IN_STOCK", stockQty: { lte: LOW_STOCK_THRESHOLD } },
      select: { id: true, name: true, stockQty: true, thumbnail: true },
      orderBy: [{ stockQty: "asc" }, { name: "asc" }],
      take: LOW_STOCK_LIMIT,
    }),
  ]);

  const revenueByDay = buildRevenueSeries(dailyRows, range);
  const products = normalizeTopProducts(productRows);

  return {
    range: { fromDay: range.fromDay, toDay: range.toDay, days: range.days },
    revenue: summarizeRevenue(revenueByDay),
    revenueByDay,
    ordersByStatus: buildStatusBreakdown(
      statusRows.map((row) => ({ status: row.status, orders: row._count._all }))
    ),
    topProductsByQuantity: rankTopProducts(products, "quantity"),
    topProductsByRevenue: rankTopProducts(products, "revenue"),
    lowStock: rankLowStock(lowStockRows),
  };
};
