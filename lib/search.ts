import "server-only";

import type { PrismaClient } from "@prisma/client";

/**
 * Catalog search v2 (Task 4.4). pg_trgm similarity ranks typo-tolerant matches;
 * ILIKE still decides plain substring matches and remains the complete query
 * when the extension/raw SQL is unavailable. Every statement is parameterized
 * by `$queryRaw` and bounded to ten rows.
 */

export type SearchHit = {
  id: string;
  name: string;
  thumbnail: string | null;
  price: string;
};

export const SEARCH_RESULT_LIMIT = 10;

type RawSearchRow = {
  id: string;
  name: string;
  thumbnail: string | null;
  /** Prisma Decimal from the raw select, or a string/number in tests. */
  price: { toString(): string } | string | number;
};

const toPrice = (value: RawSearchRow["price"]): string => Number(value.toString()).toFixed(2);

const toHit = (row: RawSearchRow): SearchHit => ({
  id: row.id,
  name: row.name,
  thumbnail: row.thumbnail,
  price: toPrice(row.price),
});

/**
 * Ranked search. Ordering, in priority order:
 * 1. exact (case-insensitive) name match,
 * 2. exact tag match,
 * 3. name prefix, then name substring,
 * 4. trigram similarity of name/tag (typos such as "madhuani").
 *
 * The `WHERE` keeps description substring matches from the previous
 * implementation but stays on `Product` columns only: a predicate referencing
 * `Category` would force a join filter and defeat every trigram index. The
 * fuzzy arms use the indexable `%` operator (pg_trgm's default 0.3 threshold)
 * and the exact `similarity()` score is used for ordering. Category-name
 * matches are a separate bounded query appended in `searchCatalog`.
 */
export const trigramSearch = async (db: PrismaClient, term: string): Promise<SearchHit[]> => {
  const substring = `%${term}%`;
  const prefix = `${term}%`;
  const needle = term.toLowerCase();

  const rows = await db.$queryRaw<RawSearchRow[]>`
    SELECT
      p."id",
      p."name",
      p."thumbnail",
      p."price",
      GREATEST(
        similarity(lower(p."name"), ${needle}),
        similarity(lower(COALESCE(p."tag", '')), ${needle})
      ) AS "score"
    FROM "Product" p
    WHERE p."name" ILIKE ${substring}
       OR p."tag" ILIKE ${substring}
       OR p."description" ILIKE ${substring}
       OR p."name" % ${needle}
       OR p."tag" % ${needle}
    ORDER BY
      (lower(p."name") = ${needle}) DESC,
      (lower(COALESCE(p."tag", '')) = ${needle}) DESC,
      (p."name" ILIKE ${prefix}) DESC,
      (p."name" ILIKE ${substring}) DESC,
      "score" DESC,
      p."name" ASC
    LIMIT ${SEARCH_RESULT_LIMIT}
  `;

  return rows.map(toHit);
};

/**
 * Pre-pg_trgm query, kept verbatim as the runtime fallback: same fields, same
 * bound, case-insensitive substring matches across name/category/description/tag.
 */
export const ilikeSearch = async (db: PrismaClient, term: string): Promise<SearchHit[]> => {
  const rows = await db.product.findMany({
    where: {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { category: { name: { contains: term, mode: "insensitive" } } },
        { description: { contains: term, mode: "insensitive" } },
        { tag: { contains: term, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      thumbnail: true,
      price: true,
    },
    take: SEARCH_RESULT_LIMIT,
  });

  return rows.map(toHit);
};

/**
 * Category-name matches for the primary path. A separate, bounded, in-stock
 * query: adding a Category arm to the ranked SQL would force a join filter and
 * defeat the trigram indexes. The ILIKE fallback already covers categories, so
 * this only runs after a successful ranked query with slots left.
 */
export const categoryNameSearch = async (
  db: PrismaClient,
  term: string,
  excludeIds: readonly string[],
  take: number = SEARCH_RESULT_LIMIT
): Promise<SearchHit[]> => {
  if (take <= 0) {
    return [];
  }

  const rows = await db.product.findMany({
    where: {
      availability: "IN_STOCK",
      category: { name: { contains: term, mode: "insensitive" } },
      ...(excludeIds.length > 0 ? { id: { notIn: [...excludeIds] } } : {}),
    },
    select: {
      id: true,
      name: true,
      thumbnail: true,
      price: true,
    },
    orderBy: { name: "asc" },
    take: Math.min(take, SEARCH_RESULT_LIMIT),
  });

  return rows.map(toHit);
};

/** First occurrence wins, so ranked hits keep their position over appends. */
const dedupeHits = (hits: readonly SearchHit[]): SearchHit[] => {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.id)) {
      return false;
    }
    seen.add(hit.id);
    return true;
  });
};

/**
 * Runs the ranked query and degrades to ILIKE on any raw-query failure
 * (missing extension, restricted role, proxy that rejects the SQL). When the
 * ranked query leaves slots, a bounded category-name query is appended and
 * deduped; the total stays capped at ten. `usedFallback` lets the action emit
 * one redacted warning without logging the error payload.
 */
export const searchCatalog = async (
  db: PrismaClient,
  term: string
): Promise<{ hits: SearchHit[]; usedFallback: boolean }> => {
  try {
    const ranked = await trigramSearch(db, term);
    const remaining = SEARCH_RESULT_LIMIT - ranked.length;
    const categoryHits =
      remaining > 0
        ? await categoryNameSearch(
            db,
            term,
            ranked.map((hit) => hit.id),
            remaining
          )
        : [];

    return {
      hits: dedupeHits([...ranked, ...categoryHits]).slice(0, SEARCH_RESULT_LIMIT),
      usedFallback: false,
    };
  } catch {
    return { hits: await ilikeSearch(db, term), usedFallback: true };
  }
};
