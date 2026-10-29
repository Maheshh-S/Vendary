"use server"

import { auth } from "@/auth";
import {prisma} from "@/lib/db/prisma";
import { invalidateProductCache } from "@/lib/product-cache";
import type { ProductFormValues } from "@/schemas/admin/products/create-product-schema"

export const createProduct = async (product: ProductFormValues) => {
    const session = await auth();
    if (!session?.user.id || session.user.role !== "ADMIN") {
        throw new Error("Unauthorized")
    }
    const stockQty = Number(product.stock);
    if (Number.isNaN(stockQty) || stockQty < 0 || !Number.isInteger(stockQty)) {
        throw new Error("Stock must be a non-negative whole number")
    }
    const newProduct = await prisma.product.create({
        data: {
            name: product.name,
            description: product.description,
            price: product.price,
            shippingTime: product.shippingTime,
            categoryId: product.categoryId,
            userId: session.user.id,
            availability: "IN_STOCK",
            stockQty,
            thumbnail: product.thumbnail,
            shortDescription: product.shortDescription,
            tag: product.tag,
        }
    })
    await invalidateProductCache()
    return newProduct;
}

