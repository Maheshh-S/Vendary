"use server"

import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/redis";
import { serializePrismaObject } from "@/lib/db/serializer";
import { CACHE_TTL_SECONDS, productBasicDetailsKey } from "@/lib/product-cache";

export const getBasicProductDetails = async (id: string) => {
    const cacheKey = productBasicDetailsKey(id);
    let basicDetails: string | null = null;
    try {
        basicDetails = await redis.get(cacheKey);
    } catch (cacheError) {
        // Cache outage must never take down the page — fall through to DB.
        console.error("Product details cache read failed:", cacheError);
    }
    if (basicDetails) {
        return JSON.parse(basicDetails);
    }
    const product = await prisma.product.findUnique({
        where: {
            id,
        },
    });

    if (!product) {
        return null;
    }

    const serializedProduct = serializePrismaObject(product);
    try {
        await redis.setWithTtl(cacheKey, JSON.stringify(serializedProduct), CACHE_TTL_SECONDS.basicDetails);
    } catch (cacheError) {
        console.error("Product details cache write failed:", cacheError);
    }

    return serializedProduct;
}
