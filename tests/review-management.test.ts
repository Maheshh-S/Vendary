import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reviewed-purchase trust signals and own-review management (Task 2.4).
 * Auth, Prisma, rate limiting, request keys and revalidation are mocked; the
 * schemas and action bodies run for real. The aggregate summary is exercised
 * against a mocked Prisma so the whole-table query is pinned.
 */

const { authMock, prismaMock, rateLimitMock, clientKeyMock, revalidateMock } = vi.hoisted(() => {
  const prismaMock = {
    product: { findUnique: vi.fn() },
    orderItem: { findFirst: vi.fn() },
    review: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
  };
  return {
    authMock: vi.fn(),
    prismaMock,
    rateLimitMock: vi.fn(),
    clientKeyMock: vi.fn(),
    revalidateMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  RATE_LIMITS: { addReview: { limit: 5, windowMs: 3_600_000 } },
}));
vi.mock("@/lib/request-key", () => ({ clientKey: clientKeyMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { addReview } from "@/actions/products/reviews/add-review";
import { deleteReview, updateReview } from "@/actions/products/reviews/manage-review";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import { getRatingSummary } from "@/lib/reviews/summary";

const USER_ID = "user_1";
const OTHER_ID = "user_2";
const PRODUCT_ID = "clx0product0000000000000000";
const REVIEW_ID = "review_1";

const REVIEW_ROW = {
  id: REVIEW_ID,
  productId: PRODUCT_ID,
  userId: USER_ID,
  rating: 5,
  review: "A genuinely detailed review.",
  verifiedPurchase: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  return result.data;
};

const expectFailure = (
  result: ActionResult<unknown>,
  code: ActionErrorCode,
  message?: string
): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  if (message) expect(result.message).toBe(message);
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });
  clientKeyMock.mockResolvedValue(`user:${USER_ID}`);
  rateLimitMock.mockResolvedValue(undefined);
  revalidateMock.mockReturnValue(undefined);

  prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
  prismaMock.orderItem.findFirst.mockResolvedValue(null);
  prismaMock.review.create.mockResolvedValue(REVIEW_ROW);
  prismaMock.review.findFirst.mockResolvedValue({
    id: REVIEW_ID,
    productId: PRODUCT_ID,
  });
  prismaMock.review.update.mockResolvedValue({ ...REVIEW_ROW, rating: 4 });
  prismaMock.review.deleteMany.mockResolvedValue({ count: 1 });
});

describe("addReview verified purchase", () => {
  it("flags the review when an eligible order item exists", async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ id: "order_item_1" });

    expectSuccess(await addReview({ productId: PRODUCT_ID, rating: 5, review: REVIEW_ROW.review }));

    expect(prismaMock.review.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ verifiedPurchase: true, userId: USER_ID }),
    });
  });

  it("does not flag a review without a purchase", async () => {
    expectSuccess(await addReview({ productId: PRODUCT_ID, rating: 5, review: REVIEW_ROW.review }));

    expect(prismaMock.review.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ verifiedPurchase: false }),
    });
  });

  it("maps the one-per-user/product unique violation to CONFLICT", async () => {
    prismaMock.review.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "productId"] },
      })
    );

    expectFailure(
      await addReview({ productId: PRODUCT_ID, rating: 5, review: REVIEW_ROW.review }),
      "CONFLICT",
      "You already reviewed this product."
    );
  });
});

describe("updateReview ownership", () => {
  it("updates the caller's own review and revalidates its product page", async () => {
    const data = expectSuccess(
      await updateReview({ id: REVIEW_ID, rating: 4, review: "  Updated and detailed.  " })
    );

    expect(prismaMock.review.findFirst).toHaveBeenCalledWith({
      where: { id: REVIEW_ID, userId: USER_ID },
      select: { id: true, productId: true },
    });
    expect(prismaMock.review.update).toHaveBeenCalledWith({
      where: { id: REVIEW_ID },
      data: { rating: 4, review: "Updated and detailed." },
    });
    expect(revalidateMock).toHaveBeenCalledWith(`/products/${PRODUCT_ID}`);
    expect(data).toMatchObject({ id: REVIEW_ID });
  });

  it("returns NOT_FOUND for another user's or a missing review", async () => {
    prismaMock.review.findFirst.mockResolvedValue(null);

    expectFailure(
      await updateReview({ id: REVIEW_ID, rating: 3, review: "Trying to edit a foreign row." }),
      "NOT_FOUND",
      "Review not found."
    );
    expect(prismaMock.review.update).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers and invalid bodies before querying", async () => {
    authMock.mockResolvedValue(null);
    expectFailure(
      await updateReview({ id: REVIEW_ID, rating: 3, review: "A sufficiently long review." }),
      "UNAUTHORIZED"
    );
    expect(prismaMock.review.findFirst).not.toHaveBeenCalled();

    authMock.mockResolvedValue({ user: { id: OTHER_ID, role: "USER" } });
    expectFailure(
      await updateReview({ id: REVIEW_ID, rating: 9, review: "short" }),
      "VALIDATION"
    );
    expect(prismaMock.review.findFirst).not.toHaveBeenCalled();
  });
});

describe("deleteReview ownership", () => {
  it("deletes the caller's own review with the id+user predicate", async () => {
    const result = await deleteReview(REVIEW_ID);

    expect(expectSuccess(result)).toEqual({ id: REVIEW_ID });
    expect(prismaMock.review.deleteMany).toHaveBeenCalledWith({
      where: { id: REVIEW_ID, userId: USER_ID },
    });
    expect(revalidateMock).toHaveBeenCalledWith(`/products/${PRODUCT_ID}`);
  });

  it("returns a typed NOT_FOUND without deleting for a foreign review", async () => {
    prismaMock.review.findFirst.mockResolvedValue(null);

    const result = await deleteReview(REVIEW_ID);

    expectFailure(result, "NOT_FOUND", "Review not found.");
    expect(prismaMock.review.deleteMany).not.toHaveBeenCalled();
  });

  it("treats a lost delete race as NOT_FOUND", async () => {
    prismaMock.review.deleteMany.mockResolvedValue({ count: 0 });

    expectFailure(await deleteReview(REVIEW_ID), "NOT_FOUND", "Review not found.");
  });
});

describe("getRatingSummary", () => {
  it("uses aggregate and groupBy over every review", async () => {
    prismaMock.review.aggregate.mockResolvedValue({
      _avg: { rating: 4.25 },
      _count: { _all: 8 },
    });
    prismaMock.review.groupBy.mockResolvedValue([
      { rating: 2, _count: { _all: 1 } },
      { rating: 3, _count: { _all: 2 } },
      { rating: 5, _count: { _all: 5 } },
    ]);

    const summary = await getRatingSummary(PRODUCT_ID);

    expect(summary).toEqual({
      average: 4.25,
      count: 8,
      counts: [0, 1, 2, 0, 5],
    });
    expect(prismaMock.review.aggregate).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID },
      _avg: { rating: true },
      _count: { _all: true },
    });
    expect(prismaMock.review.groupBy).toHaveBeenCalledWith({
      by: ["rating"],
      where: { productId: PRODUCT_ID },
      _count: { _all: true },
    });
  });

  it("returns a zero summary for a product without reviews", async () => {
    prismaMock.review.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { _all: 0 },
    });
    prismaMock.review.groupBy.mockResolvedValue([]);

    expect(await getRatingSummary(PRODUCT_ID)).toEqual({
      average: 0,
      count: 0,
      counts: [0, 0, 0, 0, 0],
    });
  });
});
