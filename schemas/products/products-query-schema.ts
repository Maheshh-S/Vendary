import * as z from "zod"

export const PRODUCT_SORTS = ["newest", "price_asc", "price_desc", "name_asc"] as const

export type ProductSort = (typeof PRODUCT_SORTS)[number]

/**
 * Defensive upper bound for the URL page number: `skip` grows linearly, so an
 * arbitrarily large page must never reach Prisma.
 */
export const MAX_PRODUCTS_PAGE = 10_000

/**
 * Price bounds arrive as paise (integer) from the action boundary. An empty
 * URL parameter (`?min=`) means "no filter", not zero, so it is normalized to
 * undefined before coercion.
 */
const optionalPaise = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce
    .number()
    .int("Price bounds must be whole paise")
    .min(0, "Price cannot be negative")
    .optional()
)

/**
 * Public catalog query boundary. Numbers arrive as URL strings, so they are
 * coerced; every field carries a default (or is optional) so an empty query is
 * valid. `minPricePaise <= maxPricePaise` is enforced here so the action and
 * the page agree on what a valid filter looks like.
 */
export const productsQuerySchema = z
  .object({
    page: z.coerce
      .number()
      .int("Page must be a whole number")
      .min(1, "Page must be at least 1")
      .max(MAX_PRODUCTS_PAGE, `Page cannot exceed ${MAX_PRODUCTS_PAGE}`)
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
    minPricePaise: optionalPaise,
    maxPricePaise: optionalPaise,
  })
  .refine(
    (query) =>
      query.minPricePaise === undefined ||
      query.maxPricePaise === undefined ||
      query.minPricePaise <= query.maxPricePaise,
    {
      message: "Minimum price cannot exceed maximum price",
      path: ["maxPricePaise"],
    }
  )

export type ProductsQuery = z.infer<typeof productsQuerySchema>
