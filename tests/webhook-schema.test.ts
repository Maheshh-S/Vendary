import { describe, expect, it } from "vitest";

import {
  paymentEntitySchema,
  refundEntitySchema,
  webhookSchema,
} from "@/schemas/razorpay/webhook-schema";

/**
 * The webhook body is a trust boundary: the HMAC proves the sender, but the
 * shape still has to be validated before any DB read or write. Amounts stay
 * integer paise on the wire.
 */

const validPayment = {
  id: "pay_123",
  order_id: "order_123",
  amount: 21600,
  status: "captured",
};

const validRefund = {
  id: "rfnd_123",
  payment_id: "pay_123",
  amount: 21600,
  status: "processed",
};

describe("payment entity schema", () => {
  it("accepts a captured payment", () => {
    expect(paymentEntitySchema.parse(validPayment)).toEqual(validPayment);
  });

  it("keeps an optional error code for failed payments", () => {
    const parsed = paymentEntitySchema.parse({
      ...validPayment,
      status: "failed",
      error_code: "BAD_REQUEST_ERROR",
    });

    expect(parsed.error_code).toBe("BAD_REQUEST_ERROR");
  });

  it("rejects a fractional amount because paise are integers", () => {
    expect(paymentEntitySchema.safeParse({ ...validPayment, amount: 21600.5 }).success).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(paymentEntitySchema.safeParse({ ...validPayment, amount: -1 }).success).toBe(false);
  });

  it("rejects an amount sent as a string", () => {
    expect(paymentEntitySchema.safeParse({ ...validPayment, amount: "21600" }).success).toBe(false);
  });

  it.each(["id", "order_id", "amount", "status"] as const)("rejects a missing %s", (field) => {
    const invalid: Record<string, unknown> = { ...validPayment };
    delete invalid[field];

    expect(paymentEntitySchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a non-string payment id", () => {
    expect(paymentEntitySchema.safeParse({ ...validPayment, id: 42 }).success).toBe(false);
  });
});

describe("refund entity schema", () => {
  it("accepts a processed refund", () => {
    expect(refundEntitySchema.parse(validRefund)).toEqual(validRefund);
  });

  it.each(["id", "payment_id", "amount", "status"] as const)("rejects a missing %s", (field) => {
    const invalid: Record<string, unknown> = { ...validRefund };
    delete invalid[field];

    expect(refundEntitySchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a fractional or negative amount", () => {
    expect(refundEntitySchema.safeParse({ ...validRefund, amount: 1.5 }).success).toBe(false);
    expect(refundEntitySchema.safeParse({ ...validRefund, amount: -100 }).success).toBe(false);
  });
});

describe("webhook envelope schema", () => {
  it("accepts a captured payment envelope", () => {
    const parsed = webhookSchema.parse({
      event: "payment.captured",
      payload: { payment: { entity: validPayment } },
    });

    expect(parsed.event).toBe("payment.captured");
    expect(parsed.payload.payment?.entity.amount).toBe(21600);
  });

  it("accepts a refund envelope", () => {
    const parsed = webhookSchema.parse({
      event: "refund.processed",
      payload: { refund: { entity: validRefund } },
    });

    expect(parsed.payload.refund?.entity.payment_id).toBe("pay_123");
  });

  it("accepts an unknown event with an empty payload", () => {
    expect(webhookSchema.safeParse({ event: "payment.authorized", payload: {} }).success).toBe(
      true
    );
  });

  it("rejects a body without a payload object", () => {
    expect(webhookSchema.safeParse({ event: "payment.captured" }).success).toBe(false);
  });

  it("rejects a malformed entity inside the payload", () => {
    expect(
      webhookSchema.safeParse({
        event: "payment.captured",
        payload: { payment: { entity: { ...validPayment, amount: "21600" } } },
      }).success
    ).toBe(false);
  });

  it("strips unknown keys instead of passing them through", () => {
    const parsed = webhookSchema.parse({
      event: "payment.captured",
      extra: "ignored",
      payload: {
        payment: { entity: { ...validPayment, email: "shopper@example.com" } },
      },
    });

    expect(parsed).not.toHaveProperty("extra");
    expect(parsed.payload.payment?.entity).not.toHaveProperty("email");
  });
});
