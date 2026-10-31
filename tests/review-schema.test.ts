import { describe, expect, it } from "vitest";

import { AddReviewSchema } from "@/schemas/products/reviews/review-schema";

/**
 * Review input contract (Task 0.8): whole-star ratings, trimmed bounds on the
 * body, and a bounded product id. The same schema backs the client form and
 * the server action, so transformations must be visible in its output.
 */

const parse = (input: unknown) => AddReviewSchema.safeParse(input);

const VALID = {
  productId: "clx0product0000000000000000",
  rating: 5,
  review: "A genuinely detailed review.",
};

const validReview = (input: unknown) => {
  const result = parse(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("Expected the review schema to accept the input");
  }
  return result.data;
};

describe("AddReviewSchema", () => {
  it("accepts a well-formed review", () => {
    expect(validReview(VALID)).toEqual(VALID);
  });

  it("trims the product id and review body", () => {
    const data = validReview({
      ...VALID,
      productId: `  ${VALID.productId}  `,
      review: `  ${VALID.review}  `,
    });
    expect(data.productId).toBe(VALID.productId);
    expect(data.review).toBe(VALID.review);
  });

  it("accepts integer ratings on both boundaries", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(validReview({ ...VALID, rating }).rating).toBe(rating);
    }
  });

  it.each([
    { label: "zero", rating: 0 },
    { label: "above five", rating: 6 },
    { label: "fractional", rating: 3.5 },
    { label: "negative", rating: -1 },
    { label: "NaN", rating: Number.NaN },
    { label: "Infinity", rating: Number.POSITIVE_INFINITY },
    { label: "numeric string", rating: "5" },
    { label: "null", rating: null },
    { label: "missing", rating: undefined },
  ])("rejects a $label rating", ({ rating }) => {
    expect(parse({ ...VALID, rating }).success).toBe(false);
  });

  it("accepts a review of exactly 10 characters after trimming", () => {
    expect(validReview({ ...VALID, review: "abcdefghij" }).review).toBe("abcdefghij");
    expect(validReview({ ...VALID, review: "  abcdefghij  " }).review).toBe("abcdefghij");
  });

  it("rejects reviews shorter than 10 characters after trimming", () => {
    for (const review of ["short", "abcdefghi", "  abcdefghi  ", "          "]) {
      expect(parse({ ...VALID, review }).success).toBe(false);
    }
  });

  it("accepts the 2000-character maximum boundary and rejects 2001", () => {
    expect(validReview({ ...VALID, review: "x".repeat(2000) }).review).toHaveLength(2000);
    expect(parse({ ...VALID, review: "x".repeat(2001) }).success).toBe(false);
  });

  it("rejects missing and non-string review bodies", () => {
    expect(parse({ ...VALID, review: undefined }).success).toBe(false);
    expect(parse({ ...VALID, review: 1234567890 }).success).toBe(false);
  });

  it("accepts a 64-character product id and rejects 65", () => {
    expect(validReview({ ...VALID, productId: "p".repeat(64) }).productId).toHaveLength(64);
    expect(parse({ ...VALID, productId: "p".repeat(65) }).success).toBe(false);
  });

  it("rejects empty, whitespace-only and non-string product ids", () => {
    for (const productId of ["", "   ", 123, null, undefined]) {
      expect(parse({ ...VALID, productId }).success).toBe(false);
    }
  });
});
