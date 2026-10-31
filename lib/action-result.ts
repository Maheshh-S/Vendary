/**
 * Client-safe result contract for server actions.
 *
 * This module is imported by client components to narrow on the result of an
 * action, so it must stay type-only: no runtime imports, no "use server", no
 * server-only modules.
 */

export type ActionErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION"
  | "NOT_FOUND"
  | "OUT_OF_STOCK"
  | "PRICE_CHANGED"
  | "AMOUNT_MISMATCH"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "PAYMENT_FAILED"
  | "INTERNAL";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode; message: string; fieldErrors?: Record<string, string[]> };
