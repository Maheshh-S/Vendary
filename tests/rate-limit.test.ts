import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Memory-path tests. The Redis client is mocked as disabled so the limiter
 * exercises its in-memory fallback; the Redis-enabled path lives in
 * `tests/rate-limit-redis.test.ts`.
 */

const headerStore = vi.hoisted(() => ({ forwardedFor: null as string | null }));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === "x-forwarded-for" ? headerStore.forwardedFor : null,
  }),
}));

vi.mock("@/lib/redis", () => ({
  isRedisEnabled: false,
  redis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    setWithTtl: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    pexpire: vi.fn(async () => 1),
  },
}));

type RateLimitModule = typeof import("@/lib/rate-limit");
type RequestKeyModule = typeof import("@/lib/request-key");

let rateLimit: RateLimitModule;
let requestKey: RequestKeyModule;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Fixed-window logic depends on the clock; pin it to a window-aligned instant
  // so no test can straddle a boundary by accident.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  headerStore.forwardedFor = null;

  // Fresh module state per test (memory buckets + fallback-warning throttle).
  vi.resetModules();
  rateLimit = await import("@/lib/rate-limit");
  requestKey = await import("@/lib/request-key");
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
});

describe("checkRateLimit (memory fallback)", () => {
  it("allows up to the limit and blocks the next attempt", async () => {
    const opts = {
      bucket: "login",
      subject: "203.0.113.1",
      limit: 3,
      windowMs: 60_000,
    };

    for (let i = 0; i < 3; i++) {
      await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({
        allowed: true,
      });
    }

    await expect(rateLimit.checkRateLimit(opts)).resolves.toEqual({
      allowed: false,
      retryAfterS: 60,
      remaining: 0,
    });
  });

  it("reports the decreasing remaining budget", async () => {
    const opts = {
      bucket: "login",
      subject: "203.0.113.2",
      limit: 3,
      windowMs: 60_000,
    };

    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({ remaining: 2 });
    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({ remaining: 1 });
    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({ remaining: 0 });
    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("isolates subjects and buckets", async () => {
    const login = (subject: string) =>
      rateLimit.checkRateLimit({ bucket: "login", subject, limit: 2, windowMs: 60_000 });

    await login("203.0.113.3");
    await login("203.0.113.3");
    await expect(login("203.0.113.3")).resolves.toMatchObject({ allowed: false });

    // A different subject has its own budget.
    await expect(login("203.0.113.4")).resolves.toMatchObject({ allowed: true });

    // The same subject in a different bucket has its own budget too.
    await expect(
      rateLimit.checkRateLimit({
        bucket: "register",
        subject: "203.0.113.3",
        limit: 2,
        windowMs: 60_000,
      })
    ).resolves.toMatchObject({ allowed: true });
  });

  it("frees the bucket once the window has passed", async () => {
    const opts = {
      bucket: "login",
      subject: "203.0.113.5",
      limit: 2,
      windowMs: 60_000,
    };

    await rateLimit.checkRateLimit(opts);
    await rateLimit.checkRateLimit(opts);
    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({ allowed: false });

    vi.advanceTimersByTime(60_001);

    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({ allowed: true });
  });

  it("derives retryAfterS from the current window's remainder", async () => {
    const opts = {
      bucket: "login",
      subject: "203.0.113.6",
      limit: 1,
      windowMs: 60_000,
    };

    await rateLimit.checkRateLimit(opts);
    vi.advanceTimersByTime(30_000);

    await expect(rateLimit.checkRateLimit(opts)).resolves.toEqual({
      allowed: false,
      retryAfterS: 30,
      remaining: 0,
    });
  });

  it("logs one structured fallback warning per minute, without request identifiers", async () => {
    const opts = {
      bucket: "login",
      subject: "203.0.113.7",
      limit: 10,
      windowMs: 60_000,
    };

    for (let i = 0; i < 5; i++) {
      await rateLimit.checkRateLimit(opts);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The logger emits one JSON line (single console.warn argument).
    const entry = JSON.parse(String(warnSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "warn",
      msg: "rate_limit_redis_fallback",
      event: "rate_limit_redis_fallback",
      reason: "redis_disabled",
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(opts.subject);

    vi.advanceTimersByTime(60_001);
    await rateLimit.checkRateLimit(opts);

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("enforceRateLimit", () => {
  it("rejects with a typed RATE_LIMITED AppError once the limit is hit", async () => {
    const opts = {
      bucket: "login",
      subject: "203.0.113.8",
      limit: 1,
      windowMs: 60_000,
    };

    await expect(rateLimit.enforceRateLimit(opts)).resolves.toBeUndefined();

    await expect(rateLimit.enforceRateLimit(opts)).rejects.toMatchObject({
      name: "AppError",
      code: "RATE_LIMITED",
    });
    await expect(rateLimit.enforceRateLimit(opts)).rejects.toThrow(
      /^Too many attempts\. Please try again in \d+s\.$/
    );
  });
});

describe("clientKey", () => {
  it("uses the first x-forwarded-for hop", async () => {
    headerStore.forwardedFor = "203.0.113.9, 10.0.0.1, 10.0.0.2";

    await expect(requestKey.clientKey("login")).resolves.toBe("203.0.113.9");
  });

  it("falls back to 'unknown' when the header is absent or blank", async () => {
    await expect(requestKey.clientKey("login")).resolves.toBe("unknown");
    headerStore.forwardedFor = "  ";
    await expect(requestKey.clientKey("login")).resolves.toBe("unknown");
  });

  it("prefers the user identity when a userId is provided", async () => {
    headerStore.forwardedFor = "203.0.113.9";

    await expect(requestKey.clientKey("adminMutation", "user_123")).resolves.toBe("user:user_123");
  });

  it("returns the bare subject so the limiter owns bucket namespacing", async () => {
    headerStore.forwardedFor = "203.0.113.9";

    const subject = await requestKey.clientKey("login");

    expect(subject).toBe("203.0.113.9");
    expect(subject).not.toContain("login");
  });
});
