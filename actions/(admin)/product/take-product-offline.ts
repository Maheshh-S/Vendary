"use server"

import type { $Enums } from "@prisma/client"
import { revalidatePath } from "next/cache"

import { requireAdmin } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { invalidateProductCache } from "@/lib/product-cache"
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import { takeOfflineSchema } from "@/schemas/admin/products/take-offline-schema"

export const takeProductOffline = async (
  productId: string,
  availability: $Enums.Availability
) =>
  runAction("admin.takeProductOffline", async () => {
    const session = await requireAdmin()

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    })

    // The enum is validated at runtime; the TypeScript parameter type alone
    // would let an untyped caller persist an arbitrary string.
    const input = parseInput(takeOfflineSchema, { productId, availability })

    const { count } = await prisma.product.updateMany({
      where: { id: input.productId },
      data: { availability: input.availability },
    })
    if (count === 0) {
      throw new AppError("NOT_FOUND", "Product not found.")
    }

    await invalidateProductCache(input.productId)
    revalidatePath(`/products/${input.productId}`)
    revalidatePath("/admin")

    return { productId: input.productId, availability: input.availability }
  })
