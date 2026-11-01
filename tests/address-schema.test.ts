import { describe, expect, it } from "vitest";

import {
  MAX_SAVED_ADDRESSES,
  SavedAddressIdSchema,
  SavedAddressInputSchema,
  UpdateSavedAddressSchema,
} from "@/schemas/account/address-schema";

/**
 * Saved-address contract (Task 2.2). Bounds are finite because every field is
 * stored, and phone/postal rules must match the checkout schema so a saved
 * address always passes `PlaceOrderSchema`.
 */

const VALID = {
  label: "Home",
  firstName: "Asha",
  lastName: "Rao",
  phone: "9876543210",
  line1: "12 MG Road, Apartment 4B",
  line2: "Near the park",
  area: "Indiranagar",
  landmark: "Opposite the library",
  state: "Karnataka",
  postalCode: "560038",
  country: "India",
  isDefault: true,
};

const parse = (input: unknown) => SavedAddressInputSchema.safeParse(input);

const valid = (input: unknown = VALID) => {
  const result = parse(input);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("Expected the address schema to accept the input");
  return result.data;
};

describe("SavedAddressInputSchema", () => {
  it("accepts a complete address and normalizes optional blanks", () => {
    expect(valid()).toMatchObject({
      firstName: "Asha",
      lastName: "Rao",
      phone: "9876543210",
      isDefault: true,
    });

    expect(
      valid({ ...VALID, label: "   ", line2: "", landmark: "  " })
    ).toMatchObject({ label: undefined, line2: undefined, landmark: undefined });
  });

  it("defaults lastName to an empty string and isDefault to false", () => {
    const { lastName: _lastName, isDefault: _isDefault, ...rest } = VALID;
    const data = valid(rest);
    expect(data.lastName).toBe("");
    expect(data.isDefault).toBe(false);
  });

  it.each([
    ["bare 10 digits", "9876543210"],
    ["+91 prefixed", "+91 98765 43210"],
    ["91 prefix without plus", "919876543210"],
    ["dashes", "98765-43210"],
  ])("normalizes %s phone numbers to 10 digits", (_label, phone) => {
    expect(valid({ ...VALID, phone }).phone).toBe("9876543210");
  });

  it.each([
    ["too short", "987654321"],
    ["starts with 5", "5876543210"],
    ["non-numeric", "abcdefghij"],
    ["empty", ""],
    ["foreign country code", "+1 4155552671"],
  ])("rejects a %s phone number", (_label, phone) => {
    expect(parse({ ...VALID, phone }).success).toBe(false);
  });

  it("enforces name, line and area bounds", () => {
    expect(parse({ ...VALID, firstName: "" }).success).toBe(false);
    expect(valid({ ...VALID, firstName: "a".repeat(60) }).firstName).toHaveLength(60);
    expect(parse({ ...VALID, firstName: "a".repeat(61) }).success).toBe(false);

    expect(valid({ ...VALID, lastName: "" }).lastName).toBe("");
    expect(parse({ ...VALID, lastName: "a".repeat(61) }).success).toBe(false);

    expect(valid({ ...VALID, line1: "12345" }).line1).toBe("12345");
    expect(parse({ ...VALID, line1: "1234" }).success).toBe(false);
    expect(parse({ ...VALID, line1: "a".repeat(201) }).success).toBe(false);

    expect(parse({ ...VALID, area: "a" }).success).toBe(false);
    expect(parse({ ...VALID, state: "" }).success).toBe(false);
  });

  it("requires a real six-digit PIN code", () => {
    expect(valid({ ...VALID, postalCode: "560001" }).postalCode).toBe("560001");
    for (const postalCode of ["56001", "5600011", "abcdef", " 56001 "]) {
      expect(parse({ ...VALID, postalCode }).success).toBe(false);
    }
  });

  it("bounds the optional label, line 2 and landmark", () => {
    expect(valid({ ...VALID, label: "a".repeat(40) }).label).toHaveLength(40);
    expect(parse({ ...VALID, label: "a".repeat(41) }).success).toBe(false);
    expect(parse({ ...VALID, line2: "a".repeat(201) }).success).toBe(false);
    expect(parse({ ...VALID, landmark: "a".repeat(121) }).success).toBe(false);
  });

  it("exposes a ten-address cap", () => {
    expect(MAX_SAVED_ADDRESSES).toBe(10);
  });
});

describe("UpdateSavedAddressSchema", () => {
  it("requires a bounded id alongside the address fields", () => {
    expect(UpdateSavedAddressSchema.parse({ ...VALID, id: "addr_1" })).toMatchObject({
      id: "addr_1",
      firstName: "Asha",
    });
    expect(UpdateSavedAddressSchema.safeParse(VALID).success).toBe(false);
    expect(UpdateSavedAddressSchema.safeParse({ ...VALID, id: "" }).success).toBe(false);
    expect(UpdateSavedAddressSchema.safeParse({ ...VALID, id: "a".repeat(65) }).success).toBe(false);
  });
});

describe("SavedAddressIdSchema", () => {
  it("accepts a bounded id and rejects empty or oversized values", () => {
    expect(SavedAddressIdSchema.parse("addr_1")).toBe("addr_1");
    expect(SavedAddressIdSchema.safeParse("").success).toBe(false);
    expect(SavedAddressIdSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});
