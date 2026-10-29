import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceRateLimit } from "@/lib/rate-limit";

describe("enforceRateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the limit and blocks the next attempt", () => {
    for (let i = 0; i < 3; i++) {
      expect(() =>
        enforceRateLimit({ key: "k1", limit: 3, windowMs: 60_000 })
      ).not.toThrow();
    }
    expect(() => enforceRateLimit({ key: "k1", limit: 3, windowMs: 60_000 }))
      .toThrowError(/Too many attempts.*try again in \d+s/);
  });

  it("isolates keys", () => {
    for (let i = 0; i < 3; i++) {
      enforceRateLimit({ key: "kA", limit: 3, windowMs: 60_000 });
    }
    expect(() => enforceRateLimit({ key: "kB", limit: 3, windowMs: 60_000 })).not.toThrow();
  });

  it("frees the bucket once the window has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let i = 0; i < 3; i++) {
      enforceRateLimit({ key: "k2", limit: 3, windowMs: 60_000 });
    }
    expect(() => enforceRateLimit({ key: "k2", limit: 3, windowMs: 60_000 })).toThrow();

    vi.advanceTimersByTime(61_000);
    expect(() => enforceRateLimit({ key: "k2", limit: 3, windowMs: 60_000 })).not.toThrow();
  });

  it("reports retry-after based on the oldest hit in the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    enforceRateLimit({ key: "k3", limit: 1, windowMs: 60_000 });
    vi.advanceTimersByTime(30_000);
    try {
      enforceRateLimit({ key: "k3", limit: 1, windowMs: 60_000 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("try again in 30s");
    }
  });
});
