"use server"

import { revalidatePath } from "next/cache"

import { requireAdmin } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { invalidateProductCache } from "@/lib/product-cache"
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import {
  addImagesInputSchema,
  MAX_PRODUCT_IMAGES,
  type ImageFormValues,
} from "@/schemas/admin/products/add-image-schema"

export const addImagesToProduct = async (productId: string, imageData: ImageFormValues) =>
  runAction("admin.addImagesToProduct", async () => {
    const session = await requireAdmin()

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    })

    const input = parseInput(addImagesInputSchema, { productId, images: imageData?.images })

    // No ownership filter: every ADMIN edits the single store catalog.
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true },
    })
    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found.")
    }

    // The per-request schema caps `images`, but the product total must stay
    // bounded too: count what is already stored before appending.
    const existingImages = await prisma.image.count({
      where: { productId: product.id },
    })
    if (existingImages + input.images.length > MAX_PRODUCT_IMAGES) {
      throw new AppError("VALIDATION", `A product can have at most ${MAX_PRODUCT_IMAGES} images.`)
    }

    await prisma.image.createMany({
      data: input.images.map((image) => ({
        productId: product.id,
        url: image.url,
        isMain: image.isMain,
      })),
    })

    await invalidateProductCache(product.id)
    revalidatePath(`/products/${product.id}`)
    revalidatePath("/admin")

    return { productId: product.id, added: input.images.length }
  })
