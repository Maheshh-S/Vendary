import { z } from "zod";

/** Product prices are rupees, persisted as Decimal(10,2). */
export const MAX_PRODUCT_PRICE = 10_000_000;

/** Decimal(10,2) ceiling: rejects e.g. 10.123 despite float representation. */
const hasAtMostTwoDecimals = (value: number): boolean =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/**
 * Legacy clients submit rupee strings from number inputs, so coercion stays.
 * Plain decimal strings are the only strings accepted: booleans, arrays and
 * exponent/hex notation (`"1e3"`, `"0x10"`) are never coerced into a price.
 */
const coercePriceInput = (value: unknown): unknown => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+(\.\d{1,2})?$/.test(trimmed) ? trimmed : Number.NaN;
  }
  return Number.NaN;
};

export const rupeePriceSchema = z.preprocess(
  coercePriceInput,
  z.coerce
    .number()
    .finite("Price must be a finite number")
    .min(1, "Price must be at least ₹1")
    .max(MAX_PRODUCT_PRICE, "Price is too large")
    .refine(hasAtMostTwoDecimals, "Price can have at most 2 decimal places")
);

export const editPriceSchema = z.object({
  productId: z.string().min(1, "Product id is required").max(64, "Product id is invalid"),
  price: rupeePriceSchema,
});

/** Canonical Decimal(10,2) string, e.g. 10.1 -> "10.10". */
export const formatPriceForStorage = (price: number): string =>
  (Math.round(price * 100) / 100).toFixed(2);
