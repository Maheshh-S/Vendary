"use server"

import { prisma } from "@/lib/db/prisma"
import { redis } from "@/lib/redis"
import { CACHE_TTL_SECONDS, FEATURED_PRODUCTS_KEY } from "@/lib/product-cache"

const DEFAULT_TAKE = 4
const MIN_TAKE = 1
const MAX_TAKE = 12

/**
 * Public callers can pass any take. Clamp it to a small, positive window so a
 * rogue request cannot turn the homepage query into a table scan.
 */
const clampTake = (value: unknown): number => {
    const parsed =
        typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
    if (!Number.isFinite(parsed)) {
        return DEFAULT_TAKE
    }
    return Math.min(MAX_TAKE, Math.max(MIN_TAKE, Math.trunc(parsed)))
}

export const GetFeaturedProducts = async ({
    take = DEFAULT_TAKE,
    skip = 0,
}) => {
    try {
        let cachedProducts: string | null = null;
        try {
            cachedProducts = await redis.get(FEATURED_PRODUCTS_KEY)
        } catch (cacheError) {
            // Cache outage must never take down the page — fall through to DB.
            console.error("Featured products cache read failed:", cacheError)
        }
        if(cachedProducts) {
            return JSON.parse(cachedProducts)
        }
        const featuredProducts = await prisma.product.findMany({
            where: {
                availability: "IN_STOCK",
                isFeatured: true,
            },
            skip,
            take: clampTake(take),
        })

        const products = featuredProducts.map((product) => ({
            id: product.id,
            name: product.name,
            tag: product.tag,
            imageSrc: product.thumbnail,
            price: typeof product.price === 'object' && typeof product.price.toNumber === 'function' ? product.price.toNumber() : Number(product.price),
            imageAlt: product.shortDescription
        }))
        try {
            await redis.setWithTtl(FEATURED_PRODUCTS_KEY, JSON.stringify(products), CACHE_TTL_SECONDS.featured)
        } catch (cacheError) {
            console.error("Featured products cache write failed:", cacheError)
        }
        return products;
    } catch (error) {
        console.error("Error fetching featured products:", error)
        throw new Error("Failed to fetch featured products")
    }
}
