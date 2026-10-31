import * as z from 'zod'

import { isAllowedImageUrl } from '@/lib/images'
import { rupeePriceSchema } from './edit-price-schema'

/**
 * Client-side form schema. Inputs stay strings so react-hook-form keeps its
 * native input types; `createProductSchema` below is the server boundary and
 * coerces them.
 */
export const productFormSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    description: z.string().min(10, 'Description must be at least 10 characters'),
    price: z.string().refine((val) => !isNaN(Number(val)), {
      message: 'Price must be a valid number',
    }),
    shippingTime: z.string().min(1, 'Shipping time is required'),
    // images: z.array(mediaSchema),
    // mainImage: z.string().min(1, 'Main image is required'),
    // videos: z.array(mediaSchema),
    categoryId: z.string().min(1, 'Category is required'),
    stock: z.string().refine((val) => !isNaN(Number(val)), {
      message: 'Stock must be a valid number',
    }),
    isAvailable: z.boolean().optional(),
    thumbnail: z.string().optional(),
    tag: z.string().optional(),
    shortDescription: z.string().optional(),
  })
  
 export type ProductFormValues = z.infer<typeof productFormSchema>

/** Empty optional text inputs become absent instead of persisted as "". */
const optionalTrimmedString = (min: number, max: number, message: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(min, message).max(max, message).optional()
  )

/**
 * Server boundary for `createProduct`. Prices accept legacy rupee strings via
 * `rupeePriceSchema`; stock is coerced and must be a whole number.
 */
export const createProductSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(120, "Name cannot exceed 120 characters"),
  description: z
    .string()
    .trim()
    .min(10, "Description must be at least 10 characters")
    .max(5000, "Description cannot exceed 5000 characters"),
  price: rupeePriceSchema,
  stock: z.coerce
    .number()
    .int("Stock must be a whole number")
    .min(0, "Stock cannot be negative")
    .max(100_000, "Stock cannot exceed 100000"),
  categoryId: z
    .string()
    .trim()
    .min(1, "Category is required")
    .max(64, "Category id is invalid"),
  shippingTime: z
    .string()
    .trim()
    .min(1, "Shipping time is required")
    .max(80, "Shipping time cannot exceed 80 characters"),
  shortDescription: optionalTrimmedString(
    10,
    300,
    "Short description must be between 10 and 300 characters"
  ),
  tag: optionalTrimmedString(1, 40, "Tag cannot exceed 40 characters"),
  thumbnail: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .trim()
      .max(2048, "Thumbnail URL is too long")
      .refine(isAllowedImageUrl, "Thumbnail must be an https image URL from an allowed host")
      .optional()
  ),
})

export type CreateProductInput = z.infer<typeof createProductSchema>
