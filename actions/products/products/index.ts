"use server"

import type { Prisma } from "@prisma/client"

import type { ActionResult } from "@/lib/action-result"
import { prisma } from "@/lib/db/prisma"
import { paiseToRupees } from "@/lib/money"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import {
    productsQuerySchema,
    type ProductSort,
} from "@/schemas/products/products-query-schema"

export type GetProductsParams = {
    page?: number | string
    pageSize?: number | string
    category?: string
    sort?: string
    minPricePaise?: number | string
    maxPricePaise?: number | string
}

export type ProductSummary = {
    id: string
    name: string
    tag: string | null
    imageSrc: string | null
    price: number
    imageAlt: string | null
}

export type ProductsPage = {
    items: ProductSummary[]
    total: number
    page: number
    pageSize: number
    totalPages: number
}

const ORDER_BY: Record<ProductSort, Prisma.ProductOrderByWithRelationInput> = {
    newest: { createdAt: "desc" },
    price_asc: { price: "asc" },
    price_desc: { price: "desc" },
    name_asc: { name: "asc" },
}

/**
 * Public catalog listing. The where clause is built once and shared by the
 * page query and the count so the total always describes the same result set.
 */
export const GetProducts = async (
    params: GetProductsParams = {}
): Promise<ActionResult<ProductsPage>> =>
    runAction("products.list", async () => {
        const { page, pageSize, category, sort, minPricePaise, maxPricePaise } =
            parseInput(productsQuerySchema, params)

        // Built once and shared by findMany and count, so `total` always
        // describes exactly the pages being returned.
        const where: Prisma.ProductWhereInput = {
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
            ...(minPricePaise !== undefined || maxPricePaise !== undefined
                ? {
                    price: {
                        // Paise on the wire, rupee Decimal in the database.
                        ...(minPricePaise !== undefined
                            ? { gte: paiseToRupees(minPricePaise) }
                            : {}),
                        ...(maxPricePaise !== undefined
                            ? { lte: paiseToRupees(maxPricePaise) }
                            : {}),
                    },
                }
                : {}),
        }

        const [products, total] = await Promise.all([
            prisma.product.findMany({
                where,
                include: {
                    category: true,
                },
                orderBy: ORDER_BY[sort],
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            prisma.product.count({ where }),
        ])

        return {
            items: products.map((product) => ({
                id: product.id,
                name: product.name,
                tag: product.tag,
                imageSrc: product.thumbnail,
                price: typeof product.price === "object" && typeof product.price.toNumber === "function" ? product.price.toNumber() : Number(product.price),
                imageAlt: product.shortDescription,
            })),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        }
    })
