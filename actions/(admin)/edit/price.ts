"use server"

import { revalidatePath } from "next/cache"

import { requireAdmin } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { invalidateProductCache } from "@/lib/product-cache"
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import { editPriceSchema, formatPriceForStorage } from "@/schemas/admin/products/edit-price-schema"

type EditPriceInput = {
  price: number | string
  productId: string
}

export const editPrice = async (input: EditPriceInput) =>
  runAction("admin.editPrice", async () => {
    const session = await requireAdmin()

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    })

    const { productId, price } = parseInput(editPriceSchema, input)
    const priceValue = formatPriceForStorage(price)

    // Admins are single-store editors: the id is the only predicate, userId
    // stays on the product purely as creator audit.
    const { count } = await prisma.product.updateMany({
      where: { id: productId },
      data: { price: priceValue },
    })
    if (count === 0) {
      throw new AppError("NOT_FOUND", "Product not found.")
    }

    await invalidateProductCache(productId)
    revalidatePath(`/products/${productId}`)
    revalidatePath("/admin")

    return { productId, price: priceValue }
  })
