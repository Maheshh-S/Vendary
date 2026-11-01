/**
 * Fixed-window rate limiting for abuse control.
 *
 * Redis is the source of truth across instances when `REDIS_URL` is set. When
 * Redis is absent or a call throws, the limiter falls back to a per-process
 * map and stays available (fail open): availability beats strictness for a
 * brute-force guard, and the in-memory window still enforces per instance.
 */

import { AppError } from "./errors";
import { logger } from "./logger";
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
  /** Upper bound on the Redis round trip; defaults to `REDIS_CALL_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * Upper bound on the Redis path. A blackholed/partitioned Redis must not make
 * the caller (e.g. login) wait on ioredis retries; past this bound the limiter
 * degrades to the in-memory window within the same request.
 */
export const REDIS_CALL_TIMEOUT_MS = 1000;

/** Limits from the phase plan. Every bucket is wired up at its call site. */
export const RATE_LIMITS = {
  login: { limit: 5, windowMs: 60_000 },
  register: { limit: 5, windowMs: 15 * 60_000 },
  createRazorpayOrder: { limit: 10, windowMs: 60_000 },
  search: { limit: 60, windowMs: 60_000 },
  addReview: { limit: 5, windowMs: 60 * 60_000 },
  adminMutation: { limit: 60, windowMs: 60_000 },
  /** Heart toggle: 60 adds/removes per user per minute. */
  wishlistToggle: { limit: 60, windowMs: 60_000 },
  /** Three reset-mail requests per address per hour (fixed window). */
  passwordResetEmail: { limit: 3, windowMs: 60 * 60_000 },
  /** A single IP can try ten different addresses per hour. */
  passwordResetIp: { limit: 10, windowMs: 60 * 60_000 },
  /** CSP violation reports: bursts are normal, sustained floods are not. */
  cspReport: { limit: 30, windowMs: 60_000 },
} as const;

type MemoryWindow = { count: number; expiresAt: number };

const memoryWindows = new Map<string, MemoryWindow>();

let lastFallbackWarningAt = 0;
const FALLBACK_WARNING_INTERVAL_MS = 60_000;

/**
 * One warning per minute per process. `reason` is a fixed code so a Redis
 * error message (which may contain a URL or host) and the request subject are
 * never passed to the logger.
 */
const warnFallback = (reason: "redis_disabled" | "redis_error" | "timeout", now: number): void => {
  if (now - lastFallbackWarningAt < FALLBACK_WARNING_INTERVAL_MS) {
    return;
  }
  lastFallbackWarningAt = now;
  logger.warn("rate_limit_redis_fallback", {
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

/** Distinguishes our own deadline from a Redis error so the reason is exact. */
class RedisTimeoutError extends Error {}

/**
 * Resolves with `operation` or rejects with `RedisTimeoutError` after
 * `timeoutMs`. The timer is always cleared, and `Promise.race` keeps a handler
 * on `operation`, so a late rejection after the deadline is not unhandled.
 */
const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedisTimeoutError("redis call timed out")), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
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
  timeoutMs = REDIS_CALL_TIMEOUT_MS,
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
    return await withTimeout(checkRedis(key, limit, windowMs, now, expiresAt), timeoutMs);
  } catch (error) {
    // A timed-out INCR may still land in Redis later; the memory window is
    // authoritative for this hit so the caller is never blocked past the bound.
    warnFallback(error instanceof RedisTimeoutError ? "timeout" : "redis_error", now);
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
