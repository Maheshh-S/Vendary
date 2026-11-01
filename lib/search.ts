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
 * search is intentionally not part of relevance.
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
 * Runs the ranked query and degrades to ILIKE on any raw-query failure
 * (missing extension, restricted role, proxy that rejects the SQL). `usedFallback`
 * lets the action emit one redacted warning without logging the error payload.
 */
export const searchCatalog = async (
  db: PrismaClient,
  term: string
): Promise<{ hits: SearchHit[]; usedFallback: boolean }> => {
  try {
    return { hits: await trigramSearch(db, term), usedFallback: false };
  } catch {
    return { hits: await ilikeSearch(db, term), usedFallback: true };
  }
};
