import { redis } from "@/lib/redis";

export const CACHE_TTL_SECONDS = {
  featured: 600,
  basicDetails: 300,
  recommendations: 600,
};

/**
 * Cache keys for product-derived data. v3: the featured list now filters on
 * `isFeatured`, so entries cached before that filter can never be served.
 */
export const FEATURED_PRODUCTS_KEY = "featured-products:v3";
export const productBasicDetailsKey = (productId: string) =>
  `product-basic-details:v2:${productId}`;
/** Also-bought list for one product (Task 4.5). */
export const recommendationsKey = (productId: string) => `recommendations:${productId}:v1`;

/**
 * Purges every cached view derived from a product. Call after any product
 * mutation; pass the productId to also drop its detail and recommendation
 * caches. Recommendation lists also depend on other products and on new
 * orders, so per-product invalidation is best-effort; the 600s TTL bounds
 * whatever a mutation cannot reach.
 *
 * Cache outages must never break the mutation, so failures are swallowed with
 * a log.
 */
export async function invalidateProductCache(productId?: string) {
  const keys = productId
    ? [FEATURED_PRODUCTS_KEY, productBasicDetailsKey(productId), recommendationsKey(productId)]
    : [FEATURED_PRODUCTS_KEY];

  for (const key of keys) {
    try {
      await redis.del(key);
    } catch (cacheError) {
      console.error(`Cache invalidation failed for ${key}:`, cacheError);
    }
  }
}
