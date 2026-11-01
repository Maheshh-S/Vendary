import { z } from "zod";

import { normalizeCouponCode } from "@/lib/coupons";

/**
 * Optional coupon code at every request boundary (cart quote and checkout
 * init). Blanks mean "no coupon"; the one trim + uppercase normalization is
 * shared so the advisory quote and the authoritative charge path can never
 * disagree about which code was sent.
 */
export const couponCodeSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.string().trim().max(64, "Coupon code is too long").transform(normalizeCouponCode).optional()
);
