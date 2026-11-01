import * as z from "zod";

/**
 * Public search boundary. The term is trimmed before the bounds are applied,
 * so whitespace-only or padded single-character terms never reach the database.
 */
export const searchProductsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(2, "Search term must be at least 2 characters")
    .max(64, "Search term cannot exceed 64 characters"),
});

export type SearchProductsInput = z.infer<typeof searchProductsSchema>;
