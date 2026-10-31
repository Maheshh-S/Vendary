import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests for the Razorpay webhook backstop.
 *
 * Every boundary is mocked: Prisma, the confirm claim, the Razorpay refund
 * call and Next's cache. The shared refund claim (`lib/orders/refund.ts`), the
 * typed schema and the signature verifier run for real, so the assertions
 * cover the actual status guards and the "refund exactly once" behaviour.
 */

const { prismaMock, txMock, confirmOrderMock, refundPaymentMock, revalidateMock } = vi.hoisted(() => {
  const txMock = {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    product: { updateMany: vi.fn() },
  };
  return {
    txMock,
    prismaMock: {
      order: { findUnique: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(),
    },
    confirmOrderMock: vi.fn(),
    refundPaymentMock: vi.fn(),
    revalidateMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/orders/confirm-order", () => ({ confirmOrder: confirmOrderMock }));
vi.mock("@/lib/razorpay-client", () => ({
  getRazorpayClient: vi.fn(),
  refundPayment: refundPaymentMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { POST } from "@/app/api/razorpay/webhook/route";
import { AppError } from "@/lib/errors";
import { signRazorpayPayload } from "@/lib/razorpay";

const SECRET = "webhook-test-secret";
const ORDER_ID = "order_1";
const RAZORPAY_ORDER_ID = "order_rzp_1";
const PAYMENT_ID = "pay_123";
const ORDER_TOTAL_PAISE = 21600;

const ORDER = {
  id: ORDER_ID,
  status: "pending",
  total: "216.00",
};

const paymentEntity = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  order_id: RAZORPAY_ORDER_ID,
  amount: ORDER_TOTAL_PAISE,
  status: "captured",
  ...overrides,
});

const capturedBody = (entity = paymentEntity()) =>
  JSON.stringify({ event: "payment.captured", payload: { payment: { entity } } });

const failedBody = (
  entity = paymentEntity({ status: "failed", error_code: "BAD_REQUEST_ERROR" })
) => JSON.stringify({ event: "payment.failed", payload: { payment: { entity } } });

const refundEntity = (overrides: Record<string, unknown> = {}) => ({
  id: "rfnd_123",
  payment_id: PAYMENT_ID,
  amount: ORDER_TOTAL_PAISE,
  status: "processed",
  ...overrides,
});

const refundBody = (entity = refundEntity()) =>
  JSON.stringify({ event: "refund.processed", payload: { refund: { entity } } });

const signedRequest = (body: string, secret = SECRET) =>
  new Request("https://vendary.test/api/razorpay/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signRazorpayPayload(body, secret),
    },
    body,
  });

const orderWithItems = (status: string) => ({
  ...ORDER,
  status,
  items: [
    { productId: "prod_1", quantity: 2 },
    { productId: null, quantity: 1 },
  ],
});

describe("razorpay webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;

    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER });
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) =>
      callback(txMock)
    );

    confirmOrderMock.mockResolvedValue({ status: "confirmed" });
    refundPaymentMock.mockResolvedValue({ refundId: "rfnd_123" });
    revalidateMock.mockReturnValue(undefined);

    txMock.order.updateMany.mockResolvedValue({ count: 1 });
    txMock.product.updateMany.mockResolvedValue({ count: 1 });
  });

  describe("trust boundary", () => {
    it("returns 501 when the webhook secret is not configured", async () => {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;

      const res = await POST(signedRequest(capturedBody()));

      expect(res.status).toBe(501);
      expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
    });

    it("returns 400 for an unsigned or wrongly-signed request", async () => {
      const unsigned = new Request("https://vendary.test/api/razorpay/webhook", {
        method: "POST",
        body: capturedBody(),
      });
      expect((await POST(unsigned)).status).toBe(400);

      const wrongSecret = signedRequest(capturedBody(), "other-secret");
      expect((await POST(wrongSecret)).status).toBe(400);

      expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
      expect(refundPaymentMock).not.toHaveBeenCalled();
    });

    it("returns 400 for a signed but non-JSON body", async () => {
      const res = await POST(signedRequest("not-json"));

      expect(res.status).toBe(400);
      expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
    });

    it("returns 400 without DB access for a signed but schema-invalid payload", async () => {
      const res = await POST(signedRequest(capturedBody(paymentEntity({ amount: "21600" }))));

      expect(res.status).toBe(400);
      expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(refundPaymentMock).not.toHaveBeenCalled();
    });

    it("returns 400 when a handled event omits its entity", async () => {
      const body = JSON.stringify({ event: "payment.captured", payload: {} });
      const res = await POST(signedRequest(body));

      expect(res.status).toBe(400);
      expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("payment.captured", () => {
    it("confirms a pending order with the captured payment id", async () => {
      const res = await POST(signedRequest(capturedBody()));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect(confirmOrderMock).toHaveBeenCalledTimes(1);
      expect(confirmOrderMock).toHaveBeenCalledWith(ORDER_ID, PAYMENT_ID);
      expect(refundPaymentMock).not.toHaveBeenCalled();
      expect(revalidateMock).toHaveBeenCalledWith("/admin");
      expect(revalidateMock).toHaveBeenCalledWith("/my-orders");
    });

    it("acknowledges a capture whose order row does not exist", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        prismaMock.order.findUnique.mockResolvedValue(null);

        const res = await POST(signedRequest(capturedBody()));

        expect(res.status).toBe(200);
        expect(confirmOrderMock).not.toHaveBeenCalled();
        expect(refundPaymentMock).not.toHaveBeenCalled();
        expect(revalidateMock).not.toHaveBeenCalled();
        expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
          event: "webhook_order_not_found",
          razorpayOrderId: RAZORPAY_ORDER_ID,
          paymentId: PAYMENT_ID,
        });
      } finally {
        warn.mockRestore();
      }
    });

    it.each(["confirmed", "shipped", "delivered", "refunded", "cancelled"])(
      "is an idempotent no-op when the order is already %s",
      async (status) => {
        prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, status });

        const res = await POST(signedRequest(capturedBody()));

        expect(res.status).toBe(200);
        expect(confirmOrderMock).not.toHaveBeenCalled();
        expect(refundPaymentMock).not.toHaveBeenCalled();
        expect(revalidateMock).not.toHaveBeenCalled();
      }
    );

    it("refunds once and marks the order refunded when the captured amount is wrong", async () => {
      const capturedPaise = ORDER_TOTAL_PAISE - 1;

      const res = await POST(signedRequest(capturedBody(paymentEntity({ amount: capturedPaise }))));

      expect(res.status).toBe(200);
      expect(confirmOrderMock).not.toHaveBeenCalled();
      expect(refundPaymentMock).toHaveBeenCalledTimes(1);
      expect(refundPaymentMock).toHaveBeenCalledWith({
        paymentId: PAYMENT_ID,
        amountPaise: capturedPaise,
        orderId: ORDER_ID,
        reason: "AMOUNT_MISMATCH",
      });
      // Claim the pending order with the payment proof, then flip it.
      expect(prismaMock.order.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: ORDER_ID, status: "pending", paymentId: "" },
        data: { paymentId: PAYMENT_ID },
      });
      expect(prismaMock.order.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: ORDER_ID, status: "pending" },
        data: { status: "refunded" },
      });
      expect(revalidateMock).toHaveBeenCalledWith("/admin");
      expect(revalidateMock).toHaveBeenCalledWith("/my-orders");
    });

    it("refunds once and marks the order refunded when confirmation sells out", async () => {
      confirmOrderMock.mockRejectedValue(
        new AppError("OUT_OF_STOCK", '"Widget" just sold out. Your payment will be refunded.')
      );

      const res = await POST(signedRequest(capturedBody()));

      expect(res.status).toBe(200);
      expect(refundPaymentMock).toHaveBeenCalledTimes(1);
      expect(refundPaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: PAYMENT_ID, orderId: ORDER_ID, reason: "OUT_OF_STOCK" })
      );
      expect(prismaMock.order.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: ORDER_ID, status: "pending" },
        data: { status: "refunded" },
      });
      expect(revalidateMock).toHaveBeenCalledWith("/admin");
    });

    it("returns 500 and leaves the order pending when the refund call fails", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        confirmOrderMock.mockRejectedValue(new AppError("OUT_OF_STOCK", "sold out"));
        refundPaymentMock.mockRejectedValue(new Error("razorpay unavailable"));

        const res = await POST(signedRequest(capturedBody()));

        expect(res.status).toBe(500);
        // The claim is the only write: the order is never marked refunded
        // without a successful refund.
        expect(prismaMock.order.updateMany).toHaveBeenCalledTimes(1);
        expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
          where: { id: ORDER_ID, status: "pending", paymentId: "" },
          data: { paymentId: PAYMENT_ID },
        });
        expect(revalidateMock).not.toHaveBeenCalled();

        const entries = error.mock.calls.map((call) => JSON.parse(String(call[0])));
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              level: "error",
              event: "order_refund_failed",
              orderId: ORDER_ID,
              reason: "OUT_OF_STOCK",
            }),
            expect.objectContaining({
              level: "error",
              event: "webhook_refund_failed",
              orderId: ORDER_ID,
              paymentId: PAYMENT_ID,
              reason: "OUT_OF_STOCK",
            }),
          ])
        );
      } finally {
        error.mockRestore();
      }
    });

    it("does not refund again when a refund already owns the pending order", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        confirmOrderMock.mockResolvedValue({
          status: "already",
          current: "pending",
          paymentId: PAYMENT_ID,
        });

        const res = await POST(signedRequest(capturedBody()));

        expect(res.status).toBe(200);
        expect(refundPaymentMock).not.toHaveBeenCalled();
        expect(revalidateMock).not.toHaveBeenCalled();
        expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
          event: "webhook_confirm_lost_claim",
          orderId: ORDER_ID,
          orderStatus: "pending",
        });
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("payment.failed", () => {
    it("logs a structured warning without changing any state", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await POST(signedRequest(failedBody()));

        expect(res.status).toBe(200);
        expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
        expect(prismaMock.order.updateMany).not.toHaveBeenCalled();
        expect(confirmOrderMock).not.toHaveBeenCalled();
        expect(refundPaymentMock).not.toHaveBeenCalled();

        const entry = JSON.parse(String(warn.mock.calls[0][0]));
        expect(entry).toMatchObject({
          level: "warn",
          event: "payment_failed",
          orderId: RAZORPAY_ORDER_ID,
          paymentId: PAYMENT_ID,
          errorCode: "BAD_REQUEST_ERROR",
        });
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("refund.processed", () => {
    it("moves a confirmed order to refunded and restores stock exactly once", async () => {
      txMock.order.findFirst.mockResolvedValue(orderWithItems("confirmed"));

      const res = await POST(signedRequest(refundBody()));

      expect(res.status).toBe(200);
      expect(txMock.order.findFirst).toHaveBeenCalledWith({
        where: { paymentId: PAYMENT_ID },
        include: { items: true },
      });
      expect(txMock.order.updateMany).toHaveBeenCalledWith({
        where: { id: ORDER_ID, status: "confirmed" },
        data: { status: "refunded" },
      });
      // Only the line with a product id is restored; the deleted product's
      // null snapshot is skipped.
      expect(txMock.product.updateMany).toHaveBeenCalledTimes(1);
      expect(txMock.product.updateMany).toHaveBeenCalledWith({
        where: { id: "prod_1" },
        data: { stockQty: { increment: 2 }, availability: "IN_STOCK" },
      });
      expect(revalidateMock).toHaveBeenCalledWith("/admin");
      expect(revalidateMock).toHaveBeenCalledWith("/my-orders");
    });

    it("is a no-op on replay once the order is refunded", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        txMock.order.findFirst.mockResolvedValue(orderWithItems("refunded"));

        const res = await POST(signedRequest(refundBody()));

        expect(res.status).toBe(200);
        expect(txMock.order.updateMany).not.toHaveBeenCalled();
        expect(txMock.product.updateMany).not.toHaveBeenCalled();
        expect(revalidateMock).not.toHaveBeenCalled();
        expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
          event: "webhook_refund_ignored",
          orderStatus: "refunded",
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("never overwrites a cancelled order", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        txMock.order.findFirst.mockResolvedValue(orderWithItems("cancelled"));

        const res = await POST(signedRequest(refundBody()));

        expect(res.status).toBe(200);
        expect(txMock.order.updateMany).not.toHaveBeenCalled();
        expect(txMock.product.updateMany).not.toHaveBeenCalled();
        expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
          event: "webhook_refund_ignored",
          orderStatus: "cancelled",
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("moves a pending order to refunded without restoring stock", async () => {
      txMock.order.findFirst.mockResolvedValue(orderWithItems("pending"));

      const res = await POST(signedRequest(refundBody()));

      expect(res.status).toBe(200);
      expect(txMock.order.updateMany).toHaveBeenCalledWith({
        where: { id: ORDER_ID, status: "pending" },
        data: { status: "refunded" },
      });
      expect(txMock.product.updateMany).not.toHaveBeenCalled();
      expect(revalidateMock).toHaveBeenCalledWith("/admin");
    });

    it.each(["shipped", "delivered"])(
      "moves a %s order to refunded without restoring stock",
      async (status) => {
        txMock.order.findFirst.mockResolvedValue(orderWithItems(status));

        const res = await POST(signedRequest(refundBody()));

        expect(res.status).toBe(200);
        expect(txMock.order.updateMany).toHaveBeenCalledWith({
          where: { id: ORDER_ID, status },
          data: { status: "refunded" },
        });
        expect(txMock.product.updateMany).not.toHaveBeenCalled();
      }
    );

    it("does not restore stock when another path wins the transition", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        txMock.order.findFirst.mockResolvedValue(orderWithItems("confirmed"));
        txMock.order.updateMany.mockResolvedValue({ count: 0 });

        const res = await POST(signedRequest(refundBody()));

        expect(res.status).toBe(200);
        expect(txMock.product.updateMany).not.toHaveBeenCalled();
        expect(revalidateMock).not.toHaveBeenCalled();
        expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
          event: "webhook_refund_raced",
          orderStatus: "confirmed",
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("ignores a partial refund without transitioning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        txMock.order.findFirst.mockResolvedValue(orderWithItems("confirmed"));

        const res = await POST(signedRequest(refundBody(refundEntity({ amount: 100 }))));

        expect(res.status).toBe(200);
        expect(txMock.order.updateMany).not.toHaveBeenCalled();
        expect(txMock.product.updateMany).not.toHaveBeenCalled();
        expect(revalidateMock).not.toHaveBeenCalled();
        expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
          event: "webhook_refund_partial",
          orderId: ORDER_ID,
          refundedPaise: 100,
          orderTotalPaise: ORDER_TOTAL_PAISE,
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("acknowledges a refund whose order row does not exist", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        txMock.order.findFirst.mockResolvedValue(null);

        const res = await POST(signedRequest(refundBody()));

        expect(res.status).toBe(200);
        expect(txMock.order.updateMany).not.toHaveBeenCalled();
        expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
          event: "webhook_refund_order_not_found",
          paymentId: PAYMENT_ID,
        });
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("failure modes", () => {
    it("acknowledges unknown events without touching the database", async () => {
      const body = JSON.stringify({ event: "payment.authorized", payload: {} });

      const res = await POST(signedRequest(body));

      expect(res.status).toBe(200);
      expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(revalidateMock).not.toHaveBeenCalled();
    });

    it("returns 500 so Razorpay retries when the database is unavailable", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        prismaMock.order.findUnique.mockRejectedValue(new Error("db down"));

        const res = await POST(signedRequest(capturedBody()));

        expect(res.status).toBe(500);
        expect(refundPaymentMock).not.toHaveBeenCalled();
        expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
          level: "error",
          event: "webhook_processing_failed",
          eventType: "payment.captured",
        });
      } finally {
        error.mockRestore();
      }
    });
  });
});
