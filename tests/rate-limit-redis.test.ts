import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redis-enabled path. `@/lib/redis` is mocked so no connection is attempted;
 * the assertions are about the key layout and the INCR/PEXPIRE sequence.
 */

const redisMock = vi.hoisted(() => ({
  incr: vi.fn(async (_key: string): Promise<number> => 1),
  pexpire: vi.fn(async (_key: string, _ttlMs: number): Promise<number> => 1),
}));

vi.mock("@/lib/redis", () => ({
  isRedisEnabled: true,
  redis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    setWithTtl: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
    incr: redisMock.incr,
    pexpire: redisMock.pexpire,
  },
}));

type RateLimitModule = typeof import("@/lib/rate-limit");

let rateLimit: RateLimitModule;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** The fixed-window key the limiter is expected to build right now. */
const expectedKey = (bucket: string, subject: string, windowMs = 60_000): string =>
  `rl:${bucket}:${subject}:${Math.floor(Date.now() / windowMs)}`;

beforeEach(async () => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // 2026-01-01T00:00:00Z is aligned to minute, 15-minute and hour windows.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

  vi.resetModules();
  rateLimit = await import("@/lib/rate-limit");

  redisMock.incr.mockReset();
  redisMock.incr.mockImplementation(async () => 1);
  redisMock.pexpire.mockReset();
  redisMock.pexpire.mockImplementation(async () => 1);
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("checkRateLimit (redis)", () => {
  it("INCRs a fixed-window key and PEXPIREs it on the first hit", async () => {
    const result = await rateLimit.checkRateLimit({
      bucket: "login",
      subject: "203.0.113.10",
      limit: 5,
      windowMs: 60_000,
    });

    const key = expectedKey("login", "203.0.113.10");
    expect(redisMock.incr).toHaveBeenCalledTimes(1);
    expect(redisMock.incr).toHaveBeenCalledWith(key);
    expect(redisMock.pexpire).toHaveBeenCalledTimes(1);
    expect(redisMock.pexpire).toHaveBeenCalledWith(key, 60_000);
    expect(result).toEqual({ allowed: true, retryAfterS: 60, remaining: 4 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not refresh the TTL on later hits in the same window", async () => {
    redisMock.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const opts = {
      bucket: "login",
      subject: "203.0.113.11",
      limit: 5,
      windowMs: 60_000,
    };
    await rateLimit.checkRateLimit(opts);
    await rateLimit.checkRateLimit(opts);

    expect(redisMock.incr).toHaveBeenCalledTimes(2);
    expect(redisMock.pexpire).toHaveBeenCalledTimes(1);
  });

  it("allows the request that reaches the limit and blocks the next", async () => {
    vi.advanceTimersByTime(45_000);
    const opts = {
      bucket: "login",
      subject: "203.0.113.12",
      limit: 5,
      windowMs: 60_000,
    };

    redisMock.incr.mockResolvedValueOnce(5);
    await expect(rateLimit.checkRateLimit(opts)).resolves.toEqual({
      allowed: true,
      retryAfterS: 15,
      remaining: 0,
    });

    redisMock.incr.mockResolvedValueOnce(6);
    await expect(rateLimit.checkRateLimit(opts)).resolves.toEqual({
      allowed: false,
      retryAfterS: 15,
      remaining: 0,
    });
  });

  it("buckets keys by window and by bucket", async () => {
    const opts = {
      bucket: "login",
      subject: "203.0.113.13",
      limit: 5,
      windowMs: 60_000,
    };

    await rateLimit.checkRateLimit(opts);
    vi.advanceTimersByTime(30_000);
    await rateLimit.checkRateLimit(opts);

    // Same window: the same key is incremented twice.
    expect(redisMock.incr.mock.calls[0][0]).toBe(expectedKey("login", "203.0.113.13"));
    expect(redisMock.incr.mock.calls[1][0]).toBe(expectedKey("login", "203.0.113.13"));

    vi.advanceTimersByTime(30_000);
    await rateLimit.checkRateLimit(opts);
    await rateLimit.checkRateLimit({
      ...opts,
      bucket: "register",
      windowMs: 15 * 60_000,
    });

    const nextWindowKey = redisMock.incr.mock.calls[2][0];
    const otherBucketKey = redisMock.incr.mock.calls[3][0];
    expect(nextWindowKey).toBe(expectedKey("login", "203.0.113.13"));
    expect(nextWindowKey).not.toBe(redisMock.incr.mock.calls[0][0]);
    expect(otherBucketKey).toBe(
      expectedKey("register", "203.0.113.13", 15 * 60_000)
    );
  });

  it("fails open to the in-memory window when Redis throws", async () => {
    const opts = {
      bucket: "search",
      subject: "198.51.100.7",
      limit: 2,
      windowMs: 60_000,
    };
    redisMock.incr.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:6379"));

    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(rateLimit.checkRateLimit(opts)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });

    expect(redisMock.pexpire).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({
      event: "rate_limit_redis_fallback",
      reason: "redis_error",
    });

    // The warning must not leak the subject or the underlying connection error.
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain(opts.subject);
    expect(logged).not.toContain("ECONNREFUSED");
  });

  it("does not reject the caller when Redis throws", async () => {
    redisMock.incr.mockRejectedValue(new Error("socket closed"));

    await expect(
      rateLimit.checkRateLimit({
        bucket: "login",
        subject: "198.51.100.8",
        limit: 5,
        windowMs: 60_000,
      })
    ).resolves.toBeDefined();
  });
});
