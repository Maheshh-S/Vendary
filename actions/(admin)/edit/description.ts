"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/db/prisma";
import { invalidateProductCache } from "@/lib/product-cache";

export const editShortDescription = async ( {
    productId,
    shortDescription
} : {
    productId: string,
    shortDescription: string,
} ) => {
    try {
        const session = await auth();
        if(!session?.user.id) {
            throw new Error("User not authenticated");
        }

        await prisma.product.update({
            where: {
                id: productId,
                userId: session.user.id,
            },
            data: {
                shortDescription
            }
        })
        await invalidateProductCache(productId);
    } catch (error) {
        console.error("Error updating short description:", error);
        throw error;
    }
}

export const editLongDescription = async ( {
    productId,
    longDescription
} : {
    productId: string,
    longDescription: string,
} ) => {
    try {
        const session = await auth();
        if(!session?.user.id) {
            throw new Error("User not authenticated");
        }

        await prisma.product.update({
            where: {
                id: productId,
                userId: session.user.id,
            },
            data: {
                description: longDescription
            }
        })
        await invalidateProductCache(productId);
    } catch (error) {
        console.error("Error updating long description:", error);
        throw error;
    }
}
