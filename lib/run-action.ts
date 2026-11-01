import "server-only";

import type { ActionResult } from "./action-result";
import { AppError } from "./errors";
import { logger } from "./logger";
import { captureException } from "./monitoring";

/**
 * `redirect()`, `notFound()`, and the HTTP fallbacks signal control flow by
 * throwing an error carrying a `digest` such as `NEXT_REDIRECT;...`. Those must
 * reach the framework untouched, so they are excluded from the masking below.
 */
const isNextControlFlowError = (e: unknown): e is { digest: string } => {
  if (typeof e !== "object" || e === null) return false;
  const { digest } = e as { digest?: unknown };
  return typeof digest === "string" && digest.startsWith("NEXT_");
};

/**
 * Wraps a server action body into the client-safe `ActionResult` contract.
 * AppErrors pass through with their user-facing copy; anything else is masked
 * behind a reference id and logged as structured JSON so the raw error (which
 * may carry payload data) never reaches the client.
 */
export async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  const startedAt = Date.now();
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isNextControlFlowError(e)) {
      throw e;
    }
    if (e instanceof AppError) {
      return { ok: false, code: e.code, message: e.userMessage, fieldErrors: e.fieldErrors };
    }
    const requestId = crypto.randomUUID();
    // The logger masks the error to a truncated, redacted message; the stack
    // never reaches the log line. Monitoring gets the raw error, keyed by the
    // same reference the user is shown.
    logger.error("action_failed", {
      action: name,
      requestId,
      durationMs: Date.now() - startedAt,
      error: e,
    });
    captureException(e, { action: name, requestId, code: "INTERNAL" });
    return {
      ok: false,
      code: "INTERNAL",
      message: `Something went wrong. Reference: ${requestId}`,
    };
  }
}
