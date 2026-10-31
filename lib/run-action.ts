import "server-only";

import type { ActionResult } from "./action-result";
import { AppError } from "./errors";

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
    console.error(
      JSON.stringify({
        level: "error",
        action: name,
        requestId,
        error: e instanceof Error ? e.message : String(e),
      })
    );
    return { ok: false, code: "INTERNAL", message: `Something went wrong. Reference: ${requestId}` };
  }
}
