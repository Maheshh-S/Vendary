/**
 * Sentry bootstrapping, imported ONLY by `instrumentation.ts`.
 *
 * Keeping the runtime `import("@sentry/nextjs")` out of `lib/monitoring.ts` is
 * load-bearing: webpack turns each dynamic import into an async chunk, so a
 * dynamic import in the shared module shipped a ~1.6 MB copy of the SDK into
 * every server graph (instrumentation + each route/action graph). This module
 * exists in the instrumentation graph only, so exactly one copy is emitted.
 *
 * The initialised SDK is published on `globalThis` via `registerSentrySdk`;
 * `lib/monitoring.ts` capture code (bundled into action chunks) reads it from
 * there. Never throws: a monitoring outage must not take the server down.
 */

import { logger } from "./logger";
import { buildSentryOptions, isMonitoringInitialized, registerSentrySdk } from "./monitoring";

/**
 * Initialises Sentry once per process. Returns false when no DSN is configured,
 * when the SDK import fails, or when it was already initialised.
 */
export const initMonitoring = async (): Promise<boolean> => {
  // The flag is process-global, so a second chunk calling this (or a repeated
  // instrumentation run) does not initialise the SDK twice.
  if (isMonitoringInitialized()) {
    return true;
  }

  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    return false;
  }

  try {
    const sdk = await import("@sentry/nextjs");
    sdk.init(buildSentryOptions(dsn));
    // Publish only after a successful init: a thrown init must leave capture
    // disabled instead of pointing at a half-initialised SDK.
    registerSentrySdk(sdk);
    return true;
  } catch (error) {
    registerSentrySdk(null);
    logger.warn("monitoring_init_failed", { error });
    return false;
  }
};
