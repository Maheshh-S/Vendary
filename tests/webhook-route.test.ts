import { beforeEach, describe, expect, it, vi } from "vitest";
import { signRazorpayPayload } from "@/lib/razorpay";

// The webhook touches Prisma and Next's cache revalidation — neither exists
// in unit tests. Mock both; the behavior under test is the route's trust
// boundary and status transitions.
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    order: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { POST } from "@/app/api/razorpay/webhook/route";
import { prisma } from "@/lib/db/prisma";

const SECRET = "webhook-test-secret";
const WEBHOOK_BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        order_id: "order_123",
        payment_id: "pay_123",
      },
    },
  },
});

const signedRequest = (body: string, secret = SECRET) =>
  new Request("https://vendary.test/api/razorpay/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signRazorpayPayload(body, secret),
    },
    body,
  });

describe("razorpay webhook route", () => {
  beforeEach(() => {
    vi.mocked(prisma.order.updateMany).mockClear().mockResolvedValue({ count: 1 });
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  });

  it("returns 501 when the webhook secret is not configured", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const res = await POST(signedRequest(WEBHOOK_BODY));
    expect(res.status).toBe(501);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("returns 400 for an unsigned or wrongly-signed request", async () => {
    const unsigned = new Request("https://vendary.test/api/razorpay/webhook", {
      method: "POST",
      body: WEBHOOK_BODY,
    });
    expect((await POST(unsigned)).status).toBe(400);

    const wrongSecret = signedRequest(WEBHOOK_BODY, "other-secret");
    expect((await POST(wrongSecret)).status).toBe(400);

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed but non-JSON body", async () => {
    const res = await POST(signedRequest("not-json"));
    expect(res.status).toBe(400);
  });

  it("advances a pending order to confirmed on payment.captured", async () => {
    const res = await POST(signedRequest(WEBHOOK_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { transactionId: "order_123", status: "pending" },
      data: { status: "confirmed" },
    });
  });

  it("cancels a refunded order on refund.processed", async () => {
    const body = JSON.stringify({
      event: "refund.processed",
      payload: { refund: { entity: { payment_id: "pay_123" } } },
    });
    const res = await POST(signedRequest(body));
    expect(res.status).toBe(200);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { paymentId: "pay_123", status: { not: "cancelled" } },
      data: { status: "cancelled" },
    });
  });

  it("acknowledges unknown events without touching the database", async () => {
    const res = await POST(signedRequest(JSON.stringify({ event: "webhook.test" })));
    expect(res.status).toBe(200);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("returns 500 so Razorpay retries when the database write fails", async () => {
    vi.mocked(prisma.order.updateMany).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(signedRequest(WEBHOOK_BODY));
    expect(res.status).toBe(500);
  });
});
