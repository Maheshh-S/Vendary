import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deep health endpoint contract. Prisma and Redis are mocked: the tests pin
 * the status codes (DB down must fail the container, Redis is optional) and
 * that no connection detail leaks into the body or the log.
 */

const { dbMock, redisState } = vi.hoisted(() => ({
  dbMock: { queryRaw: vi.fn() },
  redisState: { enabled: false, ping: vi.fn() },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { $queryRaw: dbMock.queryRaw } }));
vi.mock("@/lib/redis", () => ({
  get isRedisEnabled() {
    return redisState.enabled;
  },
  redis: {
    ping: redisState.ping,
  },
}));

import { GET } from "@/app/api/status/route";

const originalEnv: Record<string, string | undefined> = {};

const body = async (response: Response) =>
  (await response.json()) as {
    status: string;
    checks: { db: string; redis: string };
    version: string;
    uptimeS: number;
  };

beforeEach(() => {
  vi.clearAllMocks();
  originalEnv.GIT_SHA = process.env.GIT_SHA;
  delete process.env.GIT_SHA;
  redisState.enabled = false;
  dbMock.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  redisState.ping.mockResolvedValue("PONG");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  const value = originalEnv.GIT_SHA;
  if (value === undefined) {
    delete process.env.GIT_SHA;
  } else {
    process.env.GIT_SHA = value;
  }
  vi.restoreAllMocks();
});

describe("/api/status", () => {
  it("returns 200 ok with db up and redis disabled", async () => {
    const response = await GET();
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toMatchObject({
      status: "ok",
      checks: { db: "up", redis: "disabled" },
      version: "dev",
    });
    expect(typeof payload.uptimeS).toBe("number");
    expect(dbMock.queryRaw).toHaveBeenCalledTimes(1);
    expect(redisState.ping).not.toHaveBeenCalled();
  });

  it("reports the configured Redis as up", async () => {
    redisState.enabled = true;

    const response = await GET();
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ status: "ok", checks: { db: "up", redis: "up" } });
    expect(redisState.ping).toHaveBeenCalledTimes(1);
  });

  it("stays 200/degraded when a configured Redis is down", async () => {
    redisState.enabled = true;
    redisState.ping.mockRejectedValue(new Error("connect ECONNREFUSED redis-internal:6379"));

    const response = await GET();
    const payload = await body(response);

    // Redis is a cache: its outage must not fail the healthcheck.
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ status: "degraded", checks: { db: "up", redis: "down" } });
    expect(JSON.stringify(payload)).not.toContain("redis-internal");
  });

  it("treats a non-PONG reply as down", async () => {
    redisState.enabled = true;
    redisState.ping.mockResolvedValue("LOADING");

    const payload = await body(await GET());

    expect(payload.checks.redis).toBe("down");
    expect(payload.status).toBe("degraded");
  });

  it("returns 503 error when the database is down", async () => {
    dbMock.queryRaw.mockRejectedValue(
      new Error("Can't reach database server at postgres-internal:5432")
    );

    const response = await GET();
    const payload = await body(response);

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({ status: "error", checks: { db: "down", redis: "disabled" } });
    expect(JSON.stringify(payload)).not.toContain("postgres-internal");
    // Redis is still probed when enabled; here it is disabled.
    expect(redisState.ping).not.toHaveBeenCalled();
  });

  it("exposes GIT_SHA as the version when provided", async () => {
    process.env.GIT_SHA = "abc1234";

    const payload = await body(await GET());

    expect(payload.version).toBe("abc1234");
  });

  it("logs a fixed reason code, never the connection error", async () => {
    dbMock.queryRaw.mockRejectedValue(new Error("postgres://user:password@internal:5432/db"));

    await GET();

    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('"check":"db"');
    expect(line).toContain('"reason":"error"');
    expect(line).not.toContain("password");
    expect(line).not.toContain("internal:5432");
  });
});
