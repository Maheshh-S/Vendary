import { describe, expect, it } from "vitest";
import {
  checkoutSessionSchema,
  placeOrderSchema,
} from "@/schemas/checkout/place-order-schema";

const validAddress = {
  fName: "Ada",
  lName: "Lovelace",
  mobile: "9876543210",
  pinCode: "560001",
  address: "12 MG Road",
  area: "Central",
  landmark: "Near Metro",
  country: ["India", "Karnataka"] as [string, string],
};

describe("checkoutSessionSchema (client cart boundary)", () => {
  it("accepts a well-formed cart and strips client-supplied price data", () => {
    const parsed = checkoutSessionSchema.parse({
      line_items: [
        {
          productId: "prod_1",
          quantity: 2,
          price_data: { unit_amount: 1, product_data: { name: "x", images: [] } },
        },
      ],
    });
    // Only id + quantity survive — client prices can never influence totals.
    expect(parsed.line_items).toEqual([{ productId: "prod_1", quantity: 2 }]);
  });

  it("rejects an empty cart", () => {
    expect(() => checkoutSessionSchema.parse({ line_items: [] })).toThrow();
  });

  it("rejects pre-id localStorage sessions (old cart shape fails loudly)", () => {
    const oldSession = {
      line_items: [
        { price_data: { product_data: { name: "Old item" }, unit_amount: 100 }, quantity: 1 },
      ],
    };
    expect(() => checkoutSessionSchema.parse(oldSession)).toThrow();
  });

  it("rejects zero, negative, fractional and oversized quantities", () => {
    for (const quantity of [0, -1, 2.5, 100]) {
      expect(() =>
        checkoutSessionSchema.parse({ line_items: [{ productId: "p", quantity }] })
      ).toThrow();
    }
    expect(() =>
      checkoutSessionSchema.parse({ line_items: [{ productId: "p", quantity: 99 }] })
    ).not.toThrow();
  });
});

describe("placeOrderSchema (address boundary)", () => {
  it("accepts a valid Indian address", () => {
    expect(() => placeOrderSchema.parse(validAddress)).not.toThrow();
  });

  it("normalizes +91 prefixes, spaces and dashes in mobile numbers", () => {
    const parsed = placeOrderSchema.parse({ ...validAddress, mobile: "+91 98765-43210" });
    expect(parsed.mobile).toBe("9876543210");
  });

  it("rejects non-Indian mobiles (landline prefix, too short)", () => {
    for (const mobile of ["1234567890", "987654321", "+44 7700900123"]) {
      expect(() => placeOrderSchema.parse({ ...validAddress, mobile })).toThrow();
    }
  });

  it("rejects missing required address fields", () => {
    expect(() => placeOrderSchema.parse({ ...validAddress, address: "" })).toThrow();
    expect(() => placeOrderSchema.parse({ ...validAddress, pinCode: "" })).toThrow();
  });
});
