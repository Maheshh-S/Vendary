import * as z from "zod";

export const AddReviewSchema = z.object({
  productId: z.string().trim().min(1, "Product id is required").max(64, "Product id is invalid"),
  rating: z
    .number()
    .int("Rating must be a whole number")
    .min(1, "Rating must be at least 1")
    .max(5, "Rating cannot exceed 5"),
  review: z
    .string()
    .trim()
    .min(10, {
      message: "Review must be at least 10 characters long",
    })
    .max(2000, "Review cannot exceed 2000 characters"),
});

/** Edit contract: the product is inferred from the stored review. */
export const UpdateReviewSchema = z.object({
  id: z.string().trim().min(1, "Review id is required").max(64, "Review id is invalid"),
  rating: AddReviewSchema.shape.rating,
  review: AddReviewSchema.shape.review,
});

export const ReviewIdSchema = z
  .string()
  .trim()
  .min(1, "Review id is required")
  .max(64, "Review id is invalid");

export type AddReviewInput = z.infer<typeof AddReviewSchema>;
export type UpdateReviewInput = z.infer<typeof UpdateReviewSchema>;
