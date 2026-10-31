import type { z } from "zod";

import { AppError } from "./errors";

/**
 * Parses untrusted action input at the boundary. TypeScript types are not a
 * runtime guarantee, so every exported server action must run its input
 * through here (or an equivalent `safeParse`) before using it.
 */
export const parseInput = <S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const { fieldErrors: flattened, formErrors } = result.error.flatten();
    const fieldErrors: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(flattened)) {
      if (messages && messages.length > 0) {
        fieldErrors[field] = messages;
      }
    }
    // Root-level `.refine()` / `.superRefine()` issues have no field path.
    if (formErrors.length > 0) {
      fieldErrors._form = formErrors;
    }
    throw new AppError("VALIDATION", "Please check the highlighted fields.", fieldErrors);
  }
  return result.data;
};
