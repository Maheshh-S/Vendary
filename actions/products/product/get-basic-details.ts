"use server"

import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/redis";
import { serializePrismaObject } from "@/lib/db/serializer";

export const getBasicProductDetails = async (id: string) => {
    let basicDetails: string | null = null;
    try {
        basicDetails = await redis.get(`product-basic-details:${id}`);
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
        await redis.set(`product-basic-details:${id}`, JSON.stringify(serializedProduct));
    } catch (cacheError) {
        console.error("Product details cache write failed:", cacheError);
    }

    return serializedProduct;
}