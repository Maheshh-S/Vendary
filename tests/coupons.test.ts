import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4A — coupons.
 *
 * The pure math runs for real; the money-path actions run with Prisma,
 * Razorpay, auth, mail, cache and rate limiting mocked at their boundaries so
 * the tests pin the exact transaction writes: stored discount, one redemption,
 * the conditional usage claim, and release only on unpaid cancellation.
 */

const { authMock, prismaMock, txMock, razorpayMock, rateLimitMock, revalidateMock, mailMock } =
  vi.hoisted(() => {
    const txMock = {
      address: { create: vi.fn() },
      order: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
      orderItem: { createMany: vi.fn() },
      orderEvent: { create: vi.fn() },
      coupon: { updateMany: vi.fn() },
      couponRedemption: {
        create: vi.fn(),
        findUnique: vi.fn(),
        deleteMany: vi.fn(),
      },
    };
    const prismaMock = {
      product: { findMany: vi.fn(), findUnique: vi.fn() },
      coupon: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
      order: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    };
    return {
      authMock: vi.fn(),
      prismaMock,
      txMock,
      razorpayMock: { orders: { create: vi.fn(), fetch: vi.fn() } },
      rateLimitMock: vi.fn(),
      revalidateMock: vi.fn(),
      mailMock: vi.fn(),
    };
  });

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/razorpay-client", () => ({
  getRazorpayClient: () => razorpayMock,
  refundPayment: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  // Mirrors lib/rate-limit.ts; the actions read these at call time.
  RATE_LIMITS: {
    createRazorpayOrder: { limit: 10, windowMs: 60_000 },
    adminMutation: { limit: 60, windowMs: 60_000 },
  },
}));
vi.mock("@/lib/product-cache", () => ({ invalidateProductCache: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendOrderEmail: mailMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { createCoupon, deactivateCoupon, updateCoupon } from "@/actions/(admin)/coupons";
import { getCartQuote } from "@/actions/cart/quote";
import { createRazorpayOrder } from "@/actions/orders";
import { cancelOrder } from "@/actions/orders/cancel";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import {
  computeCouponDiscount,
  couponRejectionMessage,
  MIN_PAYABLE_AMOUNT_MESSAGE,
  normalizeCouponCode,
  rupeesToPaise,
  type CouponLike,
} from "@/lib/coupons";
import { computeTotalsWithDiscount } from "@/lib/money";
import { couponInputSchema } from "@/schemas/admin/coupons/coupon-schema";

const USER_ID = "user_1";
const NOW = new Date("2026-06-15T12:00:00.000Z");

const mathCoupon = (overrides: Partial<CouponLike> = {}): CouponLike => ({
  type: "PERCENT",
  value: "10.00",
  minSubtotal: "0.00",
  maxDiscount: null,
  startsAt: new Date("2026-06-01T00:00:00.000Z"),
  endsAt: new Date("2026-07-01T00:00:00.000Z"),
  usageLimit: null,
  usedCount: 0,
  isActive: true,
  ...overrides,
});

const daysFromNow = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const couponRow = (overrides: Record<string, unknown> = {}) => ({
  id: "coupon_1",
  code: "SAVE10",
  type: "PERCENT",
  value: "10.00",
  minSubtotal: "0.00",
  maxDiscount: null,
  startsAt: daysFromNow(-1),
  endsAt: daysFromNow(1),
  usageLimit: 5,
  usedCount: 0,
  isActive: true,
  createdAt: daysFromNow(-2),
  updatedAt: daysFromNow(-1),
  ...overrides,
});

const PRODUCT = {
  id: "prod_1",
  name: "Widget",
  price: "200.00",
  availability: "IN_STOCK" as const,
  stockQty: 5,
  thumbnail: "https://cdn.example/widget.png",
};

const ADDRESS = {
  fName: "Ada",
  lName: "Lovelace",
  mobile: "9876543210",
  pinCode: "560001",
  address: "12 MG Road",
  area: "Central",
  landmark: "Near Metro",
  country: ["India", "Karnataka"] as [string, string],
};

const CHECKOUT = { line_items: [{ productId: PRODUCT.id, quantity: 1 }] };

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  }
  return result.data;
};

const expectFailure = (
  result: ActionResult<unknown>,
  code: ActionErrorCode,
  message?: string
): void => {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected the action to fail");
  }
  expect(result.code).toBe(code);
  if (message) expect(result.message).toBe(message);
};

beforeEach(() => {
  vi.clearAllMocks();

  authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });
  rateLimitMock.mockResolvedValue(undefined);
  revalidateMock.mockReturnValue(undefined);
  mailMock.mockResolvedValue(undefined);

  prismaMock.product.findMany.mockResolvedValue([PRODUCT]);
  prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT.id });
  prismaMock.coupon.findUnique.mockResolvedValue(couponRow());
  prismaMock.coupon.create.mockResolvedValue({ id: "coupon_new", code: "SAVE20" });
  prismaMock.coupon.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.order.findFirst.mockResolvedValue(null);
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) =>
    callback(txMock)
  );

  txMock.address.create.mockResolvedValue({ id: "addr_1" });
  txMock.order.create.mockResolvedValue({ id: "order_1" });
  txMock.order.findUnique.mockResolvedValue(null);
  txMock.order.updateMany.mockResolvedValue({ count: 1 });
  txMock.orderItem.createMany.mockResolvedValue({ count: 1 });
  txMock.orderEvent.create.mockResolvedValue({ id: "event_1" });
  txMock.coupon.updateMany.mockResolvedValue({ count: 1 });
  txMock.couponRedemption.create.mockResolvedValue({ id: "redemption_1" });
  txMock.couponRedemption.findUnique.mockResolvedValue(null);
  txMock.couponRedemption.deleteMany.mockResolvedValue({ count: 1 });

  razorpayMock.orders.create.mockResolvedValue({
    id: "order_rzp_1",
    amount: 19440,
    currency: "INR",
  });
});

describe("coupon math", () => {
  it("charges GST on the discounted subtotal (₹1000, 10% → 900 + 72 GST = 972)", () => {
    const discount = computeCouponDiscount(mathCoupon(), 100_000, NOW);
    expect(discount).toEqual({ ok: true, discountPaise: 10_000 });

    expect(computeTotalsWithDiscount(100_000, 10_000)).toEqual({
      subtotalPaise: 100_000,
      discountPaise: 10_000,
      taxablePaise: 90_000,
      taxPaise: 7_200,
      totalPaise: 97_200,
    });
  });

  it("treats FIXED value as rupees and keeps every amount in paise", () => {
    const discount = computeCouponDiscount(
      mathCoupon({ type: "FIXED", value: "149.50" }),
      100_000,
      NOW
    );
    expect(discount).toEqual({ ok: true, discountPaise: 14_950 });
    expect(rupeesToPaise("149.50")).toBe(14_950);
  });

  it("rounds a percent discount exactly once", () => {
    // 12.5% of 33333p = 4166.625p; the single rounding step yields 4167.
    const discount = computeCouponDiscount(mathCoupon({ value: "12.50" }), 33_333, NOW);
    expect(discount).toEqual({ ok: true, discountPaise: 4_167 });
  });

  it("caps a percent discount at maxDiscount", () => {
    const discount = computeCouponDiscount(
      mathCoupon({ value: "50.00", maxDiscount: "300.00" }),
      100_000,
      NOW
    );
    expect(discount).toEqual({ ok: true, discountPaise: 30_000 });
  });

  it("never discounts more than the subtotal", () => {
    const discount = computeCouponDiscount(
      mathCoupon({ type: "FIXED", value: "500.00" }),
      10_000,
      NOW
    );
    expect(discount).toEqual({ ok: true, discountPaise: 10_000 });

    expect(computeTotalsWithDiscount(10_000, 50_000)).toEqual({
      subtotalPaise: 10_000,
      discountPaise: 10_000,
      taxablePaise: 0,
      taxPaise: 0,
      totalPaise: 0,
    });
  });

  it("enforces the minimum subtotal, inclusive at the boundary", () => {
    const coupon = mathCoupon({ minSubtotal: "1000.00" });
    expect(computeCouponDiscount(coupon, 99_999, NOW)).toEqual({
      ok: false,
      discountPaise: 0,
      reason: "MIN_SUBTOTAL",
    });
    expect(computeCouponDiscount(coupon, 100_000, NOW)).toEqual({
      ok: true,
      discountPaise: 10_000,
    });
  });

  it("enforces the active flag, window and usage limit", () => {
    expect(computeCouponDiscount(mathCoupon({ isActive: false }), 100_000, NOW)).toEqual({
      ok: false,
      discountPaise: 0,
      reason: "INACTIVE",
    });
    expect(
      computeCouponDiscount(
        mathCoupon({ startsAt: new Date("2026-07-01T00:00:00.000Z") }),
        100_000,
        NOW
      )
    ).toEqual({ ok: false, discountPaise: 0, reason: "NOT_STARTED" });
    expect(
      computeCouponDiscount(
        mathCoupon({ endsAt: new Date("2026-06-15T12:00:00.000Z") }),
        100_000,
        NOW
      )
    ).toEqual({ ok: false, discountPaise: 0, reason: "EXPIRED" });
    expect(
      computeCouponDiscount(mathCoupon({ usageLimit: 5, usedCount: 5 }), 100_000, NOW)
    ).toEqual({ ok: false, discountPaise: 0, reason: "USAGE_LIMIT" });
    expect(
      computeCouponDiscount(mathCoupon({ usageLimit: null, usedCount: 999 }), 100_000, NOW)
    ).toEqual({ ok: true, discountPaise: 10_000 });
  });

  it("maps every rejection to user-facing copy", () => {
    expect(couponRejectionMessage("INACTIVE")).toMatch(/no longer active/i);
    expect(couponRejectionMessage("NOT_STARTED")).toMatch(/not active yet/i);
    expect(couponRejectionMessage("EXPIRED")).toMatch(/expired/i);
    expect(couponRejectionMessage("MIN_SUBTOTAL")).toMatch(/minimum subtotal/i);
    expect(couponRejectionMessage("USAGE_LIMIT")).toMatch(/no longer available/i);
    expect(normalizeCouponCode(" save10 ")).toBe("SAVE10");
  });
});

describe("getCartQuote with a coupon", () => {
  it("prices a valid coupon once and blocks nothing", async () => {
    const data = expectSuccess(
      await getCartQuote([{ productId: PRODUCT.id, quantity: 1 }], "save10")
    );

    // 20000p subtotal, 10% = 2000p off, 8% GST on 18000p = 1440p.
    expect(data.subtotalPaise).toBe(20_000);
    expect(data.discountPaise).toBe(2_000);
    expect(data.taxPaise).toBe(1_440);
    expect(data.totalPaise).toBe(19_440);
    expect(data.couponCode).toBe("SAVE10");
    expect(data.couponError).toBeNull();
    expect(prismaMock.coupon.findUnique).toHaveBeenCalledWith({ where: { code: "SAVE10" } });
  });

  it("returns a non-blocking warning for an unknown code and no discount", async () => {
    prismaMock.coupon.findUnique.mockResolvedValue(null);

    const data = expectSuccess(
      await getCartQuote([{ productId: PRODUCT.id, quantity: 1 }], "NOPE")
    );

    expect(data.discountPaise).toBe(0);
    expect(data.couponCode).toBe("NOPE");
    expect(data.couponError).toBe("Invalid coupon code.");
    expect(data.totalPaise).toBe(21_600);
  });

  it("returns the rejection reason for an expired coupon", async () => {
    prismaMock.coupon.findUnique.mockResolvedValue(couponRow({ endsAt: daysFromNow(-1) }));

    const data = expectSuccess(
      await getCartQuote([{ productId: PRODUCT.id, quantity: 1 }], "SAVE10")
    );

    expect(data.discountPaise).toBe(0);
    expect(data.couponError).toBe("This coupon has expired.");
  });

  it("blocks a coupon that discounts the total below the ₹1 Razorpay floor", async () => {
    // ₹200 fixed off a ₹200 cart: the discounted total is 0p, below Razorpay's
    // 100p minimum. The quote must report it as a blocking coupon error.
    prismaMock.coupon.findUnique.mockResolvedValue(
      couponRow({ type: "FIXED", value: "200.00", usageLimit: null })
    );

    const data = expectSuccess(
      await getCartQuote([{ productId: PRODUCT.id, quantity: 1 }], "SAVE10")
    );

    expect(data.totalPaise).toBe(0);
    expect(data.couponError).toBe(MIN_PAYABLE_AMOUNT_MESSAGE);
    expect(MIN_PAYABLE_AMOUNT_MESSAGE).toBe("Order total must be at least ₹1 after the discount.");

    // The charge path refuses the same cart with the same message.
    expectFailure(
      await createRazorpayOrder({
        checkoutSession: CHECKOUT,
        orderData: ADDRESS,
        couponCode: "SAVE10",
      }),
      "VALIDATION",
      MIN_PAYABLE_AMOUNT_MESSAGE
    );
    expect(razorpayMock.orders.create).not.toHaveBeenCalled();
  });

  it("does not query coupons when no code was supplied", async () => {
    const data = expectSuccess(await getCartQuote([{ productId: PRODUCT.id, quantity: 1 }]));

    expect(data.couponCode).toBeNull();
    expect(data.couponError).toBeNull();
    expect(prismaMock.coupon.findUnique).not.toHaveBeenCalled();
  });
});

describe("createRazorpayOrder coupon redemption", () => {
  it("charges the discounted total and stores the redemption in the order transaction", async () => {
    const data = expectSuccess(
      await createRazorpayOrder({
        checkoutSession: CHECKOUT,
        orderData: ADDRESS,
        couponCode: "save10",
      })
    );

    expect(data.amountPaise).toBe(19_440);
    expect(razorpayMock.orders.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 19_440 })
    );

    expect(txMock.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        total: "194.40",
        taxAmount: "14.40",
        discountAmount: "20.00",
        couponCode: "SAVE10",
        status: "pending",
      }),
    });
    expect(txMock.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: "coupon_1", usedCount: { lt: 5 } },
      data: { usedCount: { increment: 1 } },
    });
    expect(txMock.couponRedemption.create).toHaveBeenCalledWith({
      data: {
        couponId: "coupon_1",
        orderId: "order_1",
        userId: USER_ID,
        amount: "20.00",
      },
    });
  });

  it("rejects an invalid coupon before creating a Razorpay order", async () => {
    prismaMock.coupon.findUnique.mockResolvedValue(null);

    const result = await createRazorpayOrder({
      checkoutSession: CHECKOUT,
      orderData: ADDRESS,
      couponCode: "BOGUS",
    });

    expectFailure(result, "VALIDATION", "Invalid coupon code.");
    expect(razorpayMock.orders.create).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an expired or exhausted coupon before creating a Razorpay order", async () => {
    prismaMock.coupon.findUnique.mockResolvedValueOnce(couponRow({ endsAt: daysFromNow(-1) }));

    expectFailure(
      await createRazorpayOrder({
        checkoutSession: CHECKOUT,
        orderData: ADDRESS,
        couponCode: "SAVE10",
      }),
      "VALIDATION",
      "This coupon has expired."
    );
    expect(razorpayMock.orders.create).not.toHaveBeenCalled();

    prismaMock.coupon.findUnique.mockResolvedValueOnce(couponRow({ usageLimit: 5, usedCount: 5 }));
    expectFailure(
      await createRazorpayOrder({
        checkoutSession: CHECKOUT,
        orderData: ADDRESS,
        couponCode: "SAVE10",
      }),
      "VALIDATION",
      "This coupon is no longer available."
    );
    expect(razorpayMock.orders.create).not.toHaveBeenCalled();
  });

  it("fails CONFLICT when the conditional usage claim matches zero rows", async () => {
    // Validation read a coupon with uses left; another checkout consumed the
    // last use before this transaction ran.
    txMock.coupon.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await createRazorpayOrder({
      checkoutSession: CHECKOUT,
      orderData: ADDRESS,
      couponCode: "SAVE10",
    });

    expectFailure(result, "CONFLICT", "This coupon is no longer available.");
    expect(txMock.couponRedemption.create).not.toHaveBeenCalled();
  });

  it("redeems a coupon at most once per customer", async () => {
    const first = await createRazorpayOrder({
      checkoutSession: CHECKOUT,
      orderData: ADDRESS,
      couponCode: "SAVE10",
    });
    expect(first.ok).toBe(true);
    expect(txMock.couponRedemption.create).toHaveBeenCalledTimes(1);

    // The second attempt hits the (couponId, userId) unique constraint.
    txMock.couponRedemption.create.mockRejectedValueOnce({ code: "P2002" });
    const second = await createRazorpayOrder({
      checkoutSession: CHECKOUT,
      orderData: ADDRESS,
      couponCode: "SAVE10",
    });

    expectFailure(second, "CONFLICT", "You have already used this coupon.");
    expect(txMock.couponRedemption.create).toHaveBeenCalledTimes(2);
  });

  it("releases an abandoned pending checkout and redeems the coupon again", async () => {
    // Attempt 1 created the redemption; the shopper closed the Razorpay modal.
    // Attempt 2 finds that redemption, its order is still pending and unpaid,
    // so the transaction cancels it, releases the usage, and redeems anew.
    txMock.couponRedemption.findUnique
      .mockResolvedValueOnce({ orderId: "order_old" }) // reuse lookup (coupon+user)
      .mockResolvedValueOnce({ id: "redemption_old", couponId: "coupon_1" }); // release helper
    txMock.order.findUnique.mockResolvedValue({ status: "pending", paymentId: "" });

    const result = await createRazorpayOrder({
      checkoutSession: CHECKOUT,
      orderData: ADDRESS,
      couponCode: "SAVE10",
    });

    expectSuccess(result);
    expect(txMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order_old", status: "pending", paymentId: "" },
      data: { status: "cancelled" },
    });
    expect(txMock.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order_old",
        type: "order_cancelled",
        fromStatus: "pending",
        toStatus: "cancelled",
        metadata: { source: "coupon_reuse" },
      }),
    });
    expect(txMock.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: "coupon_1", usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
    expect(txMock.couponRedemption.deleteMany).toHaveBeenCalledWith({
      where: { id: "redemption_old" },
    });
    // The new checkout still claims its own use and redemption.
    expect(txMock.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: "coupon_1", usedCount: { lt: 5 } },
      data: { usedCount: { increment: 1 } },
    });
    expect(txMock.couponRedemption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ couponId: "coupon_1", orderId: "order_1" }),
    });
  });

  it("keeps CONFLICT for a paid redemption instead of releasing it", async () => {
    txMock.couponRedemption.findUnique.mockResolvedValueOnce({ orderId: "order_paid" });
    txMock.order.findUnique.mockResolvedValue({ status: "confirmed", paymentId: "pay_123" });

    const result = await createRazorpayOrder({
      checkoutSession: CHECKOUT,
      orderData: ADDRESS,
      couponCode: "SAVE10",
    });

    expectFailure(result, "CONFLICT", "You have already used this coupon.");
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(txMock.couponRedemption.deleteMany).not.toHaveBeenCalled();
    expect(txMock.couponRedemption.create).not.toHaveBeenCalled();
  });

  it("keeps CONFLICT when a pending order already carries a payment proof", async () => {
    txMock.couponRedemption.findUnique.mockResolvedValueOnce({ orderId: "order_proof" });
    txMock.order.findUnique.mockResolvedValue({ status: "pending", paymentId: "pay_proof" });

    expectFailure(
      await createRazorpayOrder({
        checkoutSession: CHECKOUT,
        orderData: ADDRESS,
        couponCode: "SAVE10",
      }),
      "CONFLICT",
      "You have already used this coupon."
    );
    expect(txMock.order.updateMany).not.toHaveBeenCalled();
  });

  it("keeps CONFLICT when the guarded cancel loses the race", async () => {
    txMock.couponRedemption.findUnique.mockResolvedValueOnce({ orderId: "order_old" });
    txMock.order.findUnique.mockResolvedValue({ status: "pending", paymentId: "" });
    txMock.order.updateMany.mockResolvedValueOnce({ count: 0 });

    expectFailure(
      await createRazorpayOrder({
        checkoutSession: CHECKOUT,
        orderData: ADDRESS,
        couponCode: "SAVE10",
      }),
      "CONFLICT",
      "You have already used this coupon."
    );
    expect(txMock.couponRedemption.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the plain path untouched when no coupon is sent", async () => {
    const data = expectSuccess(
      await createRazorpayOrder({ checkoutSession: CHECKOUT, orderData: ADDRESS })
    );

    expect(data.amountPaise).toBe(21_600);
    expect(txMock.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        total: "216.00",
        taxAmount: "16.00",
        discountAmount: "0.00",
        couponCode: null,
      }),
    });
    expect(txMock.coupon.updateMany).not.toHaveBeenCalled();
    expect(txMock.couponRedemption.create).not.toHaveBeenCalled();
  });
});

describe("coupon release on unpaid cancellation", () => {
  it("deletes the redemption and decrements usedCount inside the cancel transaction", async () => {
    prismaMock.order.findFirst.mockResolvedValue({
      id: "order_1",
      status: "pending",
      total: "194.40",
      paymentId: "",
    });
    txMock.couponRedemption.findUnique.mockResolvedValue({
      id: "redemption_1",
      couponId: "coupon_1",
    });

    const data = expectSuccess(await cancelOrder("order_1"));

    expect(data).toEqual({ orderId: "order_1", status: "cancelled" });
    expect(txMock.couponRedemption.findUnique).toHaveBeenCalledWith({
      where: { orderId: "order_1" },
      select: { id: true, couponId: true },
    });
    expect(txMock.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: "coupon_1", usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
    expect(txMock.couponRedemption.deleteMany).toHaveBeenCalledWith({
      where: { id: "redemption_1" },
    });
  });

  it("does not touch coupons when the pending order has no redemption", async () => {
    prismaMock.order.findFirst.mockResolvedValue({
      id: "order_1",
      status: "pending",
      total: "216.00",
      paymentId: "",
    });

    expectSuccess(await cancelOrder("order_1"));

    expect(txMock.coupon.updateMany).not.toHaveBeenCalled();
    expect(txMock.couponRedemption.deleteMany).not.toHaveBeenCalled();
  });

  it("does not release when the cancel claim loses (already paid/cancelled)", async () => {
    prismaMock.order.findFirst.mockResolvedValue({
      id: "order_1",
      status: "pending",
      total: "194.40",
      paymentId: "",
    });
    txMock.order.updateMany.mockResolvedValue({ count: 0 });

    const result = await cancelOrder("order_1");

    expectFailure(result, "CONFLICT");
    expect(txMock.couponRedemption.findUnique).not.toHaveBeenCalled();
  });
});

describe("admin coupon validation", () => {
  const VALID_INPUT = {
    code: " save20 ",
    type: "PERCENT",
    value: "20",
    minSubtotal: "",
    maxDiscount: "",
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-02-01T00:00:00.000Z",
    usageLimit: "",
    isActive: true,
  };

  it("normalizes code, optional blanks and defaults", () => {
    const parsed = couponInputSchema.safeParse(VALID_INPUT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.code).toBe("SAVE20");
    expect(parsed.data.minSubtotal).toBeUndefined();
    expect(parsed.data.maxDiscount).toBeUndefined();
    expect(parsed.data.usageLimit).toBeUndefined();
    expect(parsed.data.isActive).toBe(true);
  });

  it.each([
    ["percent above 100", { ...VALID_INPUT, value: "101" }, "value"],
    ["end before start", { ...VALID_INPUT, endsAt: "2025-12-01T00:00:00.000Z" }, "endsAt"],
    ["invalid code characters", { ...VALID_INPUT, code: "SAVE 20!" }, "code"],
    ["negative value", { ...VALID_INPUT, value: "-5" }, "value"],
    ["more than two decimals", { ...VALID_INPUT, value: "10.999" }, "value"],
    ["zero usage limit", { ...VALID_INPUT, usageLimit: "0" }, "usageLimit"],
    ["zero max discount", { ...VALID_INPUT, maxDiscount: "0" }, "maxDiscount"],
  ])("rejects %s", (_label, input, field) => {
    const parsed = couponInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
  });

  it("requires ADMIN and persists normalized data", async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID, role: "USER" } });
    expectFailure(await createCoupon(VALID_INPUT), "FORBIDDEN");
    expect(prismaMock.coupon.create).not.toHaveBeenCalled();

    authMock.mockResolvedValueOnce({ user: { id: "admin_1", role: "ADMIN" } });
    const result = expectSuccess(await createCoupon(VALID_INPUT));

    expect(result).toEqual({ id: "coupon_new", code: "SAVE20" });
    expect(prismaMock.coupon.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: "SAVE20",
        type: "PERCENT",
        value: "20.00",
        minSubtotal: "0.00",
        maxDiscount: null,
        usageLimit: null,
        isActive: true,
      }),
    });
  });

  it("maps a duplicate code to CONFLICT", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "admin_1", role: "ADMIN" } });
    prismaMock.coupon.create.mockRejectedValueOnce({ code: "P2002" });

    expectFailure(await createCoupon(VALID_INPUT), "CONFLICT");
  });

  it("updates (reactivates) a coupon only for ADMIN", async () => {
    const updateInput = { ...VALID_INPUT, id: "coupon_1", isActive: true };

    authMock.mockResolvedValueOnce({ user: { id: USER_ID, role: "USER" } });
    expectFailure(await updateCoupon(updateInput), "FORBIDDEN");
    expect(prismaMock.coupon.updateMany).not.toHaveBeenCalled();

    authMock.mockResolvedValueOnce({ user: { id: "admin_1", role: "ADMIN" } });
    expect(expectSuccess(await updateCoupon(updateInput))).toEqual({
      id: "coupon_1",
      code: "SAVE20",
    });
    expect(prismaMock.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: "coupon_1" },
      data: expect.objectContaining({
        code: "SAVE20",
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-02-01T00:00:00.000Z"),
        isActive: true,
      }),
    });
  });

  it("deactivates a coupon and reports a missing one", async () => {
    authMock.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });

    expectSuccess(await deactivateCoupon({ id: "coupon_1" }));
    expect(prismaMock.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: "coupon_1" },
      data: { isActive: false },
    });

    prismaMock.coupon.updateMany.mockResolvedValueOnce({ count: 0 });
    expectFailure(await deactivateCoupon({ id: "missing" }), "NOT_FOUND");
  });
});
