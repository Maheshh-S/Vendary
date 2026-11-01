import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 4.4 fallback path. The ranked pg_trgm query is mocked to fail exactly
 * like a database without the extension would; the action must run the old
 * ILIKE query, bound it to ten rows, and log a redacted reason code only.
 */

const { prismaMock, rateLimitMock, clientKeyMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    product: { findMany: vi.fn() },
  },
  rateLimitMock: vi.fn(),
  clientKeyMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  RATE_LIMITS: { search: { limit: 60, windowMs: 60_000 } },
}));
vi.mock("@/lib/request-key", () => ({ clientKey: clientKeyMock }));

import { Prisma } from "@prisma/client";

import { searchProducts } from "@/actions/products/search";
import type { ActionResult } from "@/lib/action-result";
import { SEARCH_RESULT_LIMIT } from "@/lib/search";

const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  }
  return result.data;
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue(undefined);
  clientKeyMock.mockResolvedValue("ip:127.0.0.1");
  consoleWarn.mockImplementation(() => {});
});

afterAll(() => {
  consoleWarn.mockRestore();
});

describe("searchProducts ILIKE fallback", () => {
  it("runs the bounded legacy query when the trigram query fails", async () => {
    prismaMock.$queryRaw.mockRejectedValue(
      new Error("function similarity(text, text) does not exist")
    );
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: "prod_1",
        name: "Pashmina Shawl",
        thumbnail: "https://images.unsplash.com/photo-shawl",
        price: new Prisma.Decimal("1200.50"),
      },
    ]);

    const data = expectSuccess(await searchProducts("  shawl  "));

    expect(data).toEqual([
      {
        id: "prod_1",
        name: "Pashmina Shawl",
        thumbnail: "https://images.unsplash.com/photo-shawl",
        price: "1200.50",
      },
    ]);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.product.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: "shawl", mode: "insensitive" } },
          { category: { name: { contains: "shawl", mode: "insensitive" } } },
          { description: { contains: "shawl", mode: "insensitive" } },
          { tag: { contains: "shawl", mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, thumbnail: true, price: true },
      take: SEARCH_RESULT_LIMIT,
    });
    expect(SEARCH_RESULT_LIMIT).toBe(10);
  });

  it("logs only a fixed reason code, never the raw SQL error", async () => {
    prismaMock.$queryRaw.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres://vendor:secret@db.internal:5432")
    );
    prismaMock.product.findMany.mockResolvedValue([]);

    expectSuccess(await searchProducts("vase"));

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    const line = String(consoleWarn.mock.calls[0][0]);
    const payload = JSON.parse(line) as Record<string, unknown>;
    expect(payload.event).toBe("search_trigram_fallback");
    expect(payload.reason).toBe("raw_query_failed");
    expect(line).not.toContain("ECONNREFUSED");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("db.internal");
  });
});
