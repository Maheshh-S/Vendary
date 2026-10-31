import * as z from "zod"

export const PRODUCT_SORTS = ["newest", "price_asc", "price_desc", "name_asc"] as const

export type ProductSort = (typeof PRODUCT_SORTS)[number]

/**
 * Public catalog query boundary. Numbers arrive as URL strings, so they are
 * coerced; every field carries a default so an empty query is valid.
 */
export const productsQuerySchema = z.object({
  page: z.coerce
    .number()
    .int("Page must be a whole number")
    .min(1, "Page must be at least 1")
    .default(1),
  pageSize: z.coerce
    .number()
    .int("Page size must be a whole number")
    .min(1, "Page size must be at least 1")
    .max(48, "Page size cannot exceed 48")
    .default(24),
  category: z
    .string()
    .trim()
    .max(60, "Category cannot exceed 60 characters")
    .optional(),
  sort: z.enum(PRODUCT_SORTS).default("newest"),
})

export type ProductsQuery = z.infer<typeof productsQuerySchema>
