/**
 * Fixed-window rate limiting for abuse control.
 *
 * Redis is the source of truth across instances when `REDIS_URL` is set. When
 * Redis is absent or a call throws, the limiter falls back to a per-process
 * map and stays available (fail open): availability beats strictness for a
 * brute-force guard, and the in-memory window still enforces per instance.
 */

import { AppError } from "./errors";
import { isRedisEnabled, redis } from "./redis";

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the current window resets. */
  retryAfterS: number;
  remaining: number;
};

export type RateLimitOptions = {
  bucket: string;
  subject: string;
  limit: number;
  windowMs: number;
};

/** Limits from the phase plan. Only the auth ones are wired up today. */
export const RATE_LIMITS = {
  login: { limit: 5, windowMs: 60_000 },
  register: { limit: 5, windowMs: 15 * 60_000 },
  createRazorpayOrder: { limit: 10, windowMs: 60_000 },
  search: { limit: 60, windowMs: 60_000 },
  addReview: { limit: 5, windowMs: 60 * 60_000 },
  adminMutation: { limit: 60, windowMs: 60_000 },
} as const;

type MemoryWindow = { count: number; expiresAt: number };

const memoryWindows = new Map<string, MemoryWindow>();

let lastFallbackWarningAt = 0;
const FALLBACK_WARNING_INTERVAL_MS = 60_000;

/**
 * One warning per minute per process. `reason` is a fixed code so a Redis
 * error message (which may contain a URL or host) is never logged.
 */
const warnFallback = (reason: "redis_disabled" | "redis_error", now: number): void => {
  if (now - lastFallbackWarningAt < FALLBACK_WARNING_INTERVAL_MS) {
    return;
  }
  lastFallbackWarningAt = now;
  console.warn("[rate-limit] Redis unavailable; enforcing in-memory fallback.", {
    event: "rate_limit_redis_fallback",
    reason,
  });
};

const toResult = (
  count: number,
  limit: number,
  now: number,
  expiresAt: number
): RateLimitResult => ({
  allowed: count <= limit,
  retryAfterS: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
  remaining: Math.max(0, limit - count),
});

const checkMemory = (
  key: string,
  limit: number,
  now: number,
  expiresAt: number
): RateLimitResult => {
  const existing = memoryWindows.get(key);
  const count = (existing && existing.expiresAt > now ? existing.count : 0) + 1;
  memoryWindows.set(key, { count, expiresAt });

  // Opportunistic cleanup so abandoned keys don't grow the map forever.
  if (memoryWindows.size > 1000) {
    for (const [k, window] of memoryWindows) {
      if (window.expiresAt <= now) {
        memoryWindows.delete(k);
      }
    }
  }

  return toResult(count, limit, now, expiresAt);
};

/**
 * Redis path. `INCR` and `PEXPIRE` are two round trips rather than a Lua
 * script, so a crash between them can leave a counter without a TTL. That is
 * acceptable for abuse control: the key embeds the window index and is never
 * read again once the window passes (worst case is a leaked key, not a wrong
 * decision).
 */
const checkRedis = async (
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  expiresAt: number
): Promise<RateLimitResult> => {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, windowMs);
  }
  return toResult(count, limit, now, expiresAt);
};

/**
 * Counts one hit for `subject` in `bucket` and reports whether it is allowed.
 * The key is `rl:{bucket}:{subject}:{windowIndex}` — `subject` must therefore
 * be bare (see `clientKey` in `lib/request-key.ts`).
 */
export const checkRateLimit = async ({
  bucket,
  subject,
  limit,
  windowMs,
}: RateLimitOptions): Promise<RateLimitResult> => {
  const now = Date.now();
  const windowIndex = Math.floor(now / windowMs);
  const key = `rl:${bucket}:${subject}:${windowIndex}`;
  const expiresAt = (windowIndex + 1) * windowMs;

  if (!isRedisEnabled) {
    warnFallback("redis_disabled", now);
    return checkMemory(key, limit, now, expiresAt);
  }

  try {
    return await checkRedis(key, limit, windowMs, now, expiresAt);
  } catch {
    warnFallback("redis_error", now);
    return checkMemory(key, limit, now, expiresAt);
  }
};

/** Throwing wrapper for call sites that fail the whole request on rejection. */
export const enforceRateLimit = async (options: RateLimitOptions): Promise<void> => {
  const result = await checkRateLimit(options);
  if (!result.allowed) {
    throw new AppError(
      "RATE_LIMITED",
      `Too many attempts. Please try again in ${result.retryAfterS}s.`
    );
  }
};
