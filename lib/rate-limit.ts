/**
 * Best-effort in-memory sliding-window rate limiter for the auth endpoints
 * (login brute force, verification-email cost abuse).
 *
 * Honest limitation: on serverless platforms each instance has its own
 * memory, so this is per-instance protection — it raises the bar for abuse
 * without central coordination. The upgrade path when Redis is provisioned is
 * swapping the Map for Upstash Ratelimiter behind the same interface.
 */

const buckets = new Map<string, number[]>()

export const enforceRateLimit = ({
  key,
  limit,
  windowMs,
}: {
  key: string
  limit: number
  windowMs: number
}): void => {
  const now = Date.now()
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)

  if (recent.length >= limit) {
    const retryAfterS = Math.ceil((windowMs - (now - recent[0])) / 1000)
    throw new Error(`Too many attempts. Please try again in ${retryAfterS}s.`)
  }

  recent.push(now)
  buckets.set(key, recent)

  // Opportunistic cleanup so abandoned keys don't grow the map forever.
  if (buckets.size > 1000) {
    for (const [k, timestamps] of buckets) {
      if (timestamps.every((t) => now - t >= windowMs)) {
        buckets.delete(k)
      }
    }
  }
}
