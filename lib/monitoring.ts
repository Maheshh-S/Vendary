/**
 * Optional error monitoring seam.
 *
 * Sentry is enabled only when `SENTRY_DSN` is set. Without a DSN this module is
 * a pure no-op: it does not import the SDK, does not initialise it and never
 * throws. That keeps `next build`, Docker builds and local/e2e runs working
 * with no Sentry credentials or auth token, and satisfies the "monitoring is
 * optional at runtime" constraint.
 *
 * `next.config.ts` is deliberately NOT wrapped with `withSentryConfig`: that
 * wrapper expects source-map upload settings and an auth token at build time.
 * Exception capture is the only feature Phase 3 needs, so the node runtime
 * initialises the SDK from `instrumentation.ts` instead.
 */

import { logger } from "./logger";

type SentryModule = typeof import("@sentry/nextjs");

export type MonitoringContext = {
  /** Server-action name, e.g. `orders.place`. */
  action?: string;
  /** Reference id returned to the client and written to the log line. */
  requestId?: string;
  /** Action error code (`INTERNAL` for masked failures). */
  code?: string;
};

let sentry: SentryModule | null = null;

/** True when a DSN is configured; the SDK itself may still be uninitialised. */
export const isMonitoringConfigured = (
  source: Record<string, string | undefined> = process.env
): boolean => Boolean(source.SENTRY_DSN?.trim());

/**
 * Initialises Sentry once. Returns false when no DSN is configured, when the
 * SDK import fails, or when it was already initialised. Never throws: a
 * monitoring outage must not take the server down.
 */
export const initMonitoring = async (): Promise<boolean> => {
  if (sentry) {
    return true;
  }

  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    return false;
  }

  try {
    const sdk = await import("@sentry/nextjs");
    sdk.init({
      dsn,
      environment: process.env.NODE_ENV ?? "development",
      // Errors only: tracing would sample customer requests and add noise.
      tracesSampleRate: 0,
      // Opt out of every automatic PII channel (Sentry v11 `dataCollection`).
      // Events are captured manually from runAction, never by the request
      // instrumentation, so there is nothing to attach here.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      // Console breadcrumbs can echo application logs (and their redaction is
      // not guaranteed to match lib/logger.ts).
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
        return event;
      },
    });
    sentry = sdk;
    return true;
  } catch (error) {
    logger.warn("monitoring_init_failed", { error });
    return false;
  }
};

/**
 * Captures an unexpected exception with the action/request reference tags.
 * No-op until `initMonitoring()` succeeded; never throws.
 */
export const captureException = (error: unknown, context: MonitoringContext = {}): void => {
  if (!sentry) {
    return;
  }

  const tags: Record<string, string> = {};
  if (context.action) tags.action = context.action;
  if (context.requestId) tags.requestId = context.requestId;
  if (context.code) tags.code = context.code;

  try {
    sentry.captureException(error, { tags });
  } catch {
    // Monitoring failures are never allowed to mask the original error.
  }
};

/** Test/teardown helper: forget the initialised SDK. */
export const resetMonitoringForTests = (): void => {
  sentry = null;
};
