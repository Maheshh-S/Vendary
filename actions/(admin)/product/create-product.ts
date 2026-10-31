"use server"

import { revalidatePath } from "next/cache"

import { requireAdmin } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { invalidateProductCache } from "@/lib/product-cache"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import {
  createProductSchema,
  type ProductFormValues,
} from "@/schemas/admin/products/create-product-schema"
import { formatPriceForStorage } from "@/schemas/admin/products/edit-price-schema"

export const createProduct = async (input: ProductFormValues) =>
  runAction("admin.createProduct", async () => {
    const session = await requireAdmin()

    const data = parseInput(createProductSchema, input)

    // A dangling categoryId would surface as an opaque Prisma FK error.
    const category = await prisma.category.findUnique({
      where: { id: data.categoryId },
      select: { id: true },
    })
    if (!category) {
      throw new AppError("NOT_FOUND", "Category not found.")
    }

    const product = await prisma.product.create({
      data: {
        name: data.name,
        description: data.description,
        price: formatPriceForStorage(data.price),
        shippingTime: data.shippingTime,
        categoryId: category.id,
        // Creator audit only — admins share one store.
        userId: session.user.id,
        availability: "IN_STOCK",
        stockQty: data.stock,
        thumbnail: data.thumbnail ?? null,
        shortDescription: data.shortDescription ?? null,
        tag: data.tag ?? null,
      },
      select: { id: true },
    })

    await invalidateProductCache()
    revalidatePath("/admin")

    return { productId: product.id }
  })
