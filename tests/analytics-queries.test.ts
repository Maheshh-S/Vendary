import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 4.3 — analytics aggregation.
 *
 * The pure helpers run for real. Prisma is mocked at its boundary so the tests
 * can pin the aggregation math, the dense day series, the status exclusion and
 * the bounded/low-stock queries without a database.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    order: { groupBy: vi.fn() },
    product: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import {
  ANALYTICS_MAX_RANGE_DAYS,
  buildRevenueSeries,
  buildStatusBreakdown,
  defaultAnalyticsRange,
  isRevenueStatus,
  loadAnalyticsDashboard,
  LOW_STOCK_LIMIT,
  LOW_STOCK_THRESHOLD,
  normalizeTopProducts,
  ORDER_STATUSES,
  parseAnalyticsRange,
  rankLowStock,
  rankTopProducts,
  REVENUE_STATUSES,
  summarizeRevenue,
  TOP_PRODUCT_LIMIT,
  type AnalyticsRange,
  type LowStockProduct,
  type TopProduct,
} from "@/lib/analytics/queries";

const NOW = new Date("2026-06-15T10:30:00.000Z");

const rangeFor = (from: string, to: string): AnalyticsRange => {
  const parsed = parseAnalyticsRange({ from, to }, NOW);
  if (!parsed.ok) {
    throw new Error(`Expected a valid range: ${parsed.message}`);
  }
  return parsed.range;
};

const topProduct = (overrides: Partial<TopProduct> = {}): TopProduct => ({
  productId: "prod_1",
  productName: "Vase",
  quantity: 1,
  revenuePaise: 100,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.order.groupBy.mockResolvedValue([]);
  prismaMock.product.findMany.mockResolvedValue([]);
});

describe("analytics date range", () => {
  it("defaults to the last 30 UTC days including today", () => {
    const parsed = parseAnalyticsRange({}, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.range.fromDay).toBe("2026-05-17");
    expect(parsed.range.toDay).toBe("2026-06-15");
    expect(parsed.range.days).toBe(30);
    // Half-open upper bound so the last day is fully included.
    expect(parsed.range.toExclusive.toISOString()).toBe("2026-06-16T00:00:00.000Z");
  });

  it("anchors a lone end date to the 30 days ending on that day", () => {
    const parsed = parseAnalyticsRange({ to: "2026-06-01" }, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.range.fromDay).toBe("2026-05-03");
    expect(parsed.range.toDay).toBe("2026-06-01");
    expect(parsed.range.days).toBe(30);
  });

  it("accepts explicit bounds and counts inclusive days", () => {
    const range = rangeFor("2026-01-01", "2026-01-03");
    expect(range.days).toBe(3);
    expect(range.toExclusive.toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });

  it("caps the span at 365 inclusive days", () => {
    // 2026 is not a leap year: Jan 1 → Dec 31 is exactly 365 days.
    expect(parseAnalyticsRange({ from: "2026-01-01", to: "2026-12-31" }, NOW).ok).toBe(true);
    expect(ANALYTICS_MAX_RANGE_DAYS).toBe(365);

    const tooLong = parseAnalyticsRange({ from: "2026-01-01", to: "2027-01-01" }, NOW);
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.message).toMatch(/cannot exceed 365 days/);
  });

  it.each([
    ["malformed month", { from: "2026-6-01" }, /start date must be a valid/],
    ["impossible day", { from: "2026-02-31" }, /start date must be a valid/],
    ["garbage end", { to: "tomorrow" }, /end date must be a valid/],
    ["reversed bounds", { from: "2026-06-10", to: "2026-06-01" }, /on or before the end date/],
  ])("rejects a $label", (_label, params, message) => {
    const parsed = parseAnalyticsRange(params, NOW);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toMatch(message);
  });

  it("exposes the same default window through the helper", () => {
    const range = defaultAnalyticsRange(NOW);
    expect(range.fromDay).toBe("2026-05-17");
    expect(range.toDay).toBe("2026-06-15");
  });
});

describe("revenue aggregation", () => {
  it("fills missing days with zero and converts Decimal rupees to paise", () => {
    const range = rangeFor("2026-01-01", "2026-01-03");
    const series = buildRevenueSeries(
      [
        { day: "2026-01-02", revenue: "1234.50", orders: 2 },
        // Prisma Decimal-like sum object.
        { day: "2026-01-02", revenue: { toString: () => "0.50" }, orders: 1 },
      ],
      range
    );

    expect(series).toEqual([
      { day: "2026-01-01", revenuePaise: 0, orders: 0 },
      { day: "2026-01-02", revenuePaise: 123_500, orders: 3 },
      { day: "2026-01-03", revenuePaise: 0, orders: 0 },
    ]);
  });

  it("sums revenue and rounds the AOV once", () => {
    const summary = summarizeRevenue([
      { day: "2026-01-01", revenuePaise: 100_000, orders: 1 },
      { day: "2026-01-02", revenuePaise: 50_000, orders: 2 },
    ]);
    expect(summary).toEqual({
      revenuePaise: 150_000,
      orderCount: 3,
      aovPaise: 50_000,
    });

    expect(summarizeRevenue([])).toEqual({ revenuePaise: 0, orderCount: 0, aovPaise: 0 });
  });

  it("counts only confirmed/shipped/delivered as revenue statuses", () => {
    expect(REVENUE_STATUSES).toEqual(["confirmed", "shipped", "delivered"]);
    for (const status of REVENUE_STATUSES) {
      expect(isRevenueStatus(status)).toBe(true);
    }
    for (const status of ["pending", "cancelled", "refunded"] as const) {
      expect(isRevenueStatus(status)).toBe(false);
    }
  });

  it("zero-fills every order status in the breakdown", () => {
    const rows = buildStatusBreakdown([
      { status: "confirmed", orders: 2 },
      { status: "cancelled", orders: 1 },
    ]);

    expect(rows.map((row) => row.status)).toEqual([...ORDER_STATUSES]);
    expect(rows.find((row) => row.status === "confirmed")?.orders).toBe(2);
    expect(rows.find((row) => row.status === "cancelled")?.orders).toBe(1);
    expect(rows.find((row) => row.status === "refunded")?.orders).toBe(0);
  });
});

describe("top products and low stock", () => {
  it("normalizes raw aggregates and ranks both metrics", () => {
    const products = normalizeTopProducts([
      { productId: "a", productName: "A", quantity: 3, revenue: "300.00" },
      { productId: "b", productName: "B", quantity: 9, revenue: "90.00" },
      { productId: "c", productName: "C", quantity: 1, revenue: "500.00" },
    ]);
    expect(products[0]).toEqual({
      productId: "a",
      productName: "A",
      quantity: 3,
      revenuePaise: 30_000,
    });

    expect(rankTopProducts(products, "quantity", 2).map((p) => p.productId)).toEqual(["b", "a"]);
    expect(rankTopProducts(products, "revenue", 2).map((p) => p.productId)).toEqual(["c", "a"]);
  });

  it("caps product rankings at the default limit", () => {
    const products = Array.from({ length: 8 }, (_, index) =>
      topProduct({
        productId: `p_${index}`,
        productName: `Product ${index}`,
        quantity: index,
        revenuePaise: index * 100,
      })
    );
    expect(rankTopProducts(products, "quantity")).toHaveLength(TOP_PRODUCT_LIMIT);
  });

  it("keeps only in-stock products at or below the threshold, lowest first", () => {
    const products: LowStockProduct[] = [
      { id: "1", name: "Enough", stockQty: 9, thumbnail: null },
      { id: "2", name: "Five", stockQty: 5, thumbnail: null },
      { id: "3", name: "One", stockQty: 1, thumbnail: null },
      { id: "4", name: "Zero", stockQty: 0, thumbnail: null },
    ];
    const ranked = rankLowStock(products);
    expect(ranked.map((product) => product.id)).toEqual(["4", "3", "2"]);
    expect(LOW_STOCK_THRESHOLD).toBe(5);
    expect(LOW_STOCK_LIMIT).toBe(10);

    expect(rankLowStock(products, 5, 1).map((product) => product.id)).toEqual(["4"]);
  });
});

describe("loadAnalyticsDashboard", () => {
  it("runs bounded queries that exclude cancelled/refunded revenue", async () => {
    const range = rangeFor("2026-01-01", "2026-01-03");

    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        { day: "2026-01-01", revenue: "900.00", orders: 1 },
        { day: "2026-01-03", revenue: "100.00", orders: 1 },
      ])
      .mockResolvedValueOnce([
        { productId: "prod_1", productName: "Vase", quantity: 4, revenue: "800.00" },
        { productId: "prod_2", productName: "Shawl", quantity: 6, revenue: "200.00" },
      ]);
    prismaMock.order.groupBy.mockResolvedValue([
      { status: "confirmed", _count: { _all: 2 } },
      { status: "cancelled", _count: { _all: 1 } },
    ]);
    prismaMock.product.findMany.mockResolvedValue([
      { id: "prod_3", name: "Almost gone", stockQty: 2, thumbnail: null },
    ]);

    const dashboard = await loadAnalyticsDashboard(range);

    expect(dashboard.range).toEqual({ fromDay: "2026-01-01", toDay: "2026-01-03", days: 3 });
    expect(dashboard.revenue).toEqual({ revenuePaise: 100_000, orderCount: 2, aovPaise: 50_000 });
    expect(dashboard.revenueByDay.map((point) => point.revenuePaise)).toEqual([90_000, 0, 10_000]);
    expect(dashboard.ordersByStatus.find((row) => row.status === "cancelled")?.orders).toBe(1);
    expect(dashboard.topProductsByRevenue.map((p) => p.productId)).toEqual(["prod_1", "prod_2"]);
    expect(dashboard.topProductsByQuantity.map((p) => p.productId)).toEqual(["prod_2", "prod_1"]);
    expect(dashboard.lowStock.map((p) => p.id)).toEqual(["prod_3"]);

    // Two raw aggregates: daily revenue and top products.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);

    // Every raw aggregate is filtered to paid statuses only. The nested
    // Prisma.sql object serializes its bound status params, so the assertion
    // proves `cancelled`/`refunded`/`pending` never reach the revenue query.
    const rawValues = prismaMock.$queryRaw.mock.calls
      .flatMap(([, ...values]) => values)
      .map((value) => JSON.stringify(value))
      .join("|");
    expect(rawValues).toContain('"confirmed"');
    expect(rawValues).toContain('"shipped"');
    expect(rawValues).toContain('"delivered"');
    expect(rawValues).not.toContain('"cancelled"');
    expect(rawValues).not.toContain('"refunded"');
    expect(rawValues).not.toContain('"pending"');

    expect(prismaMock.order.groupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: {
        createdAt: {
          gte: range.from,
          lt: range.toExclusive,
        },
      },
      _count: { _all: true },
    });
    expect(prismaMock.product.findMany).toHaveBeenCalledWith({
      where: { availability: "IN_STOCK", stockQty: { lte: LOW_STOCK_THRESHOLD } },
      select: { id: true, name: true, stockQty: true, thumbnail: true },
      orderBy: [{ stockQty: "asc" }, { name: "asc" }],
      take: LOW_STOCK_LIMIT,
    });
  });
});
