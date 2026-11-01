"use server";

import type { ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { clientKey } from "@/lib/request-key";
import { runAction } from "@/lib/run-action";
import { searchCatalog } from "@/lib/search";
import { parseInput } from "@/lib/validation";
import { searchProductsSchema } from "@/schemas/products/search-schema";

export type SearchHit = import("@/lib/search").SearchHit;

/**
 * Public catalog search (Task 4.4). Rate limited per client before validation
 * so junk requests cannot be used to hammer the database. Ranking is done in
 * Postgres with pg_trgm; if the raw query is unavailable the same bounded
 * ILIKE query from the first implementation runs instead, so search never
 * fails because of a missing extension.
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

    const { hits, usedFallback } = await searchCatalog(prisma, term);
    if (usedFallback) {
      // Fixed reason code only: raw SQL errors can embed hosts/parameters.
      logger.warn("search_trigram_fallback", {
        event: "search_trigram_fallback",
        reason: "raw_query_failed",
      });
    }

    return hits;
  });
