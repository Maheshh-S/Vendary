import { z } from "zod";

/** Codes are stored uppercase and typed without spaces. */
export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;

/** Values are rupees with at most two decimals; percentages use the same field. */
const rupeesSchema = z.coerce
  .number({ invalid_type_error: "Enter a valid amount" })
  .finite("Enter a valid amount")
  .min(0, "Amount cannot be negative")
  .max(1_000_000, "Amount is too large")
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    "Use at most 2 decimal places"
  );

const optionalRupeesSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  rupeesSchema.optional()
);

const optionalUsageLimitSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce
    .number({ invalid_type_error: "Usage limit must be a number" })
    .int("Usage limit must be a whole number")
    .min(1, "Usage limit must be at least 1")
    .max(1_000_000, "Usage limit is too large")
    .optional()
);

/** A cap of zero would silently disable the coupon; require a real amount. */
const optionalMaxDiscountSchema = optionalRupeesSchema.refine(
  (value) => value === undefined || value > 0,
  "Max discount must be greater than zero"
);

const couponFieldsSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, "Code must be at least 3 characters")
    .max(32, "Code cannot exceed 32 characters")
    .transform((value) => value.toUpperCase())
    .pipe(
      z.string().regex(COUPON_CODE_PATTERN, "Use letters, numbers, underscores or dashes only")
    ),
  type: z.enum(["PERCENT", "FIXED"], { invalid_type_error: "Choose a coupon type" }),
  value: rupeesSchema.refine((value) => value > 0, "Value must be greater than zero"),
  minSubtotal: optionalRupeesSchema,
  maxDiscount: optionalMaxDiscountSchema,
  startsAt: z.coerce.date({ invalid_type_error: "Enter a valid start date" }),
  endsAt: z.coerce.date({ invalid_type_error: "Enter a valid end date" }),
  usageLimit: optionalUsageLimitSchema,
  isActive: z.boolean().optional().default(true),
});

/** Window and percentage rules that span more than one field. */
const validateCouponRules = (
  data: {
    type: "PERCENT" | "FIXED";
    value: number;
    startsAt: Date;
    endsAt: Date;
  },
  ctx: z.RefinementCtx
): void => {
  if (data.endsAt.getTime() <= data.startsAt.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endsAt"],
      message: "Ends at must be after starts at",
    });
  }
  if (data.type === "PERCENT" && data.value > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Percentage cannot exceed 100",
    });
  }
};

export const couponInputSchema = couponFieldsSchema.superRefine(validateCouponRules);

export const couponUpdateSchema = couponFieldsSchema
  .extend({ id: z.string().min(1).max(64) })
  .superRefine(validateCouponRules);

export const couponIdSchema = z.object({
  id: z.string().min(1).max(64),
});

export type CouponInput = z.infer<typeof couponInputSchema>;
export type CouponUpdateInput = z.infer<typeof couponUpdateSchema>;
