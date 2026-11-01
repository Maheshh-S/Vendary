/**
 * Coupon eligibility and discount math. Client-safe and dependency-free: every
 * amount is integer paise, percentages are rounded exactly once, and the same
 * function is used by the advisory cart quote and the authoritative charge path.
 * No float-rupee arithmetic ever reaches an order total.
 */

export type CouponTypeValue = "PERCENT" | "FIXED";

/** Anything Prisma's Decimal or a JSON-decoded string can look like. */
export type DecimalLike = number | string | { toString(): string };

export type CouponLike = {
  type: CouponTypeValue;
  /** Percentage for PERCENT (10 = 10%), rupee amount for FIXED. */
  value: DecimalLike;
  minSubtotal: DecimalLike;
  maxDiscount: DecimalLike | null;
  startsAt: Date;
  endsAt: Date;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
};

export type CouponRejectionReason =
  "INACTIVE" | "NOT_STARTED" | "EXPIRED" | "MIN_SUBTOTAL" | "USAGE_LIMIT";

export type CouponDiscountResult =
  | { ok: true; discountPaise: number }
  | { ok: false; discountPaise: 0; reason: CouponRejectionReason };

export const INVALID_COUPON_MESSAGE = "Invalid coupon code.";

/**
 * Razorpay rejects order amounts below ₹1 (100 paise). The cart quote reports
 * this as a coupon error so checkout disables payment before the charge path
 * would refuse the same cart.
 */
export const MIN_PAYABLE_AMOUNT_PAISE = 100;
export const MIN_PAYABLE_AMOUNT_MESSAGE = "Order total must be at least ₹1 after the discount.";
/** Same floor for a cart that never had a coupon to discount. */
export const MIN_PAYABLE_AMOUNT_MESSAGE_NO_COUPON = "Order total must be at least ₹1.";

/** Floor copy must not blame a discount that was never applied. */
export const minPayableAmountMessage = (hasCoupon: boolean): string =>
  hasCoupon ? MIN_PAYABLE_AMOUNT_MESSAGE : MIN_PAYABLE_AMOUNT_MESSAGE_NO_COUPON;

/** Codes are stored uppercase; this is the only normalization applied. */
export const normalizeCouponCode = (code: string): string => code.trim().toUpperCase();

const toNumber = (value: DecimalLike): number =>
  typeof value === "number" ? value : Number(value.toString());

/** Rupee Decimal (or string) to integral paise. */
export const rupeesToPaise = (value: DecimalLike): number => Math.round(toNumber(value) * 100);

/**
 * Validates a coupon against the cart subtotal and `now`, returning the
 * discount in paise. The window is `[startsAt, endsAt)`: at exactly `endsAt`
 * the coupon has expired. The discount is clamped to the subtotal so a total
 * can never go negative.
 */
export function computeCouponDiscount(
  coupon: CouponLike,
  subtotalPaise: number,
  now: Date
): CouponDiscountResult {
  if (!coupon.isActive) {
    return { ok: false, discountPaise: 0, reason: "INACTIVE" };
  }
  if (now < coupon.startsAt) {
    return { ok: false, discountPaise: 0, reason: "NOT_STARTED" };
  }
  if (now >= coupon.endsAt) {
    return { ok: false, discountPaise: 0, reason: "EXPIRED" };
  }
  if (subtotalPaise < rupeesToPaise(coupon.minSubtotal)) {
    return { ok: false, discountPaise: 0, reason: "MIN_SUBTOTAL" };
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, discountPaise: 0, reason: "USAGE_LIMIT" };
  }

  const subtotal = Number.isFinite(subtotalPaise) ? Math.max(0, Math.round(subtotalPaise)) : 0;
  // Percentages keep two decimals in the database; convert to hundredths of a
  // percent and divide once so rounding happens a single time at the end.
  const valueHundredths = Math.round(toNumber(coupon.value) * 100);
  let discountPaise =
    coupon.type === "PERCENT"
      ? Math.round((subtotal * valueHundredths) / 10_000)
      : rupeesToPaise(coupon.value);

  if (coupon.maxDiscount !== null) {
    discountPaise = Math.min(discountPaise, rupeesToPaise(coupon.maxDiscount));
  }
  discountPaise = Math.min(Math.max(0, discountPaise), subtotal);

  return { ok: true, discountPaise };
}

/** User-facing copy for a rejected coupon (never includes internal codes). */
export const couponRejectionMessage = (reason: CouponRejectionReason): string => {
  switch (reason) {
    case "INACTIVE":
      return "This coupon is no longer active.";
    case "NOT_STARTED":
      return "This coupon is not active yet.";
    case "EXPIRED":
      return "This coupon has expired.";
    case "MIN_SUBTOTAL":
      return "Your cart does not meet this coupon's minimum subtotal.";
    case "USAGE_LIMIT":
      return "This coupon is no longer available.";
  }
};
