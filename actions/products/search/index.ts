"use server";

import type { ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/db/prisma";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { clientKey } from "@/lib/request-key";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";
import { searchProductsSchema } from "@/schemas/products/search-schema";

export type SearchHit = {
  id: string;
  name: string;
  thumbnail: string | null;
  price: string;
};

/**
 * Public catalog search. Rate limited per client before validation so junk
 * requests cannot be used to hammer the database, and bounded to 10 rows with
 * only the fields the search panel renders.
 */
export const searchProducts = async (query: string): Promise<ActionResult<SearchHit[]>> =>
  runAction("products.search", async () => {
    await enforceRateLimit({
      bucket: "search",
      subject: await clientKey("search"),
      limit: RATE_LIMITS.search.limit,
      windowMs: RATE_LIMITS.search.windowMs,
    });

    const { query: term } = parseInput(searchProductsSchema, { query });

    const results = await prisma.product.findMany({
      where: {
        OR: [
          {
            name: {
              contains: term,
              mode: "insensitive",
            },
          },
          {
            category: {
              name: {
                contains: term,
                mode: "insensitive",
              },
            },
          },
          {
            description: {
              contains: term,
              mode: "insensitive",
            },
          },
          {
            tag: {
              contains: term,
              mode: "insensitive",
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        thumbnail: true,
        price: true,
      },
      take: 10,
    });

    return results.map((product) => ({
      id: product.id,
      name: product.name,
      thumbnail: product.thumbnail,
      price: product.price.toFixed(2),
    }));
  });
