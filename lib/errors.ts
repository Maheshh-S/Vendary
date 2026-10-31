import type { ActionErrorCode } from "./action-result";

/**
 * An error that is safe to show to the caller: `userMessage` is user-facing
 * copy, `fieldErrors` maps form fields to messages, and the original error is
 * kept (unserialized) as `cause` for server-side diagnostics.
 */
export class AppError extends Error {
  constructor(
    public code: ActionErrorCode,
    public userMessage: string,
    public fieldErrors?: Record<string, string[]>,
    public cause?: unknown
  ) {
    super(userMessage);
    this.name = "AppError";
  }
}
