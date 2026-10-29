"use server"

import { prisma } from "@/lib/db/prisma"

export type GetProductsParams = {
    take?: number
    skip?: number
    category?: string
}

export const GetProducts = async ({
    take = 24,
    skip = 0,
    category,
}: GetProductsParams) => {
    const products = await prisma.product.findMany({
        where: {
            availability: "IN_STOCK",
            ...(category
                ? {
                    category: {
                        name: {
                            equals: category,
                            mode: "insensitive",
                        },
                    },
                }
                : {}),
        },
        include: {
            category: true,
        },
        orderBy: {
            createdAt: "desc",
        },
        skip,
        take,
    })

    return products.map((product) => ({
        id: product.id,
        name: product.name,
        tag: product.tag,
        imageSrc: product.thumbnail,
        price: typeof product.price === "object" && typeof product.price.toNumber === "function" ? product.price.toNumber() : Number(product.price),
        imageAlt: product.shortDescription,
    }))
}