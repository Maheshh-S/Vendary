import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CSP enforcement guardrails: the header must keep the Razorpay allowlists and
 * the report collector must stay quiet, rate-limited and PII-free.
 */

const { rateLimitMock } = vi.hoisted(() => ({ rateLimitMock: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: rateLimitMock,
  RATE_LIMITS: {
    cspReport: { limit: 30, windowMs: 60_000 },
  },
}));

import { POST } from "@/app/api/csp-report/route";
import { buildContentSecurityPolicy, CSP_REPORT_URI, SECURITY_HEADERS } from "@/lib/csp";
import nextConfig from "../next.config";

const cspHeader = SECURITY_HEADERS.find((header) => header.key === "Content-Security-Policy");
const reportOnlyHeader = SECURITY_HEADERS.find((header) => header.key.includes("Report-Only"));

const reportRequest = (body: string, contentType = "application/csp-report", ip = "203.0.113.10") =>
  new Request("https://vendary.test/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType, "x-forwarded-for": ip },
    body,
  });

const lastWarn = (): Record<string, unknown> =>
  JSON.parse(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0])) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue({ allowed: true, retryAfterS: 30, remaining: 29 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Content-Security-Policy header", () => {
  it("is enforcing, not report-only", () => {
    expect(cspHeader).toBeDefined();
    expect(reportOnlyHeader).toBeUndefined();
    expect(
      SECURITY_HEADERS.filter((header) => header.key.includes("Content-Security-Policy"))
    ).toHaveLength(1);
  });

  it("keeps the Razorpay script, connect and frame hosts", () => {
    const policy = cspHeader?.value ?? "";

    expect(policy).toContain("https://checkout.razorpay.com");
    expect(policy).toContain("https://api.razorpay.com");
    expect(policy).toContain("https://lumberjack.razorpay.com");
    expect(policy).toMatch(/frame-src[^;]*https:\/\/checkout\.razorpay\.com/);
    expect(policy).toMatch(/connect-src[^;]*https:\/\/api\.razorpay\.com/);
  });

  it("locks framing and navigation with the report endpoint attached", () => {
    const policy = cspHeader?.value ?? "";

    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain(`report-uri ${CSP_REPORT_URI}`);
    expect(CSP_REPORT_URI).toBe("/api/csp-report");
  });

  it("keeps inline/eval scripts while nonce hardening is deferred", () => {
    const policy = buildContentSecurityPolicy();

    expect(policy).toContain("'unsafe-inline'");
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("default-src 'self'");
  });

  it("is the header Next actually serves for every route", async () => {
    const headerGroups = await (
      nextConfig as unknown as {
        headers: () => Promise<
          Array<{ source: string; headers: Array<{ key: string; value: string }> }>
        >;
      }
    ).headers();

    expect(headerGroups[0].source).toBe("/(.*)");
    const served = headerGroups[0].headers.find(
      (header) => header.key === "Content-Security-Policy"
    );
    expect(served?.value).toBe(buildContentSecurityPolicy());
  });
});

describe("POST /api/csp-report", () => {
  it("logs the legacy csp-report envelope with sanitized URLs", async () => {
    const response = await POST(
      reportRequest(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://vendary.test/products?email=shopper@example.com#reviews",
            "effective-directive": "script-src-elem",
            "blocked-uri": "https://evil.example/tracker.js?ref=shopper@example.com",
            "violated-directive": "script-src-elem",
          },
        })
      )
    );

    expect(response.status).toBe(204);
    expect(rateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "csp-report", subject: "203.0.113.10", limit: 30 })
    );
    const entry = lastWarn();
    expect(entry).toMatchObject({
      level: "warn",
      msg: "csp_violation",
      directive: "script-src-elem",
      documentUri: "https://vendary.test/products",
      blockedUri: "https://evil.example/tracker.js",
    });
    expect(JSON.stringify(entry)).not.toContain("shopper@example.com");
    expect(JSON.stringify(entry)).not.toContain("reviews");
    expect(JSON.stringify(entry)).not.toContain("ref=");
    expect(JSON.stringify(entry)).not.toContain("cookie");
  });

  it("accepts the Reporting API array format", async () => {
    const response = await POST(
      reportRequest(
        JSON.stringify([
          {
            type: "csp-violation",
            url: "https://vendary.test/checkout",
            body: {
              effectiveDirective: "connect-src",
              documentURL: "https://vendary.test/checkout?token=secret-token",
              blockedURL: "https://unexpected.example/api",
            },
          },
        ]),
        "application/reports+json"
      )
    );

    expect(response.status).toBe(204);
    expect(lastWarn()).toMatchObject({
      msg: "csp_violation",
      directive: "connect-src",
      documentUri: "https://vendary.test/checkout",
      blockedUri: "https://unexpected.example/api",
    });
    expect(JSON.stringify(lastWarn())).not.toContain("secret-token");
  });

  it("accepts a bare JSON violation object", async () => {
    const response = await POST(
      reportRequest(
        JSON.stringify({
          "violated-directive": "img-src",
          "document-uri": "https://vendary.test/",
        }),
        "application/json"
      )
    );

    expect(response.status).toBe(204);
    expect(lastWarn()).toMatchObject({
      directive: "img-src",
      documentUri: "https://vendary.test/",
      blockedUri: "unknown",
    });
  });

  it("drops reports over the per-IP budget without parsing or logging", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterS: 10, remaining: 0 });

    const response = await POST(
      reportRequest(JSON.stringify({ "csp-report": { "effective-directive": "script-src" } }))
    );

    expect(response.status).toBe(204);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", reportRequest("{not-json")],
    ["an unsupported content type", reportRequest("{}", "text/plain")],
    ["an oversized body", reportRequest(JSON.stringify({ x: "a".repeat(20_000) }))],
    [
      "a non-CSP reporting-API entry",
      reportRequest(JSON.stringify([{ type: "deprecation" }]), "application/reports+json"),
    ],
  ])("answers 204 and logs nothing for %s", async (_label, request) => {
    const response = await POST(request);

    expect(response.status).toBe(204);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
