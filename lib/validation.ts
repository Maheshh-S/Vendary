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
    const fieldErrors: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(result.error.flatten().fieldErrors)) {
      if (messages && messages.length > 0) {
        fieldErrors[field] = messages;
      }
    }
    throw new AppError("VALIDATION", "Please check the highlighted fields.", fieldErrors);
  }
  return result.data;
};
