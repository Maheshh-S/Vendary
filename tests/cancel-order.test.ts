import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Customer cancel flow (Task 1.4).
 *
 * Prisma is an in-memory order/refund/event store so the real
 * `claim → refundPayment → finalize` flow runs end to end: the pending no-money
 * path, the confirmed refund path, the unique ledger race guards and the
 * exactly-once stock restore are all executed for real.
 */

const {
  authMock,
  prismaMock,
  txMock,
  refundPaymentMock,
  invalidateMock,
  revalidateMock,
} = vi.hoisted(() => {
  const txMock = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    orderEvent: { findFirst: vi.fn(), create: vi.fn() },
    refund: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { updateMany: vi.fn() },
  };
  const prismaMock = {
    order: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    authMock: vi.fn(),
    prismaMock,
    txMock,
    refundPaymentMock: vi.fn(),
    invalidateMock: vi.fn(),
    revalidateMock: vi.fn(),
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
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { cancelOrder } from "@/actions/orders/cancel";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";

const USER_ID = "user_1";
const ORDER_ID = "order_1";
const PAYMENT_ID = "pay_1";

type OrderRow = {
  id: string;
  userId: string;
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
  userId: USER_ID,
  status: "confirmed",
  paymentId: PAYMENT_ID,
  total: "216.00",
  items: [
    { productId: "prod_1", quantity: 2 },
    { productId: null, quantity: 1 },
  ],
  ...overrides,
});

const makeRefund = (overrides: Partial<RefundRow> = {}): RefundRow => ({
  id: "refund_row_1",
  orderId: ORDER_ID,
  razorpayRefundId: "pending:seed",
  paymentId: PAYMENT_ID,
  amount: "216.00",
  reason: "CUSTOMER_CANCEL",
  status: "requested",
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

  authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });
  refundPaymentMock.mockResolvedValue({ refundId: "rfnd_1" });
  invalidateMock.mockResolvedValue(undefined);
  revalidateMock.mockReturnValue(undefined);
  txMock.product.updateMany.mockResolvedValue({ count: 1 });

  prismaMock.order.findFirst.mockImplementation(
    async (args: { where: { id: string; userId: string } }) => {
      if (
        !orderRow ||
        args.where.id !== orderRow.id ||
        args.where.userId !== orderRow.userId
      ) {
        return null;
      }
      return {
        id: orderRow.id,
        status: orderRow.status,
        paymentId: orderRow.paymentId,
        total: orderRow.total,
      };
    }
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
    async (args: {
      where: {
        id: string;
        userId?: string;
        status?: string;
        paymentId?: string;
      };
      data: { status?: string };
    }) => {
      if (!orderRow || args.where.id !== orderRow.id) return { count: 0 };
      if (args.where.userId !== undefined && args.where.userId !== orderRow.userId) {
        return { count: 0 };
      }
      if (args.where.status !== undefined && args.where.status !== orderRow.status) {
        return { count: 0 };
      }
      if (
        args.where.paymentId !== undefined &&
        args.where.paymentId !== orderRow.paymentId
      ) {
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

  txMock.orderEvent.findFirst.mockImplementation(
    async (args: { where: { orderId: string; type: string } }) =>
      events.find(
        (event) =>
          event.orderId === args.where.orderId && event.type === args.where.type
      ) ?? null
  );
  txMock.orderEvent.create.mockImplementation(
    async (args: { data: EventRow }) => {
      events.push(args.data);
      return { id: `event_${events.length}` };
    }
  );
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("cancelOrder authorization and status guards", () => {
  it("rejects unauthenticated callers before touching the database", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(await cancelOrder(ORDER_ID), "UNAUTHORIZED", "Please sign in to continue.");
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a foreign or missing order", async () => {
    orderRow = makeOrder({ userId: "someone_else" });

    expectFailure(await cancelOrder(ORDER_ID), "NOT_FOUND");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();

    orderRow = null;
    expectFailure(await cancelOrder("missing"), "NOT_FOUND");
  });

  it("rejects an invalid order id with VALIDATION", async () => {
    expectFailure(await cancelOrder(""), "VALIDATION");
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled();
  });

  it.each(["shipped", "delivered", "cancelled", "refunded"])(
    "refuses to cancel a %s order",
    async (status) => {
      orderRow = makeOrder({ status });

      expectFailure(await cancelOrder(ORDER_ID), "CONFLICT");
      expect(refundPaymentMock).not.toHaveBeenCalled();
      expect(txMock.refund.create).not.toHaveBeenCalled();
    }
  );
});

describe("cancelOrder pending orders", () => {
  beforeEach(() => {
    orderRow = makeOrder({ status: "pending", paymentId: "" });
  });

  it("cancels without refunding or touching stock and records the event", async () => {
    const result = await cancelOrder(ORDER_ID);

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, status: "cancelled" },
    });
    expect(orderRow?.status).toBe("cancelled");
    expect(refundPaymentMock).not.toHaveBeenCalled();
    expect(txMock.refund.create).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        orderId: ORDER_ID,
        type: "order_cancelled",
        fromStatus: "pending",
        toStatus: "cancelled",
        actorId: USER_ID,
      },
    ]);
    expect(revalidateMock).toHaveBeenCalledWith(`/my-orders/${ORDER_ID}`);
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("refuses to cancel once a payment proof is recorded", async () => {
    orderRow = makeOrder({ status: "pending", paymentId: PAYMENT_ID });

    expectFailure(await cancelOrder(ORDER_ID), "CONFLICT");
    expect(orderRow?.status).toBe("pending");
    expect(events).toEqual([]);
  });

  it("returns CONFLICT when another path cancels between read and claim", async () => {
    txMock.order.updateMany.mockResolvedValueOnce({ count: 0 });

    expectFailure(await cancelOrder(ORDER_ID), "CONFLICT");
    expect(events).toEqual([]);
  });
});

describe("cancelOrder confirmed orders (full refund)", () => {
  it("refunds in full, cancels, restores stock once and writes the events", async () => {
    const result = await cancelOrder(ORDER_ID);

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, status: "cancelled", refundId: "rfnd_1" },
    });
    expect(refundPaymentMock).toHaveBeenCalledTimes(1);
    expect(refundPaymentMock).toHaveBeenCalledWith({
      paymentId: PAYMENT_ID,
      amountPaise: 21600,
      orderId: ORDER_ID,
      reason: "CUSTOMER_CANCEL",
    });
    expect(orderRow?.status).toBe("cancelled");
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      orderId: ORDER_ID,
      razorpayRefundId: "rfnd_1",
      status: "processed",
      amount: "216.00",
      reason: "CUSTOMER_CANCEL",
    });
    // The null product snapshot is skipped; the live line is restored once.
    expect(txMock.product.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.product.updateMany).toHaveBeenCalledWith({
      where: { id: "prod_1" },
      data: { stockQty: { increment: 2 }, availability: "IN_STOCK" },
    });
    expect(invalidateMock).toHaveBeenCalledWith("prod_1");
    expect(eventTypes()).toEqual([
      "refund_requested",
      "order_cancelled",
      "refund_processed",
    ]);
    expect(events[1]).toMatchObject({
      fromStatus: "confirmed",
      toStatus: "cancelled",
      actorId: USER_ID,
    });
  });

  it("returns CONFLICT without refunding when a refund is already in progress", async () => {
    refundRows = [makeRefund({ status: "requested" })];

    expectFailure(await cancelOrder(ORDER_ID), "CONFLICT");
    expect(refundPaymentMock).not.toHaveBeenCalled();
    expect(orderRow?.status).toBe("confirmed");
  });

  it("returns CONFLICT without refunding when the order was already refunded", async () => {
    refundRows = [makeRefund({ status: "processed", razorpayRefundId: "rfnd_1" })];

    expectFailure(await cancelOrder(ORDER_ID), "CONFLICT");
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });

  it("retries a failed refund against the same ledger row", async () => {
    refundRows = [
      makeRefund({ status: "failed", razorpayRefundId: "pending:old" }),
    ];

    const result = await cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    expect(txMock.refund.create).not.toHaveBeenCalled();
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      id: "refund_row_1",
      razorpayRefundId: "rfnd_1",
      status: "processed",
    });
    expect(refundPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the order confirmed and records refund_failed when Razorpay fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      refundPaymentMock.mockRejectedValue(new Error("razorpay unavailable"));

      const result = await cancelOrder(ORDER_ID);

      expectFailure(result, "PAYMENT_FAILED", /support/i);
      expect(orderRow?.status).toBe("confirmed");
      expect(refundRows[0]).toMatchObject({
        status: "failed",
        paymentId: PAYMENT_ID,
      });
      expect(txMock.product.updateMany).not.toHaveBeenCalled();
      expect(invalidateMock).not.toHaveBeenCalled();
      expect(eventTypes()).toEqual(["refund_requested", "refund_failed"]);
      expect(events[1].metadata).toMatchObject({
        reason: "CUSTOMER_CANCEL",
        error: "razorpay unavailable",
      });

      const entries = error.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "order_refund_failed",
            orderId: ORDER_ID,
            reason: "CUSTOMER_CANCEL",
          }),
        ])
      );
    } finally {
      error.mockRestore();
    }
  });

  it("does not refund an order that moved on between read and claim", async () => {
    prismaMock.order.findFirst.mockImplementation(async () => {
      // The action reads `confirmed`, then an admin ships the order before the
      // claim transaction re-reads it.
      orderRow = makeOrder({ status: "shipped" });
      return {
        id: ORDER_ID,
        status: "confirmed",
        paymentId: PAYMENT_ID,
        total: "216.00",
      };
    });

    expectFailure(await cancelOrder(ORDER_ID), "CONFLICT");
    expect(refundPaymentMock).not.toHaveBeenCalled();
    expect(orderRow?.status).toBe("shipped");
  });
});
