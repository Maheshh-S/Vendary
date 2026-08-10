"use server"

import { prisma } from "@/lib/db/prisma"
import { redis } from "@/lib/redis"

export const GetFeaturedPrpducts = async ({
    take = 4,
    skip = 0,
}) => {
    try {
        const cachedProducts = await redis.get("featured-products")
        if(cachedProducts) {
            return JSON.parse(cachedProducts)
        }
        const featuredProducts = await prisma.product.findMany({
            where: {
                avaiavility: "IN_STOCK"
            },
            skip,
            take,
        })

        const products = featuredProducts.map((product) => ({
            id: product.id,
            name: product.name,
            tag: product.tag,
            imageSrc: product.thumbnail,
            price: typeof product.price === 'object' && typeof product.price.toNumber === 'function' ? product.price.toNumber() : Number(product.price),
            imageAlt: product.shortDescription
        }))
        await redis.set("featured-products", JSON.stringify(products))
        return products;
    } catch (error) {
        console.error("Error fetching featured products:", error)
        throw new Error("Failed to fetch featured products")
    }
}