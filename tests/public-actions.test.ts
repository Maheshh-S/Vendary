import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Public catalog/review actions (Task 0.8). Auth, Prisma, the Redis-backed
 * rate limiter, request keys, cache and Next revalidation are mocked; the
 * schemas, `runAction`, `parseInput` and the action bodies run for real so the
 * tests pin the exact Prisma predicates, bounds and error contract.
 */

const { authMock, prismaMock, rateLimitMock, clientKeyMock, redisMock, revalidateMock } =
  vi.hoisted(() => {
    const prismaMock = {
      product: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        count: vi.fn(),
      },
      orderItem: { findFirst: vi.fn() },
      review: { create: vi.fn() },
    };

    const redisMock = {
      get: vi.fn(),
      set: vi.fn(),
      setWithTtl: vi.fn(),
      del: vi.fn(),
    };

    return {
      authMock: vi.fn(),
      prismaMock,
      rateLimitMock: vi.fn(),
      clientKeyMock: vi.fn(),
      redisMock,
      revalidateMock: vi.fn(),
    };
  });

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  // Mirrors lib/rate-limit.ts; the actions read these at call time.
  RATE_LIMITS: {
    search: { limit: 60, windowMs: 60_000 },
    addReview: { limit: 5, windowMs: 3_600_000 },
  },
}));
vi.mock("@/lib/request-key", () => ({ clientKey: clientKeyMock }));
vi.mock("@/lib/redis", () => ({ redis: redisMock, isRedisEnabled: false }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { Prisma } from "@prisma/client";

import { searchProducts } from "@/actions/products/search";
import { GetProducts } from "@/actions/products/products";
import { addReview } from "@/actions/products/reviews/add-review";
import { GetFeaturedProducts } from "@/actions/products/hot-products";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import { AppError } from "@/lib/errors";
import { CACHE_TTL_SECONDS, FEATURED_PRODUCTS_KEY } from "@/lib/product-cache";

const USER_SESSION = {
  user: { id: "user_1", role: "USER", email: "user@example.com" },
};

const PRODUCT_ID = "clx0product0000000000000000";

const REVIEW_INPUT = {
  productId: PRODUCT_ID,
  rating: 5,
  review: "A genuinely detailed review.",
};

const PRODUCT_ROW = {
  id: PRODUCT_ID,
  name: "Bidriware Vase",
  tag: "Decor",
  thumbnail: "https://images.unsplash.com/photo-vase",
  shortDescription: "A handcrafted vase",
  price: new Prisma.Decimal("1499.50"),
};

const REVIEW_ROW = {
  id: "review_1",
  productId: PRODUCT_ID,
  userId: USER_SESSION.user.id,
  rating: REVIEW_INPUT.rating,
  review: REVIEW_INPUT.review,
  verifiedPurchase: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  }
  return result.data;
};

const expectFailure = (
  result: ActionResult<unknown>,
  code: ActionErrorCode,
  message?: string
): Extract<ActionResult<unknown>, { ok: false }> => {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected the action to fail");
  }
  expect(result.code).toBe(code);
  if (message) {
    expect(result.message).toBe(message);
  }
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();

  authMock.mockResolvedValue(USER_SESSION);
  rateLimitMock.mockResolvedValue(undefined);
  clientKeyMock.mockResolvedValue("user:user_1");
  revalidateMock.mockReturnValue(undefined);

  prismaMock.product.findMany.mockResolvedValue([]);
  prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
  prismaMock.product.count.mockResolvedValue(0);
  prismaMock.orderItem.findFirst.mockResolvedValue(null);
  prismaMock.review.create.mockResolvedValue(REVIEW_ROW);

  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.setWithTtl.mockResolvedValue(undefined);
  redisMock.del.mockResolvedValue(1);
});

afterEach(() => {
  // Every expected failure is an AppError; only unexpected errors may log.
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  consoleError.mockClear();
  consoleWarn.mockClear();
});

afterAll(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe("searchProducts", () => {
  it("rate-limits, trims the term and runs one bounded, minimal query", async () => {
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: "prod_1",
        name: "Pashmina Shawl",
        thumbnail: "https://images.unsplash.com/photo-shawl",
        price: new Prisma.Decimal("1200.50"),
      },
    ]);

    const data = expectSuccess(await searchProducts("  shawl  "));

    expect(data).toEqual([
      {
        id: "prod_1",
        name: "Pashmina Shawl",
        thumbnail: "https://images.unsplash.com/photo-shawl",
        price: "1200.50",
      },
    ]);

    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock).toHaveBeenCalledWith({
      bucket: "search",
      subject: "user:user_1",
      limit: 60,
      windowMs: 60_000,
    });
    expect(clientKeyMock).toHaveBeenCalledWith("search");

    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1);
    const [args] = prismaMock.product.findMany.mock.calls[0];
    expect(args.take).toBe(10);
    expect(args.select).toEqual({
      id: true,
      name: true,
      thumbnail: true,
      price: true,
    });
    expect(args.where).toEqual({
      OR: [
        { name: { contains: "shawl", mode: "insensitive" } },
        { category: { name: { contains: "shawl", mode: "insensitive" } } },
        { description: { contains: "shawl", mode: "insensitive" } },
        { tag: { contains: "shawl", mode: "insensitive" } },
      ],
    });
  });

  it("returns RATE_LIMITED without touching the database", async () => {
    rateLimitMock.mockRejectedValueOnce(
      new AppError("RATE_LIMITED", "Too many attempts. Please try again in 30s.")
    );

    expectFailure(await searchProducts("shawl"), "RATE_LIMITED");
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty", term: "" },
    { label: "one character", term: "a" },
    { label: "whitespace only", term: "   " },
    { label: "1000 characters", term: "x".repeat(1000) },
  ])("rejects a $label query with VALIDATION before querying", async ({ term }) => {
    expectFailure(await searchProducts(term), "VALIDATION");
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
  });
});

describe("GetProducts", () => {
  it("validates, builds one where, and returns the paginated shape", async () => {
    prismaMock.product.findMany.mockResolvedValue([PRODUCT_ROW]);
    prismaMock.product.count.mockResolvedValue(49);

    const data = expectSuccess(
      await GetProducts({
        page: 2,
        pageSize: 24,
        category: "  Pottery  ",
        sort: "price_asc",
      })
    );

    expect(data).toEqual({
      items: [
        {
          id: PRODUCT_ID,
          name: "Bidriware Vase",
          tag: "Decor",
          imageSrc: "https://images.unsplash.com/photo-vase",
          price: 1499.5,
          imageAlt: "A handcrafted vase",
        },
      ],
      total: 49,
      page: 2,
      pageSize: 24,
      totalPages: 3,
    });

    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.product.count).toHaveBeenCalledTimes(1);

    const [findArgs] = prismaMock.product.findMany.mock.calls[0];
    const [countArgs] = prismaMock.product.count.mock.calls[0];

    const expectedWhere = {
      availability: "IN_STOCK",
      category: { name: { equals: "Pottery", mode: "insensitive" } },
    };
    expect(findArgs.where).toEqual(expectedWhere);
    expect(countArgs.where).toEqual(expectedWhere);
    expect(findArgs.skip).toBe(24);
    expect(findArgs.take).toBe(24);
    expect(findArgs.orderBy).toEqual({ price: "asc" });
  });

  it("defaults to page 1, 24 per page and newest-first without a category filter", async () => {
    prismaMock.product.count.mockResolvedValue(0);

    const data = expectSuccess(await GetProducts({}));

    expect(data).toEqual({ items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 });

    const [findArgs] = prismaMock.product.findMany.mock.calls[0];
    expect(findArgs.where).toEqual({ availability: "IN_STOCK" });
    expect(findArgs.skip).toBe(0);
    expect(findArgs.take).toBe(24);
    expect(findArgs.orderBy).toEqual({ createdAt: "desc" });
  });

  it("coerces URL strings and computes skip from the page", async () => {
    prismaMock.product.count.mockResolvedValue(25);

    const data = expectSuccess(
      await GetProducts({ page: "3", pageSize: "10", sort: "name_asc" })
    );

    expect(data.page).toBe(3);
    expect(data.pageSize).toBe(10);
    expect(data.totalPages).toBe(3);

    const [findArgs] = prismaMock.product.findMany.mock.calls[0];
    expect(findArgs.skip).toBe(20);
    expect(findArgs.take).toBe(10);
    expect(findArgs.orderBy).toEqual({ name: "asc" });
  });

  it.each([
    ["newest", { createdAt: "desc" }],
    ["price_asc", { price: "asc" }],
    ["price_desc", { price: "desc" }],
    ["name_asc", { name: "asc" }],
  ])("maps sort %s to the expected orderBy", async (sort, orderBy) => {
    expectSuccess(await GetProducts({ sort }));
    const [findArgs] = prismaMock.product.findMany.mock.calls[0];
    expect(findArgs.orderBy).toEqual(orderBy);
  });

  it.each([
    { label: "zero page", input: { page: 0 } },
    { label: "fractional page", input: { page: 1.5 } },
    { label: "oversized pageSize", input: { pageSize: 49 } },
    { label: "zero pageSize", input: { pageSize: 0 } },
    { label: "unknown sort", input: { sort: "cheapest" } },
    { label: "oversized category", input: { category: "c".repeat(61) } },
  ])("rejects $label with VALIDATION before querying", async ({ input }) => {
    expectFailure(await GetProducts(input), "VALIDATION");
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
    expect(prismaMock.product.count).not.toHaveBeenCalled();
  });
});

describe("addReview", () => {
  it("rejects unauthenticated callers before parsing, limiting or querying", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(await addReview(REVIEW_INPUT), "UNAUTHORIZED");
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(clientKeyMock).not.toHaveBeenCalled();
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.orderItem.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.review.create).not.toHaveBeenCalled();
  });

  it.each([
    { label: "fractional rating", input: { ...REVIEW_INPUT, rating: 4.5 } },
    { label: "short review", input: { ...REVIEW_INPUT, review: "too short" } },
    { label: "empty product id", input: { ...REVIEW_INPUT, productId: "" } },
  ])("rejects a $label with VALIDATION before rate limiting", async ({ input }) => {
    expectFailure(await addReview(input), "VALIDATION");
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
  });

  it("returns RATE_LIMITED after five reviews per hour for the user", async () => {
    rateLimitMock.mockRejectedValueOnce(
      new AppError("RATE_LIMITED", "Too many attempts. Please try again in 3600s.")
    );

    expectFailure(await addReview(REVIEW_INPUT), "RATE_LIMITED");
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the product does not exist", async () => {
    prismaMock.product.findUnique.mockResolvedValue(null);

    expectFailure(await addReview(REVIEW_INPUT), "NOT_FOUND", "Product not found.");
    expect(prismaMock.product.findUnique).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      select: { id: true },
    });
    expect(prismaMock.orderItem.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.review.create).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("marks the review verified when the user has an eligible order item", async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ id: "order_item_1" });
    prismaMock.review.create.mockResolvedValue({ ...REVIEW_ROW, verifiedPurchase: true });

    const data = expectSuccess(
      await addReview({ ...REVIEW_INPUT, review: `  ${REVIEW_INPUT.review}  ` })
    );

    expect(data).toEqual({ ...REVIEW_ROW, verifiedPurchase: true });
    expect(rateLimitMock).toHaveBeenCalledWith({
      bucket: "addReview",
      subject: "user:user_1",
      limit: 5,
      windowMs: 3_600_000,
    });
    expect(clientKeyMock).toHaveBeenCalledWith("addReview", USER_SESSION.user.id);

    expect(prismaMock.orderItem.findFirst).toHaveBeenCalledWith({
      where: {
        productId: PRODUCT_ID,
        order: {
          userId: USER_SESSION.user.id,
          status: { in: ["confirmed", "shipped", "delivered"] },
        },
      },
      select: { id: true },
    });

    expect(prismaMock.review.create).toHaveBeenCalledWith({
      data: {
        rating: REVIEW_INPUT.rating,
        review: REVIEW_INPUT.review,
        productId: PRODUCT_ID,
        userId: USER_SESSION.user.id,
        verifiedPurchase: true,
      },
    });
    expect(revalidateMock).toHaveBeenCalledWith(`/products/${PRODUCT_ID}`);
  });

  it("stores verifiedPurchase false when no eligible purchase exists", async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue(null);

    expectSuccess(await addReview(REVIEW_INPUT));

    const [createArgs] = prismaMock.review.create.mock.calls[0];
    expect(createArgs.data.verifiedPurchase).toBe(false);
  });

  it("maps a unique-constraint violation to CONFLICT", async () => {
    prismaMock.review.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "productId"] },
      })
    );

    expectFailure(
      await addReview(REVIEW_INPUT),
      "CONFLICT",
      "You already reviewed this product."
    );
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("GetFeaturedProducts", () => {
  it("only selects in-stock featured products and caches under the v3 key", async () => {
    prismaMock.product.findMany.mockResolvedValue([PRODUCT_ROW]);

    const data = await GetFeaturedProducts({ take: 4, skip: 0 });

    expect(data).toEqual([
      {
        id: PRODUCT_ID,
        name: "Bidriware Vase",
        tag: "Decor",
        imageSrc: "https://images.unsplash.com/photo-vase",
        price: 1499.5,
        imageAlt: "A handcrafted vase",
      },
    ]);

    const [findArgs] = prismaMock.product.findMany.mock.calls[0];
    expect(findArgs.where).toEqual({ availability: "IN_STOCK", isFeatured: true });
    expect(findArgs.take).toBe(4);
    expect(findArgs.skip).toBe(0);

    expect(FEATURED_PRODUCTS_KEY).toBe("featured-products:v3");
    expect(redisMock.setWithTtl).toHaveBeenCalledWith(
      FEATURED_PRODUCTS_KEY,
      JSON.stringify(data),
      CACHE_TTL_SECONDS.featured
    );
  });

  it.each([
    [10000, 12],
    [13, 12],
    [12, 12],
    [0, 1],
    [-5, 1],
    [4, 4],
  ])("clamps take %j to %i", async (take, expected) => {
    await GetFeaturedProducts({ take, skip: 0 });
    const [findArgs] = prismaMock.product.findMany.mock.calls[0];
    expect(findArgs.take).toBe(expected);
  });

  it.each([
    ["10000", 12],
    ["not-a-number", 4],
    [null, 4],
  ])("coerces take %j to %i", async (take, expected) => {
    await GetFeaturedProducts({ take: take as unknown as number, skip: 0 });
    const [findArgs] = prismaMock.product.findMany.mock.calls[0];
    expect(findArgs.take).toBe(expected);
  });

  it("serves the cached list without querying the database", async () => {
    const cached = [
      {
        id: "cached_1",
        name: "Cached Product",
        tag: null,
        imageSrc: null,
        price: 10,
        imageAlt: null,
      },
    ];
    redisMock.get.mockResolvedValue(JSON.stringify(cached));

    await expect(GetFeaturedProducts({ take: 4, skip: 0 })).resolves.toEqual(cached);
    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
  });
});
