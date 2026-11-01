import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 1.1 — the cart quote is the single pre-payment source of truth.
 *
 * Prisma is mocked so the tests pin the query shape, the paise conversion and
 * the issue classification; `runAction`, `parseInput` and the schema run for
 * real so the ActionResult contract is exercised as shipped.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    product: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { Prisma } from "@prisma/client";

import { getCartQuote } from "@/actions/cart/quote";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import {
  hasBlockingQuoteIssue,
  hasPriceDrift,
  type CartQuote,
} from "@/schemas/cart/quote-schema";

const VASE = {
  id: "product_vase",
  name: "Jaipur Blue Pottery Vase",
  thumbnail: "https://images.unsplash.com/photo-vase",
  price: new Prisma.Decimal("1199.00"),
  availability: "IN_STOCK" as const,
  stockQty: 20,
};

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  }
  return result.data;
};

const expectFailure = (
  result: ActionResult<unknown>,
  code: ActionErrorCode
): void => {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected the action to fail");
  }
  expect(result.code).toBe(code);
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.product.findMany.mockResolvedValue([]);
});

describe("getCartQuote", () => {
  it("re-prices from the database and returns integer paise plus totals", async () => {
    prismaMock.product.findMany.mockResolvedValue([VASE]);

    const data = expectSuccess(
      await getCartQuote([{ productId: VASE.id, quantity: 2 }])
    );

    expect(data.lines).toEqual([
      {
        productId: VASE.id,
        name: VASE.name,
        image: VASE.thumbnail,
        unitPaise: 119900,
        quantity: 2,
        availability: "IN_STOCK",
        stockQty: 20,
        issue: null,
      },
    ]);
    expect(data.subtotalPaise).toBe(239800);
    expect(data.taxPaise).toBe(Math.round(239800 * 0.08));
    expect(data.totalPaise).toBe(239800 + data.taxPaise);

    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1);
    const [args] = prismaMock.product.findMany.mock.calls[0];
    // Only ids are queried; the client never supplies a price.
    expect(args.where).toEqual({ id: { in: [VASE.id] } });
    expect(args.select).toEqual({
      id: true,
      name: true,
      thumbnail: true,
      price: true,
      availability: true,
      stockQty: true,
    });
  });

  it("rounds a fractional rupee price to whole paise", async () => {
    prismaMock.product.findMany.mockResolvedValue([
      { ...VASE, price: new Prisma.Decimal("1499.50") },
    ]);

    const data = expectSuccess(
      await getCartQuote([{ productId: VASE.id, quantity: 1 }])
    );

    expect(data.lines[0].unitPaise).toBe(149950);
  });

  it("marks a deleted product MISSING and excludes it from totals", async () => {
    prismaMock.product.findMany.mockResolvedValue([]);

    const data = expectSuccess(
      await getCartQuote([{ productId: "gone", quantity: 3 }])
    );

    expect(data.lines).toEqual([
      {
        productId: "gone",
        name: "",
        image: null,
        unitPaise: 0,
        quantity: 3,
        availability: "OUT_OF_STOCK",
        stockQty: 0,
        issue: "MISSING",
      },
    ]);
    expect(data).toMatchObject({ subtotalPaise: 0, taxPaise: 0, totalPaise: 0 });
    expect(hasBlockingQuoteIssue(data)).toBe(true);
  });

  it.each([
    { label: "OUT_OF_STOCK", availability: "OUT_OF_STOCK" as const },
    { label: "PRE_ORDER", availability: "PRE_ORDER" as const },
  ])("blocks a $label product", async ({ availability }) => {
    prismaMock.product.findMany.mockResolvedValue([
      { ...VASE, availability, stockQty: 50 },
    ]);

    const data = expectSuccess(
      await getCartQuote([{ productId: VASE.id, quantity: 1 }])
    );

    expect(data.lines[0].issue).toBe("OUT_OF_STOCK");
    // The listed price still contributes to the displayed total.
    expect(data.lines[0].unitPaise).toBe(119900);
  });

  it("blocks an under-stocked quantity but accepts an exact stock match", async () => {
    prismaMock.product.findMany.mockResolvedValue([{ ...VASE, stockQty: 3 }]);

    const tooMany = expectSuccess(
      await getCartQuote([{ productId: VASE.id, quantity: 4 }])
    );
    expect(tooMany.lines[0].issue).toBe("INSUFFICIENT_STOCK");
    expect(tooMany.lines[0].stockQty).toBe(3);

    const exact = expectSuccess(
      await getCartQuote([{ productId: VASE.id, quantity: 3 }])
    );
    expect(exact.lines[0].issue).toBeNull();
  });

  it("keeps one line per requested item and shares quantities with totals", async () => {
    prismaMock.product.findMany.mockResolvedValue([
      VASE,
      {
        id: "product_shawl",
        name: "Pashmina Shawl",
        thumbnail: null,
        price: new Prisma.Decimal("8999.00"),
        availability: "IN_STOCK" as const,
        stockQty: 6,
      },
    ]);

    const data = expectSuccess(
      await getCartQuote([
        { productId: VASE.id, quantity: 2 },
        { productId: "product_shawl", quantity: 1 },
      ])
    );

    expect(data.lines).toHaveLength(2);
    expect(data.lines[1]).toMatchObject({
      productId: "product_shawl",
      image: null,
      unitPaise: 899900,
      quantity: 1,
      issue: null,
    });
    expect(data.subtotalPaise).toBe(239800 + 899900);
  });

  it("rejects an empty cart and more than 50 lines before querying", async () => {
    expectFailure(await getCartQuote([]), "VALIDATION");
    expectFailure(
      await getCartQuote(
        Array.from({ length: 51 }, (_, index) => ({
          productId: `p_${index}`,
          quantity: 1,
        }))
      ),
      "VALIDATION"
    );
    expectFailure(await getCartQuote([{ productId: VASE.id, quantity: 0 }]), "VALIDATION");
    expectFailure(await getCartQuote([{ productId: VASE.id, quantity: 100 }]), "VALIDATION");

    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
  });
});

describe("quote helpers", () => {
  const quote: CartQuote = {
    lines: [
      {
        productId: "p1",
        name: "Vase",
        image: null,
        unitPaise: 1000,
        quantity: 1,
        availability: "IN_STOCK",
        stockQty: 5,
        issue: null,
      },
      {
        productId: "p2",
        name: "",
        image: null,
        unitPaise: 0,
        quantity: 1,
        availability: "OUT_OF_STOCK",
        stockQty: 0,
        issue: "MISSING",
      },
    ],
    subtotalPaise: 1000,
    taxPaise: 80,
    totalPaise: 1080,
  };

  it("detects price drift against the local cart, ignoring missing lines", () => {
    expect(hasPriceDrift(quote, [{ productId: "p1", unitPaise: 1000 }])).toBe(false);
    expect(hasPriceDrift(quote, [{ productId: "p1", unitPaise: 999 }])).toBe(true);
    // Missing lines have no authoritative price to drift from.
    expect(hasPriceDrift(quote, [{ productId: "p2", unitPaise: 500 }])).toBe(false);
    expect(hasPriceDrift(null, [{ productId: "p1", unitPaise: 1 }])).toBe(false);
  });

  it("treats any non-null issue as blocking", () => {
    expect(hasBlockingQuoteIssue(quote)).toBe(true);
    expect(
      hasBlockingQuoteIssue({
        ...quote,
        lines: [quote.lines[0]],
      })
    ).toBe(false);
    expect(hasBlockingQuoteIssue(null)).toBe(false);
  });
});
