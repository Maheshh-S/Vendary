"use server"

import { revalidatePath } from "next/cache"

import { requireAdmin } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { invalidateProductCache } from "@/lib/product-cache"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import { deleteProductSchema } from "@/schemas/admin/products/delete-product-schema"

export const deleteProduct = async (productId: string) =>
  runAction("admin.deleteProduct", async () => {
    await requireAdmin()

    const input = parseInput(deleteProductSchema, { productId })

    // `deleteMany` + count turns a missing row into an expected NOT_FOUND
    // instead of a thrown Prisma error. OrderItem.productId is `SetNull`, so
    // order history keeps its name/image/price snapshots after the delete.
    const { count } = await prisma.product.deleteMany({ where: { id: input.productId } })
    if (count === 0) {
      throw new AppError("NOT_FOUND", "Product not found.")
    }

    await invalidateProductCache(input.productId)
    revalidatePath("/admin")

    return { productId: input.productId }
  })
