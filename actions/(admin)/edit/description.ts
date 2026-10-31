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
  editLongDescriptionSchema,
  editShortDescriptionSchema,
} from "@/schemas/admin/products/edit-description-schema"

export const editShortDescription = async (input: {
  productId: string
  shortDescription: string
}) =>
  runAction("admin.editShortDescription", async () => {
    const session = await requireAdmin()

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    })

    const { productId, shortDescription } = parseInput(editShortDescriptionSchema, input)

    const { count } = await prisma.product.updateMany({
      where: { id: productId },
      data: { shortDescription },
    })
    if (count === 0) {
      throw new AppError("NOT_FOUND", "Product not found.")
    }

    await invalidateProductCache(productId)
    revalidatePath(`/products/${productId}`)
    revalidatePath("/admin")

    return { productId }
  })

export const editLongDescription = async (input: {
  productId: string
  longDescription: string
}) =>
  runAction("admin.editLongDescription", async () => {
    const session = await requireAdmin()

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    })

    const { productId, longDescription } = parseInput(editLongDescriptionSchema, input)

    const { count } = await prisma.product.updateMany({
      where: { id: productId },
      data: { description: longDescription },
    })
    if (count === 0) {
      throw new AppError("NOT_FOUND", "Product not found.")
    }

    await invalidateProductCache(productId)
    revalidatePath(`/products/${productId}`)
    revalidatePath("/admin")

    return { productId }
  })
