import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger, redactText } from "@/lib/logger";
import {
  captureException,
  initMonitoring,
  isMonitoringConfigured,
  resetMonitoringForTests,
} from "@/lib/monitoring";

/**
 * `lib/logger.ts` writes one JSON line per call. These tests pin the field
 * shape and, more importantly, that credentials/PII can never reach a log line
 * — including when they arrive nested inside a context object or an Error.
 */

const MANAGED_KEYS = ["LOG_LEVEL", "SENTRY_DSN"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MANAGED_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetMonitoringForTests();
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
  resetMonitoringForTests();
});

const captureInfo = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(console, "info").mockImplementation(() => {});

const lastEntry = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> =>
  JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;

describe("logger shape", () => {
  it("emits one JSON object with level, msg, time and context fields", () => {
    const info = captureInfo();

    logger.info("order_placed", {
      action: "orders.place",
      requestId: "req-1",
      orderId: "order_1",
      durationMs: 42,
    });

    expect(info).toHaveBeenCalledTimes(1);
    const entry = lastEntry(info);
    expect(entry).toMatchObject({
      level: "info",
      msg: "order_placed",
      action: "orders.place",
      requestId: "req-1",
      orderId: "order_1",
      durationMs: 42,
    });
    expect(typeof entry.time).toBe("string");
    expect(Number.isNaN(Date.parse(String(entry.time)))).toBe(false);
  });

  it("routes warn and error to the matching console method", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.warn("cache_degraded", { action: "catalog" });
    logger.error("action_failed", { action: "orders.place" });

    expect(lastEntry(warn)).toMatchObject({ level: "warn", msg: "cache_degraded" });
    expect(lastEntry(error)).toMatchObject({ level: "error", msg: "action_failed" });
  });

  it("does not let context overwrite level/msg/time", () => {
    const info = captureInfo();

    logger.info("real_message", { level: "fatal", msg: "spoofed", time: "x" });

    const entry = lastEntry(info);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("real_message");
    expect(entry.time).not.toBe("x");
  });

  it("filters below LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = captureInfo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to info for an invalid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "verbose";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = captureInfo();

    logger.debug("hidden");
    logger.info("shown");

    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("logger redaction", () => {
  it("redacts credential, cookie, Razorpay, email and address keys", () => {
    const info = captureInfo();

    logger.info("checkout_attempt", {
      authorization: "Bearer super-secret",
      cookie: "session=abc",
      razorpayKeySecret: "rzp_test_abcdef",
      razorpayPaymentId: "pay_123",
      email: "shopper@example.com",
      customerEmail: "shopper@example.com",
      address: "12 MG Road, Bengaluru 560001",
      addressLine1: "12 MG Road",
      postalCode: "560001",
      landmark: "Near the park",
    });

    const entry = lastEntry(info);
    for (const key of [
      "authorization",
      "cookie",
      "razorpayKeySecret",
      "razorpayPaymentId",
      "email",
      "customerEmail",
      "address",
      "addressLine1",
      "postalCode",
      "landmark",
    ]) {
      expect(entry[key]).toBe("[redacted]");
    }
    expect(JSON.stringify(entry)).not.toContain("super-secret");
    expect(JSON.stringify(entry)).not.toContain("shopper@example.com");
  });

  it("redacts sensitive keys inside nested objects and arrays", () => {
    const info = captureInfo();

    logger.info("nested", {
      context: {
        headers: { authorization: "Bearer leak", accept: "application/json" },
        attempts: [{ email: "a@example.com", reason: "retry" }],
      },
    });

    const entry = lastEntry(info) as {
      context: { headers: Record<string, unknown>; attempts: Array<Record<string, unknown>> };
    };
    expect(entry.context.headers.authorization).toBe("[redacted]");
    expect(entry.context.headers.accept).toBe("application/json");
    expect(entry.context.attempts[0].email).toBe("[redacted]");
    expect(entry.context.attempts[0].reason).toBe("retry");
  });

  it("scrubs emails and Razorpay key material from free text", () => {
    const info = captureInfo();

    logger.info("mail_failed", {
      detail: "resend rejected for shopper@example.com with key rzp_test_abc123",
    });

    const entry = lastEntry(info);
    expect(entry.detail).toBe(
      "resend rejected for [redacted-email] with key [redacted-razorpay-key]"
    );
  });

  it("reduces an Error to a redacted, truncated message without a stack or cause", () => {
    const error = new Error(`database unavailable for shopper@example.com ${"x".repeat(500)}`);
    error.stack = "Error: database unavailable\\n    at secretStackFrame (/srv/app.ts:1:1)";
    (error as Error & { cause?: unknown }).cause = { authorization: "Bearer leak" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.error("action_failed", { error });

    const entry = lastEntry(log);
    expect(typeof entry.error).toBe("string");
    expect(String(entry.error)).not.toContain("shopper@example.com");
    expect(String(entry.error)).not.toContain("secretStackFrame");
    expect(String(entry.error)).not.toContain("Bearer leak");
    expect(String(entry.error).length).toBeLessThanOrEqual(201);
  });

  it("never throws on circular context", () => {
    const info = captureInfo();
    const context: Record<string, unknown> = { action: "test" };
    context.self = context;

    expect(() => logger.info("circular", context)).not.toThrow();
    expect(lastEntry(info).self).toBe("[circular]");
  });

  it("redactText bounds length and scrubs both patterns", () => {
    const text = redactText(`${"a".repeat(20)} shopper@example.com`, 20);

    expect(text).toBe("aaaaaaaaaaaaaaaaaaaa…");
    expect(redactText("shopper@example.com")).toBe("[redacted-email]");
  });
});

describe("monitoring seam", () => {
  it("is disabled and a no-op without SENTRY_DSN", async () => {
    expect(isMonitoringConfigured()).toBe(false);
    await expect(initMonitoring()).resolves.toBe(false);
    expect(() =>
      captureException(new Error("boom"), { action: "test", requestId: "r1" })
    ).not.toThrow();
  });

  it("reports configured only when the DSN is non-blank", () => {
    expect(isMonitoringConfigured({ SENTRY_DSN: "  " })).toBe(false);
    expect(isMonitoringConfigured({ SENTRY_DSN: "https://key@sentry.example.com/1" })).toBe(true);
  });
});
