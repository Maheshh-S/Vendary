import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cleanup cron contract. Prisma is mocked at the boundary; `writeOrderEvent`
 * runs for real so the tests pin the exact audit event (type, actor null,
 * metadata source) and the guarded update that makes replays safe.
 */

const { prismaMock, txMock, invalidateMock } = vi.hoisted(() => {
  const txMock = {
    order: { updateMany: vi.fn() },
    orderEvent: { create: vi.fn() },
    coupon: { updateMany: vi.fn() },
    couponRedemption: { findUnique: vi.fn(), deleteMany: vi.fn() },
  };
  return {
    txMock,
    prismaMock: {
      order: { findMany: vi.fn() },
      address: { deleteMany: vi.fn() },
      $transaction: vi.fn(),
    },
    invalidateMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/product-cache", () => ({ invalidateProductCache: invalidateMock }));

import { GET, POST } from "@/app/api/cron/cleanup/route";

const SECRET = "cron-test-secret";
const originalSecret = process.env.CRON_SECRET;

const authorizedRequest = (method = "POST") =>
  new Request("https://vendary.test/api/cron/cleanup", {
    method,
    headers: { authorization: `Bearer ${SECRET}` },
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;

  prismaMock.order.findMany.mockResolvedValue([]);
  prismaMock.address.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) =>
    callback(txMock)
  );
  txMock.order.updateMany.mockResolvedValue({ count: 1 });
  txMock.orderEvent.create.mockResolvedValue({ id: "event_1" });
  // Abandoned orders without a coupon have no redemption to release.
  txMock.couponRedemption.findUnique.mockResolvedValue(null);
  txMock.couponRedemption.deleteMany.mockResolvedValue({ count: 0 });
  txMock.coupon.updateMany.mockResolvedValue({ count: 0 });
  invalidateMock.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalSecret;
  }
  vi.restoreAllMocks();
});

describe("cleanup authorization", () => {
  it("returns 501 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("CRON_SECRET") });
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
    expect(prismaMock.address.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["wrong", { authorization: "Bearer not-the-secret" }],
    ["wrong scheme", { authorization: `Basic ${SECRET}` }],
  ])("returns 401 for a %s authorization header", async (_label, headers) => {
    const response = await POST(
      new Request("https://vendary.test/api/cron/cleanup", { method: "POST", headers })
    );

    expect(response.status).toBe(401);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
    expect(prismaMock.address.deleteMany).not.toHaveBeenCalled();
  });

  it("accepts GET as a scheduler alias", async () => {
    const response = await GET(authorizedRequest("GET"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelledOrders: 0, deletedAddresses: 0 });
  });
});

describe("stale pending orders", () => {
  it("cancels only orders that are still pending and unpaid past the cutoff", async () => {
    const before = Date.now();
    prismaMock.order.findMany.mockResolvedValue([{ id: "order_old_1" }, { id: "order_old_2" }]);
    // Second order lost a race (captured or cancelled in between): the guarded
    // update claims nothing and no event is written for it.
    txMock.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    prismaMock.address.deleteMany.mockResolvedValue({ count: 3 });
    const after = Date.now();

    const response = await POST(authorizedRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ cancelledOrders: 1, deletedAddresses: 3 });

    const query = prismaMock.order.findMany.mock.calls[0][0] as {
      where: Record<string, unknown> & { createdAt: { lt: Date } };
      take: number;
    };
    expect(query.where).toMatchObject({ status: "pending", paymentId: "" });
    const cutoff = query.where.createdAt.lt.getTime();
    // 60 minutes, with scheduling slack between the clock reads.
    expect(cutoff).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 5);
    expect(cutoff).toBeLessThanOrEqual(after - 60 * 60 * 1000 + 5);

    expect(txMock.order.updateMany).toHaveBeenCalledTimes(2);
    expect(txMock.order.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "order_old_1", status: "pending", paymentId: "" },
      data: { status: "cancelled" },
    });
    // Only the claimed order gets the audit event.
    expect(txMock.orderEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.orderEvent.create).toHaveBeenCalledWith({
      data: {
        orderId: "order_old_1",
        type: "order_cancelled",
        fromStatus: "pending",
        toStatus: "cancelled",
        actorId: null,
        metadata: { source: "cleanup" },
      },
    });

    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });

  it("releases the coupon redemption of a cancelled abandoned checkout", async () => {
    prismaMock.order.findMany.mockResolvedValue([{ id: "order_old_1" }]);
    txMock.couponRedemption.findUnique.mockResolvedValue({
      id: "redemption_1",
      couponId: "coupon_1",
    });
    txMock.coupon.updateMany.mockResolvedValue({ count: 1 });
    txMock.couponRedemption.deleteMany.mockResolvedValue({ count: 1 });

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelledOrders: 1, deletedAddresses: 0 });
    expect(txMock.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: "coupon_1", usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
    expect(txMock.couponRedemption.deleteMany).toHaveBeenCalledWith({
      where: { id: "redemption_1" },
    });
  });

  it("never touches orders with a recorded payment proof", async () => {
    await POST(authorizedRequest());

    const query = prismaMock.order.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(query.where.paymentId).toBe("");
    // No confirmed/shipped/delivered/refunded status is ever selected.
    expect(query.where.status).toBe("pending");
  });

  it("is idempotent: a rerun with nothing stale writes nothing", async () => {
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.address.deleteMany.mockResolvedValue({ count: 0 });

    const first = await POST(authorizedRequest());
    const second = await POST(authorizedRequest());

    expect(await first.json()).toEqual({ cancelledOrders: 0, deletedAddresses: 0 });
    expect(await second.json()).toEqual({ cancelledOrders: 0, deletedAddresses: 0 });
    // An empty candidate list never opens a transaction or writes an event.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.orderEvent.create).not.toHaveBeenCalled();
    expect(prismaMock.address.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("logs the counts and duration without order ids", async () => {
    prismaMock.order.findMany.mockResolvedValue([{ id: "order_old_1" }]);
    prismaMock.address.deleteMany.mockResolvedValue({ count: 2 });

    await POST(authorizedRequest());

    const warn = vi.mocked(console.info);
    expect(warn).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warn.mock.calls[0][0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      msg: "cleanup_completed",
      action: "cron.cleanup",
      cancelledOrders: 1,
      deletedAddresses: 2,
    });
    expect(typeof entry.durationMs).toBe("number");
  });
});

describe("stale addresses", () => {
  it("deletes only unreferenced addresses older than 24 hours", async () => {
    const before = Date.now();

    await POST(authorizedRequest());

    const before24h = before - 24 * 60 * 60 * 1000;
    const [call] = prismaMock.address.deleteMany.mock.calls[0] as [
      { where: { order: unknown; createdAt: { lt: Date } } },
    ];
    expect(call.where.order).toEqual({ is: null });
    expect(call.where.createdAt.lt.getTime()).toBeGreaterThanOrEqual(before24h - 5);
    expect(call.where.createdAt.lt.getTime()).toBeLessThanOrEqual(
      Date.now() - 24 * 60 * 60 * 1000 + 5
    );
  });

  it("returns 500 and skips cache invalidation when the database fails", async () => {
    prismaMock.order.findMany.mockRejectedValue(new Error("db down"));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(500);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
