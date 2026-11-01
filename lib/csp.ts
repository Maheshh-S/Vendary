/**
 * Content-Security-Policy and the adjacent security headers.
 *
 * The policy is ENFORCING (not report-only). It is pragmatic by design:
 *
 * - `script-src` keeps `'unsafe-inline'` because Next.js 15 emits inline
 *   bootstrap/flight scripts and Razorpay Checkout injects its own inline
 *   script at runtime; `'unsafe-eval'` is needed by the Razorpay checkout
 *   bundle (and some dev tooling). Replacing these with a per-request nonce +
 *   `'strict-dynamic'` is deferred: it requires threading a nonce from
 *   middleware through every page/component and revalidating the Razorpay
 *   integration, which is a larger change than this phase's risk budget.
 * - The allowlists below are the exact hosts the storefront uses today:
 *   Razorpay checkout/API/lumberjack telemetry, the FX widget and the image
 *   hosts already allowed by `next/image`.
 * - `report-uri` points at `/api/csp-report`, which rate-limits and logs the
 *   violated directive. Cookies/PII are never part of the report payload we
 *   log (document URLs are stripped to origin + path).
 */

/** Razorpay hosts required by the embedded checkout. */
export const RAZORPAY_SCRIPT_SRC = ["https://checkout.razorpay.com"] as const;
export const RAZORPAY_CONNECT_SRC = [
  "https://api.razorpay.com",
  "https://lumberjack.razorpay.com",
] as const;
export const RAZORPAY_FRAME_SRC = [
  "https://api.razorpay.com",
  "https://checkout.razorpay.com",
] as const;

/** Third-party image hosts mirrored from the next/image allowlist. */
export const IMAGE_SRC_HOSTS = [
  "https://images.unsplash.com",
  "https://images.pexels.com",
  "https://m.media-amazon.com",
  "https://lh3.googleusercontent.com",
  "https://pixabay.com",
  "https://tailwindcss.com",
  "https://*.razorpay.com",
] as const;

export const CSP_REPORT_URI = "/api/csp-report";

export const buildContentSecurityPolicy = (): string =>
  [
    "default-src 'self'",
    ["script-src 'self' 'unsafe-inline' 'unsafe-eval'", ...RAZORPAY_SCRIPT_SRC].join(" "),
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob:", ...IMAGE_SRC_HOSTS].join(" "),
    "font-src 'self' data:",
    [
      "connect-src 'self'",
      ...RAZORPAY_CONNECT_SRC,
      // FX widget: historical + current hostnames.
      "https://api.exchangerate-api.com",
      "https://exchangerate-api.com",
    ].join(" "),
    ["frame-src", ...RAZORPAY_FRAME_SRC].join(" "),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_URI}`,
  ].join("; ");

/** Baseline headers applied to every route by next.config.ts. */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // geolocation=self: the checkout autofill flow uses it.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self)",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  {
    // Enforcing since Phase 3. Rollback to
    // `Content-Security-Policy-Report-Only` is a one-line change here.
    key: "Content-Security-Policy",
    value: buildContentSecurityPolicy(),
  },
];
