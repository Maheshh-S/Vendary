import { describe, expect, it } from "vitest";
import {
  signRazorpayPayload,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
} from "@/lib/razorpay";

const SECRET = "test-key-secret";
const ORDER_ID = "order_NyaSEw1fmmJEtd";
const PAYMENT_ID = "pay_NyaTFw2gn4dNqq";

describe("verifyRazorpayPaymentSignature", () => {
  it("accepts a correctly signed payment", () => {
    const signature = signRazorpayPayload(`${ORDER_ID}|${PAYMENT_ID}`, SECRET);
    expect(
      verifyRazorpayPaymentSignature(ORDER_ID, PAYMENT_ID, signature, SECRET)
    ).toBe(true);
  });

  it("rejects a tampered payment id (signature from a different payment)", () => {
    const signature = signRazorpayPayload(`${ORDER_ID}|${PAYMENT_ID}`, SECRET);
    expect(
      verifyRazorpayPaymentSignature(ORDER_ID, "pay_forged", signature, SECRET)
    ).toBe(false);
  });

  it("rejects signatures produced with a different secret", () => {
    const signature = signRazorpayPayload(`${ORDER_ID}|${PAYMENT_ID}`, "other-secret");
    expect(
      verifyRazorpayPaymentSignature(ORDER_ID, PAYMENT_ID, signature, SECRET)
    ).toBe(false);
  });

  it("rejects garbage signatures and fails closed on a missing secret", () => {
    expect(verifyRazorpayPaymentSignature(ORDER_ID, PAYMENT_ID, "not-even-hex", SECRET)).toBe(false);
    expect(verifyRazorpayPaymentSignature(ORDER_ID, PAYMENT_ID, "deadbeef", SECRET)).toBe(false);
    expect(
      verifyRazorpayPaymentSignature(ORDER_ID, PAYMENT_ID, "deadbeef", undefined)
    ).toBe(false);
  });
});

describe("verifyRazorpayWebhookSignature", () => {
  const body = JSON.stringify({ event: "payment.captured" });

  it("accepts a correctly signed raw body", () => {
    const signature = signRazorpayPayload(body, SECRET);
    expect(verifyRazorpayWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("rejects a body tampered after signing", () => {
    const signature = signRazorpayPayload(body, SECRET);
    const tampered = JSON.stringify({ event: "payment.captured", extra: true });
    expect(verifyRazorpayWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("fails closed on missing secret or missing header", () => {
    const signature = signRazorpayPayload(body, SECRET);
    expect(verifyRazorpayWebhookSignature(body, signature, undefined)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, null, SECRET)).toBe(false);
  });
});
