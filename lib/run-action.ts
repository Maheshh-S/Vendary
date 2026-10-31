import "server-only";

import type { ActionResult } from "./action-result";
import { AppError } from "./errors";

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
