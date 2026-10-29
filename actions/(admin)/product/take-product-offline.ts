"use server"

import { auth } from "@/auth"
import {prisma} from "@/lib/db/prisma"
import { invalidateProductCache } from "@/lib/product-cache";
import type { $Enums } from "@prisma/client"
import { revalidatePath } from "next/cache"

export const takeProductOffline = async (productId: string, availability: $Enums.Availability) => {
    const session = await auth()
    if (!session?.user.id || session.user.role !== "ADMIN") {
        throw new Error("Unauthorized")
    }

    const product = await prisma.product.update({
        where: {
            id: productId
        },
        data: {
            availability
        }
    })

    await invalidateProductCache(productId);
    revalidatePath(`/products/${productId}`)
    return product
}
