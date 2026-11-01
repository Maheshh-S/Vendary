import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Money-path tests for durable checkout intent (Task 0.4).
 *
 * Every boundary is mocked: NextAuth, Prisma, Razorpay, the rate limiter and
 * Next's cache. The modules under test are the real server actions, so the
 * signature checks, ownership checks, amount checks and the idempotent
 * confirm claim all execute for real.
 */

const {
  authMock,
  prismaMock,
  txMock,
  razorpayMock,
  rateLimitMock,
  refundMock,
  revalidateMock,
  invalidateMock,
} = vi.hoisted(() => {
  const txMock = {
    address: { create: vi.fn() },
    order: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    orderItem: { create: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    orderEvent: { create: vi.fn(), findFirst: vi.fn() },
    refund: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    product: { updateMany: vi.fn() },
  };
  const prismaMock = {
    product: { findMany: vi.fn() },
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  const razorpayMock = {
    orders: { create: vi.fn(), fetch: vi.fn() },
    payments: { refund: vi.fn() },
  };
  return {
    authMock: vi.fn(),
    prismaMock,
    txMock,
    razorpayMock,
    rateLimitMock: { enforceRateLimit: vi.fn() },
    refundMock: vi.fn(),
    revalidateMock: vi.fn(),
    invalidateMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/razorpay-client", () => ({
  getRazorpayClient: () => razorpayMock,
  refundPayment: refundMock,
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock.enforceRateLimit,
  RATE_LIMITS: {
    createRazorpayOrder: { limit: 10, windowMs: 60_000 },
  },
}));
vi.mock("@/lib/product-cache", () => ({ invalidateProductCache: invalidateMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { PlaceOrder, createRazorpayOrder } from "@/actions/orders";
import { refundReasonLabel } from "@/lib/orders/refund-labels";
import { signRazorpayPayload } from "@/lib/razorpay";

const SECRET = "unit-test-razorpay-secret";
const USER_ID = "user_1";
const RAZORPAY_ORDER_ID = "order_rzp_1";
const RAZORPAY_PAYMENT_ID = "pay_1";

const PRODUCT = {
  id: "prod_1",
  name: "Widget",
  price: "200.00",
  availability: "IN_STOCK",
  stockQty: 5,
  thumbnail: "https://cdn.example/widget.png",
};

// 200.00 * 1 = 20000p subtotal, + 8% GST = 21600p.
const ORDER_TOTAL_PAISE = 21600;

const checkoutSession = {
  line_items: [
    {
      productId: PRODUCT.id,
      price_data: {
        currency: "INR",
        product_data: { name: PRODUCT.name, images: [] },
        unit_amount: 20000,
      },
      quantity: 1,
    },
  ],
};

const addressData = {
  fName: "Ada",
  lName: "Lovelace",
  mobile: "9876543210",
  pinCode: "560001",
  address: "12 MG Road",
  area: "Central",
  landmark: "Near Metro",
  country: ["India", "Karnataka"] as [string, string],
};

const signedProof = () => ({
  razorpayOrderId: RAZORPAY_ORDER_ID,
  razorpayPaymentId: RAZORPAY_PAYMENT_ID,
  razorpaySignature: signRazorpayPayload(`${RAZORPAY_ORDER_ID}|${RAZORPAY_PAYMENT_ID}`, SECRET),
});

/** Mirrors the durable order an init call leaves behind. */
const makeOrder = (overrides: Record<string, unknown> = {}) => ({
  id: "order_1",
  userId: USER_ID,
  status: "pending",
  total: "216.00",
  taxAmount: "16.00",
  discountAmount: "0.00",
  couponCode: null,
  paymentId: "",
  transactionId: RAZORPAY_ORDER_ID,
  items: [
    {
      id: "item_1",
      orderId: "order_1",
      productId: PRODUCT.id,
      productName: PRODUCT.name,
      productImage: PRODUCT.thumbnail,
      quantity: 1,
      price: "200.00",
    },
  ],
  ...overrides,
});

// Durable state, so a second call observes the first call's commit and the
// transaction mock can roll back the in-transaction claim on failure.
let orderState: { status: string; paymentId: string };
let txState: { status: string; paymentId: string };
/** Per-test stored-order fields (coupon totals change what was charged). */
let orderOverrides: Record<string, unknown>;

type RefundRow = {
  id: string;
  orderId: string;
  razorpayRefundId: string;
  paymentId: string;
  amount: string;
  reason: string;
  status: string;
};

let refundRows: RefundRow[];

const initState = (status = "pending", paymentId = "") => {
  orderState = { status, paymentId };
  txState = { ...orderState };
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAZORPAY_KEY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_unit";

  initState();
  refundRows = [];
  orderOverrides = {};

  authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });
  rateLimitMock.enforceRateLimit.mockResolvedValue(undefined);
  refundMock.mockResolvedValue({ refundId: "rfnd_1" });
  revalidateMock.mockReturnValue(undefined);
  invalidateMock.mockResolvedValue(undefined);

  prismaMock.product.findMany.mockResolvedValue([PRODUCT]);
  prismaMock.order.findUnique.mockImplementation(async () => ({
    ...makeOrder(),
    ...orderOverrides,
    status: orderState.status,
    paymentId: orderState.paymentId,
  }));
  prismaMock.order.updateMany.mockImplementation(
    async (args: {
      where: { status?: string; paymentId?: string };
      data: { status?: string; paymentId?: string };
    }) => {
      if (args.where.status !== undefined && args.where.status !== orderState.status) {
        return { count: 0 };
      }
      if (args.where.paymentId !== undefined && args.where.paymentId !== orderState.paymentId) {
        return { count: 0 };
      }
      if (args.data.status !== undefined) orderState.status = args.data.status;
      if (args.data.paymentId !== undefined) orderState.paymentId = args.data.paymentId;
      return { count: 1 };
    }
  );

  // Commit on success, discard on throw: the closest a mock gets to a real
  // transaction rollback, which is what the sold-out case depends on.
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) => {
    txState = { ...orderState };
    const result = await callback(txMock);
    orderState = { ...txState };
    return result;
  });

  txMock.address.create.mockResolvedValue({ id: "addr_1" });
  txMock.order.create.mockResolvedValue({ id: "order_1" });
  txMock.orderItem.createMany.mockResolvedValue({ count: 1 });
  txMock.orderEvent.create.mockResolvedValue({ id: "event_1" });
  txMock.order.updateMany.mockImplementation(
    async (args: {
      where: { status?: string; paymentId?: string };
      data: { status?: string; paymentId?: string };
    }) => {
      if (args.where.status !== undefined && args.where.status !== txState.status) {
        return { count: 0 };
      }
      if (args.where.paymentId !== undefined && args.where.paymentId !== txState.paymentId) {
        return { count: 0 };
      }
      if (args.data.status !== undefined) txState.status = args.data.status;
      if (args.data.paymentId !== undefined) txState.paymentId = args.data.paymentId;
      return { count: 1 };
    }
  );
  txMock.order.findUniqueOrThrow.mockImplementation(async () => ({
    status: txState.status,
    paymentId: txState.paymentId,
  }));
  txMock.order.findUnique.mockImplementation(async () => ({
    status: txState.status,
    paymentId: txState.paymentId,
    items: makeOrder().items,
  }));
  txMock.orderItem.findMany.mockResolvedValue(makeOrder().items);
  txMock.product.updateMany.mockResolvedValue({ count: 1 });

  // Refund ledger store for the shared claim/finalize flow.
  txMock.refund.findUnique.mockImplementation(
    async (args: { where: { orderId: string } }) =>
      refundRows.find((refund) => refund.orderId === args.where.orderId) ?? null
  );
  txMock.refund.create.mockImplementation(async (args: { data: Omit<RefundRow, "id"> }) => {
    const refund: RefundRow = { id: "refund_row_1", ...args.data };
    refundRows.push(refund);
    return { id: refund.id };
  });
  txMock.refund.update.mockImplementation(
    async (args: { where: { id: string }; data: Partial<RefundRow> }) => {
      const refund = refundRows.find((candidate) => candidate.id === args.where.id);
      if (!refund) throw new Error("refund row missing");
      Object.assign(refund, args.data);
      return { id: refund.id };
    }
  );
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
  txMock.orderEvent.findFirst.mockResolvedValue(null);

  razorpayMock.orders.create.mockResolvedValue({
    id: RAZORPAY_ORDER_ID,
    amount: ORDER_TOTAL_PAISE,
    currency: "INR",
  });
  razorpayMock.orders.fetch.mockResolvedValue({ status: "paid", amount: ORDER_TOTAL_PAISE });
});

describe("createRazorpayOrder (durable checkout intent)", () => {
  it("rejects unauthenticated callers before touching Razorpay", async () => {
    authMock.mockResolvedValue(null);

    const result = await createRazorpayOrder({ checkoutSession, orderData: addressData });

    expect(result).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Please sign in to continue.",
    });
    expect(razorpayMock.orders.create).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rate-limits order creation per user", async () => {
    const result = await createRazorpayOrder({ checkoutSession, orderData: addressData });

    expect(result.ok).toBe(true);
    expect(rateLimitMock.enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "createRazorpayOrder",
        subject: USER_ID,
        limit: 10,
        windowMs: 60_000,
      })
    );
  });

  it("creates a pending order with item snapshots before the client can pay", async () => {
    const result = await createRazorpayOrder({ checkoutSession, orderData: addressData });

    expect(result).toEqual({
      ok: true,
      data: {
        orderId: "order_1",
        razorpayOrderId: RAZORPAY_ORDER_ID,
        amountPaise: ORDER_TOTAL_PAISE,
        currency: "INR",
      },
    });

    // Razorpay first, then the durable row that carries its id.
    expect(razorpayMock.orders.create).toHaveBeenCalledTimes(1);
    expect(razorpayMock.orders.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: ORDER_TOTAL_PAISE,
        currency: "INR",
        receipt: expect.stringMatching(/^rcpt_/),
        notes: { userId: USER_ID },
      })
    );

    expect(txMock.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "pending",
        userId: USER_ID,
        transactionId: RAZORPAY_ORDER_ID,
        paymentId: "",
        paymentMethod: "RAZORPAY",
        total: "216.00",
        taxAmount: "16.00",
        addressId: "addr_1",
      }),
    });

    expect(txMock.orderItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          orderId: "order_1",
          productId: PRODUCT.id,
          productName: PRODUCT.name,
          productImage: PRODUCT.thumbnail,
          price: "200.00",
          quantity: 1,
        }),
      ],
    });
    // Nothing is reserved at init: stock is only decremented on confirmation.
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    // The audit trail starts with the order row.
    expect(txMock.orderEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order_1",
        type: "order_placed",
        fromStatus: null,
        toStatus: "pending",
        actorId: USER_ID,
      }),
    });
  });

  it("returns INTERNAL and logs the orphan Razorpay order when persistence fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      prismaMock.$transaction.mockRejectedValueOnce(new Error("db down"));

      const result = await createRazorpayOrder({ checkoutSession, orderData: addressData });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INTERNAL");
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
        level: "error",
        event: "order_persist_failed",
        // The logger redacts any `razorpay`-named key; the reference is logged
        // under a role-based key so support can still reconcile the orphan.
        orderReference: RAZORPAY_ORDER_ID,
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe("PlaceOrder (confirm with payment proof only)", () => {
  beforeEach(() => {
    prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: PRODUCT.price }]);
  });

  it("rejects an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);

    const result = await PlaceOrder(signedProof());

    expect(result).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Please sign in to continue.",
    });
    expect(razorpayMock.orders.fetch).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a caller who does not own the order", async () => {
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ userId: "someone_else" }));

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FORBIDDEN");
    expect(razorpayMock.orders.fetch).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a payment whose signature does not verify", async () => {
    const result = await PlaceOrder({ ...signedProof(), razorpaySignature: "deadbeef" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PAYMENT_FAILED");
    expect(razorpayMock.orders.fetch).not.toHaveBeenCalled();
    expect(refundMock).not.toHaveBeenCalled();
  });

  it("confirms once, decrements stock once, and treats a replay as already confirmed", async () => {
    const first = await PlaceOrder(signedProof());

    expect(first).toEqual({ ok: true, data: { orderId: "order_1" } });
    expect(orderState).toEqual({ status: "confirmed", paymentId: RAZORPAY_PAYMENT_ID });
    // The claim is only available while the payment proof is empty, making it
    // mutually exclusive with the refund claim.
    expect(txMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order_1", status: "pending", paymentId: "" },
      data: { status: "confirmed", paymentId: RAZORPAY_PAYMENT_ID },
    });
    // One decrement + one zero-stock availability check for the single line.
    expect(txMock.product.updateMany).toHaveBeenCalledTimes(2);
    expect(txMock.product.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: PRODUCT.id, availability: "IN_STOCK", stockQty: { gte: 1 } },
      data: { stockQty: { decrement: 1 } },
    });
    // The transition winner records the confirmation event exactly once.
    expect(txMock.orderEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order_1",
        type: "payment_confirmed",
        fromStatus: "pending",
        toStatus: "confirmed",
        actorId: USER_ID,
      }),
    });
    expect(invalidateMock).toHaveBeenCalledWith(PRODUCT.id);

    const second = await PlaceOrder(signedProof());

    expect(second).toEqual({ ok: true, data: { orderId: "order_1" } });
    // The replay returns before the confirm transaction: no second decrement
    // and no duplicate confirmation event.
    expect(txMock.product.updateMany).toHaveBeenCalledTimes(2);
    expect(txMock.orderEvent.create).toHaveBeenCalledTimes(1);
    expect(razorpayMock.orders.fetch).toHaveBeenCalledTimes(1);
  });

  it("confirms a coupon order without treating the stored discount as a price change", async () => {
    // ₹200 - ₹20 coupon = ₹180 taxable, + 8% GST = ₹194.40.
    orderOverrides = {
      total: "194.40",
      taxAmount: "14.40",
      discountAmount: "20.00",
      couponCode: "SAVE10",
    };
    razorpayMock.orders.fetch.mockResolvedValue({ status: "paid", amount: 19440 });

    const result = await PlaceOrder(signedProof());

    expect(result).toEqual({ ok: true, data: { orderId: "order_1" } });
    expect(orderState).toEqual({ status: "confirmed", paymentId: RAZORPAY_PAYMENT_ID });
    // The discounted total is what was charged and what the re-price expects.
    expect(refundMock).not.toHaveBeenCalled();
  });

  it("refuses to confirm a pending order whose payment proof is already recorded", async () => {
    // A refund is in flight (or its API call failed): it owns the capture.
    initState("pending", RAZORPAY_PAYMENT_ID);

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PAYMENT_FAILED");
    expect(result.message).toMatch(/support/i);
    expect(razorpayMock.orders.fetch).not.toHaveBeenCalled();
    expect(refundMock).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("treats a lost confirm claim as success when a concurrent confirmation won", async () => {
    // The claim inside the transaction matches nothing; the winner left the
    // order confirmed with the proof recorded.
    txMock.order.updateMany.mockResolvedValue({ count: 0 });
    txMock.order.findUniqueOrThrow.mockResolvedValue({
      status: "confirmed",
      paymentId: RAZORPAY_PAYMENT_ID,
    });

    const result = await PlaceOrder(signedProof());

    expect(result).toEqual({ ok: true, data: { orderId: "order_1" } });
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(refundMock).not.toHaveBeenCalled();
  });

  it("refuses to confirm when a concurrent refund already recorded the proof", async () => {
    // The refund path wrote the proof first, so the confirm claim matches
    // nothing and the in-transaction read exposes the refund-owned row.
    txMock.order.updateMany.mockResolvedValueOnce({ count: 0 });
    txMock.order.findUniqueOrThrow.mockResolvedValueOnce({
      status: "pending",
      paymentId: RAZORPAY_PAYMENT_ID,
    });

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PAYMENT_FAILED");
    expect(result.message).toMatch(/support/i);
    // The loser must not decrement stock or refund a capture it never owned.
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(refundMock).not.toHaveBeenCalled();
    // Nothing was written: the order still belongs to the refund.
    expect(orderState).toEqual({ status: "pending", paymentId: "" });
  });

  it("refunds once through the late-capture backstop when a concurrent cancel owns the order", async () => {
    // The customer cancel wins the confirm claim after PlaceOrder read
    // `pending`, leaving the order cancelled with no proof recorded.
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) => {
      if (txState.status === "pending") {
        txState = { status: "cancelled", paymentId: "" };
      }
      const result = await callback(txMock);
      orderState = { ...txState };
      return result;
    });

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PAYMENT_FAILED");
    expect(result.message).toMatch(/refunded/i);

    expect(refundMock).toHaveBeenCalledTimes(1);
    expect(refundMock).toHaveBeenCalledWith({
      paymentId: RAZORPAY_PAYMENT_ID,
      amountPaise: ORDER_TOTAL_PAISE,
      orderId: "order_1",
      reason: "LATE_CAPTURE",
    });
    // The order stays cancelled; the proof and the ledger carry the refund.
    expect(orderState).toEqual({ status: "cancelled", paymentId: RAZORPAY_PAYMENT_ID });
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      orderId: "order_1",
      razorpayRefundId: "rfnd_1",
      paymentId: RAZORPAY_PAYMENT_ID,
      amount: "216.00",
      reason: "LATE_CAPTURE",
      status: "processed",
    });
    expect(refundReasonLabel(refundRows[0].reason)).toBe("Late capture");

    // Replay: the order is terminal and the proof is recorded — no second refund.
    const replay = await PlaceOrder(signedProof());

    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("CONFLICT");
    expect(refundMock).toHaveBeenCalledTimes(1);
  });

  it("returns a support message and records refund_failed when the late-capture refund fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The customer cancel wins the confirm claim, then the late-capture
      // refund call itself fails: the proof stays recorded for support.
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof txMock) => unknown) => {
          if (txState.status === "pending") {
            txState = { status: "cancelled", paymentId: "" };
          }
          const result = await callback(txMock);
          orderState = { ...txState };
          return result;
        }
      );
      refundMock.mockRejectedValue(new Error("razorpay unavailable"));

      const result = await PlaceOrder(signedProof());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("PAYMENT_FAILED");
      expect(result.message).toMatch(/couldn't refund/i);
      expect(refundMock).toHaveBeenCalledTimes(1);
      expect(refundMock).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "LATE_CAPTURE", orderId: "order_1" })
      );

      // The capture is claimed (never silently dropped) and the failed attempt
      // is on the ledger; the order stays cancelled.
      expect(orderState).toEqual({ status: "cancelled", paymentId: RAZORPAY_PAYMENT_ID });
      expect(refundRows).toHaveLength(1);
      expect(refundRows[0]).toMatchObject({
        orderId: "order_1",
        reason: "LATE_CAPTURE",
        status: "failed",
      });

      const eventTypes = txMock.orderEvent.create.mock.calls.map(
        (call) => (call[0] as { data: { type: string } }).data.type
      );
      expect(eventTypes).toContain("refund_requested");
      expect(eventTypes).toContain("refund_failed");
      expect(eventTypes).not.toContain("refund_processed");

      const entries = error.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "late_capture_refund_failed", orderId: "order_1" }),
        ])
      );
    } finally {
      error.mockRestore();
    }
  });

  it("returns CONFLICT when the late capture was already handled elsewhere", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The order is observed as cancelled with no proof, but the proof claim
      // loses: another refund path already recorded the capture.
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof txMock) => unknown) => {
          txState = { status: "cancelled", paymentId: "" };
          const result = await callback(txMock);
          orderState = { ...txState };
          return result;
        }
      );
      txMock.order.updateMany.mockResolvedValue({ count: 0 });
      txMock.order.findUniqueOrThrow.mockResolvedValue({
        status: "cancelled",
        paymentId: "",
      });

      const result = await PlaceOrder(signedProof());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("CONFLICT");
      expect(refundMock).not.toHaveBeenCalled();
      expect(refundRows).toHaveLength(0);
      expect(orderState).toEqual({ status: "cancelled", paymentId: "" });
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        event: "late_capture_already_claimed",
        orderId: "order_1",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("refunds the capture and returns PRICE_CHANGED when current prices drift", async () => {
    prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: "300.00" }]);

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRICE_CHANGED");
    expect(result.message).toMatch(/refunded/i);

    expect(refundMock).toHaveBeenCalledTimes(1);
    expect(refundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: RAZORPAY_PAYMENT_ID,
        amountPaise: ORDER_TOTAL_PAISE,
        reason: "PRICE_CHANGED",
      })
    );
    expect(orderState).toEqual({ status: "refunded", paymentId: RAZORPAY_PAYMENT_ID });
    expect(txMock.product.updateMany).not.toHaveBeenCalled();

    // The automatic refund is on the shared ledger, exactly as the order
    // detail page and support expect.
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      orderId: "order_1",
      razorpayRefundId: "rfnd_1",
      paymentId: RAZORPAY_PAYMENT_ID,
      amount: "216.00",
      reason: "PRICE_CHANGED",
      status: "processed",
    });
    expect(refundReasonLabel(refundRows[0].reason)).toBe("Price changed");

    // The refund is on the audit trail too; the `refund.processed` webhook
    // then sees a settled ledger row and does not duplicate the event.
    expect(txMock.orderEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order_1",
        type: "refund_processed",
        fromStatus: "pending",
        toStatus: "refunded",
        actorId: null,
      }),
    });
  });

  it("updates an existing ledger row instead of duplicating the automatic refund", async () => {
    prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: "300.00" }]);
    // A webhook reconciled this order's refund first: the row must be updated,
    // not duplicated (Refund.orderId is unique).
    refundRows = [
      {
        id: "refund_row_1",
        orderId: "order_1",
        razorpayRefundId: "rfnd_earlier",
        paymentId: RAZORPAY_PAYMENT_ID,
        amount: "216.00",
        reason: "PRICE_CHANGED",
        status: "requested",
      },
    ];

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRICE_CHANGED");
    expect(txMock.refund.create).not.toHaveBeenCalled();
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      razorpayRefundId: "rfnd_1",
      status: "processed",
    });
  });

  it("retries a P2002 insert race as an update instead of duplicating the ledger row", async () => {
    prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: "300.00" }]);
    // A webhook path inserted the row between our read and our insert: the
    // first read misses it, the insert loses the unique race, and the retry
    // converges on that row.
    refundRows = [
      {
        id: "refund_row_1",
        orderId: "order_1",
        razorpayRefundId: "rfnd_webhook",
        paymentId: RAZORPAY_PAYMENT_ID,
        amount: "216.00",
        reason: "PRICE_CHANGED",
        status: "requested",
      },
    ];
    txMock.refund.findUnique.mockResolvedValueOnce(null);
    txMock.refund.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRICE_CHANGED");
    // One rejected insert, then an update of the concurrent row.
    expect(txMock.refund.create).toHaveBeenCalledTimes(1);
    expect(txMock.refund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "refund_row_1", status: "requested" } })
    );
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      razorpayRefundId: "rfnd_1",
      status: "processed",
    });
  });

  it("leaves an already-processed ledger row untouched", async () => {
    prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: "300.00" }]);
    // A webhook-first reconciliation already settled this refund with the real
    // Razorpay id; the automatic path must not rewrite that audit trail.
    refundRows = [
      {
        id: "refund_row_1",
        orderId: "order_1",
        razorpayRefundId: "rfnd_webhook",
        paymentId: RAZORPAY_PAYMENT_ID,
        amount: "216.00",
        reason: "PRICE_CHANGED",
        status: "processed",
      },
    ];

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRICE_CHANGED");
    // The guarded update matches nothing on a processed row.
    expect(txMock.refund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "refund_row_1", status: "requested" } })
    );
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      razorpayRefundId: "rfnd_webhook",
      status: "processed",
    });
  });

  it("returns success without refunding when a concurrent confirmation wins the refund claim", async () => {
    // Price drift would normally refund, but the refund claim finds the order
    // already owned by the confirm path: no money moves, no stock is touched.
    prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: "300.00" }]);
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.order.findUnique
      .mockResolvedValueOnce(makeOrder())
      .mockResolvedValueOnce({ status: "confirmed", paymentId: RAZORPAY_PAYMENT_ID });

    const result = await PlaceOrder(signedProof());

    expect(result).toEqual({ ok: true, data: { orderId: "order_1" } });
    expect(refundMock).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("returns PAYMENT_FAILED when the refund claim loses to a recorded proof", async () => {
    // Price drift enters the refund path, but the claim matches nothing: a
    // concurrent refund already recorded the proof, so refunding again would
    // return the capture twice.
    prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: "300.00" }]);
    prismaMock.order.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.order.findUnique
      .mockResolvedValueOnce({ ...makeOrder(), status: "pending", paymentId: "" })
      .mockResolvedValueOnce({ status: "pending", paymentId: RAZORPAY_PAYMENT_ID });

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PAYMENT_FAILED");
    expect(result.message).toMatch(/support/i);
    expect(refundMock).not.toHaveBeenCalled();
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
    expect(orderState).toEqual({ status: "pending", paymentId: "" });
  });

  it("refunds the capture and returns AMOUNT_MISMATCH when Razorpay reports a different amount", async () => {
    razorpayMock.orders.fetch.mockResolvedValue({ status: "paid", amount: ORDER_TOTAL_PAISE - 1 });

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("AMOUNT_MISMATCH");
    expect(refundMock).toHaveBeenCalledTimes(1);
    expect(orderState.status).toBe("refunded");
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("refunds and returns OUT_OF_STOCK when a product sold out after init", async () => {
    txMock.product.updateMany.mockResolvedValue({ count: 0 });

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("OUT_OF_STOCK");
    expect(refundMock).toHaveBeenCalledTimes(1);
    // The confirm transaction rolled back its claim; the refund path is the
    // only durable write, and it never leaves the order confirmed.
    expect(orderState.status).toBe("refunded");
    expect(orderState.status).not.toBe("confirmed");
  });

  it("refunds and returns OUT_OF_STOCK when the product was deleted (null snapshot id)", async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      makeOrder({ items: [{ ...makeOrder().items[0], productId: null }] })
    );

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("OUT_OF_STOCK");
    expect(refundMock).toHaveBeenCalledTimes(1);
    expect(orderState.status).toBe("refunded");
    expect(txMock.product.updateMany).not.toHaveBeenCalled();
  });

  it("leaves the order pending with the payment id when the refund itself fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      prismaMock.product.findMany.mockResolvedValue([{ id: PRODUCT.id, price: "300.00" }]);
      refundMock.mockRejectedValue(new Error("razorpay unavailable"));

      const result = await PlaceOrder(signedProof());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("PAYMENT_FAILED");
      expect(result.message).toMatch(/support/i);
      expect(orderState).toEqual({ status: "pending", paymentId: RAZORPAY_PAYMENT_ID });

      expect(log).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(String(log.mock.calls[0][0]));
      expect(entry).toMatchObject({
        level: "error",
        event: "order_refund_failed",
        orderId: "order_1",
        reason: "PRICE_CHANGED",
      });
      // No card/customer data is ever logged.
      expect(String(log.mock.calls[0][0])).not.toMatch(/9876543210|MG Road/);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a cancelled or refunded order with CONFLICT", async () => {
    initState("cancelled");

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CONFLICT");
    expect(razorpayMock.orders.fetch).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the Razorpay order has no durable row", async () => {
    prismaMock.order.findUnique.mockResolvedValue(null);

    const result = await PlaceOrder(signedProof());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_FOUND");
    expect(razorpayMock.orders.fetch).not.toHaveBeenCalled();
  });
});
