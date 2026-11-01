/**
 * Optional error monitoring seam.
 *
 * Sentry is enabled only when `SENTRY_DSN` is set. Without a DSN nothing
 * imports or initialises the SDK, nothing is sent and nothing throws. That
 * keeps `next build`, Docker builds and local/e2e runs working with no Sentry
 * credentials or auth token, and satisfies the "monitoring is optional at
 * runtime" constraint.
 *
 * `next.config.ts` is deliberately NOT wrapped with `withSentryConfig`: that
 * wrapper expects source-map upload settings and an auth token at build time.
 * Exception capture is the only feature Phase 3 needs.
 *
 * ## Why state is process-global and the SDK import lives elsewhere
 *
 * Next.js bundles this module into several server graphs: instrumentation
 * (which initialises Sentry) and every server-action/page graph (which
 * captures). Module-local state is a different variable per graph, so a
 * module-local `let sentry` made action-chunk capture silently no-op in the
 * built server. `globalThis` is shared by every graph in the Node process, so
 * the initialising chunk publishes there and every capturing chunk reads it.
 *
 * The runtime `import("@sentry/nextjs")` is deliberately NOT in this module:
 * webpack emits an async chunk per graph that contains one, which duplicated
 * the ~1.6 MB SDK into every route graph. Only `lib/monitoring-init.ts` (loaded
 * solely by `instrumentation.ts`) imports the SDK, so it lands in exactly one
 * server chunk. The capture path here has no runtime imports at all.
 */

import type * as SentryNextjs from "@sentry/nextjs";

export type SentryModule = typeof SentryNextjs;
type SentryInitOptions = NonNullable<Parameters<SentryModule["init"]>[0]>;

/** `globalThis` carrier shared by every server chunk in the process. */
type MonitoringGlobalScope = typeof globalThis & {
  /** The SDK namespace returned by the dynamic import in monitoring-init. */
  __vendarySentrySdk?: SentryModule | null;
  /** True once a DSN was configured and `Sentry.init` succeeded. */
  __vendarySentryEnabled?: boolean;
};

const globalScope = (): MonitoringGlobalScope => globalThis as MonitoringGlobalScope;

export type MonitoringContext = {
  /** Server-action name, e.g. `orders.place`. */
  action?: string;
  /** Reference id returned to the client and written to the log line. */
  requestId?: string;
  /** Action error code (`INTERNAL` for masked failures). */
  code?: string;
};

/** True when a DSN is configured; the SDK itself may still be uninitialised. */
export const isMonitoringConfigured = (
  source: Record<string, string | undefined> = process.env
): boolean => Boolean(source.SENTRY_DSN?.trim());

/** True when a chunk in this process has initialised the SDK successfully. */
export const isMonitoringInitialized = (): boolean => {
  const scope = globalScope();
  return Boolean(scope.__vendarySentryEnabled && scope.__vendarySentrySdk);
};

/** Publishes the initialised SDK to every chunk; `null` disables capture. */
export const registerSentrySdk = (sdk: SentryModule | null): void => {
  const scope = globalScope();
  scope.__vendarySentrySdk = sdk;
  scope.__vendarySentryEnabled = Boolean(sdk);
};

/**
 * The full `Sentry.init` options. Kept here (not in monitoring-init) so the
 * PII policy is testable without importing the SDK runtime; the type-only
 * import above is erased at build time.
 */
export const buildSentryOptions = (dsn: string): SentryInitOptions => ({
  dsn,
  environment: process.env.NODE_ENV ?? "development",
  // Errors only: tracing would sample customer requests and add noise.
  tracesSampleRate: 0,
  // Opt out of every automatic PII channel (Sentry v11 `dataCollection`).
  // Events are captured manually from runAction, never by the request
  // instrumentation, so there is nothing to attach here. Stack-frame variables
  // and DB query data are the two channels that can carry action locals
  // (addresses, emails, Razorpay payloads) verbatim.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
    databaseQueryData: false,
  },
  // Console breadcrumbs can echo application logs (and their redaction is not
  // guaranteed to match lib/logger.ts).
  beforeBreadcrumb: () => null,
  beforeSend(event) {
    // Defence in depth: even an automatic capture must not ship request
    // headers/cookies or user identity.
    if (event.request) {
      delete event.request.headers;
      delete event.request.cookies;
      delete event.request.data;
      delete event.request.query_string;
    }
    delete event.user;
    // Belt and braces for stack-frame locals should the SDK ever collect them
    // despite `stackFrameVariables: false`.
    for (const exception of event.exception?.values ?? []) {
      for (const frame of exception.stacktrace?.frames ?? []) {
        delete frame.vars;
      }
    }
    return event;
  },
});

/**
 * Captures an unexpected exception with the action/request reference tags.
 * No-op until `initMonitoring()` succeeded (in any chunk); never throws.
 */
export const captureException = (error: unknown, context: MonitoringContext = {}): void => {
  const scope = globalScope();
  // Read the global flag and SDK on every call: this module instance may have
  // been loaded by a different chunk than the one that ran `initMonitoring`.
  if (!scope.__vendarySentryEnabled || !scope.__vendarySentrySdk) {
    return;
  }

  const tags: Record<string, string> = {};
  if (context.action) tags.action = context.action;
  if (context.requestId) tags.requestId = context.requestId;
  if (context.code) tags.code = context.code;

  try {
    scope.__vendarySentrySdk.captureException(error, { tags });
  } catch {
    // Monitoring failures are never allowed to mask the original error.
  }
};

/** Test/teardown helper: forget the process-wide SDK and enabled flag. */
export const resetMonitoringForTests = (): void => {
  registerSentrySdk(null);
};
