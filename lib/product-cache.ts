import { redis } from "@/lib/redis"

export const CACHE_TTL_SECONDS = {
  featured: 600,
  basicDetails: 300,
}

/**
 * Cache keys for product-derived data. v2: bumped when the Product shape
 * changed (availability rename) so pre-rename entries can never be served.
 */
export const FEATURED_PRODUCTS_KEY = "featured-products:v2"
export const productBasicDetailsKey = (productId: string) =>
  `product-basic-details:v2:${productId}`

/**
 * Purges every cached view derived from a product. Call after any product
 * mutation; pass the productId to also drop its detail cache. Cache outages
 * must never break the mutation, so failures are swallowed with a log.
 */
export async function invalidateProductCache(productId?: string) {
  const keys = productId
    ? [FEATURED_PRODUCTS_KEY, productBasicDetailsKey(productId)]
    : [FEATURED_PRODUCTS_KEY]

  for (const key of keys) {
    try {
      await redis.del(key)
    } catch (cacheError) {
      console.error(`Cache invalidation failed for ${key}:`, cacheError)
    }
  }
}
