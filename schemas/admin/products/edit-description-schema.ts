import { z } from "zod";

const productIdSchema = z
  .string()
  .min(1, "Product id is required")
  .max(64, "Product id is invalid");

export const editShortDescriptionSchema = z.object({
  productId: productIdSchema,
  shortDescription: z
    .string()
    .trim()
    .min(10, "Short description must be at least 10 characters")
    .max(300, "Short description cannot exceed 300 characters"),
});

export const editLongDescriptionSchema = z.object({
  productId: productIdSchema,
  longDescription: z
    .string()
    .trim()
    .min(10, "Description must be at least 10 characters")
    .max(5000, "Description cannot exceed 5000 characters"),
});
