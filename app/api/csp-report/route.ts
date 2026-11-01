import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * CSP violation collector (the `report-uri` target).
 *
 * Browsers send either the legacy `application/csp-report` envelope
 * (`{ "csp-report": { "document-uri", "effective-directive", ... } }`) or the
 * Reporting API array (`application/reports+json`). Both are accepted, plus a
 * bare violation object for easy manual/curl reporting.
 *
 * Safety:
 * - per-IP fixed-window rate limit (RATE_LIMITS.cspReport); over-budget
 *   reports are dropped silently — this endpoint must never become a log
 *   amplification vector,
 * - only the violated directive and origin+path (query/hash stripped) are
 *   logged; cookies, headers, user agents and report bodies are discarded,
 * - every request answers 204, so a malformed report cannot cause browsers to
 *   retry or page anyone. Nothing here touches the database.
 */

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;
const MAX_DIRECTIVE_LENGTH = 80;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringField = (record: Record<string, unknown> | null, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Keeps a suspicious URL useful without shipping customer data: `https://host`
 * + path only. CSP keywords (`inline`, `eval`, `data:`) pass through.
 */
const sanitizeUri = (value: string | undefined): string => {
  if (!value) {
    return "unknown";
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value.split(/[?#]/)[0].slice(0, 200);
  }
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch {
    return value.split(/[?#]/)[0].slice(0, 200);
  }
};

type Violation = {
  directive: string;
  documentUri: string;
  blockedUri: string;
};

const extractViolation = (json: unknown): Violation | null => {
  // Reporting API: [{ type: "csp-violation", body: { effectiveDirective, ... } }]
  if (Array.isArray(json)) {
    const entry = asRecord(json[0]);
    if (!entry || entry.type !== "csp-violation") {
      return null;
    }
    const report = asRecord(entry.body);
    return {
      directive: (
        stringField(report, "effectiveDirective") ??
        stringField(report, "effective-directive") ??
        "unknown"
      ).slice(0, MAX_DIRECTIVE_LENGTH),
      documentUri: sanitizeUri(
        stringField(report, "documentURL") ?? stringField(report, "document-uri")
      ),
      blockedUri: sanitizeUri(
        stringField(report, "blockedURL") ?? stringField(report, "blocked-uri")
      ),
    };
  }

  const root = asRecord(json);
  if (!root) {
    return null;
  }
  // Legacy envelope; a bare report object is accepted too.
  const report = asRecord(root["csp-report"]) ?? root;

  return {
    directive: (
      stringField(report, "effective-directive") ??
      stringField(report, "violated-directive") ??
      "unknown"
    ).slice(0, MAX_DIRECTIVE_LENGTH),
    documentUri: sanitizeUri(
      stringField(report, "document-uri") ?? stringField(report, "documentURL")
    ),
    blockedUri: sanitizeUri(
      stringField(report, "blocked-uri") ?? stringField(report, "blockedURL")
    ),
  };
};

export async function POST(request: Request) {
  const subject = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = await checkRateLimit({
    ...RATE_LIMITS.cspReport,
    bucket: "csp-report",
    subject,
  });

  // Over budget: acknowledge without parsing or logging.
  if (!limit.allowed) {
    return new NextResponse(null, { status: 204 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const looksLikeReport =
    contentType.includes("application/csp-report") ||
    contentType.includes("application/json") ||
    contentType.includes("application/reports+json");
  if (!looksLikeReport) {
    return new NextResponse(null, { status: 204 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 204 });
  }

  let violation: Violation | null = null;
  try {
    violation = extractViolation(JSON.parse(raw));
  } catch {
    // Malformed reports are dropped silently.
  }

  if (violation) {
    logger.warn("csp_violation", violation);
  }

  return new NextResponse(null, { status: 204 });
}
