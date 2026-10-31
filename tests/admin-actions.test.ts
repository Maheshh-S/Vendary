import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the admin mutation boundary. Auth, Prisma, Redis-backed cache
 * invalidation and Next's revalidation are mocked; the schemas, guards,
 * `runAction` and `parseInput` run for real so the tests cover the actual
 * authorization/validation order and the exact Prisma calls.
 */

const { authMock, prismaMock, invalidateMock, revalidateMock } = vi.hoisted(() => {
  const prismaMock = {
    product: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
    category: { findUnique: vi.fn() },
    image: { createMany: vi.fn() },
  };

  return {
    authMock: vi.fn(),
    prismaMock,
    invalidateMock: vi.fn(),
    revalidateMock: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/product-cache", () => ({ invalidateProductCache: invalidateMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { editLongDescription, editShortDescription } from "@/actions/(admin)/edit/description";
import { editPrice } from "@/actions/(admin)/edit/price";
import { addImagesToProduct } from "@/actions/(admin)/product/add-image";
import { createProduct } from "@/actions/(admin)/product/create-product";
import { deleteProduct } from "@/actions/(admin)/product/delete-product";
import { takeProductOffline } from "@/actions/(admin)/product/take-product-offline";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import type { ProductFormValues } from "@/schemas/admin/products/create-product-schema";

const ADMIN_SESSION = {
  user: { id: "admin_1", role: "ADMIN", email: "admin@example.com" },
};
const USER_SESSION = {
  user: { id: "user_1", role: "USER", email: "user@example.com" },
};

const PRODUCT_ID = "clx0product0000000000000000";
const ALLOWED_URL = "https://images.unsplash.com/photo-1";

const FORM_VALUES: ProductFormValues = {
  name: "Wireless Mouse",
  description: "A reliable wireless mouse for daily use.",
  price: "1234.50",
  stock: "12",
  shippingTime: "1-5 business days",
  categoryId: "clx0category000000000000000",
  shortDescription: "",
  tag: "",
  thumbnail: "",
};

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

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

const expectNoDatabaseAccess = () => {
  expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
  expect(prismaMock.product.create).not.toHaveBeenCalled();
  expect(prismaMock.product.updateMany).not.toHaveBeenCalled();
  expect(prismaMock.product.deleteMany).not.toHaveBeenCalled();
  expect(prismaMock.product.delete).not.toHaveBeenCalled();
  expect(prismaMock.category.findUnique).not.toHaveBeenCalled();
  expect(prismaMock.image.createMany).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(ADMIN_SESSION);
  prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
  prismaMock.product.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.product.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.product.create.mockResolvedValue({ id: "prod_new" });
  prismaMock.category.findUnique.mockResolvedValue({ id: FORM_VALUES.categoryId });
  prismaMock.image.createMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  // Expected failures are user-facing AppErrors; only unexpected (INTERNAL)
  // errors may reach the logger.
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockClear();
});

afterAll(() => {
  consoleError.mockRestore();
});

const ACTION_CALLS: Array<[string, () => Promise<ActionResult<unknown>>]> = [
  ["editPrice", () => editPrice({ productId: PRODUCT_ID, price: 10.1 })],
  [
    "editShortDescription",
    () => editShortDescription({ productId: PRODUCT_ID, shortDescription: "A sufficiently long text" }),
  ],
  [
    "editLongDescription",
    () => editLongDescription({ productId: PRODUCT_ID, longDescription: "A sufficiently long description" }),
  ],
  ["takeProductOffline", () => takeProductOffline(PRODUCT_ID, "OUT_OF_STOCK")],
  ["createProduct", () => createProduct(FORM_VALUES)],
  ["deleteProduct", () => deleteProduct(PRODUCT_ID)],
  [
    "addImagesToProduct",
    () => addImagesToProduct(PRODUCT_ID, { images: [{ url: ALLOWED_URL, isMain: false }] }),
  ],
];

describe.each(ACTION_CALLS)("%s authorization", (_name, call) => {
  it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
    authMock.mockResolvedValue(null);
    expectFailure(await call(), "UNAUTHORIZED");
    expectNoDatabaseAccess();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("rejects non-ADMIN callers with FORBIDDEN before validating input", async () => {
    authMock.mockResolvedValue(USER_SESSION);
    expectFailure(await call(), "FORBIDDEN");
    expectNoDatabaseAccess();
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe("editPrice", () => {
  it("persists two-decimal rupees by id only and invalidates the product", async () => {
    const data = expectSuccess(await editPrice({ productId: PRODUCT_ID, price: 10.1 }));

    expect(data).toEqual({ productId: PRODUCT_ID, price: "10.10" });
    expect(prismaMock.product.updateMany).toHaveBeenCalledTimes(1);
    const [args] = prismaMock.product.updateMany.mock.calls[0];
    expect(args.data).toEqual({ price: "10.10" });
    expect(args.where).toEqual({ id: PRODUCT_ID });
    expect(args.where).not.toHaveProperty("userId");
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_ID);
    expect(revalidateMock).toHaveBeenCalledWith(`/products/${PRODUCT_ID}`);
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
  });

  it("coerces legacy rupee strings", async () => {
    const data = expectSuccess(await editPrice({ productId: PRODUCT_ID, price: "999.5" }));
    expect(data.price).toBe("999.50");
    expect(prismaMock.product.updateMany.mock.calls[0][0].data).toEqual({ price: "999.50" });
  });

  it.each([Number.NaN, -1, 10.123, "1e3", 1e12])(
    "rejects fuzz price %j before touching the database",
    async (price) => {
      expectFailure(await editPrice({ productId: PRODUCT_ID, price }), "VALIDATION");
      expect(prismaMock.product.updateMany).not.toHaveBeenCalled();
      expect(invalidateMock).not.toHaveBeenCalled();
    }
  );

  it("returns NOT_FOUND when no product row matched", async () => {
    prismaMock.product.updateMany.mockResolvedValue({ count: 0 });
    expectFailure(await editPrice({ productId: PRODUCT_ID, price: 10 }), "NOT_FOUND", "Product not found.");
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe("description edits", () => {
  it("trims the short description and updates by id only", async () => {
    expectSuccess(
      await editShortDescription({
        productId: PRODUCT_ID,
        shortDescription: "  A compact wireless mouse  ",
      })
    );

    const [args] = prismaMock.product.updateMany.mock.calls[0];
    expect(args.where).toEqual({ id: PRODUCT_ID });
    expect(args.where).not.toHaveProperty("userId");
    expect(args.data).toEqual({ shortDescription: "A compact wireless mouse" });
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it("trims the long description and updates by id only", async () => {
    expectSuccess(
      await editLongDescription({
        productId: PRODUCT_ID,
        longDescription: "  A longer product description.  ",
      })
    );

    const [args] = prismaMock.product.updateMany.mock.calls[0];
    expect(args.where).toEqual({ id: PRODUCT_ID });
    expect(args.data).toEqual({ description: "A longer product description." });
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it("rejects out-of-bounds descriptions without writing", async () => {
    expectFailure(
      await editShortDescription({ productId: PRODUCT_ID, shortDescription: "too short" }),
      "VALIDATION"
    );
    expectFailure(
      await editLongDescription({ productId: PRODUCT_ID, longDescription: "too short" }),
      "VALIDATION"
    );
    expect(prismaMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the product is gone", async () => {
    prismaMock.product.updateMany.mockResolvedValue({ count: 0 });
    expectFailure(
      await editShortDescription({ productId: PRODUCT_ID, shortDescription: "A valid short description" }),
      "NOT_FOUND",
      "Product not found."
    );
  });
});

describe("takeProductOffline", () => {
  it("updates availability with the validated enum value and no owner predicate", async () => {
    const data = expectSuccess(await takeProductOffline(PRODUCT_ID, "OUT_OF_STOCK"));

    expect(data).toEqual({ productId: PRODUCT_ID, availability: "OUT_OF_STOCK" });
    const [args] = prismaMock.product.updateMany.mock.calls[0];
    expect(args.where).toEqual({ id: PRODUCT_ID });
    expect(args.where).not.toHaveProperty("userId");
    expect(args.data).toEqual({ availability: "OUT_OF_STOCK" });
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it("accepts PRE_ORDER at runtime", async () => {
    expectSuccess(await takeProductOffline(PRODUCT_ID, "PRE_ORDER"));
    expect(prismaMock.product.updateMany.mock.calls[0][0].data).toEqual({ availability: "PRE_ORDER" });
  });

  it("rejects an availability outside the enum before touching the database", async () => {
    expectFailure(
      await takeProductOffline(PRODUCT_ID, "SOLD_OUT" as unknown as "IN_STOCK"),
      "VALIDATION"
    );
    expect(prismaMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the product is gone", async () => {
    prismaMock.product.updateMany.mockResolvedValue({ count: 0 });
    expectFailure(await takeProductOffline(PRODUCT_ID, "IN_STOCK"), "NOT_FOUND", "Product not found.");
  });
});

describe("createProduct", () => {
  it("returns NOT_FOUND for an unknown category without creating a product", async () => {
    prismaMock.category.findUnique.mockResolvedValue(null);

    expectFailure(await createProduct(FORM_VALUES), "NOT_FOUND", "Category not found.");
    expect(prismaMock.category.findUnique).toHaveBeenCalledWith({
      where: { id: FORM_VALUES.categoryId },
      select: { id: true },
    });
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });

  it("persists coerced values and records the admin as creator audit", async () => {
    const data = expectSuccess(await createProduct(FORM_VALUES));

    expect(data).toEqual({ productId: "prod_new" });
    const [args] = prismaMock.product.create.mock.calls[0];
    expect(args.data).toEqual({
      name: "Wireless Mouse",
      description: "A reliable wireless mouse for daily use.",
      price: "1234.50",
      shippingTime: "1-5 business days",
      categoryId: FORM_VALUES.categoryId,
      userId: ADMIN_SESSION.user.id,
      availability: "IN_STOCK",
      stockQty: 12,
      thumbnail: null,
      shortDescription: null,
      tag: null,
    });
    expect(invalidateMock).toHaveBeenCalledWith();
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
  });

  it.each([
    { label: "scientific price", input: { ...FORM_VALUES, price: "1e3" } },
    { label: "fractional stock", input: { ...FORM_VALUES, stock: "1.5" } },
    { label: "missing category", input: { ...FORM_VALUES, categoryId: "" } },
    { label: "short description", input: { ...FORM_VALUES, description: "too short" } },
    { label: "bad thumbnail host", input: { ...FORM_VALUES, thumbnail: "https://evil.example/p.png" } },
  ])("rejects $label before any database access", async ({ input }) => {
    expectFailure(await createProduct(input), "VALIDATION");
    expect(prismaMock.category.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });
});

describe("deleteProduct", () => {
  it("uses deleteMany by id (not delete) so OrderItem snapshots survive via SetNull", async () => {
    const data = expectSuccess(await deleteProduct(PRODUCT_ID));

    expect(data).toEqual({ productId: PRODUCT_ID });
    expect(prismaMock.product.deleteMany).toHaveBeenCalledTimes(1);
    const [args] = prismaMock.product.deleteMany.mock.calls[0];
    expect(args.where).toEqual({ id: PRODUCT_ID });
    expect(args.where).not.toHaveProperty("userId");
    expect(prismaMock.product.delete).not.toHaveBeenCalled();
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_ID);
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
  });

  it("returns NOT_FOUND when deleteMany matched no row", async () => {
    prismaMock.product.deleteMany.mockResolvedValue({ count: 0 });
    expectFailure(await deleteProduct(PRODUCT_ID), "NOT_FOUND", "Product not found.");
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid id before touching the database", async () => {
    expectFailure(await deleteProduct(""), "VALIDATION");
    expect(prismaMock.product.deleteMany).not.toHaveBeenCalled();
  });
});

describe("addImagesToProduct", () => {
  it("creates the images with the product id and no ownership filter", async () => {
    const images = [
      { url: ALLOWED_URL, isMain: true },
      { url: `${ALLOWED_URL}-2`, isMain: false },
    ];
    const data = expectSuccess(await addImagesToProduct(PRODUCT_ID, { images }));

    expect(data).toEqual({ productId: PRODUCT_ID, added: 2 });
    expect(prismaMock.product.findUnique).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      select: { id: true },
    });
    expect(prismaMock.product.findUnique.mock.calls[0][0].where).not.toHaveProperty("userId");
    expect(prismaMock.image.createMany).toHaveBeenCalledWith({
      data: [
        { productId: PRODUCT_ID, url: ALLOWED_URL, isMain: true },
        { productId: PRODUCT_ID, url: `${ALLOWED_URL}-2`, isMain: false },
      ],
    });
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_ID);
    expect(revalidateMock).toHaveBeenCalledWith(`/products/${PRODUCT_ID}`);
  });

  it("returns NOT_FOUND when the product does not exist", async () => {
    prismaMock.product.findUnique.mockResolvedValue(null);
    expectFailure(
      await addImagesToProduct(PRODUCT_ID, { images: [{ url: ALLOWED_URL, isMain: false }] }),
      "NOT_FOUND",
      "Product not found."
    );
    expect(prismaMock.image.createMany).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted image host before any database access", async () => {
    expectFailure(
      await addImagesToProduct(PRODUCT_ID, {
        images: [{ url: "https://evil.example/photo.png", isMain: false }],
      }),
      "VALIDATION"
    );
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.image.createMany).not.toHaveBeenCalled();
  });

  it("rejects more than one main image per request", async () => {
    expectFailure(
      await addImagesToProduct(PRODUCT_ID, {
        images: [
          { url: ALLOWED_URL, isMain: true },
          { url: `${ALLOWED_URL}-2`, isMain: true },
        ],
      }),
      "VALIDATION"
    );
    expect(prismaMock.image.createMany).not.toHaveBeenCalled();
  });
});
