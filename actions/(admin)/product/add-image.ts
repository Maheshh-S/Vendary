"use server"

import { revalidatePath } from "next/cache"

import { requireAdmin } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { invalidateProductCache } from "@/lib/product-cache"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import {
  addImagesInputSchema,
  type ImageFormValues,
} from "@/schemas/admin/products/add-image-schema"

export const addImagesToProduct = async (productId: string, imageData: ImageFormValues) =>
  runAction("admin.addImagesToProduct", async () => {
    await requireAdmin()

    const input = parseInput(addImagesInputSchema, { productId, images: imageData?.images })

    // No ownership filter: every ADMIN edits the single store catalog.
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true },
    })
    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found.")
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
