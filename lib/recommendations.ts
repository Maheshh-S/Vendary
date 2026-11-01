import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { CACHE_TTL_SECONDS, recommendationsKey } from "@/lib/product-cache";
import { redis } from "@/lib/redis";

/**
 * "Customers also bought" recommendations (Task 4.5).
 *
 * Co-occurrence is derived from `OrderItem` itself: other products that appear
 * in the same paid orders as the current product, ranked by how many distinct
 * orders they share. Only products that are in stock right now are eligible,
 * and the current product is excluded. Paid statuses only — a pending order is
 * an abandoned checkout, not a purchase.
 *
 * A cold catalog has no co-purchases, so an empty (or failing) co-occurrence
 * query falls back to featured/in-stock products. The result is cached per
 * product under `recommendations:<id>:v1` for 600s; `invalidateProductCache`
 * drops it on product mutations. A Redis outage degrades to the database.
 */

export const RECOMMENDATION_LIMIT = 4;
/** Co-occurrence rows scanned before ranking; bounds a very popular product. */
export const RECOMMENDATION_SCAN_LIMIT = 12;
const MAX_PRODUCT_ID_LENGTH = 64;

/** "Bought" means the order actually collected money. */
const PAID_ORDER_STATUSES = ["confirmed", "shipped", "delivered"] as const;

export type RecommendationCard = {
  id: string;
  name: string;
  imageSrc: string | null;
  price: number;
  imageAlt: string | null;
};

export type RawCoPurchaseRow = {
  productId: string;
  name: string;
  thumbnail: string | null;
  shortDescription: string | null;
  /** Prisma Decimal from the raw select, or a string/number in tests. */
  price: { toNumber?: () => number; toString(): string } | string | number;
  coPurchases: number | bigint;
};

const toCount = (value: number | bigint): number => {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
};

/** Rupee Decimal/string/number to a plain rupee number for display. */
const toRupees = (price: RawCoPurchaseRow["price"]): number => {
  if (price !== null && typeof price === "object" && typeof price.toNumber === "function") {
    return price.toNumber();
  }
  const value = Number(price);
  return Number.isFinite(value) ? value : 0;
};

const byProductId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ranks co-purchase rows by shared-order count (descending), then product id.
 * The current product is excluded defensively even though the SQL filters it,
 * and the list is capped so a caller can never render an unbounded grid.
 */
export const rankCoPurchases = (
  rows: readonly RawCoPurchaseRow[],
  currentProductId: string,
  limit: number = RECOMMENDATION_LIMIT
): RawCoPurchaseRow[] =>
  rows
    .filter((row) => row.productId !== currentProductId)
    .sort(
      (a, b) =>
        toCount(b.coPurchases) - toCount(a.coPurchases) || byProductId(a.productId, b.productId)
    )
    .slice(0, Math.max(0, limit));

const toCard = (row: RawCoPurchaseRow): RecommendationCard => ({
  id: row.productId,
  name: row.name,
  imageSrc: row.thumbnail,
  price: toRupees(row.price),
  imageAlt: row.shortDescription,
});

type FallbackRow = {
  id: string;
  name: string;
  thumbnail: string | null;
  shortDescription: string | null;
  price: RawCoPurchaseRow["price"];
};

const toFallbackCard = (row: FallbackRow): RecommendationCard => ({
  id: row.id,
  name: row.name,
  imageSrc: row.thumbnail,
  price: toRupees(row.price),
  imageAlt: row.shortDescription,
});

/**
 * Co-purchase aggregates, bounded twice: one product id parameter, paid orders
 * only, in-stock products only, and a scan limit before JS ranking.
 */
const queryCoPurchases = async (db: PrismaClient, productId: string): Promise<RawCoPurchaseRow[]> =>
  db.$queryRaw<RawCoPurchaseRow[]>`
    SELECT
      p."id" AS "productId",
      p."name",
      p."thumbnail",
      p."shortDescription",
      p."price",
      COUNT(DISTINCT oi_other."orderId")::int AS "coPurchases"
    FROM "OrderItem" oi_self
    JOIN "OrderItem" oi_other
      ON oi_other."orderId" = oi_self."orderId"
     AND oi_other."productId" <> oi_self."productId"
    JOIN "Order" o ON o."id" = oi_self."orderId"
    JOIN "Product" p ON p."id" = oi_other."productId"
    WHERE oi_self."productId" = ${productId}
      AND oi_other."productId" IS NOT NULL
      AND o."status"::text IN (${Prisma.join([...PAID_ORDER_STATUSES])})
      AND p."availability"::text = 'IN_STOCK'
    GROUP BY p."id", p."name", p."thumbnail", p."shortDescription", p."price"
    ORDER BY "coPurchases" DESC, p."id" ASC
    LIMIT ${RECOMMENDATION_SCAN_LIMIT}
  `;

/**
 * Cold-start fallback: featured first, then newest, always in stock and never
 * the product being viewed.
 */
const queryFallback = async (
  db: PrismaClient,
  productId: string,
  limit: number = RECOMMENDATION_LIMIT
): Promise<RecommendationCard[]> => {
  const rows = await db.product.findMany({
    where: { availability: "IN_STOCK", id: { not: productId } },
    orderBy: [{ isFeatured: "desc" }, { createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      name: true,
      thumbnail: true,
      shortDescription: true,
      price: true,
    },
  });

  return rows.map(toFallbackCard);
};

const readCached = async (key: string): Promise<RecommendationCard[] | null> => {
  try {
    const cached = await redis.get(key);
    if (!cached) {
      return null;
    }
    const parsed: unknown = JSON.parse(cached);
    return Array.isArray(parsed) ? (parsed as RecommendationCard[]) : null;
  } catch (cacheError) {
    // A malformed entry or a cache outage must fall through to the database.
    console.error("Recommendations cache read failed:", cacheError);
    return null;
  }
};

const writeCached = async (key: string, cards: RecommendationCard[]): Promise<void> => {
  try {
    await redis.setWithTtl(key, JSON.stringify(cards), CACHE_TTL_SECONDS.recommendations);
  } catch (cacheError) {
    // The page still renders from the fresh result.
    console.error("Recommendations cache write failed:", cacheError);
  }
};

/**
 * Recommendations for the product detail page. Never throws: a recommendation
 * failure hides the section instead of taking down the product page.
 */
export const getAlsoBought = async (
  productId: string,
  db: PrismaClient = prisma
): Promise<RecommendationCard[]> => {
  const id = productId.trim();
  if (!id || id.length > MAX_PRODUCT_ID_LENGTH) {
    return [];
  }

  const key = recommendationsKey(id);
  const cached = await readCached(key);
  if (cached) {
    return cached;
  }

  let cards: RecommendationCard[];
  try {
    const ranked = rankCoPurchases(await queryCoPurchases(db, id), id, RECOMMENDATION_LIMIT);
    cards = ranked.length > 0 ? ranked.map(toCard) : await queryFallback(db, id);
  } catch (error) {
    // A broken co-occurrence query (or a cold table) still has the featured
    // fallback; only a total database failure hides the section.
    console.error("Recommendations query failed:", error);
    try {
      cards = await queryFallback(db, id);
    } catch (fallbackError) {
      console.error("Recommendations fallback failed:", fallbackError);
      return [];
    }
  }

  await writeCached(key, cards);
  return cards;
};
