import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 1.5 — transactional order email.
 *
 * Resend, Prisma and `server-only` are mocked; the real `lib/mail.ts` renders
 * the templates, applies the config gates, writes the idempotency event before
 * sending and swallows delivery failures.
 */

const { prismaMock, sendMock, resendState } = vi.hoisted(() => {
  const sendMock = vi.fn();
  return {
    sendMock,
    resendState: { throwOnConstruct: false },
    prismaMock: {
      order: { findUnique: vi.fn() },
      orderEvent: { findMany: vi.fn(), create: vi.fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor() {
      if (resendState.throwOnConstruct) {
        throw new Error("invalid API key");
      }
    }
  },
}));

import { sendOrderEmail } from "@/lib/mail";

const ORDER_ID = "order_1";
const USER_EMAIL = "ada@example.test";
const FROM_ADDRESS = "Vendary <orders@vendary.test>";

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  status: "confirmed",
  createdAt: new Date("2026-11-01T10:00:00Z"),
  total: "216.00",
  taxAmount: "16.00",
  items: [
    {
      productName: "Widget <Pro>",
      quantity: 2,
      // 100.00 rupees = 10000 paise, line total 20000 paise.
      price: "100.00",
    },
  ],
  address: {
    firstName: "Ada",
    lastName: "Lovelace",
    address: "12 MG Road",
    area: "Central",
    landmark: "Near <Metro>",
    state: "Karnataka",
    postalCode: "560001",
    country: "India",
    phone: "9876543210",
  },
  user: { email: USER_EMAIL },
  ...overrides,
});

const sentPayload = () => {
  expect(sendMock).toHaveBeenCalledTimes(1);
  return sendMock.mock.calls[0][0] as {
    from: string;
    to: string[];
    bcc?: string[];
    subject: string;
    html: string;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  resendState.throwOnConstruct = false;
  vi.stubEnv("EMAIL_FROM", FROM_ADDRESS);
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("ORDER_NOTIFICATION_EMAIL", "");
  vi.stubEnv("NODE_ENV", "test");

  prismaMock.order.findUnique.mockResolvedValue(makeOrder());
  prismaMock.orderEvent.findMany.mockResolvedValue([]);
  prismaMock.orderEvent.create.mockResolvedValue({ id: "event_1" });
  sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendOrderEmail", () => {
  it("sends the confirmation from EMAIL_FROM with the user as the only recipient", async () => {
    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "sent" });
    const payload = sentPayload();
    expect(payload.from).toBe(FROM_ADDRESS);
    expect(payload.to).toEqual([USER_EMAIL]);
    expect(payload.subject).toMatch(/Order confirmed/);
    expect(payload.subject).toContain(ORDER_ID);
  });

  it("renders item names, paise-derived totals and the address as escaped HTML", async () => {
    await sendOrderEmail(ORDER_ID, "confirmation");

    const html = sentPayload().html;
    // 100.00 × 2 = ₹200.00, 8% GST = ₹16.00, total ₹216.00.
    expect(html).toContain("₹200.00");
    expect(html).toContain("₹16.00");
    expect(html).toContain("₹216.00");
    expect(html).toContain("Widget &lt;Pro&gt;");
    expect(html).not.toContain("Widget <Pro>");
    expect(html).toContain("Near &lt;Metro&gt;");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("12 MG Road");
    expect(html).toContain("confirmed");
  });

  it("BCCs ORDER_NOTIFICATION_EMAIL so the internal address stays hidden", async () => {
    vi.stubEnv("ORDER_NOTIFICATION_EMAIL", "store@vendary.test");

    await sendOrderEmail(ORDER_ID, "shipped");

    const payload = sentPayload();
    expect(payload.to).toEqual([USER_EMAIL]);
    expect(payload.bcc).toEqual(["store@vendary.test"]);
    expect(payload.subject).toMatch(/shipped/i);
  });

  it("uses ORDER_NOTIFICATION_EMAIL as the sole recipient when the customer has no email", async () => {
    vi.stubEnv("ORDER_NOTIFICATION_EMAIL", "store@vendary.test");
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ user: { email: null } }));

    const result = await sendOrderEmail(ORDER_ID, "cancelled");

    expect(result).toEqual({ status: "sent" });
    const payload = sentPayload();
    expect(payload.to).toEqual(["store@vendary.test"]);
    expect(payload.bcc).toBeUndefined();
  });

  it("deduplicates a notification address equal to the customer's email", async () => {
    vi.stubEnv("ORDER_NOTIFICATION_EMAIL", USER_EMAIL);

    await sendOrderEmail(ORDER_ID, "delivered");

    const payload = sentPayload();
    expect(payload.to).toEqual([USER_EMAIL]);
    expect(payload.bcc).toBeUndefined();
  });

  it("writes the idempotency event before the send and skips a second email", async () => {
    const first = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(first).toEqual({ status: "sent" });
    expect(prismaMock.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: ORDER_ID,
        type: "order_email_sent",
        metadata: { kind: "confirmation" },
      }),
    });
    // Marker first: a crash between the two writes cannot double-send on retry.
    expect(prismaMock.orderEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      sendMock.mock.invocationCallOrder[0]
    );

    prismaMock.orderEvent.findMany.mockResolvedValue([
      { metadata: { kind: "confirmation" } },
    ]);
    const second = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(second).toEqual({ status: "skipped", reason: "already_sent" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.orderEvent.create).toHaveBeenCalledTimes(1);
  });

  it("keeps each kind independent (a shipped marker does not block delivered)", async () => {
    prismaMock.orderEvent.findMany.mockResolvedValue([{ metadata: { kind: "shipped" } }]);

    const result = await sendOrderEmail(ORDER_ID, "delivered");

    expect(result).toEqual({ status: "sent" });
    expect(prismaMock.orderEvent.create).toHaveBeenCalledTimes(1);
  });

  it("never throws when Resend returns an error, and logs a structured warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "domain is not verified" },
    });

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "failed", error: "domain is not verified" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      level: "warn",
      event: "order_email_failed",
      orderId: ORDER_ID,
      kind: "confirmation",
    });
  });

  it("never throws when the Resend call rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendMock.mockRejectedValue(new Error("network down"));

    const result = await sendOrderEmail(ORDER_ID, "refunded");

    expect(result).toEqual({ status: "failed", error: "network down" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never throws when building the mail transport config fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resendState.throwOnConstruct = true;

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "failed", error: "invalid API key" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips without touching the database when EMAIL_FROM is absent", async () => {
    vi.stubEnv("EMAIL_FROM", undefined);

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "skipped", reason: "not_configured" });
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.orderEvent.findMany).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips without touching the database when RESEND_API_KEY is absent", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "skipped", reason: "not_configured" });
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips in production when EMAIL_FROM is absent (no implicit sender)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_FROM", undefined);

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "skipped", reason: "not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("uses Resend's shared sender in local development when EMAIL_FROM is blank", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EMAIL_FROM", "");

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "sent" });
    expect(sentPayload().from).toBe("onboarding@resend.dev");
  });

  it("skips when neither the customer nor the store inbox has an address", async () => {
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ user: { email: null } }));

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "skipped", reason: "no_recipients" });
    expect(prismaMock.orderEvent.create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips a missing order and writes no marker", async () => {
    prismaMock.order.findUnique.mockResolvedValue(null);

    const result = await sendOrderEmail(ORDER_ID, "confirmation");

    expect(result).toEqual({ status: "skipped", reason: "order_not_found" });
    expect(prismaMock.orderEvent.create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("renders the status subject and copy for every status kind", async () => {
    const kinds = ["shipped", "delivered", "cancelled", "refunded"] as const;

    for (const kind of kinds) {
      vi.clearAllMocks();
      prismaMock.order.findUnique.mockResolvedValue(makeOrder());
      prismaMock.orderEvent.findMany.mockResolvedValue([]);
      prismaMock.orderEvent.create.mockResolvedValue({ id: "event_1" });
      sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });

      const result = await sendOrderEmail(ORDER_ID, kind);

      expect(result).toEqual({ status: "sent" });
      expect(sentPayload().subject.toLowerCase()).toContain(
        kind === "refunded" ? "refund" : kind
      );
    }
  });
});
