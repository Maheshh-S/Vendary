import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Order status state machine + stock restoration (Task 0.7).
 *
 * The transition map and `restoreOrderStock` run for real; auth, Prisma, the
 * Razorpay client, Redis cache invalidation and Next revalidation are mocked so
 * the tests assert the exact claim and stock-restore calls. Expected failures
 * are `AppError`s, so nothing may reach `console.error`.
 */

const {
  authMock,
  prismaMock,
  txMock,
  invalidateMock,
  revalidateMock,
  refundPaymentMock,
  rateLimitMock,
  mailMock,
} = vi.hoisted(() => {
  const txMock = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    orderEvent: { create: vi.fn() },
    product: { updateMany: vi.fn() },
  };
  const prismaMock = { $transaction: vi.fn() };
  return {
    authMock: vi.fn(),
    prismaMock,
    txMock,
    invalidateMock: vi.fn(),
    revalidateMock: vi.fn(),
    refundPaymentMock: vi.fn(),
    rateLimitMock: vi.fn(),
    mailMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/mail", () => ({ sendOrderEmail: mailMock }));
vi.mock("@/lib/product-cache", () => ({ invalidateProductCache: invalidateMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("@/lib/razorpay-client", () => ({
  getRazorpayClient: vi.fn(),
  refundPayment: refundPaymentMock,
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  // Mirrors lib/rate-limit.ts; the actions read these at call time.
  RATE_LIMITS: {
    createRazorpayOrder: { limit: 10, windowMs: 60_000 },
    adminMutation: { limit: 60, windowMs: 60_000 },
  },
}));

import type { OrderStatus } from "@prisma/client";

import { updateOrderStatus } from "@/actions/orders";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import { AppError } from "@/lib/errors";
import {
  ADMIN_TRANSITIONS,
  INVOICE_ELIGIBLE_STATUSES,
  ORDER_TRANSITIONS,
  canAdminTransition,
  canTransition,
  isInvoiceEligible,
} from "@/lib/orders/status";

const ALL_STATUSES: OrderStatus[] = [
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
];

const LEGAL_TRANSITIONS: [OrderStatus, OrderStatus][] = [
  ["pending", "confirmed"],
  ["pending", "cancelled"],
  ["confirmed", "shipped"],
  ["confirmed", "cancelled"],
  ["confirmed", "refunded"],
  ["shipped", "delivered"],
  ["shipped", "refunded"],
  ["delivered", "refunded"],
];

const ILLEGAL_TRANSITIONS: [OrderStatus, OrderStatus][] = [
  ["pending", "shipped"],
  ["pending", "delivered"],
  ["pending", "refunded"],
  ["confirmed", "delivered"],
  ["confirmed", "pending"],
  ["shipped", "pending"],
  ["shipped", "cancelled"],
  ["shipped", "confirmed"],
  ["delivered", "cancelled"],
  ["delivered", "shipped"],
  ["delivered", "confirmed"],
  ["cancelled", "confirmed"],
  ["cancelled", "pending"],
  ["refunded", "confirmed"],
  ["refunded", "cancelled"],
  ...ALL_STATUSES.map((status) => [status, status] as [OrderStatus, OrderStatus]),
];

describe("ORDER_TRANSITIONS / canTransition", () => {
  it("matches the full system map, including the payment-verified edge", () => {
    expect(ORDER_TRANSITIONS).toEqual({
      pending: ["confirmed", "cancelled"],
      confirmed: ["shipped", "cancelled", "refunded"],
      shipped: ["delivered", "refunded"],
      delivered: ["refunded"],
      cancelled: [],
      refunded: [],
    });
  });

  it("covers every order status exactly once as a key", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("only lists known statuses as targets", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) {
        expect(ALL_STATUSES).toContain(to);
      }
    }
  });

  it.each(LEGAL_TRANSITIONS)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(ILLEGAL_TRANSITIONS)("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("matches the declared map for every from/to pair", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to)).toBe(ORDER_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("treats cancelled and refunded as terminal", () => {
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
    expect(ORDER_TRANSITIONS.refunded).toEqual([]);
  });
});

const ADMIN_LEGAL_TRANSITIONS: [OrderStatus, OrderStatus][] = LEGAL_TRANSITIONS.filter(
  ([from, to]) => !(from === "pending" && (to === "confirmed" || to === "cancelled"))
);

const ADMIN_ILLEGAL_TRANSITIONS: [OrderStatus, OrderStatus][] = [
  ...ILLEGAL_TRANSITIONS,
  ["pending", "confirmed"],
  ["pending", "cancelled"],
];

describe("ADMIN_TRANSITIONS / canAdminTransition", () => {
  it("covers every order status exactly once as a key", () => {
    expect(Object.keys(ADMIN_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("removes both pending edges while the system map keeps them", () => {
    // Pending orders have no admin options at all: confirming needs payment
    // verification and cancelling needs Phase 1's refund flow.
    expect(ADMIN_TRANSITIONS.pending).toEqual([]);
    expect(ORDER_TRANSITIONS.pending).toEqual(["confirmed", "cancelled"]);
    for (const from of ALL_STATUSES) {
      expect(ADMIN_TRANSITIONS[from]).toEqual(from === "pending" ? [] : ORDER_TRANSITIONS[from]);
    }
  });

  it("refuses pending -> confirmed while the system map still allows it", () => {
    expect(canAdminTransition("pending", "confirmed")).toBe(false);
    expect(canTransition("pending", "confirmed")).toBe(true);
  });

  it("refuses pending -> cancelled even though Phase 3 cleanup may use it", () => {
    expect(canAdminTransition("pending", "cancelled")).toBe(false);
    expect(canTransition("pending", "cancelled")).toBe(true);
  });

  it.each(ADMIN_LEGAL_TRANSITIONS)("allows admin %s -> %s", (from, to) => {
    expect(canAdminTransition(from, to)).toBe(true);
  });

  it.each(ADMIN_ILLEGAL_TRANSITIONS)("rejects admin %s -> %s", (from, to) => {
    expect(canAdminTransition(from, to)).toBe(false);
  });

  it("matches the declared admin map for every from/to pair", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(canAdminTransition(from, to)).toBe(ADMIN_TRANSITIONS[from].includes(to));
      }
    }
  });
});

describe("isInvoiceEligible", () => {
  it("only treats captured, un-reversed statuses as invoiceable", () => {
    expect(INVOICE_ELIGIBLE_STATUSES).toEqual(["confirmed", "shipped", "delivered"]);
    for (const status of ALL_STATUSES) {
      expect(isInvoiceEligible(status)).toBe(
        status === "confirmed" || status === "shipped" || status === "delivered"
      );
    }
  });

  it("rejects pending, cancelled and refunded orders", () => {
    expect(isInvoiceEligible("pending")).toBe(false);
    expect(isInvoiceEligible("cancelled")).toBe(false);
    expect(isInvoiceEligible("refunded")).toBe(false);
  });
});

const ORDER_ID = "order_1";
const PRODUCT_A = "prod_1";
const PRODUCT_B = "prod_2";

const ADMIN_SESSION = { user: { id: "admin_1", role: "ADMIN" } };
const USER_SESSION = { user: { id: "user_1", role: "USER" } };

type OrderRow = {
  id: string;
  status: OrderStatus;
  paymentId: string;
  items: { productId: string | null; quantity: number }[];
};

let orderRow: OrderRow | null;

const PAYMENT_ID = "pay_verified_1";

const makeOrder = (status: OrderStatus, paymentId = PAYMENT_ID): OrderRow => ({
  id: ORDER_ID,
  status,
  paymentId,
  items: [
    { productId: PRODUCT_A, quantity: 2 },
    // A deleted product has no row to restore; its snapshot id is null.
    { productId: null, quantity: 1 },
    { productId: PRODUCT_B, quantity: 1 },
  ],
});

const expectFailure = (
  result: ActionResult<unknown>,
  code: ActionErrorCode,
  message?: string
): Extract<ActionResult<unknown>, { ok: false }> => {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected the action to fail");
  }
  expect(result.code).toBe(code);
  if (message) {
    expect(result.message).toBe(message);
  }
  return result;
};

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

/** Exact structured warnings each test allows; every test starts at none. */
let expectedWarnings: unknown[][] = [];

beforeEach(() => {
  vi.clearAllMocks();
  expectedWarnings = [];
  orderRow = makeOrder("confirmed");

  authMock.mockResolvedValue(ADMIN_SESSION);
  rateLimitMock.mockResolvedValue(undefined);
  invalidateMock.mockResolvedValue(undefined);
  revalidateMock.mockReturnValue(undefined);
  txMock.product.updateMany.mockResolvedValue({ count: 1 });
  txMock.orderEvent.create.mockResolvedValue({ id: "event_1" });

  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) => {
    // Discard the in-transaction writes when the action throws, like a real
    // rollback: the claim and the stock restore commit together or not at all.
    const snapshot = orderRow === null ? null : structuredClone(orderRow);
    try {
      return await callback(txMock);
    } catch (error) {
      orderRow = snapshot;
      throw error;
    }
  });

  txMock.order.findUnique.mockImplementation(async () =>
    orderRow === null
      ? null
      : { status: orderRow.status, paymentId: orderRow.paymentId, items: orderRow.items }
  );
  txMock.order.updateMany.mockImplementation(
    async (args: { where: { id: string; status: OrderStatus }; data: { status: OrderStatus } }) => {
      if (
        orderRow === null ||
        args.where.id !== orderRow.id ||
        args.where.status !== orderRow.status
      ) {
        return { count: 0 };
      }
      orderRow = { ...orderRow, status: args.data.status };
      return { count: 1 };
    }
  );
});

afterEach(() => {
  // Expected failures are user-facing AppErrors; only unexpected (INTERNAL)
  // errors may reach the logger.
  expect(consoleError).not.toHaveBeenCalled();
  // Warnings are structured JSON; only the restore-skip test opts in.
  expect(consoleWarn.mock.calls).toEqual(expectedWarnings);
  consoleError.mockClear();
  consoleWarn.mockClear();
});

afterAll(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe("updateOrderStatus authorization and validation", () => {
  it("rejects unauthenticated callers with UNAUTHORIZED before touching the database", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(
      await updateOrderStatus(ORDER_ID, "cancelled"),
      "UNAUTHORIZED",
      "Please sign in to continue."
    );
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers with FORBIDDEN before touching the database", async () => {
    authMock.mockResolvedValue(USER_SESSION);

    expectFailure(
      await updateOrderStatus(ORDER_ID, "cancelled"),
      "FORBIDDEN",
      "You do not have permission to do that."
    );
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("rejects a status outside the OrderStatus enum with VALIDATION", async () => {
    expectFailure(await updateOrderStatus(ORDER_ID, "teleported"), "VALIDATION");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an empty or over-long order id with VALIDATION", async () => {
    expectFailure(await updateOrderStatus("", "cancelled"), "VALIDATION");
    expectFailure(await updateOrderStatus("x".repeat(65), "cancelled"), "VALIDATION");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("updateOrderStatus rate limiting", () => {
  it("counts one adminMutation hit per admin invocation", async () => {
    await updateOrderStatus(ORDER_ID, "cancelled");

    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock).toHaveBeenCalledWith({
      bucket: "adminMutation",
      subject: "admin_1",
      limit: 60,
      windowMs: 60_000,
    });
  });

  it("returns RATE_LIMITED without touching the database or cache when the limiter rejects", async () => {
    rateLimitMock.mockRejectedValue(
      new AppError("RATE_LIMITED", "Too many attempts. Please try again in 60s.")
    );

    expectFailure(
      await updateOrderStatus(ORDER_ID, "cancelled"),
      "RATE_LIMITED",
      "Too many attempts. Please try again in 60s."
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("updateOrderStatus transition guards", () => {
  it("returns NOT_FOUND when the order does not exist", async () => {
    orderRow = null;

    expectFailure(await updateOrderStatus(ORDER_ID, "cancelled"), "NOT_FOUND", "Order not found.");
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("rejects pending -> shipped with CONFLICT and a verbatim explanation", async () => {
    orderRow = makeOrder("pending");

    expectFailure(
      await updateOrderStatus(ORDER_ID, "shipped"),
      "CONFLICT",
      "Cannot change an order from pending to shipped."
    );
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(orderRow?.status).toBe("pending");
  });

  it("rejects pending -> cancelled with CONFLICT and writes nothing", async () => {
    // A capture can arrive after an admin cancel (the webhook acks captures
    // for non-pending orders), so cancelling before payment is never safe
    // until the Phase 1 refund flow exists.
    orderRow = makeOrder("pending", "");

    expectFailure(
      await updateOrderStatus(ORDER_ID, "cancelled"),
      "CONFLICT",
      "Cannot change an order from pending to cancelled."
    );
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
    expect(orderRow?.status).toBe("pending");
    expect(orderRow?.paymentId).toBe("");
  });

  it("rejects pending -> confirmed with the payment-verification message and writes nothing", async () => {
    orderRow = makeOrder("pending", "");

    expectFailure(
      await updateOrderStatus(ORDER_ID, "confirmed"),
      "CONFLICT",
      "Orders are confirmed automatically after payment verification. You cannot confirm a pending order manually."
    );
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
    expect(orderRow?.status).toBe("pending");
    expect(orderRow?.paymentId).toBe("");
  });

  it("rejects delivered -> cancelled with CONFLICT and writes nothing", async () => {
    orderRow = makeOrder("delivered");

    expectFailure(
      await updateOrderStatus(ORDER_ID, "cancelled"),
      "CONFLICT",
      "Cannot change an order from delivered to cancelled."
    );
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelled", "confirmed"],
    ["refunded", "confirmed"],
  ] as [OrderStatus, OrderStatus][])(
    "refuses to revive a %s order (%s -> %s)",
    async (from, to) => {
      orderRow = makeOrder(from);

      expectFailure(
        await updateOrderStatus(ORDER_ID, to),
        "CONFLICT",
        `Cannot change an order from ${from} to ${to}.`
      );
      expect(txMock.order.updateMany).not.toHaveBeenCalled();
    }
  );

  it("returns CONFLICT when the conditional claim matches no row", async () => {
    // Another admin moved the order between the read and the claim.
    txMock.order.updateMany.mockResolvedValueOnce({ count: 0 });

    expectFailure(
      await updateOrderStatus(ORDER_ID, "cancelled"),
      "CONFLICT",
      "The order changed while you were updating it. Please refresh."
    );
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it.each([
    ["delivered", "delivered"],
    ["refunded", "refunded"],
    ["cancelled", "cancelled"],
  ] as [OrderStatus, OrderStatus][])("rejects a replayed transition %s -> %s", async (from, to) => {
    orderRow = makeOrder(from);

    expectFailure(
      await updateOrderStatus(ORDER_ID, to),
      "CONFLICT",
      `Cannot change an order from ${from} to ${to}.`
    );
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });
});

describe("updateOrderStatus customer email", () => {
  it("sends exactly one shipped email for confirmed -> shipped", async () => {
    const result = await updateOrderStatus(ORDER_ID, "shipped");

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, from: "confirmed", to: "shipped" },
    });
    expect(mailMock).toHaveBeenCalledTimes(1);
    expect(mailMock).toHaveBeenCalledWith(ORDER_ID, "shipped");
  });

  it("sends exactly one delivered email for shipped -> delivered", async () => {
    orderRow = makeOrder("shipped");

    const result = await updateOrderStatus(ORDER_ID, "delivered");

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, from: "shipped", to: "delivered" },
    });
    expect(mailMock).toHaveBeenCalledTimes(1);
    expect(mailMock).toHaveBeenCalledWith(ORDER_ID, "delivered");
  });

  it.each(["cancelled", "refunded"] as OrderStatus[])(
    "sends no email for the record-only confirmed -> %s transition",
    async (to) => {
      const result = await updateOrderStatus(ORDER_ID, to);

      expect(result).toEqual({
        ok: true,
        data: { orderId: ORDER_ID, from: "confirmed", to },
      });
      // Cancelling or refunding from the dropdown moves no money, so claiming
      // "your refund was processed" would be a lie. The money paths email.
      expect(mailMock).not.toHaveBeenCalled();
    }
  );

  it("sends no email when the transition fails", async () => {
    orderRow = makeOrder("pending");

    expectFailure(await updateOrderStatus(ORDER_ID, "cancelled"), "CONFLICT");
    expect(mailMock).not.toHaveBeenCalled();
  });
});

describe("updateOrderStatus stock restoration", () => {
  it("restores stock once and invalidates product caches for confirmed -> cancelled", async () => {
    const result = await updateOrderStatus(ORDER_ID, "cancelled");

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, from: "confirmed", to: "cancelled" },
    });
    expect(txMock.order.findUnique).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
      select: {
        status: true,
        paymentId: true,
        items: { select: { productId: true, quantity: true } },
      },
    });
    expect(txMock.order.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: "confirmed" },
      data: { status: "cancelled" },
    });

    // Exactly one increment per line with a live product, null snapshot skipped.
    expect(txMock.product.updateMany).toHaveBeenCalledTimes(2);
    expect(txMock.product.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: PRODUCT_A },
      data: { stockQty: { increment: 2 }, availability: "IN_STOCK" },
    });
    expect(txMock.product.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: PRODUCT_B },
      data: { stockQty: { increment: 1 }, availability: "IN_STOCK" },
    });

    expect(invalidateMock).toHaveBeenCalledTimes(2);
    expect(invalidateMock).toHaveBeenNthCalledWith(1, PRODUCT_A);
    expect(invalidateMock).toHaveBeenNthCalledWith(2, PRODUCT_B);
    expect(invalidateMock).not.toHaveBeenCalledWith(null);

    expect(txMock.orderEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: ORDER_ID,
        type: "status_changed",
        fromStatus: "confirmed",
        toStatus: "cancelled",
        actorId: ADMIN_SESSION.user.id,
      }),
    });

    expect(revalidateMock).toHaveBeenCalledWith("/admin");
    expect(revalidateMock).toHaveBeenCalledWith("/my-orders");
  });

  it("restores stock for confirmed -> refunded without issuing a Razorpay refund", async () => {
    const result = await updateOrderStatus(ORDER_ID, "refunded");

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, from: "confirmed", to: "refunded" },
    });
    expect(txMock.product.updateMany).toHaveBeenCalledTimes(2);
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_A);
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT_B);
    // Phase 0: the admin transition is record-only; money never moves here.
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });

  it("transitions confirmed -> cancelled without restoring stock when paymentId is empty, logging a structured warning", async () => {
    orderRow = makeOrder("confirmed", "");
    expectedWarnings = [
      [
        JSON.stringify({
          level: "warn",
          event: "order_restore_skipped_no_payment",
          orderId: ORDER_ID,
        }),
      ],
    ];

    const result = await updateOrderStatus(ORDER_ID, "cancelled");

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, from: "confirmed", to: "cancelled" },
    });
    expect(txMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: "confirmed" },
      data: { status: "cancelled" },
    });
    // Nobody verified a payment, so no units were ever decremented.
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
    expect(revalidateMock).toHaveBeenCalledWith("/my-orders");
    expect(orderRow?.status).toBe("cancelled");
    expect(consoleWarn).toHaveBeenCalledTimes(1);
  });

  it("does not restore stock for shipped -> delivered (goods left the warehouse)", async () => {
    orderRow = makeOrder("shipped");

    const result = await updateOrderStatus(ORDER_ID, "delivered");

    expect(result).toEqual({
      ok: true,
      data: { orderId: ORDER_ID, from: "shipped", to: "delivered" },
    });
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
    expect(revalidateMock).toHaveBeenCalledWith("/my-orders");
  });

  it.each(["shipped", "delivered"] as OrderStatus[])(
    "does not restore stock when a %s order is refunded",
    async (from) => {
      orderRow = makeOrder(from);

      const result = await updateOrderStatus(ORDER_ID, "refunded");

      expect(result).toEqual({
        ok: true,
        data: { orderId: ORDER_ID, from, to: "refunded" },
      });
      expect(txMock.product.updateMany).not.toHaveBeenCalled();
      expect(invalidateMock).not.toHaveBeenCalled();
      expect(revalidateMock).toHaveBeenCalledWith("/admin");
      expect(revalidateMock).toHaveBeenCalledWith("/my-orders");
    }
  );
});
