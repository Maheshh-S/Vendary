import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Admin full-refund action (Task 1.4).
 *
 * The real `claim → refundPayment → finalize` ledger runs against an in-memory
 * Prisma store, so the status gates, the one-refund-per-order guard, the
 * confirmed-only stock restore and the audit events are exercised for real.
 */

const {
  authMock,
  prismaMock,
  txMock,
  refundPaymentMock,
  invalidateMock,
  revalidateMock,
  rateLimitMock,
} = vi.hoisted(() => {
  const txMock = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    orderEvent: { findFirst: vi.fn(), create: vi.fn() },
    refund: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    product: { updateMany: vi.fn() },
  };
  const prismaMock = {
    order: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    authMock: vi.fn(),
    prismaMock,
    txMock,
    refundPaymentMock: vi.fn(),
    invalidateMock: vi.fn(),
    revalidateMock: vi.fn(),
    rateLimitMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/razorpay-client", () => ({
  getRazorpayClient: vi.fn(),
  refundPayment: refundPaymentMock,
}));
vi.mock("@/lib/product-cache", () => ({ invalidateProductCache: invalidateMock }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  RATE_LIMITS: { adminMutation: { limit: 60, windowMs: 60_000 } },
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { refundOrder } from "@/actions/(admin)/orders/refund";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import { AppError } from "@/lib/errors";

const ADMIN_ID = "admin_1";
const ORDER_ID = "order_1";
const PAYMENT_ID = "pay_1";

type OrderRow = {
  id: string;
  status: string;
  paymentId: string;
  total: string;
  items: { productId: string | null; quantity: number }[];
};

type RefundRow = {
  id: string;
  orderId: string;
  razorpayRefundId: string;
  paymentId: string;
  amount: string;
  reason: string;
  status: string;
};

type EventRow = {
  orderId: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorId: string | null;
  metadata?: unknown;
};

let orderRow: OrderRow | null;
let refundRows: RefundRow[];
let events: EventRow[];

const makeOrder = (overrides: Partial<OrderRow> = {}): OrderRow => ({
  id: ORDER_ID,
  status: "confirmed",
  paymentId: PAYMENT_ID,
  total: "216.00",
  items: [
    { productId: "prod_1", quantity: 2 },
    { productId: null, quantity: 1 },
  ],
  ...overrides,
});

const expectFailure = (
  result: ActionResult<unknown>,
  code: ActionErrorCode,
  message?: string | RegExp
): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  if (typeof message === "string") expect(result.message).toBe(message);
  if (message instanceof RegExp) expect(result.message).toMatch(message);
};

const eventTypes = (): string[] => events.map((event) => event.type);

beforeEach(() => {
  vi.clearAllMocks();
  orderRow = makeOrder();
  refundRows = [];
  events = [];

  authMock.mockResolvedValue({ user: { id: ADMIN_ID, role: "ADMIN" } });
  rateLimitMock.mockResolvedValue(undefined);
  refundPaymentMock.mockResolvedValue({ refundId: "rfnd_1" });
  invalidateMock.mockResolvedValue(undefined);
  revalidateMock.mockReturnValue(undefined);
  txMock.product.updateMany.mockResolvedValue({ count: 1 });

  prismaMock.order.findUnique.mockImplementation(async () =>
    orderRow
      ? {
          id: orderRow.id,
          status: orderRow.status,
          paymentId: orderRow.paymentId,
          total: orderRow.total,
        }
      : null
  );

  prismaMock.$transaction.mockImplementation(
    async (callback: (tx: typeof txMock) => unknown) => {
      const snapshot = {
        order: orderRow === null ? null : structuredClone(orderRow),
        refunds: structuredClone(refundRows),
        events: structuredClone(events),
      };
      try {
        return await callback(txMock);
      } catch (error) {
        orderRow = snapshot.order;
        refundRows = snapshot.refunds;
        events = snapshot.events;
        throw error;
      }
    }
  );

  txMock.order.findUnique.mockImplementation(async () =>
    orderRow
      ? {
          status: orderRow.status,
          paymentId: orderRow.paymentId,
          items: orderRow.items,
        }
      : null
  );

  txMock.order.updateMany.mockImplementation(
    async (args: { where: { id: string; status?: string }; data: { status?: string } }) => {
      if (!orderRow || args.where.id !== orderRow.id) return { count: 0 };
      if (args.where.status !== undefined && args.where.status !== orderRow.status) {
        return { count: 0 };
      }
      if (args.data.status !== undefined) {
        orderRow = { ...orderRow, status: args.data.status };
      }
      return { count: 1 };
    }
  );

  txMock.refund.findUnique.mockImplementation(
    async (args: { where: { orderId: string } }) =>
      refundRows.find((refund) => refund.orderId === args.where.orderId) ?? null
  );
  txMock.refund.create.mockImplementation(
    async (args: { data: Omit<RefundRow, "id"> }) => {
      const refund: RefundRow = { id: "refund_row_1", ...args.data };
      refundRows.push(refund);
      return { id: refund.id };
    }
  );
  txMock.refund.update.mockImplementation(
    async (args: { where: { id: string }; data: Partial<RefundRow> }) => {
      const refund = refundRows.find((candidate) => candidate.id === args.where.id);
      if (!refund) throw new Error("refund row missing");
      Object.assign(refund, args.data);
      return { id: refund.id };
    }
  );
  // Compare-and-set: status predicate and write in one synchronous step.
  txMock.refund.updateMany.mockImplementation(
    async (args: { where: { id: string; status?: string }; data: Partial<RefundRow> }) => {
      const refund = refundRows.find((candidate) => candidate.id === args.where.id);
      if (!refund) return { count: 0 };
      if (args.where.status !== undefined && refund.status !== args.where.status) {
        return { count: 0 };
      }
      Object.assign(refund, args.data);
      return { count: 1 };
    }
  );

  txMock.orderEvent.findFirst.mockImplementation(
    async (args: { where: { orderId: string; type: string } }) =>
      events.find(
        (event) =>
          event.orderId === args.where.orderId && event.type === args.where.type
      ) ?? null
  );
  txMock.orderEvent.create.mockImplementation(async (args: { data: EventRow }) => {
    events.push(args.data);
    return { id: `event_${events.length}` };
  });
});

describe("refundOrder authorization and validation", () => {
  it("rejects unauthenticated callers before touching the database", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(await refundOrder(ORDER_ID), "UNAUTHORIZED");
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers before touching the database", async () => {
    authMock.mockResolvedValue({ user: { id: "user_1", role: "USER" } });

    expectFailure(await refundOrder(ORDER_ID), "FORBIDDEN");
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
  });

  it("counts one adminMutation hit per invocation", async () => {
    await refundOrder(ORDER_ID);

    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock).toHaveBeenCalledWith({
      bucket: "adminMutation",
      subject: ADMIN_ID,
      limit: 60,
      windowMs: 60_000,
    });
  });

  it("returns RATE_LIMITED without touching the database", async () => {
    rateLimitMock.mockRejectedValue(
      new AppError("RATE_LIMITED", "Too many attempts. Please try again in 60s.")
    );

    expectFailure(await refundOrder(ORDER_ID), "RATE_LIMITED");
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an invalid order id with VALIDATION", async () => {
    expectFailure(await refundOrder(""), "VALIDATION");
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unknown order", async () => {
    orderRow = null;

    expectFailure(await refundOrder(ORDER_ID), "NOT_FOUND");
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });
});

describe("refundOrder status gates", () => {
  it.each(["pending", "cancelled", "refunded"])(
    "refuses to refund a %s order",
    async (status) => {
      orderRow = makeOrder({ status });

      expectFailure(await refundOrder(ORDER_ID), "CONFLICT");
      expect(refundPaymentMock).not.toHaveBeenCalled();
      expect(txMock.refund.create).not.toHaveBeenCalled();
    }
  );

  it("refuses an order with no captured payment proof", async () => {
    orderRow = makeOrder({ paymentId: "" });

    expectFailure(await refundOrder(ORDER_ID), "CONFLICT");
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });
});

describe("refundOrder success", () => {
  it("refunds a confirmed order, marks it refunded, restores stock and writes events", async () => {
    const result = await refundOrder(ORDER_ID);

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, status: "refunded", refundId: "rfnd_1" },
    });
    expect(refundPaymentMock).toHaveBeenCalledWith({
      paymentId: PAYMENT_ID,
      amountPaise: 21600,
      orderId: ORDER_ID,
      reason: "ADMIN_REFUND",
    });
    expect(orderRow?.status).toBe("refunded");
    expect(refundRows[0]).toMatchObject({
      razorpayRefundId: "rfnd_1",
      status: "processed",
      reason: "ADMIN_REFUND",
    });
    expect(txMock.product.updateMany).toHaveBeenCalledTimes(1);
    expect(invalidateMock).toHaveBeenCalledWith("prod_1");
    expect(eventTypes()).toEqual([
      "refund_requested",
      "status_changed",
      "refund_processed",
    ]);
    expect(events[1]).toMatchObject({
      fromStatus: "confirmed",
      toStatus: "refunded",
      actorId: ADMIN_ID,
    });
  });

  it.each(["shipped", "delivered"])(
    "refunds a %s order without restoring stock",
    async (status) => {
      orderRow = makeOrder({ status });

      const result = await refundOrder(ORDER_ID);

      expect(result.ok).toBe(true);
      expect(orderRow?.status).toBe("refunded");
      expect(txMock.product.updateMany).not.toHaveBeenCalled();
      expect(invalidateMock).not.toHaveBeenCalled();
      expect(eventTypes()).toEqual([
        "refund_requested",
        "status_changed",
        "refund_processed",
      ]);
      expect(events[1]).toMatchObject({ fromStatus: status, toStatus: "refunded" });
    }
  );

  it("returns CONFLICT without refunding when the order already has a refund in flight", async () => {
    refundRows = [
      {
        id: "refund_row_1",
        orderId: ORDER_ID,
        razorpayRefundId: "pending:seed",
        paymentId: PAYMENT_ID,
        amount: "216.00",
        reason: "ADMIN_REFUND",
        status: "requested",
      },
    ];

    expectFailure(await refundOrder(ORDER_ID), "CONFLICT");
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });
});

describe("refundOrder failure", () => {
  it("leaves the order untouched and records the failed ledger row and event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      refundPaymentMock.mockRejectedValue(new Error("razorpay unavailable"));

      const result = await refundOrder(ORDER_ID);

      expectFailure(result, "PAYMENT_FAILED", /retry|reconcile/i);
      expect(orderRow?.status).toBe("confirmed");
      expect(refundRows[0]).toMatchObject({ status: "failed" });
      expect(txMock.product.updateMany).not.toHaveBeenCalled();
      expect(invalidateMock).not.toHaveBeenCalled();
      expect(eventTypes()).toEqual(["refund_requested", "refund_failed"]);

      const entries = error.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "order_refund_failed",
            orderId: ORDER_ID,
            reason: "ADMIN_REFUND",
          }),
        ])
      );
    } finally {
      error.mockRestore();
    }
  });
});
