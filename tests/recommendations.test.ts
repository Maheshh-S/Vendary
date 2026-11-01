import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 4.5 — "Customers also bought".
 *
 * The ranking helper runs for real; Prisma and Redis are mocked at their
 * boundaries so the tests pin the co-occurrence query, the exclusion/in-stock
 * rules, the cold-start fallback, the per-product cache and its invalidation.
 */

const { prismaMock, redisMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    product: { findMany: vi.fn() },
  },
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    setWithTtl: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/redis", () => ({ redis: redisMock }));

import { CACHE_TTL_SECONDS, invalidateProductCache, recommendationsKey } from "@/lib/product-cache";
import {
  getAlsoBought,
  rankCoPurchases,
  RECOMMENDATION_LIMIT,
  RECOMMENDATION_SCAN_LIMIT,
  type RawCoPurchaseRow,
} from "@/lib/recommendations";

const PRODUCT_ID = "clx0product0000000000000000";

const coPurchaseRow = (overrides: Partial<RawCoPurchaseRow> = {}): RawCoPurchaseRow => ({
  productId: "prod_1",
  name: "Bidriware Vase",
  thumbnail: "https://images.unsplash.com/photo-vase",
  shortDescription: "A handcrafted vase",
  price: "1499.50",
  coPurchases: 1,
  ...overrides,
});

const fallbackRow = (overrides: Record<string, unknown> = {}) => ({
  id: "fallback_1",
  name: "Madhubani Painting",
  thumbnail: "https://images.unsplash.com/photo-painting",
  shortDescription: "Folk art",
  price: "899.00",
  ...overrides,
});

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

/** Structured log events emitted on the error channel (the logger's sink). */
const loggedEvents = (): string[] =>
  consoleError.mock.calls.flatMap((call) => {
    try {
      const parsed = JSON.parse(String(call[0])) as { event?: unknown };
      return typeof parsed.event === "string" ? [parsed.event] : [];
    } catch {
      return [];
    }
  });

const loggedText = (): string => consoleError.mock.calls.flat().join(" ");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.product.findMany.mockResolvedValue([]);
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.setWithTtl.mockResolvedValue("OK");
  redisMock.del.mockResolvedValue(1);
  consoleError.mockClear();
});

describe("rankCoPurchases", () => {
  it("ranks by shared orders, then product id, and excludes the current product", () => {
    const ranked = rankCoPurchases(
      [
        coPurchaseRow({ productId: "b", coPurchases: 5 }),
        coPurchaseRow({ productId: "a", coPurchases: 5 }),
        coPurchaseRow({ productId: "d", coPurchases: 5 }),
        coPurchaseRow({ productId: "c", coPurchases: 2 }),
        coPurchaseRow({ productId: PRODUCT_ID, coPurchases: 99 }),
      ],
      PRODUCT_ID
    );

    expect(ranked.map((row) => row.productId)).toEqual(["a", "b", "d", "c"]);
    expect(ranked.some((row) => row.productId === PRODUCT_ID)).toBe(false);
  });

  it("accepts bigint counts and caps the list at the recommendation limit", () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      coPurchaseRow({
        productId: `prod_${index}`,
        coPurchases: BigInt(6 - index),
      })
    );

    const ranked = rankCoPurchases(rows, PRODUCT_ID);
    expect(ranked).toHaveLength(RECOMMENDATION_LIMIT);
    expect(ranked.map((row) => row.productId)).toEqual(["prod_0", "prod_1", "prod_2", "prod_3"]);
  });
});

describe("getAlsoBought", () => {
  it("queries paid orders, in-stock products and a bounded scan", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      coPurchaseRow({ productId: "prod_1", coPurchases: 3 }),
    ]);

    const cards = await getAlsoBought(PRODUCT_ID);

    expect(cards).toEqual([
      {
        id: "prod_1",
        name: "Bidriware Vase",
        imageSrc: "https://images.unsplash.com/photo-vase",
        price: 1499.5,
        imageAlt: "A handcrafted vase",
      },
    ]);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();

    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    // Exclusion and in-stock filtering stay in SQL; the scan is bounded.
    expect(sql).toContain('oi_other."productId" <> oi_self."productId"');
    expect(sql).toContain(`p."availability"::text = 'IN_STOCK'`);
    expect(sql).toContain("COUNT(DISTINCT");
    expect(sql).toContain("LIMIT");
    expect(values).toContain(PRODUCT_ID);
    expect(values).toContain(RECOMMENDATION_SCAN_LIMIT);

    const serialized = JSON.stringify(values);
    expect(serialized).toContain('"confirmed"');
    expect(serialized).toContain('"shipped"');
    expect(serialized).toContain('"delivered"');
    expect(serialized).not.toContain('"pending"');
    expect(serialized).not.toContain('"cancelled"');
    expect(serialized).not.toContain('"refunded"');
  });

  it("caches each product with the recommendation TTL", async () => {
    prismaMock.$queryRaw.mockResolvedValue([coPurchaseRow({ coPurchases: 2 })]);

    await getAlsoBought(PRODUCT_ID);

    expect(redisMock.setWithTtl).toHaveBeenCalledWith(
      recommendationsKey(PRODUCT_ID),
      expect.any(String),
      CACHE_TTL_SECONDS.recommendations
    );
    expect(CACHE_TTL_SECONDS.recommendations).toBe(600);
    expect(recommendationsKey("p1")).toBe("recommendations:p1:v1");
  });

  it("serves a cached list without touching the database", async () => {
    const cached = [
      {
        id: "cached_1",
        name: "Cached Product",
        imageSrc: null,
        price: 10,
        imageAlt: null,
      },
    ];
    redisMock.get.mockResolvedValue(JSON.stringify(cached));

    await expect(getAlsoBought(PRODUCT_ID)).resolves.toEqual(cached);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
  });

  it("falls back to featured/in-stock products when there are no co-purchases", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.product.findMany.mockResolvedValue([fallbackRow()]);

    const cards = await getAlsoBought(PRODUCT_ID);

    expect(cards).toEqual([
      {
        id: "fallback_1",
        name: "Madhubani Painting",
        imageSrc: "https://images.unsplash.com/photo-painting",
        price: 899,
        imageAlt: "Folk art",
      },
    ]);
    expect(prismaMock.product.findMany).toHaveBeenCalledWith({
      where: { availability: "IN_STOCK", id: { not: PRODUCT_ID } },
      orderBy: [{ isFeatured: "desc" }, { createdAt: "desc" }],
      take: RECOMMENDATION_LIMIT,
      select: {
        id: true,
        name: true,
        thumbnail: true,
        shortDescription: true,
        price: true,
      },
    });
    // The fallback list is cached too.
    expect(redisMock.setWithTtl).toHaveBeenCalledWith(
      recommendationsKey(PRODUCT_ID),
      expect.any(String),
      CACHE_TTL_SECONDS.recommendations
    );
  });

  it("falls back when the co-occurrence query only returns the current product", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      coPurchaseRow({ productId: PRODUCT_ID, coPurchases: 4 }),
    ]);
    prismaMock.product.findMany.mockResolvedValue([fallbackRow()]);

    const cards = await getAlsoBought(PRODUCT_ID);
    expect(cards.map((card) => card.id)).toEqual(["fallback_1"]);
  });

  it("returns an empty list when the cold-start fallback is empty", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.product.findMany.mockResolvedValue([]);

    await expect(getAlsoBought(PRODUCT_ID)).resolves.toEqual([]);
  });

  it("survives a cache read outage by querying the database", async () => {
    redisMock.get.mockRejectedValue(new Error("redis down"));
    prismaMock.$queryRaw.mockResolvedValue([coPurchaseRow()]);

    const cards = await getAlsoBought(PRODUCT_ID);

    expect(cards.map((card) => card.id)).toEqual(["prod_1"]);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(redisMock.setWithTtl).toHaveBeenCalledTimes(1);
    // Fixed reason code only — the raw cache error/host never reaches the log.
    expect(loggedEvents()).toContain("recommendations_cache_read_failed");
    expect(loggedText()).not.toContain("redis down");
  });

  it("survives a cache write outage and still returns the fresh list", async () => {
    redisMock.setWithTtl.mockRejectedValue(new Error("redis down"));
    prismaMock.$queryRaw.mockResolvedValue([coPurchaseRow()]);

    await expect(getAlsoBought(PRODUCT_ID)).resolves.toHaveLength(1);
    expect(loggedEvents()).toContain("recommendations_cache_write_failed");
    expect(loggedText()).not.toContain("redis down");
  });

  it("falls back when the co-occurrence query fails", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("similarity unavailable"));
    prismaMock.product.findMany.mockResolvedValue([fallbackRow()]);

    const cards = await getAlsoBought(PRODUCT_ID);
    expect(cards.map((card) => card.id)).toEqual(["fallback_1"]);
    expect(loggedEvents()).toContain("recommendations_query_failed");
    // Only the reason code is logged; SQL/host text from the error is dropped.
    expect(loggedText()).not.toContain("similarity unavailable");
  });

  it("hides recommendations when both the query and the fallback fail", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("db down"));
    prismaMock.product.findMany.mockRejectedValue(new Error("db down"));

    await expect(getAlsoBought(PRODUCT_ID)).resolves.toEqual([]);
    expect(redisMock.setWithTtl).not.toHaveBeenCalled();
    expect(loggedEvents()).toEqual([
      "recommendations_query_failed",
      "recommendations_fallback_failed",
    ]);
    expect(loggedText()).not.toContain("db down");
  });

  it("rejects an empty or oversized product id before any I/O", async () => {
    await expect(getAlsoBought("   ")).resolves.toEqual([]);
    await expect(getAlsoBought("p".repeat(65))).resolves.toEqual([]);
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("recommendation cache invalidation", () => {
  it("drops the recommendation key along with the other product views", async () => {
    await invalidateProductCache("prod_1");

    expect(redisMock.del).toHaveBeenCalledWith(recommendationsKey("prod_1"));
  });

  it("drops only the featured list when no product id is supplied", async () => {
    await invalidateProductCache();

    expect(redisMock.del).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith("featured-products:v3");
  });
});
