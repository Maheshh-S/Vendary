import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4A — wishlist.
 *
 * Prisma is mocked at the boundary so the tests pin the user-scoped queries,
 * the delete-first toggle and the unique-race handling. `runAction`, `requireUser`
 * and the Zod boundary run for real.
 */

const { authMock, prismaMock, revalidateMock, rateLimitMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  prismaMock: {
    product: { findUnique: vi.fn() },
    wishlistItem: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  },
  revalidateMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  RATE_LIMITS: { wishlistToggle: { limit: 60, windowMs: 60_000 } },
}));

import { getWishlist, toggleWishlist } from "@/actions/wishlist";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import { AppError } from "@/lib/errors";

const USER_ID = "user_1";
const OTHER_USER_ID = "user_2";
const PRODUCT_ID = "prod_1";

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  }
  return result.data;
};

const expectFailure = (result: ActionResult<unknown>, code: ActionErrorCode): void => {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected the action to fail");
  }
  expect(result.code).toBe(code);
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });
  rateLimitMock.mockResolvedValue(undefined);
  revalidateMock.mockReturnValue(undefined);

  prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
  prismaMock.wishlistItem.findMany.mockResolvedValue([]);
  prismaMock.wishlistItem.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.wishlistItem.create.mockResolvedValue({ id: "wishlist_1" });
});

describe("toggleWishlist", () => {
  it("adds on the first toggle and removes on the second", async () => {
    expect(expectSuccess(await toggleWishlist(PRODUCT_ID))).toEqual({ added: true });
    expect(prismaMock.wishlistItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, productId: PRODUCT_ID },
    });
    expect(prismaMock.wishlistItem.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, productId: PRODUCT_ID },
    });

    prismaMock.wishlistItem.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(expectSuccess(await toggleWishlist(PRODUCT_ID))).toEqual({ added: false });
    // Only one create across both toggles: the second was a remove.
    expect(prismaMock.wishlistItem.create).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledWith("/wishlist");
  });

  it("treats a lost unique race as 'already added' instead of an error", async () => {
    prismaMock.wishlistItem.create.mockRejectedValueOnce({ code: "P2002" });

    expect(expectSuccess(await toggleWishlist(PRODUCT_ID))).toEqual({ added: true });
    expect(revalidateMock).toHaveBeenCalledWith("/wishlist");
  });

  it("scopes every read and write to the session user", async () => {
    expectSuccess(await toggleWishlist(PRODUCT_ID));
    expect(prismaMock.wishlistItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, productId: PRODUCT_ID },
    });

    authMock.mockResolvedValueOnce({ user: { id: OTHER_USER_ID, role: "USER" } });
    prismaMock.wishlistItem.deleteMany.mockResolvedValueOnce({ count: 1 });
    expectSuccess(await toggleWishlist(PRODUCT_ID));

    expect(prismaMock.wishlistItem.deleteMany).toHaveBeenLastCalledWith({
      where: { userId: OTHER_USER_ID, productId: PRODUCT_ID },
    });
  });

  it("rejects guests before touching the database", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(await toggleWishlist(PRODUCT_ID), "UNAUTHORIZED");
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.wishlistItem.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.wishlistItem.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown product and invalid ids", async () => {
    prismaMock.product.findUnique.mockResolvedValueOnce(null);
    expectFailure(await toggleWishlist(PRODUCT_ID), "NOT_FOUND");

    prismaMock.product.findUnique.mockClear();
    expectFailure(await toggleWishlist(""), "VALIDATION");
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
  });

  it("rate-limits the toggle and touches nothing when rejected", async () => {
    rateLimitMock.mockRejectedValueOnce(
      new AppError("RATE_LIMITED", "Too many attempts. Please try again in 60s.")
    );

    expectFailure(await toggleWishlist(PRODUCT_ID), "RATE_LIMITED");
    expect(rateLimitMock).toHaveBeenCalledWith({
      bucket: "wishlistToggle",
      subject: USER_ID,
      limit: 60,
      windowMs: 60_000,
    });
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.wishlistItem.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.wishlistItem.create).not.toHaveBeenCalled();
  });
});

describe("getWishlist", () => {
  it("returns a user-scoped product summary newest first", async () => {
    prismaMock.wishlistItem.findMany.mockResolvedValue([
      {
        id: "wishlist_1",
        createdAt: new Date("2026-06-15T10:00:00.000Z"),
        product: {
          id: PRODUCT_ID,
          name: "Vase",
          thumbnail: "https://cdn.example/vase.png",
          price: "1199.00",
          availability: "IN_STOCK",
          stockQty: 4,
        },
      },
    ]);

    const data = expectSuccess(await getWishlist());

    expect(data).toEqual([
      {
        id: "wishlist_1",
        productId: PRODUCT_ID,
        name: "Vase",
        thumbnail: "https://cdn.example/vase.png",
        price: 1199,
        availability: "IN_STOCK",
        stockQty: 4,
        addedAt: "2026-06-15T10:00:00.000Z",
      },
    ]);
    const [args] = prismaMock.wishlistItem.findMany.mock.calls[0];
    expect(args.where).toEqual({ userId: USER_ID });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("requires a session", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(await getWishlist(), "UNAUTHORIZED");
    expect(prismaMock.wishlistItem.findMany).not.toHaveBeenCalled();
  });
});
