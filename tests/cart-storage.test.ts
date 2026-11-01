import { describe, expect, it } from "vitest";

import {
  MAX_CART_QUANTITY,
  cartTotalPaise,
  clampCartQuantity,
  normalizeCartItems,
  type CartItem,
} from "@/lib/cart";

/**
 * Task 1.1 — legacy localStorage carts stored `price` in rupees; the paise
 * cart must read them once, migrate, and never emit a corrupt cart.
 */
describe("normalizeCartItems", () => {
  it("migrates a legacy rupee price to integer paise and drops the old field", () => {
    const [item] = normalizeCartItems([
      {
        id: "prod_1",
        name: "Jaipur Blue Pottery Vase",
        price: 1199.5,
        quantity: 2,
        images: [{ src: "https://images.unsplash.com/vase" }],
      },
    ]);

    expect(item).toEqual({
      id: "prod_1",
      name: "Jaipur Blue Pottery Vase",
      unitPaise: 119950,
      quantity: 2,
      images: [{ src: "https://images.unsplash.com/vase" }],
    });
    expect(item).not.toHaveProperty("price");
  });

  it("keeps an already-migrated paise cart untouched", () => {
    const items: CartItem[] = [
      {
        id: "prod_2",
        name: "Shawl",
        unitPaise: 899900,
        quantity: 1,
        images: [],
      },
    ];
    expect(normalizeCartItems(items)).toEqual(items);
  });

  it("drops corrupt rows and non-array storage", () => {
    expect(normalizeCartItems(null)).toEqual([]);
    expect(normalizeCartItems({ id: "nope" })).toEqual([]);
    expect(
      normalizeCartItems([
        null,
        "garbage",
        { id: "", unitPaise: 100, quantity: 1 },
        { id: "bad_price", price: "not-a-number", quantity: 1 },
        { id: "negative", unitPaise: -5, quantity: 1 },
        { id: "ok", unitPaise: 500, quantity: 1 },
      ])
    ).toEqual([
      { id: "ok", name: "", unitPaise: 500, quantity: 1, images: [] },
    ]);
  });

  it("clamps quantities to 1..99 and merges duplicate product ids", () => {
    const items = normalizeCartItems([
      { id: "p", unitPaise: 100, quantity: 0, images: [] },
      { id: "p", unitPaise: 100, quantity: 500, images: [] },
      { id: "q", unitPaise: 200, quantity: 2.9, images: [] },
    ]);

    expect(items).toEqual([
      { id: "p", name: "", unitPaise: 100, quantity: MAX_CART_QUANTITY, images: [] },
      { id: "q", name: "", unitPaise: 200, quantity: 2, images: [] },
    ]);
  });

  it("filters malformed image entries", () => {
    const [item] = normalizeCartItems([
      {
        id: "p",
        unitPaise: 100,
        quantity: 1,
        images: [{ src: "https://ok" }, { src: "" }, { nope: true }, null],
      },
    ]);

    expect(item.images).toEqual([{ src: "https://ok" }]);
  });

  it("prefers the current unitPaise when both shapes are present", () => {
    const [item] = normalizeCartItems([
      { id: "p", price: 10, unitPaise: 1234, quantity: 1 },
    ]);

    expect(item.unitPaise).toBe(1234);
  });
});

describe("cartTotalPaise", () => {
  it("sums integer paise across quantities", () => {
    expect(
      cartTotalPaise([
        { id: "a", name: "", unitPaise: 249900, quantity: 1, images: [] },
        { id: "b", name: "", unitPaise: 34900, quantity: 3, images: [] },
      ])
    ).toBe(249900 + 104700);
    expect(cartTotalPaise([])).toBe(0);
  });
});

describe("clampCartQuantity", () => {
  it.each([
    [0, 1],
    [-5, 1],
    [2.9, 2],
    [99, 99],
    [1000, 99],
    [Number.NaN, 1],
  ])("clamps %j to %i", (input, expected) => {
    expect(clampCartQuantity(input)).toBe(expected);
  });
});
