import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1, "Please Enter a Password."),
  /** Validated again by `safeInternalPath`; only internal paths redirect. */
  callbackUrl: z.string().max(2048).optional(),
});

export type LoginSchemaType = z.infer<typeof LoginSchema>;
